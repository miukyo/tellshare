import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context, Hono } from 'hono'
import { AppConfig } from './config'
import { FileDatabase, FileRecord } from './db'
import { StorageBackend, TelegramObjectNotFoundError } from './telegram'
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
import { renderMediaEmbedHtml, renderPlainHelp, renderWebUi } from './views'

export interface CreateAppDeps {
  db: FileDatabase
  storage: StorageBackend
  config: AppConfig
}

class PayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PayloadTooLargeError'
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

async function spoolStreamToTempFile(
  stream: ReadableStream<Uint8Array>,
  maxFileSize: number
): Promise<{ tempPath: string; size: number; sha256: string }> {
  const tempPath = path.join(os.tmpdir(), `tellshare-${randomUUID()}`)
  const hasher = createHash('sha256')
  const writeStream = createWriteStream(tempPath, { flags: 'wx' })
  const reader = stream.getReader()
  let totalSize = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalSize += value.byteLength
      if (totalSize > maxFileSize) {
        throw new PayloadTooLargeError(`File exceeds max size of ${maxFileSize} bytes`)
      }
      hasher.update(value)
      if (!writeStream.write(value)) {
        await new Promise<void>((resolve, reject) => {
          const onDrain = () => {
            writeStream.off('error', onError)
            resolve()
          }
          const onError = (err: Error) => {
            writeStream.off('drain', onDrain)
            reject(err)
          }
          writeStream.once('drain', onDrain)
          writeStream.once('error', onError)
        })
      }
    }

    await new Promise<void>((resolve, reject) => {
      const onFinish = () => {
        writeStream.off('error', onError)
        resolve()
      }
      const onError = (err: Error) => {
        writeStream.off('finish', onFinish)
        reject(err)
      }
      writeStream.once('finish', onFinish)
      writeStream.once('error', onError)
      writeStream.end()
    })

    return {
      tempPath,
      size: totalSize,
      sha256: hasher.digest('hex'),
    }
  } catch (err) {
    reader.cancel().catch(() => {})
    writeStream.destroy()
    await unlink(tempPath).catch(() => {})
    throw err
  }
}

async function fetchRemoteUrlToTempFile(
  rawUrl: string,
  maxFileSize: number
): Promise<{
  tempPath: string
  size: number
  sha256: string
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
        throw new Error('Upstream redirect missing Location header')
      }
      if (i === maxRedirects) {
        throw new Error('Too many redirects while fetching URL')
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
    throw new Error(`Upstream URL returned HTTP ${status}`)
  }

  const contentLengthHeader = response.headers.get('content-length')
  if (contentLengthHeader) {
    const declaredSize = Number.parseInt(contentLengthHeader, 10)
    if (Number.isFinite(declaredSize) && declaredSize > maxFileSize) {
      await response.body.cancel().catch(() => {})
      throw new PayloadTooLargeError(`Remote file exceeds max size of ${maxFileSize} bytes`)
    }
  }

  const spooled = await spoolStreamToTempFile(response.body, maxFileSize)
  const filename = extractFilenameFromHeaders(
    response.headers.get('content-disposition'),
    currentUrl
  )
  const rawMime = response.headers.get('content-type')?.split(';')[0]?.trim()
  const mimeType = rawMime || 'application/octet-stream'

  return {
    ...spooled,
    filename,
    mimeType,
  }
}

async function deleteRecordAndCleanupTelegram(
  db: FileDatabase,
  storage: StorageBackend,
  record: FileRecord
): Promise<void> {
  const refCount = db.countByTelegramMessage(record.tg_chat_id, record.tg_message_id)
  if (refCount <= 1) {
    await storage.deleteFile({
      chatId: record.tg_chat_id,
      messageId: record.tg_message_id,
    })
  }
  db.deleteById(record.id)
}

export function createApp({ db, storage, config }: CreateAppDeps): Hono {
  const app = new Hono()

  app.get('/health', (c) => {
    return c.json({
      ok: true,
      telegram: storage.isConnected(),
      uptime: process.uptime(),
    })
  })

  app.get('/', (c) => {
    const stats = db.getStats()
    const baseUrl = resolveBaseUrl(c, config)
    if (prefersHtml(c.req.header('accept'), c.req.header('user-agent'))) {
      return c.html(renderWebUi(config, stats, baseUrl))
    }
    return c.text(renderPlainHelp(config, stats, baseUrl), 200, {
      'Content-Type': 'text/plain; charset=utf-8',
    })
  })

  app.post('/', async (c) => {
    let formData: FormData
    try {
      formData = await c.req.raw.formData()
    } catch {
      return c.text('Invalid multipart/form-data request\n', 400)
    }

    const fileEntry = formData.get('file')
    const urlEntry = formData.get('url')

    const hasFile = fileEntry instanceof File
    const hasUrl = typeof urlEntry === 'string' && urlEntry.trim().length > 0

    if ((hasFile && hasUrl) || (!hasFile && !hasUrl)) {
      return c.text('Provide exactly one of "file" or "url"\n', 400)
    }

    if (hasUrl && !config.allowUrlUpload) {
      return c.text('Remote URL uploads are disabled\n', 403)
    }

    const nowMs = Date.now()

    let tempPath: string | null = null
    let filename = 'file'
    let mimeType = 'application/octet-stream'
    let size = 0
    let sha256 = ''

    try {
      if (hasFile) {
        const uploaded = fileEntry as File
        if (uploaded.size > config.maxFileSize) {
          return c.text(`File exceeds max size of ${config.maxFileSize} bytes\n`, 413)
        }
        const spooled = await spoolStreamToTempFile(uploaded.stream(), config.maxFileSize)
        tempPath = spooled.tempPath
        size = spooled.size
        sha256 = spooled.sha256
        filename = sanitizeFilename(uploaded.name || 'file')
        mimeType = inferMimeType(filename, uploaded.type)
      } else {
        const remote = await fetchRemoteUrlToTempFile(urlEntry as string, config.maxFileSize)
        tempPath = remote.tempPath
        size = remote.size
        sha256 = remote.sha256
        filename = remote.filename
        mimeType = inferMimeType(filename, remote.mimeType)
      }

      if (size === 0) {
        return c.text('Empty files cannot be uploaded\n', 400)
      }

      let id = generateId()
      for (let attempt = 0; attempt < 10 && db.getById(id) !== null; attempt++) {
        id = generateId()
      }
      if (db.getById(id) !== null) {
        return c.text('Failed to allocate unique file ID\n', 500)
      }

      const ext = sanitizeExtension(filename)
      const mgmtToken = generateManagementToken()
      const mgmtTokenHash = hashToken(mgmtToken)

      // Reuse existing Telegram message when identical content is already stored.
      const existing = db.findExistingBySha256(sha256)
      let tgChatId: string
      let tgMessageId: number
      let tgFileId: string | null

      if (existing) {
        tgChatId = existing.tg_chat_id
        tgMessageId = existing.tg_message_id
        tgFileId = existing.tg_file_id
      } else {
        const tgObj = await storage.uploadFile({
          filePath: tempPath,
          filename,
          mimeType,
          size,
          caption: `${id}${ext ? `.${ext}` : ''} | ${filename}`,
        })
        tgChatId = tgObj.chatId
        tgMessageId = tgObj.messageId
        tgFileId = tgObj.fileId
      }

      db.insert({
        id,
        ext,
        filename,
        mime_type: mimeType,
        size,
        sha256,
        tg_chat_id: tgChatId,
        tg_message_id: tgMessageId,
        tg_file_id: tgFileId,
        mgmt_token_hash: mgmtTokenHash,
        created_at: nowMs,
      })

      const baseUrl = resolveBaseUrl(c, config)
      const fileUrl = `${baseUrl}/${id}${ext ? `.${ext}` : ''}`
      c.header('X-Token', mgmtToken)

      if (wantsJson(c.req.header('accept'))) {
        return c.json({
          url: fileUrl,
          id,
          filename,
          size,
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
        err instanceof Error &&
        (err.message.includes('URL') ||
          err.message.includes('Private or loopback') ||
          err.message.includes('Upstream') ||
          err.message.includes('redirects'))
      ) {
        return c.text(`${err.message}\n`, 400)
      }
      console.error('[upload] Error handling upload:', err)
      return c.text('Upload failed\n', 500)
    } finally {
      if (tempPath) {
        await unlink(tempPath).catch(() => {})
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
      const stream = await storage.downloadStream({
        chatId: record.tg_chat_id,
        messageId: record.tg_message_id,
        fileId: record.tg_file_id,
        offset,
        limit: length,
        signal: c.req.raw.signal,
        onRefreshedFileId: (newFileId) => {
          db.updateTgFileId(record.tg_chat_id, record.tg_message_id, newFileId)
        },
      })

      db.incrementDownloads(record.id)
      return new Response(stream, { status, headers })
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
