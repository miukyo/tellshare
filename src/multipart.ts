export class MultipartBadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MultipartBadRequestError'
  }
}

export class MultipartPayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MultipartPayloadTooLargeError'
  }
}

export class MultipartTruncatedError extends Error {
  public readonly bytesReceived: number

  constructor(message: string, bytesReceived: number) {
    super(message)
    this.name = 'MultipartTruncatedError'
    this.bytesReceived = bytesReceived
  }
}

export class MultipartAbortedError extends Error {
  constructor(message = 'Upload aborted by client') {
    super(message)
    this.name = 'MultipartAbortedError'
  }
}

export interface MultipartFileInfo {
  filename: string
  mimeType: string
}

export interface ParseMultipartOptions {
  body: ReadableStream<Uint8Array>
  boundary: string
  maxFileSize: number
  signal?: AbortSignal
  onFileStart?: (info: MultipartFileInfo) => Promise<void> | void
  onFileChunk: (chunk: Uint8Array) => Promise<void> | void
  onFileEnd?: () => Promise<void> | void
}

export interface ParseMultipartResult {
  file?: MultipartFileInfo & { size: number }
  url?: string
  bytesReceived: number
}

const MAX_PREAMBLE_BYTES = 16 * 1024
const MAX_PART_HEADER_BYTES = 16 * 1024
const MAX_URL_FIELD_BYTES = 16 * 1024
const EMPTY_BUF = Buffer.alloc(0)
const CRLF = Buffer.from('\r\n')
const HEADER_END = Buffer.from('\r\n\r\n')

export function extractMultipartBoundary(contentType: string | undefined): string | null {
  if (!contentType) return null
  const segments = contentType.split(';')
  const mediaType = segments[0]?.trim().toLowerCase()
  if (mediaType !== 'multipart/form-data') return null

  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i]!.trim()
    const eqIdx = segment.indexOf('=')
    if (eqIdx === -1) continue
    const key = segment.slice(0, eqIdx).trim().toLowerCase()
    if (key !== 'boundary') continue
    let val = segment.slice(eqIdx + 1).trim()
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1)
    }
    if (!val || val.length > 256 || /[\r\n]/.test(val)) return null
    return val
  }

  return null
}

function parseContentDisposition(headerValue: string): {
  name?: string
  filename?: string
  hasFilename: boolean
} {
  const result: { name?: string; filename?: string; hasFilename: boolean } = {
    hasFilename: false,
  }
  let plainFilename: string | undefined
  let extFilename: string | undefined

  const parts = headerValue.split(';')
  const dispType = parts[0]?.trim().toLowerCase()
  if (dispType !== 'form-data') {
    return result
  }

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]!.trim()
    const eqIdx = part.indexOf('=')
    if (eqIdx === -1) continue

    const rawKey = part.slice(0, eqIdx).trim().toLowerCase()
    let rawVal = part.slice(eqIdx + 1).trim()
    if (rawVal.startsWith('"') && rawVal.endsWith('"') && rawVal.length >= 2) {
      rawVal = rawVal.slice(1, -1).replace(/\\(.)/g, '$1')
    }

    if (rawKey === 'name') {
      result.name = rawVal
    } else if (rawKey === 'filename') {
      result.hasFilename = true
      plainFilename = rawVal
    } else if (rawKey === 'filename*') {
      result.hasFilename = true
      const match = /^([^']*)'[^']*'(.*)$/.exec(rawVal)
      const encoded = match ? match[2]! : rawVal
      try {
        extFilename = decodeURIComponent(encoded)
      } catch {
        extFilename = encoded
      }
    }
  }

  result.filename = extFilename ?? plainFilename
  return result
}

function parsePartHeaders(headerText: string): {
  name?: string
  filename?: string
  hasFilename: boolean
  mimeType: string
} {
  let name: string | undefined
  let filename: string | undefined
  let hasFilename = false
  let mimeType = 'application/octet-stream'

  for (const line of headerText.split('\r\n')) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (key === 'content-disposition') {
      const parsed = parseContentDisposition(value)
      name = parsed.name
      filename = parsed.filename
      hasFilename = parsed.hasFilename
    } else if (key === 'content-type' && value) {
      mimeType = value
    }
  }

  return { name, filename, hasFilename, mimeType }
}

function toBuffer(chunk: Uint8Array): Buffer {
  return Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
}

export async function parseMultipartStream(
  opts: ParseMultipartOptions
): Promise<ParseMultipartResult> {
  const { body, boundary, maxFileSize, signal, onFileStart, onFileChunk, onFileEnd } = opts
  const needle = Buffer.from(`\r\n--${boundary}`, 'utf8')
  const needleLen = needle.length
  const tailKeep = needleLen - 1

  type State = 'PREAMBLE' | 'AFTER_BOUNDARY' | 'HEADERS' | 'PART_BODY' | 'DONE'
  type ActivePart = 'file' | 'url' | 'skip' | null

  let state: State = 'PREAMBLE'
  let carry: Buffer = CRLF
  let smallBuf: Buffer = EMPTY_BUF
  let activePart: ActivePart = null

  let sawFile = false
  let fileInfo: MultipartFileInfo | undefined
  let fileSize = 0
  let urlValue = ''
  let urlChunks: Buffer[] = []
  let urlBytes = 0
  let bytesReceived = 0

  const reader = body.getReader()
  let aborted = Boolean(signal?.aborted)
  const onAbort = () => {
    aborted = true
    reader.cancel().catch(() => {})
  }
  if (!aborted) {
    signal?.addEventListener('abort', onAbort, { once: true })
  } else {
    await reader.cancel().catch(() => {})
    throw new MultipartAbortedError()
  }

  const emitPartData = async (slice: Buffer): Promise<void> => {
    if (slice.length === 0 || activePart === 'skip' || activePart === null) return

    if (activePart === 'file') {
      fileSize += slice.length
      if (fileSize > maxFileSize) {
        throw new MultipartPayloadTooLargeError(`File exceeds max size of ${maxFileSize} bytes`)
      }
      await onFileChunk(slice)
      return
    }

    if (activePart === 'url') {
      urlBytes += slice.length
      if (urlBytes > MAX_URL_FIELD_BYTES) {
        throw new MultipartBadRequestError('URL field exceeds maximum size')
      }
      urlChunks.push(Buffer.from(slice))
    }
  }

  const finishActivePart = async (): Promise<void> => {
    const endedPart = activePart
    activePart = null
    if (endedPart === 'file') {
      await onFileEnd?.()
    } else if (endedPart === 'url') {
      const trimmed = Buffer.concat(urlChunks).toString('utf8').trim()
      urlChunks = []
      urlBytes = 0
      if (trimmed) {
        if (sawFile || urlValue) {
          throw new MultipartBadRequestError('Provide exactly one of "file" or "url"')
        }
        urlValue = trimmed
      }
    }
  }

  const processChunk = async (rawChunk: Buffer): Promise<void> => {
    let chunk = rawChunk
    let pos = 0

    while (pos < chunk.length || state === 'PART_BODY') {
      if (state === 'DONE') {
        return
      }

      if (state === 'PREAMBLE') {
        const combined =
          carry.length > 0 ? Buffer.concat([carry, chunk.subarray(pos)]) : chunk.subarray(pos)
        const idx = combined.indexOf(needle)
        if (idx === -1) {
          if (combined.length > MAX_PREAMBLE_BYTES) {
            throw new MultipartBadRequestError('Multipart boundary not found')
          }
          carry = combined
          return
        }
        carry = EMPTY_BUF
        chunk = combined.subarray(idx + needleLen)
        pos = 0
        state = 'AFTER_BOUNDARY'
        if (chunk.length === 0) return
        continue
      }

      if (state === 'AFTER_BOUNDARY') {
        const slice =
          smallBuf.length > 0
            ? Buffer.concat([smallBuf, chunk.subarray(pos)])
            : chunk.subarray(pos)
        smallBuf = EMPTY_BUF

        // Consume optional transport padding (LWSP) before CRLF
        let scan = 0
        if (slice.length >= 2 && slice[0] === 0x2d && slice[1] === 0x2d) {
          state = 'DONE'
          return
        }
        if (slice.length === 1 && slice[0] === 0x2d) {
          smallBuf = Buffer.from(slice)
          return
        }

        while (scan < slice.length && (slice[scan] === 0x20 || slice[scan] === 0x09)) {
          scan++
        }
        if (scan > 64) {
          throw new MultipartBadRequestError('Invalid multipart boundary termination')
        }
        if (scan === slice.length) {
          smallBuf = Buffer.from(slice)
          return
        }
        if (slice[scan] === 0x0d) {
          if (scan + 1 >= slice.length) {
            smallBuf = Buffer.from(slice.subarray(scan))
            return
          }
          if (slice[scan + 1] !== 0x0a) {
            throw new MultipartBadRequestError('Invalid multipart boundary line ending')
          }
          chunk = slice.subarray(scan + 2)
          pos = 0
          smallBuf = EMPTY_BUF
          state = 'HEADERS'
          if (chunk.length === 0) return
          continue
        }
        throw new MultipartBadRequestError('Invalid multipart boundary termination')
      }

      if (state === 'HEADERS') {
        const combined =
          smallBuf.length > 0
            ? Buffer.concat([smallBuf, chunk.subarray(pos)])
            : chunk.subarray(pos)
        const hdrEnd = combined.indexOf(HEADER_END)
        if (hdrEnd === -1) {
          if (combined.length > MAX_PART_HEADER_BYTES) {
            throw new MultipartBadRequestError('Multipart part headers exceed maximum size')
          }
          smallBuf = combined
          return
        }

        const headerText = combined.subarray(0, hdrEnd).toString('utf8')
        smallBuf = EMPTY_BUF
        carry = EMPTY_BUF

        const parsed = parsePartHeaders(headerText)
        if (!parsed.name) {
          activePart = 'skip'
        } else if (parsed.name === 'file' && parsed.hasFilename) {
          if (sawFile || urlValue) {
            throw new MultipartBadRequestError('Provide exactly one of "file" or "url"')
          }
          sawFile = true
          activePart = 'file'
          fileInfo = {
            filename: parsed.filename || 'file',
            mimeType: parsed.mimeType,
          }
          await onFileStart?.(fileInfo)
        } else if (parsed.name === 'url' && !parsed.hasFilename) {
          if (sawFile || urlValue) {
            throw new MultipartBadRequestError('Provide exactly one of "file" or "url"')
          }
          activePart = 'url'
          urlChunks = []
          urlBytes = 0
        } else {
          activePart = 'skip'
        }

        chunk = combined.subarray(hdrEnd + 4)
        pos = 0
        state = 'PART_BODY'
        if (chunk.length === 0) return
        continue
      }

      if (state === 'PART_BODY') {
        if (pos >= chunk.length) return

        // Handle any carry bytes that could complete a boundary across the chunk seam.
        if (carry.length > 0) {
          const take = Math.min(chunk.length - pos, tailKeep)
          const seam = Buffer.concat([carry, chunk.subarray(pos, pos + take)])
          const seamIdx = seam.indexOf(needle)
          if (seamIdx !== -1) {
            if (seamIdx > 0) {
              await emitPartData(seam.subarray(0, seamIdx))
            }
            const consumedFromChunk = seamIdx + needleLen - carry.length
            carry = EMPTY_BUF
            pos += consumedFromChunk
            await finishActivePart()
            state = 'AFTER_BOUNDARY'
            continue
          }

          const remChunk = chunk.length - pos
          if (carry.length + remChunk < needleLen) {
            carry = seam
            return
          }

          if (remChunk < tailKeep) {
            const safe = seam.length - tailKeep
            await emitPartData(seam.subarray(0, safe))
            carry = Buffer.from(seam.subarray(safe))
            return
          }

          await emitPartData(carry)
          carry = EMPTY_BUF
        }

        // Fast path: scan remaining chunk bytes in-place without copying.
        const idx = chunk.indexOf(needle, pos)
        if (idx !== -1) {
          if (idx > pos) {
            await emitPartData(chunk.subarray(pos, idx))
          }
          pos = idx + needleLen
          await finishActivePart()
          state = 'AFTER_BOUNDARY'
          continue
        }

        const remLen = chunk.length - pos
        if (remLen >= needleLen) {
          const safeEnd = chunk.length - tailKeep
          await emitPartData(chunk.subarray(pos, safeEnd))
          carry = Buffer.from(chunk.subarray(safeEnd))
        } else {
          carry = Buffer.from(chunk.subarray(pos))
        }
        return
      }
    }
  }

  try {
    while (true) {
      if (aborted) {
        throw new MultipartAbortedError()
      }
      const { done, value } = await reader.read()
      if (aborted) {
        throw new MultipartAbortedError()
      }
      if (done) break
      if (!value || value.byteLength === 0) continue
      bytesReceived += value.byteLength
      await processChunk(toBuffer(value))
    }

    if ((state as State) !== 'DONE') {
      throw new MultipartTruncatedError(
        'Upload interrupted or truncated before completion',
        bytesReceived
      )
    }

    return {
      file: fileInfo ? { ...fileInfo, size: fileSize } : undefined,
      url: urlValue || undefined,
      bytesReceived,
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    await reader.cancel().catch(() => {})
  }
}
