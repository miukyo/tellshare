import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { createApp } from './app'
import { loadConfig } from './config'
import { FileDatabase } from './db'
import { TelegramStorage } from './telegram'

async function main(): Promise<void> {
  const config = loadConfig()
  mkdirSync(config.dataDir, { recursive: true })

  const db = new FileDatabase(path.join(config.dataDir, 'tellshare.db'))
  const storage = new TelegramStorage(config)

  console.log('[tellshare] Connecting to Telegram MTProto...')
  await storage.start()
  console.log(
    `[tellshare] Telegram connected. Storage target: ${String(storage.getStorageChatId())}`
  )

  const app = createApp({ db, storage, config })

  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    fetch: app.fetch,
    maxRequestBodySize: config.maxFileSize + 10 * 1024 * 1024,
    idleTimeout: 255,
  })

  console.log(
    `[tellshare] Listening on http://${server.hostname}:${server.port} (base URL: ${config.baseUrl ?? 'auto-detect from request'})`
  )

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\n[tellshare] Received ${signal}, shutting down...`)
    server.stop(true)
    await storage.stop().catch((err) => console.error('[tellshare] Error closing Telegram:', err))
    db.close()
    process.exit(0)
  }

  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
}

main().catch((err) => {
  console.error('[tellshare] Fatal startup error:', err)
  process.exit(1)
})
