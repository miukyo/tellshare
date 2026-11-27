import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import { Readable } from 'node:stream'
import Busboy from 'busboy'
import { Context, Hono } from 'hono'
import { AppConfig, assertEncryptionConfig } from './config'
import {
  createDecryptStream,
  createFileCipher,
  generateFileEncryptionParams,
} from './crypto'
import { FileDatabase, FilePartRecord, FileRecord } from './db'
import { SetupBackend, StorageBackend, TelegramObjectNotFoundError } from './telegram'
import {
  generateId,
  generateManagementToken,
  hashToken,
  inferMimeType,
  isEmbedCrawler,
  isEmbeddableMediaMime,
  isUnsafeInlineMime,
  parseRangeHeader,
  sanitizeExtension,
  sanitizeFilename,
  splitIdAndExt,
  validateRemoteUrl,
  verifyToken,
} from './utils'
import { renderMediaEmbedHtml, renderPlainHelp, renderSetupUi, renderWebUi } from './views'

export interface CreateAppDeps {
  db: FileDatabase
  storage: StorageBackend
  setup?: SetupBackend
  config: AppConfig
}

class PayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PayloadTooLargeError'
  }
}

class BadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

function isTruthyFormFlag(value: FormDataEntryValue | null): boolean {
  if (value === null || typeof value !== 'string') return false
  const normalized = value.trim().toLowerCase()
  return normalized !== '0' && normalized !== 'false' && normalized !== 'no' && normalized !== 'off'
}

function prefersHtml(acceptHeader: string | undefined, userAgent: string | undefined): boolean {
  if (!acceptHeader || !acceptHeader.includes('text/html')) return false
  if (userAgent && /curl|wget|httpie|libfetch|powershell/i.test(userAgent)) return false
  return true
}

function wantsJson(acceptHeader: string | undefined): boolean {
  return Boolean(acceptHeader && acceptHeader.toLowerCase().includes('application/json'))
}

export function resolveBaseUrl(c: Context, config: AppConfig): string {
  if (config.baseUrl) return config.baseUrl

  const reqUrl = new URL(c.req.url)
  const rawProto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
  const proto =
    rawProto === 'http' || rawProto === 'https' ? rawProto : reqUrl.protocol.replace(/:$/, '')
  const rawHost =
    c.req.header('x-forwarded-host')?.split(',')[0]?.trim() || c.req.header('host')?.trim()

  if (rawHost && !/[\s/\\]/.test(rawHost)) {
    return `${proto}://${rawHost}`
  }

  return reqUrl.origin
}

function extractTokenFromHeaders(
  xToken: string | undefined,
  authorization: string | undefined
): string {
  if (xToken && xToken.trim()) return xToken.trim()
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
    if (match?.[1]) return match[1].trim()
  }
  return ''
}

function buildContentDisposition(disposition: 'inline' | 'attachment', filename: string): string {
  const safeAscii = filename.replace(/["\\\r\n]/g, '_')
  const encoded = encodeURIComponent(filename)
  return `${disposition}; filename="${safeAscii}"; filename*=UTF-8''${encoded}`
}

function extractFilenameFromHeaders(contentDisposition: string | null, url: URL): string {
  if (contentDisposition) {
    const starMatch = /filename\*=UTF-8''([^;\r\n]+)/i.exec(contentDisposition)
    if (starMatch?.[1]) {
      try {
        return sanitizeFilename(decodeURIComponent(starMatch[1]))
      } catch {
        // Fall through to plain filename
      }
    }
    const plainMatch = /filename="?([^";\r\n]+)"?/i.exec(contentDisposition)
    if (plainMatch?.[1]) {
      return sanitizeFilename(plainMatch[1])
    }
  }

  const segment = path.posix.basename(url.pathname)
  return sanitizeFilename(segment || 'download')
}

interface UploadedPartsResult {
  size: number
  sha256: string
  encSalt: string
  encIv: string
  parts: FilePartRecord[]
}

async function cleanupUploadedParts(
  storage: StorageBackend,
  parts: Array<Pick<FilePartRecord, 'tg_chat_id' | 'tg_message_id'>>
): Promise<void> {
  await Promise.allSettled(
    parts.map((p) =>
      storage.deleteFile({
        chatId: p.tg_chat_id,
        messageId: p.tg_message_id,
      })
    )
  )
}

async function uploadStreamInParts(opts: {
  source: ReadableStream<Uint8Array>
  id: string
  partSize: number
  maxFileSize: number
  knownTotalSize?: number
  encryptionKey: Buffer
  storage: StorageBackend
  onProgress?: (uploadedBytes: number, totalBytes: number) => void
}): Promise<UploadedPartsResult> {
  const {
    source,
    id,
    partSize,
    maxFileSize,
    knownTotalSize,
    encryptionKey,
    storage,
    onProgress,
  } = opts

  if (maxFileSize > 0 && knownTotalSize !== undefined && knownTotalSize > maxFileSize) {
    await source.cancel().catch(() => {})
    throw new PayloadTooLargeError(`File exceeds max size of ${maxFileSize} bytes`)
  }

  const { salt: encSalt, iv: encIv } = generateFileEncryptionParams()
  const cipher = createFileCipher(encryptionKey, encSalt, encIv)
  const hasher = createHash('sha256')
  const reader = source.getReader()
  const parts: FilePartRecord[] = []

  let totalSize = 0
  let leftover: Uint8Array | null = null
  let eof = false

  const pullNextNonEmpty = async (): Promise<Uint8Array | null> => {
    if (leftover && leftover.byteLength > 0) {
      const out = leftover
      leftover = null
      return out
    }
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        eof = true
        return null
      }
      if (value.byteLength > 0) {
        return value
      }
    }
  }

  try {
    const firstChunk = await pullNextNonEmpty()
    if (firstChunk === null) {
      return {
        size: 0,
        sha256: hasher.digest('hex'),
        encSalt,
        encIv,
        parts: [],
      }
    }
    leftover = firstChunk

    let partIndex = 0
    while (true) {
      const partOffset = totalSize
      let partBytesFed = 0
      const knownPartSize =
        knownTotalSize !== undefined && knownTotalSize > partOffset
          ? Math.min(partSize, knownTotalSize - partOffset)
          : undefined

      const partStream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            if (partBytesFed >= partSize) {
              controller.close()
              return
            }
            const raw = await pullNextNonEmpty()
            if (raw === null) {
              const tail = cipher.final()
              if (tail.byteLength > 0) {
                controller.enqueue(new Uint8Array(tail))
              }
              controller.close()
              return
            }

            const take = Math.min(raw.byteLength, partSize - partBytesFed)
            const slice = take === raw.byteLength ? raw : raw.subarray(0, take)
            if (take < raw.byteLength) {
              leftover = raw.subarray(take)
            }

            totalSize += slice.byteLength
            if (maxFileSize > 0 && totalSize > maxFileSize) {
              throw new PayloadTooLargeError(`File exceeds max size of ${maxFileSize} bytes`)
            }

            partBytesFed += slice.byteLength
            hasher.update(slice)
            const encrypted = cipher.update(slice)
            if (encrypted.byteLength > 0) {
              controller.enqueue(new Uint8Array(encrypted))
            }

            if (partBytesFed >= partSize) {
              controller.close()
            }
          } catch (err) {
            controller.error(err)
          }
        },
        cancel() {
          reader.cancel().catch(() => {})
        },
      })

      const blobId = randomBytes(16).toString('hex')
      const tgObj = await storage.uploadFile({
        source: partStream,
        filename: `${blobId}.bin`,
        mimeType: 'application/octet-stream',
        size: knownPartSize,
        estimatedSize: knownPartSize ?? partSize,
        caption: undefined,
        onProgress: onProgress
          ? (partUploaded, partTotal) => {
              const clamped = Math.min(partUploaded, partBytesFed || partTotal || partSize)
              const overallUploaded = partOffset + clamped
              const overallTotal =
                knownTotalSize ??
                Math.max(overallUploaded, partOffset + (partTotal > 0 ? partTotal : partSize))
              onProgress(overallUploaded, overallTotal)
            }
          : undefined,
      })

      parts.push({
        file_id: id,
        part_index: partIndex,
        byte_offset: partOffset,
        byte_length: partBytesFed,
        tg_chat_id: tgObj.chatId,
        tg_message_id: tgObj.messageId,
        tg_file_id: tgObj.fileId,
      })

      if (eof && (!leftover || leftover.byteLength === 0)) {
        break
      }

      const nextPeek = await pullNextNonEmpty()
      if (nextPeek === null) {
        break
      }
      leftover = nextPeek
      partIndex++
    }

    return {
      size: totalSize,
      sha256: hasher.digest('hex'),
      encSalt,
      encIv,
      parts,
    }
  } catch (err) {
    await reader.cancel().catch(() => {})
    await cleanupUploadedParts(storage, parts)
    throw err
  }
}

async function fetchRemoteUrlStream(
  rawUrl: string,
  maxFileSize: number
): Promise<{
  body: ReadableStream<Uint8Array>
  knownSize?: number
  filename: string
  mimeType: string
}> {
  let currentUrl = await validateRemoteUrl(rawUrl)
  const maxRedirects = 5
  let response: Response | null = null

  for (let i = 0; i <= maxRedirects; i++) {
    response = await fetch(currentUrl.toString(), {
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
      headers: {
        'User-Agent': 'tellshare/0.1',
      },
    })

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => {})
      if (!location) {
        throw new BadRequestError('Upstream redirect missing Location header')
      }
      if (i === maxRedirects) {
        throw new BadRequestError('Too many redirects while fetching URL')
      }
      const nextRaw = new URL(location, currentUrl).toString()
      currentUrl = await validateRemoteUrl(nextRaw)
      continue
    }

    break
  }

  if (!response || !response.ok || !response.body) {
    const status = response?.status ?? 502
    await response?.body?.cancel().catch(() => {})
    throw new BadRequestError(`Upstream URL returned HTTP ${status}`)
  }

  let knownSize: number | undefined
  const contentLengthHeader = response.headers.get('content-length')
  if (contentLengthHeader) {
    const declaredSize = Number.parseInt(contentLengthHeader, 10)
    if (Number.isFinite(declaredSize) && declaredSize >= 0) {
      if (maxFileSize > 0 && declaredSize > maxFileSize) {
        await response.body.cancel().catch(() => {})
        throw new PayloadTooLargeError(`Remote file exceeds max size of ${maxFileSize} bytes`)
      }
      knownSize = declaredSize
    }
  }

  const filename = extractFilenameFromHeaders(
    response.headers.get('content-disposition'),
    currentUrl
  )
  const rawMime = response.headers.get('content-type')?.split(';')[0]?.trim()
  const mimeType = inferMimeType(filename, rawMime)

  return {
    body: response.body,
    knownSize,
    filename,
    mimeType,
  }
}

async function createMultiPartDownloadStream(
  parts: FilePartRecord[],
  offset: number,
  length: number,
  storage: StorageBackend,
  db: FileDatabase,
  signal?: AbortSignal
): Promise<ReadableStream<Uint8Array>> {
  const overlapping = parts.filter(
    (p) => p.byte_offset + p.byte_length > offset && p.byte_offset < offset + length
  )

  if (overlapping.length === 0) {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    })
  }

  const openPartStream = async (part: FilePartRecord) => {
    const localStart = Math.max(0, offset - part.byte_offset)
    const localEnd = Math.min(part.byte_length, offset + length - part.byte_offset)
    const localLimit = localEnd - localStart
    const stream = await storage.downloadStream({
      chatId: part.tg_chat_id,
      messageId: part.tg_message_id,
      fileId: part.tg_file_id,
      offset: localStart,
      limit: localLimit,
      signal,
      onRefreshedFileId: (newFileId) => {
        db.updateTgFileId(part.tg_chat_id, part.tg_message_id, newFileId)
      },
    })
    return stream.getReader()
  }

  // Probe the first overlapping part before committing HTTP 200/206 headers.
  let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = await openPartStream(
    overlapping[0]
  )
  let nextIdx = 1

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          if (currentReader === null) {
            if (nextIdx >= overlapping.length) {
              controller.close()
              return
            }
            currentReader = await openPartStream(overlapping[nextIdx++])
          }

          const { done, value } = await currentReader.read()
          if (done) {
            currentReader = null
            continue
          }
          if (value.byteLength > 0) {
            controller.enqueue(value)
            return
          }
        }
      } catch (err) {
        currentReader?.cancel().catch(() => {})
        currentReader = null
        controller.error(err)
      }
    },
    cancel() {
      currentReader?.cancel().catch(() => {})
      currentReader = null
    },
  })
}

async function deleteRecordAndCleanupTelegram(
  db: FileDatabase,
  storage: StorageBackend,
  record: FileRecord
): Promise<void> {
  const parts = db.getParts(record.id)
  const uniqueMessages = new Map<string, { chatId: string; messageId: number }>()
  for (const part of parts) {
    const key = `${part.tg_chat_id}:${part.tg_message_id}`
    if (!uniqueMessages.has(key)) {
      uniqueMessages.set(key, { chatId: part.tg_chat_id, messageId: part.tg_message_id })
    }
  }

  db.deleteById(record.id)

  for (const msg of uniqueMessages.values()) {
    const remainingRefs = db.countByTelegramMessage(msg.chatId, msg.messageId)
    if (remainingRefs === 0) {
      await storage.deleteFile(msg)
    }
  }
}

export function createApp({ db, storage, setup, config }: CreateAppDeps): Hono {
  const encryptionKey = assertEncryptionConfig(config)
  const app = new Hono()
  const uploadProgress = new Map<string, { uploaded: number; total: number; done: boolean }>()

  app.get('/health', (c) => {
    return c.json({
      ok: true,
      telegram: storage.isConnected(),
      uptime: process.uptime(),
    })
  })

  app.get('/upload-progress/:uploadId', (c) => {
    const uploadId = c.req.param('uploadId')
    const entry = uploadProgress.get(uploadId)
    if (!entry) {
      return c.json({ error: 'Not found' }, 404)
    }
    return c.json(entry)
  })

  const guardSetup = (c: Context) => {
    if (!setup) {
      return c.json({ error: 'Setup not available' }, 404)
    }
    if (storage.isConnected()) {
      return c.json({ error: 'Already configured' }, 403)
    }
    return null
  }

  app.get('/setup/status', (c) => {
    if (!setup) {
      return c.json({ error: 'Setup not available' }, 404)
    }
    if (storage.isConnected()) {
      return c.json({ connected: true, state: 'connected' })
    }
    return c.json(setup.getSetupStatus())
  })

  app.post('/setup/qr', async (c) => {
    const blocked = guardSetup(c)
    if (blocked) return blocked
    return c.json(await setup!.startQrLogin())
  })

  app.post('/setup/phone', async (c) => {
    const blocked = guardSetup(c)
    if (blocked) return blocked
    const body = (await c.req.json().catch(() => ({}))) as { phone?: string }
    return c.json(await setup!.sendPhoneCode(typeof body.phone === 'string' ? body.phone : ''))
  })

  app.post('/setup/code', async (c) => {
    const blocked = guardSetup(c)
    if (blocked) return blocked
    const body = (await c.req.json().catch(() => ({}))) as { code?: string }
    return c.json(await setup!.submitPhoneCode(typeof body.code === 'string' ? body.code : ''))
  })

  app.post('/setup/password', async (c) => {
    const blocked = guardSetup(c)
    if (blocked) return blocked
    const body = (await c.req.json().catch(() => ({}))) as { password?: string }
    return c.json(
      await setup!.submitPassword(typeof body.password === 'string' ? body.password : '')
    )
  })

  app.get('/', (c) => {
    const baseUrl = resolveBaseUrl(c, config)
    const isHtml = prefersHtml(c.req.header('accept'), c.req.header('user-agent'))
    if (!storage.isConnected() && setup) {
      if (isHtml) {
        return c.html(renderSetupUi(baseUrl))
      }
      return c.text(
        `TellShare setup required. Open ${baseUrl} in a browser or run \`bun run login\`.\n`,
        503
      )
    }
    const stats = db.getStats()
    if (isHtml) {
      return c.html(renderWebUi(config, stats, baseUrl))
    }
    return c.text(renderPlainHelp(config, stats, baseUrl), 200, {
      'Content-Type': 'text/plain; charset=utf-8',
    })
  })

  app.post('/', async (c) => {
    if (!storage.isConnected()) {
      return c.text('Telegram not configured yet. Complete setup at /\n', 503)
    }

    const reqBody = c.req.raw.body
    if (!reqBody) {
      return c.text('Invalid multipart/form-data request\n', 400)
    }

    const reqHeaders: Record<string, string> = {}
    c.req.raw.headers.forEach((value, key) => {
      reqHeaders[key.toLowerCase()] = value
    })

    let bb: Busboy.Busboy
    try {
      bb = Busboy({
        headers: reqHeaders,
        highWaterMark: 2 * 1024 * 1024,
        fileHwm: 1024 * 1024,
      })
    } catch {
      return c.text('Invalid multipart/form-data request\n', 400)
    }

    const nowMs = Date.now()
    const uploadId = (c.req.header('x-upload-id') || c.req.query('uploadId') || '').trim()
    const rawKnownSize = c.req.header('x-file-size')
    const parsedKnownSize = rawKnownSize ? Number.parseInt(rawKnownSize, 10) : NaN
    const knownTotalSize =
      Number.isFinite(parsedKnownSize) && parsedKnownSize > 0 ? parsedKnownSize : undefined

    if (uploadId) {
      uploadProgress.set(uploadId, {
        uploaded: 0,
        total: knownTotalSize ?? 0,
        done: false,
      })
    }

    let id = generateId()
    for (let attempt = 0; attempt < 10 && db.getById(id) !== null; attempt++) {
      id = generateId()
    }
    if (db.getById(id) !== null) {
      return c.text('Failed to allocate unique file ID\n', 500)
    }

    const bodyReader = reqBody.getReader()
    const rawContentLength = c.req.header('content-length')
    const parsedContentLength = rawContentLength ? Number.parseInt(rawContentLength, 10) : NaN
    const expectedContentLength =
      Number.isFinite(parsedContentLength) && parsedContentLength >= 0
        ? parsedContentLength
        : undefined
    let bytesReceived = 0
    let sawFile = false
    let urlValue = ''
    let filename = 'file'
    let mimeType = 'application/octet-stream'
    let uploadPromise: Promise<void> | null = null
    let uploadResult: UploadedPartsResult | null = null
    let uploadErr: unknown = null
    let busboyErr: unknown = null
    let pumpAborted = false
    let wakePump: (() => void) | null = null

    const abortPump = () => {
      if (pumpAborted) return
      pumpAborted = true
      bodyReader.cancel().catch(() => {})
      bb.destroy()
      wakePump?.()
    }

    const reqSignal = c.req.raw.signal
    const onClientAbort = () => {
      if (!busboyErr && !uploadErr) {
        busboyErr = new BadRequestError('Upload aborted by client')
      }
      abortPump()
    }
    if (reqSignal?.aborted) {
      onClientAbort()
    } else {
      reqSignal?.addEventListener('abort', onClientAbort, { once: true })
    }

    const reportProgress = uploadId
      ? (uploaded: number, total: number) => {
          uploadProgress.set(uploadId, { uploaded, total, done: false })
        }
      : undefined

    bb.on('field', (name, val) => {
      if (name === 'url' && val.trim()) {
        if (sawFile || urlValue) {
          busboyErr = new BadRequestError('Provide exactly one of "file" or "url"')
          abortPump()
          return
        }
        urlValue = val.trim()
      }
    })

    bb.on('file', (name, fileStream, info) => {
      if (name !== 'file') {
        fileStream.resume()
        return
      }
      if (sawFile || urlValue) {
        fileStream.resume()
        busboyErr = new BadRequestError('Provide exactly one of "file" or "url"')
        abortPump()
        return
      }
      sawFile = true
      filename = sanitizeFilename(info.filename || 'file')
      mimeType = inferMimeType(filename, info.mimeType)

      const webStream = Readable.toWeb(fileStream) as unknown as ReadableStream<Uint8Array>
      uploadPromise = uploadStreamInParts({
        source: webStream,
        id,
        partSize: config.partSize,
        maxFileSize: config.maxFileSize,
        knownTotalSize,
        encryptionKey,
        storage,
        onProgress: reportProgress,
      }).then(
        (res) => {
          uploadResult = res
        },
        (err) => {
          uploadErr = err
          abortPump()
        }
      )
    })

    const bbFinished = new Promise<void>((resolve) => {
      bb.once('finish', () => {
        wakePump?.()
        resolve()
      })
      bb.once('close', () => {
        wakePump?.()
        resolve()
      })
      bb.once('error', (err: Error) => {
        if (!pumpAborted && !busboyErr) {
          if (err?.message?.includes('Unexpected end of form')) {
            console.warn(
              `[upload] Multipart stream ended unexpectedly (received ${bytesReceived}/${expectedContentLength ?? '?'} bytes)`
            )
            busboyErr = new BadRequestError('Upload interrupted or truncated before completion')
          } else {
            busboyErr = new BadRequestError('Invalid multipart/form-data request')
          }
        }
        wakePump?.()
        resolve()
      })
    })

    const waitForDrain = () =>
      new Promise<void>((resolve) => {
        const cleanup = () => {
          bb.off('drain', onEvent)
          bb.off('close', onEvent)
          bb.off('error', onEvent)
          wakePump = null
        }
        const onEvent = () => {
          cleanup()
          resolve()
        }
        wakePump = onEvent
        bb.once('drain', onEvent)
        bb.once('close', onEvent)
        bb.once('error', onEvent)
      })

    try {
      try {
        while (!pumpAborted) {
          const { done, value } = await bodyReader.read()
          if (done) {
            bb.end()
            break
          }
          if (pumpAborted) break
          bytesReceived += value.byteLength
          if (!bb.write(value)) {
            await waitForDrain()
          }
        }
      } catch {
        if (!pumpAborted && !busboyErr && !uploadErr) {
          busboyErr = new BadRequestError('Failed to read request body')
        }
        abortPump()
      }

      await bbFinished
      if (uploadPromise) {
        await uploadPromise
      }

      if (busboyErr) throw busboyErr
      if (uploadErr) throw uploadErr

      if (!uploadResult) {
        if (!urlValue) {
          throw new BadRequestError('Provide exactly one of "file" or "url"')
        }
        if (!config.allowUrlUpload) {
          return c.text('Remote URL uploads are disabled\n', 403)
        }

        const remote = await fetchRemoteUrlStream(urlValue, config.maxFileSize)
        filename = remote.filename
        mimeType = remote.mimeType
        if (uploadId && remote.knownSize !== undefined) {
          uploadProgress.set(uploadId, { uploaded: 0, total: remote.knownSize, done: false })
        }

        uploadResult = await uploadStreamInParts({
          source: remote.body,
          id,
          partSize: config.partSize,
          maxFileSize: config.maxFileSize,
          knownTotalSize: remote.knownSize,
          encryptionKey,
          storage,
          onProgress: reportProgress,
        })
      }

      if (uploadResult.size === 0 || uploadResult.parts.length === 0) {
        return c.text('Empty files cannot be uploaded\n', 400)
      }

      const ext = sanitizeExtension(filename)
      const mgmtToken = generateManagementToken()
      const mgmtTokenHash = hashToken(mgmtToken)

      // Deduplicate identical plaintext by reusing existing encrypted Telegram parts.
      const existing = db.findExistingBySha256(uploadResult.sha256)
      let encSalt = uploadResult.encSalt
      let encIv = uploadResult.encIv
      let finalParts = uploadResult.parts

      if (existing) {
        await cleanupUploadedParts(storage, uploadResult.parts)
        encSalt = existing.enc_salt
        encIv = existing.enc_iv
        finalParts = existing.parts.map((p) => ({
          ...p,
          file_id: id,
        }))
      }

      db.insertWithParts(
        {
          id,
          ext,
          filename,
          mime_type: mimeType,
          size: uploadResult.size,
          sha256: uploadResult.sha256,
          enc_salt: encSalt,
          enc_iv: encIv,
          mgmt_token_hash: mgmtTokenHash,
          created_at: nowMs,
        },
        finalParts
      )

      if (uploadId) {
        uploadProgress.set(uploadId, {
          uploaded: uploadResult.size,
          total: uploadResult.size,
          done: true,
        })
      }

      const baseUrl = resolveBaseUrl(c, config)
      const fileUrl = `${baseUrl}/${id}${ext ? `.${ext}` : ''}`
      c.header('X-Token', mgmtToken)

      if (wantsJson(c.req.header('accept'))) {
        return c.json({
          url: fileUrl,
          id,
          filename,
          size: uploadResult.size,
          mimeType,
          token: mgmtToken,
        })
      }

      return c.text(`${fileUrl}\n`, 200)
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        return c.text(`${err.message}\n`, 413)
      }
      if (
        err instanceof BadRequestError ||
        (err instanceof Error &&
          (err.message.includes('URL') ||
            err.message.includes('Private or loopback') ||
            err.message.includes('Upstream') ||
            err.message.includes('redirects')))
      ) {
        return c.text(`${err.message}\n`, 400)
      }
      console.error('[upload] Error handling upload:', err)
      return c.text('Upload failed\n', 500)
    } finally {
      reqSignal?.removeEventListener('abort', onClientAbort)
      if (uploadId) {
        const current = uploadProgress.get(uploadId)
        if (current && current.done) {
          setTimeout(() => {
            uploadProgress.delete(uploadId)
          }, 30_000).unref?.()
        } else {
          uploadProgress.delete(uploadId)
        }
      }
    }
  })

  const handleDownload = async (c: Context) => {
    const slug = c.req.param('slug') ?? ''
    if (!slug) {
      return c.text('Not Found\n', 404)
    }
    const { id } = splitIdAndExt(slug)
    const record = db.getById(id)

    if (!record) {
      return c.text('Not Found\n', 404)
    }

    const parts = db.getParts(record.id)
    if (parts.length === 0) {
      return c.text('Not Found\n', 404)
    }

    const rangeHeader = c.req.header('range')

    if (
      c.req.method === 'GET' &&
      !c.req.query('raw') &&
      !c.req.query('download') &&
      !rangeHeader &&
      isEmbedCrawler(c.req.header('user-agent'))
    ) {
      const mediaKind = isEmbeddableMediaMime(record.mime_type)
      if (mediaKind) {
        const baseUrl = resolveBaseUrl(c, config)
        const pageUrl = `${baseUrl}/${record.id}${record.ext ? `.${record.ext}` : ''}`
        return c.html(
          renderMediaEmbedHtml({
            title: record.filename,
            pageUrl,
            rawUrl: `${pageUrl}?raw=1`,
            mimeType: record.mime_type,
            mediaKind,
            size: record.size,
          })
        )
      }
    }

    let offset = 0
    let length = record.size
    let status = 200
    let contentRange: string | undefined

    if (rangeHeader) {
      const parsedRange = parseRangeHeader(rangeHeader, record.size)
      if (parsedRange === 'invalid') {
        return new Response('Range Not Satisfiable\n', {
          status: 416,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Range': `bytes */${record.size}`,
          },
        })
      }
      if (parsedRange !== null) {
        offset = parsedRange.start
        length = parsedRange.end - parsedRange.start + 1
        status = 206
        contentRange = `bytes ${parsedRange.start}-${parsedRange.end}/${record.size}`
      }
    }

    const forceDownload = c.req.query('download') === '1'
    const unsafeMime = isUnsafeInlineMime(record.mime_type)
    const disposition: 'inline' | 'attachment' = forceDownload || unsafeMime ? 'attachment' : 'inline'

    const headers = new Headers({
      'Content-Type': record.mime_type,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(length),
      'Content-Disposition': buildContentDisposition(disposition, record.filename),
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: `"${record.sha256}"`,
      'X-Content-Type-Options': 'nosniff',
    })

    if (contentRange) {
      headers.set('Content-Range', contentRange)
    }
    if (unsafeMime) {
      headers.set('Content-Security-Policy', 'sandbox')
    }

    if (c.req.method === 'HEAD') {
      return new Response(null, { status, headers })
    }

    try {
      const encryptedStream = await createMultiPartDownloadStream(
        parts,
        offset,
        length,
        storage,
        db,
        c.req.raw.signal
      )

      const plainStream = createDecryptStream(
        encryptedStream,
        encryptionKey,
        record.enc_salt,
        record.enc_iv,
        offset
      )

      db.incrementDownloads(record.id)
      return new Response(plainStream, { status, headers })
    } catch (err) {
      if (err instanceof TelegramObjectNotFoundError) {
        return c.text('Not Found\n', 404)
      }
      console.error(`[download] Failed to stream ${record.id}:`, err)
      return c.text('Failed to retrieve file from Telegram\n', 502)
    }
  }

  app.on(['GET', 'HEAD'], '/:slug', (c) => handleDownload(c))

  app.post('/:slug', async (c) => {
    const slug = c.req.param('slug')
    const { id } = splitIdAndExt(slug)
    const record = db.getById(id)

    if (!record) {
      return c.text('Not Found\n', 404)
    }

    let formData: FormData
    try {
      formData = await c.req.raw.formData()
    } catch {
      return c.text('Invalid form data\n', 400)
    }

    const formToken = formData.get('token')
    const token =
      (typeof formToken === 'string' ? formToken.trim() : '') ||
      extractTokenFromHeaders(c.req.header('x-token'), c.req.header('authorization'))

    if (!verifyToken(token, record.mgmt_token_hash)) {
      return c.text('Forbidden\n', 403)
    }

    const deleteEntry = formData.get('delete')
    if (isTruthyFormFlag(deleteEntry)) {
      try {
        await deleteRecordAndCleanupTelegram(db, storage, record)
      } catch (err) {
        console.error(`[delete] Failed to delete Telegram message for ${record.id}:`, err)
        return c.text('Failed to delete file from storage\n', 502)
      }
      return c.text('deleted\n', 200)
    }

    return c.text('Specify "delete"\n', 400)
  })

  app.delete('/:slug', async (c) => {
    const slug = c.req.param('slug')
    const { id } = splitIdAndExt(slug)
    const record = db.getById(id)

    if (!record) {
      return c.text('Not Found\n', 404)
    }

    const token = extractTokenFromHeaders(c.req.header('x-token'), c.req.header('authorization'))
    if (!verifyToken(token, record.mgmt_token_hash)) {
      return c.text('Forbidden\n', 403)
    }

    try {
      await deleteRecordAndCleanupTelegram(db, storage, record)
    } catch (err) {
      console.error(`[delete] Failed to delete Telegram message for ${record.id}:`, err)
      return c.text('Failed to delete file from storage\n', 502)
    }
    return c.text('deleted\n', 200)
  })

  return app
}
