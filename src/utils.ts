import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import path from 'node:path'

const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

const EXTENSION_MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  mkv: 'video/x-matroska',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  opus: 'audio/opus',
  pdf: 'application/pdf',
  txt: 'text/plain',
  json: 'application/json',
  zip: 'application/zip',
}

const EMBED_CRAWLER_RE =
  /Discordbot|TelegramBot|Twitterbot|Slackbot|WhatsApp|facebookexternalhit|LinkedInBot|vkShare|Embedly|Iframely|MetaInspector|Pinterest/i

const UNSAFE_INLINE_MIMES = new Set([
  'text/html',
  'image/svg+xml',
  'application/xhtml+xml',
  'text/xml',
  'application/xml',
  'application/javascript',
  'text/javascript',
])

export function generateId(length: number = 32): string {
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) {
    out += BASE62[bytes[i] % BASE62.length]
  }
  return out
}

export function generateManagementToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function verifyToken(token: string, expectedHash: string): boolean {
  if (!token || !expectedHash) return false
  const actualHex = hashToken(token)
  const actualBuf = Buffer.from(actualHex, 'hex')
  const expectedBuf = Buffer.from(expectedHash, 'hex')
  if (actualBuf.length !== expectedBuf.length) return false
  return timingSafeEqual(actualBuf, expectedBuf)
}

export function parseRangeHeader(
  rangeHeader: string,
  totalSize: number
): { start: number; end: number } | 'invalid' | null {
  const trimmed = rangeHeader.trim()
  if (!trimmed) return null

  const match = /^bytes=([^,]+)$/i.exec(trimmed)
  if (!match) {
    // Multi-range or unsupported unit
    return trimmed.toLowerCase().startsWith('bytes=') ? 'invalid' : null
  }

  const spec = match[1].trim()
  if (totalSize <= 0) return 'invalid'

  const dashIdx = spec.indexOf('-')
  if (dashIdx === -1) return 'invalid'

  const startStr = spec.slice(0, dashIdx).trim()
  const endStr = spec.slice(dashIdx + 1).trim()

  if (startStr === '' && endStr === '') return 'invalid'

  if (startStr === '') {
    // Suffix range: bytes=-N
    if (!/^\d+$/.test(endStr)) return 'invalid'
    const suffixLength = Number(endStr)
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'invalid'
    const start = Math.max(0, totalSize - suffixLength)
    return { start, end: totalSize - 1 }
  }

  if (!/^\d+$/.test(startStr)) return 'invalid'
  const start = Number(startStr)
  if (!Number.isSafeInteger(start) || start < 0 || start >= totalSize) return 'invalid'

  if (endStr === '') {
    return { start, end: totalSize - 1 }
  }

  if (!/^\d+$/.test(endStr)) return 'invalid'
  const rawEnd = Number(endStr)
  if (!Number.isSafeInteger(rawEnd) || rawEnd < start) return 'invalid'
  const end = Math.min(rawEnd, totalSize - 1)
  return { start, end }
}

export function sanitizeExtension(filename: string): string {
  const base = path.basename(filename.trim())
  const lastDot = base.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === base.length - 1) return ''

  const ext = base.slice(lastDot + 1).toLowerCase()
  if (/^[a-z0-9]{1,10}$/.test(ext)) {
    return ext
  }
  return ''
}

export function splitIdAndExt(param: string): { id: string; ext: string } {
  const dotIdx = param.indexOf('.')
  if (dotIdx === -1) {
    return { id: param, ext: '' }
  }
  return {
    id: param.slice(0, dotIdx),
    ext: param.slice(dotIdx + 1),
  }
}

export function sanitizeFilename(filename: string): string {
  const base = path.basename(filename.replace(/[\r\n\0]/g, '')).trim()
  return base || 'file'
}

export function isUnsafeInlineMime(mime: string): boolean {
  const base = mime.split(';')[0]?.trim().toLowerCase() ?? ''
  return UNSAFE_INLINE_MIMES.has(base)
}

export function inferMimeType(filename: string, providedMime?: string): string {
  const cleanProvided = providedMime?.split(';')[0]?.trim().toLowerCase()
  if (cleanProvided && cleanProvided !== 'application/octet-stream') {
    return cleanProvided
  }
  const ext = sanitizeExtension(filename)
  return (ext && EXTENSION_MIME_MAP[ext]) || 'application/octet-stream'
}

export function isEmbedCrawler(userAgent: string | undefined): boolean {
  if (!userAgent) return false
  return EMBED_CRAWLER_RE.test(userAgent)
}

export function isEmbeddableMediaMime(mime: string): 'image' | 'video' | 'audio' | null {
  const base = mime.split(';')[0]?.trim().toLowerCase() ?? ''
  if (base === 'image/svg+xml') return null
  if (base.startsWith('image/')) return 'image'
  if (base.startsWith('video/')) return 'video'
  if (base.startsWith('audio/')) return 'audio'
  return null
}

function isPrivateOrBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true
  }
  const [a, b] = parts
  if (a === 0) return true // 0.0.0.0/8 ("this network")
  if (a === 10) return true // 10.0.0.0/8 (RFC1918)
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12 (RFC1918)
  if (a === 192 && b === 0 && parts[2] === 0) return true // 192.0.0.0/24
  if (a === 192 && b === 168) return true // 192.168.0.0/16 (RFC1918)
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18.0.0/15 (benchmark)
  if (a >= 224) return true // Multicast / reserved
  return false
}

function isPrivateOrBlockedIP(ip: string): boolean {
  const clean = ip.split('%')[0].toLowerCase()
  const version = isIP(clean)
  if (version === 4) {
    return isPrivateOrBlockedIPv4(clean)
  }
  if (version === 6) {
    if (clean === '::' || clean === '::1') return true
    // IPv4-mapped IPv6 e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1
    if (clean.startsWith('::ffff:')) {
      const rest = clean.slice(7)
      if (isIP(rest) === 4) return isPrivateOrBlockedIPv4(rest)
      const hexParts = rest.split(':')
      if (hexParts.length === 2) {
        const hi = Number.parseInt(hexParts[0], 16)
        const lo = Number.parseInt(hexParts[1], 16)
        if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
          const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
          return isPrivateOrBlockedIPv4(ipv4)
        }
      }
      return true
    }
    // Unique local (fc00::/7 -> fc.. or fd..) & link-local (fe80::/10 -> fe8., fe9., fea., feb.)
    if (clean.startsWith('fc') || clean.startsWith('fd')) return true
    if (/^fe[89ab]/.test(clean)) return true
    // Multicast ff00::/8
    if (clean.startsWith('ff')) return true
    return false
  }
  return true
}

export async function validateRemoteUrl(rawUrl: string): Promise<URL> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    throw new Error('Invalid URL')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http:// and https:// URLs are allowed')
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
  if (!hostname) {
    throw new Error('URL hostname is required')
  }

  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('Private or loopback hostnames are not allowed')
  }

  if (isIP(hostname) !== 0) {
    if (isPrivateOrBlockedIP(hostname)) {
      throw new Error('Private or loopback IP addresses are not allowed')
    }
    return parsed
  }

  let addresses: { address: string; family: number }[]
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true })
  } catch {
    throw new Error('Failed to resolve URL hostname')
  }

  if (!addresses.length) {
    throw new Error('Failed to resolve URL hostname')
  }

  for (const entry of addresses) {
    if (isPrivateOrBlockedIP(entry.address)) {
      throw new Error('URL resolves to a private or blocked IP address')
    }
  }

  return parsed
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unitIdx = -1
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024
    unitIdx++
  }
  return `${value.toFixed(value >= 10 || unitIdx === 0 ? 1 : 2)} ${units[unitIdx]}`
}
