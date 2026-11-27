import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { TelegramClient } from '@mtcute/bun'
import { loadConfig } from './config'
import { ensureStorageChannel } from './telegram'

async function main(): Promise<void> {
  const config = loadConfig()
  if (!config.apiId || !config.apiHash) {
    throw new Error('API_ID and API_HASH must be set in .env or environment variables.')
  }

  mkdirSync(config.dataDir, { recursive: true })
  const sessionPath = path.join(config.dataDir, 'telegram.session')

  const client = new TelegramClient({
    apiId: config.apiId,
    apiHash: config.apiHash,
    storage: sessionPath,
  })

  console.log(`[tellshare] Starting interactive Telegram login (session: ${sessionPath})`)
  const me = await client.start()
  console.log(
    `[tellshare] Logged in as ${me.displayName} (ID: ${me.id}, username: ${me.username ?? 'none'})`
  )

  if (config.storageChatId !== undefined) {
    try {
      await client.resolvePeer(config.storageChatId)
      console.log(`[tellshare] Verified storage target: ${String(config.storageChatId)}`)
    } catch (err) {
      console.warn(
        `[tellshare] Warning: could not resolve STORAGE_CHAT_ID (${String(config.storageChatId)}):`,
        err instanceof Error ? err.message : err
      )
    }
  } else {
    try {
      const channel = await ensureStorageChannel(client, config.storageChannelName)
      console.log(
        `[tellshare] ${channel.created ? 'Created' : 'Found'} storage channel "${channel.title}" (ID: ${channel.id})`
      )
    } catch (err) {
      console.warn(
        `[tellshare] Warning: could not ensure storage channel "${config.storageChannelName}":`,
        err instanceof Error ? err.message : err
      )
    }
  }

  await client.destroy()
  console.log('[tellshare] Session saved. You can now start the server with `bun run start`.')
}

main().catch((err) => {
  console.error('[tellshare] Login failed:', err)
  process.exit(1)
})
