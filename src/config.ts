import { parseEncryptionKey } from './crypto'

export interface AppConfig {
  port: number
  host: string
  baseUrl?: string
  apiId: number
  apiHash: string
  botToken?: string
  storageChatId?: string | number
  storageChannelName: string
  dataDir: string
  maxFileSize: number
  partSize: number
  allowUrlUpload: boolean
  encryptionKey?: Buffer
}

function parseIntEnv(value: string | undefined, fallback: number, name: string): number {
  if (!value || value.trim() === '') return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid integer value for ${name}: ${value}`)
  }
  return parsed
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value || value.trim() === '') return fallback
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false
  return fallback
}

export function parseStorageChatId(raw: string | undefined): string | number | undefined {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return undefined
  if (/^-?\d+$/.test(trimmed)) {
    const num = Number(trimmed)
    if (Number.isSafeInteger(num)) return num
  }
  return trimmed
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const port = parseIntEnv(env.PORT, 3000, 'PORT')
  const host = (env.HOST ?? '0.0.0.0').trim() || '0.0.0.0'
  const rawBaseUrl = (env.BASE_URL ?? '').trim().replace(/\/+$/, '')
  const baseUrl = rawBaseUrl || undefined

  const apiIdRaw = (env.API_ID ?? '').trim()
  const apiId = apiIdRaw ? Number.parseInt(apiIdRaw, 10) : 0
  const apiHash = (env.API_HASH ?? '').trim()
  const botToken = (env.BOT_TOKEN ?? '').trim() || undefined

  const storageChatId = parseStorageChatId(env.STORAGE_CHAT_ID)
  const storageChannelName = (env.STORAGE_CHANNEL_NAME ?? 'tellshare files').trim() || 'tellshare files'
  const dataDir = (env.DATA_DIR ?? './data').trim() || './data'

  const maxFileSize = parseIntEnv(env.MAX_FILE_SIZE, 0, 'MAX_FILE_SIZE')
  const partSize = parseIntEnv(env.PART_SIZE, 512 * 1024 * 1024, 'PART_SIZE')
  if (partSize <= 0 || partSize > 1_900 * 1024 * 1024) {
    throw new Error('PART_SIZE must be between 1 byte and 1900 MiB (1992294400 bytes)')
  }
  const allowUrlUpload = parseBooleanEnv(env.ALLOW_URL_UPLOAD, true)
  const rawEncKey = (env.ENCRYPTION_KEY ?? '').trim()
  const encryptionKey = rawEncKey ? parseEncryptionKey(rawEncKey) : undefined

  return {
    port,
    host,
    baseUrl,
    apiId,
    apiHash,
    botToken,
    storageChatId,
    storageChannelName,
    dataDir,
    maxFileSize,
    partSize,
    allowUrlUpload,
    encryptionKey,
  }
}

export function assertEncryptionConfig(config: AppConfig): Buffer {
  if (!config.encryptionKey || config.encryptionKey.length !== 32) {
    throw new Error(
      'ENCRYPTION_KEY is required. Generate one with: bun -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    )
  }
  return config.encryptionKey
}

export function assertTelegramConfig(config: AppConfig): void {
  if (!config.apiId || !Number.isFinite(config.apiId)) {
    throw new Error('API_ID is required. Get one at https://my.telegram.org')
  }
  if (!config.apiHash) {
    throw new Error('API_HASH is required. Get one at https://my.telegram.org')
  }
  if (config.botToken && !config.storageChatId) {
    throw new Error(
      'Bots cannot auto-create channels. Set STORAGE_CHAT_ID (e.g. -1001234567890) where the bot is an admin, or omit BOT_TOKEN to use a user account.'
    )
  }
  if (config.botToken && (config.storageChatId === 'me' || config.storageChatId === 'self')) {
    throw new Error(
      'STORAGE_CHAT_ID cannot be "me" when using BOT_TOKEN. Provide a channel/group ID (e.g. -1001234567890) where the bot is an admin.'
    )
  }
}
