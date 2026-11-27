import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { tl } from '@mtcute/bun'
import { createApp } from '../src/app'
import { AppConfig } from '../src/config'
import { FileDatabase } from '../src/db'
import {
  ChannelSetupClient,
  DownloadStreamOptions,
  StorageBackend,
  StorageChannelPeer,
  TelegramObjectNotFoundError,
  UploadFileOptions,
  UploadedObject,
  ensureStorageChannel,
  isRetryableUploadError,
  normalizeBareChannelId,
} from '../src/telegram'

class MockStorage implements StorageBackend {
  connected = true
  nextMessageId = 1
  uploadCount = 0
  deleteCount = 0
  readonly objects = new Map<string, Uint8Array>()

  private key(chatId: string, messageId: number): string {
    return `${chatId}:${messageId}`
  }

  isConnected(): boolean {
    return this.connected
  }

  async uploadFile(opts: UploadFileOptions): Promise<UploadedObject> {
    this.uploadCount++
    const chatId = '-1001234567890'
    const messageId = this.nextMessageId++
    const bytes = new Uint8Array(await Bun.file(opts.filePath).arrayBuffer())
    this.objects.set(this.key(chatId, messageId), bytes)
    return {
      chatId,
      messageId,
      fileId: `mock-file-${messageId}`,
    }
  }

  async downloadStream(opts: DownloadStreamOptions): Promise<ReadableStream<Uint8Array>> {
    const data = this.objects.get(this.key(opts.chatId, opts.messageId))
    if (!data) {
      throw new TelegramObjectNotFoundError()
    }
    const start = opts.offset ?? 0
    const end = opts.limit !== undefined ? Math.min(data.byteLength, start + opts.limit) : data.byteLength
    const slice = data.subarray(start, end)

    return new ReadableStream<Uint8Array>({
      start(controller) {
        if (slice.byteLength > 0) {
          const mid = Math.floor(slice.byteLength / 2)
          if (mid > 0) {
            controller.enqueue(slice.subarray(0, mid))
            controller.enqueue(slice.subarray(mid))
          } else {
            controller.enqueue(slice)
          }
        }
        controller.close()
      },
    })
  }

  async deleteFile(opts: { chatId: string; messageId: number }): Promise<void> {
    this.deleteCount++
    this.objects.delete(this.key(opts.chatId, opts.messageId))
  }
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 3000,
    host: '127.0.0.1',
    baseUrl: 'http://localhost:3000',
    apiId: 12345,
    apiHash: 'test-hash',
    storageChatId: -1001234567890,
    storageChannelName: 'tellshare files',
    dataDir: './data',
    maxFileSize: 1024,
    allowUrlUpload: true,
    ...overrides,
  }
}

async function uploadSample(
  app: ReturnType<typeof createApp>,
  content: Uint8Array | string,
  filename: string,
  mimeType: string,
  extraFields: Record<string, string> = {},
  headers: Record<string, string> = {}
) {
  const form = new FormData()
  const blob =
    typeof content === 'string'
      ? new File([content], filename, { type: mimeType })
      : new File([new Uint8Array(content)], filename, { type: mimeType })
  form.append('file', blob)
  for (const [k, v] of Object.entries(extraFields)) {
    form.append(k, v)
  }
  return app.request('http://localhost:3000/', {
    method: 'POST',
    headers,
    body: form,
  })
}

describe('TellShare Hono app', () => {
  let db: FileDatabase
  let storage: MockStorage
  let config: AppConfig
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    db = new FileDatabase(':memory:')
    storage = new MockStorage()
    config = makeConfig()
    app = createApp({ db, storage, config })
  })

  afterEach(() => {
    db.close()
  })

  it('serves plain-text help to CLI clients and HTML UI to browsers with unlimited retention', async () => {
    const cliRes = await app.request('http://localhost:3000/', {
      headers: { 'User-Agent': 'curl/8.5.0', Accept: '*/*' },
    })
    expect(cliRes.status).toBe(200)
    expect(cliRes.headers.get('content-type')).toContain('text/plain')
    const cliBody = await cliRes.text()
    expect(cliBody).toContain('TELLSHARE')
    expect(cliBody).toContain('Retention:       unlimited')

    const browserRes = await app.request('http://localhost:3000/', {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'text/html,application/xhtml+xml',
      },
    })
    expect(browserRes.status).toBe(200)
    expect(browserRes.headers.get('content-type')).toContain('text/html')
    const html = await browserRes.text()
    expect(html).toContain('<title>TellShare')
    expect(html).not.toContain('<style')
    expect(html).not.toContain('style=')
    expect(html).not.toContain('secretInput')
    expect(html).toContain('<pre>')
    expect(html).toContain('<input')
    expect(html).toContain('<button')
    expect(html).toContain('<progress')
    expect(html).toContain('Retention: unlimited')
    expect(html).toContain('CURL &amp; HTTP API')

    // Ensure the emitted inline <script> has valid JavaScript syntax
    const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(html)
    expect(scriptMatch?.[1]).toBeTruthy()
    expect(() => new Function(scriptMatch![1])).not.toThrow()
  })

  it('reports health status', async () => {
    const res = await app.request('http://localhost:3000/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; telegram: boolean; uptime: number }
    expect(body.ok).toBe(true)
    expect(body.telegram).toBe(true)
    expect(typeof body.uptime).toBe('number')
  })

  it('uploads, returns X-Token, supports JSON, and deduplicates identical content', async () => {
    const payload = 'hello tellshare world!'
    const res1 = await uploadSample(app, payload, 'hello.txt', 'text/plain')
    expect(res1.status).toBe(200)
    const token1 = res1.headers.get('x-token')
    expect(token1).toBeTruthy()
    const url1 = (await res1.text()).trim()
    expect(url1).toMatch(/^http:\/\/localhost:3000\/[0-9A-Za-z]{32}\.txt$/)
    expect(storage.uploadCount).toBe(1)

    // Identical content with JSON response should reuse Telegram message
    const res2 = await uploadSample(
      app,
      payload,
      'copy.txt',
      'text/plain',
      {},
      { Accept: 'application/json' }
    )
    expect(res2.status).toBe(200)
    const json2 = (await res2.json()) as {
      url: string
      id: string
      filename: string
      size: number
      mimeType: string
      token: string
    }
    expect(json2.id).toHaveLength(32)
    expect(json2.url).toBe(`http://localhost:3000/${json2.id}.txt`)
    expect(json2.size).toBe(payload.length)
    expect(json2.mimeType).toBe('text/plain')
    expect(storage.uploadCount).toBe(1)

    // Deleting first reference keeps Telegram object alive because second reference still exists
    const del1 = await app.request(url1, {
      method: 'DELETE',
      headers: { 'X-Token': token1! },
    })
    expect(del1.status).toBe(200)
    expect(storage.deleteCount).toBe(0)
    expect(storage.objects.size).toBe(1)

    // Second reference still downloads cleanly
    const get2 = await app.request(json2.url)
    expect(get2.status).toBe(200)
    expect(await get2.text()).toBe(payload)

    // Deleting last reference removes Telegram object too
    const del2 = await app.request(json2.url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${json2.token}` },
    })
    expect(del2.status).toBe(200)
    expect(storage.deleteCount).toBe(1)
    expect(storage.objects.size).toBe(0)
  })

  it('rejects oversized uploads with 413 and SSRF URLs with 400', async () => {
    const bigBytes = new Uint8Array(config.maxFileSize + 1).fill(65)
    const bigRes = await uploadSample(app, bigBytes, 'too-big.bin', 'application/octet-stream')
    expect(bigRes.status).toBe(413)

    for (const badUrl of [
      'http://127.0.0.1/secret',
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost:3000/health',
      'file:///etc/passwd',
    ]) {
      const form = new FormData()
      form.append('url', badUrl)
      const res = await app.request('http://localhost:3000/', {
        method: 'POST',
        body: form,
      })
      expect(res.status).toBe(400)
    }
  })

  it('supports GET, HEAD, Byte-Range requests (206 & 416), and safe XSS headers', async () => {
    const content = '0123456789abcdef'
    const up = await uploadSample(app, content, 'data.bin', 'application/octet-stream')
    const fileUrl = (await up.text()).trim()

    const headRes = await app.request(fileUrl, { method: 'HEAD' })
    expect(headRes.status).toBe(200)
    expect(headRes.headers.get('content-length')).toBe(String(content.length))
    expect(headRes.headers.get('accept-ranges')).toBe('bytes')
    expect(headRes.headers.get('content-disposition')).toContain('inline')

    const r1 = await app.request(fileUrl, { headers: { Range: 'bytes=2-5' } })
    expect(r1.status).toBe(206)
    expect(r1.headers.get('content-range')).toBe('bytes 2-5/16')
    expect(r1.headers.get('content-length')).toBe('4')
    expect(await r1.text()).toBe('2345')

    const r2 = await app.request(fileUrl, { headers: { Range: 'bytes=12-' } })
    expect(r2.status).toBe(206)
    expect(r2.headers.get('content-range')).toBe('bytes 12-15/16')
    expect(await r2.text()).toBe('cdef')

    const r3 = await app.request(fileUrl, { headers: { Range: 'bytes=-3' } })
    expect(r3.status).toBe(206)
    expect(r3.headers.get('content-range')).toBe('bytes 13-15/16')
    expect(await r3.text()).toBe('def')

    const r4 = await app.request(fileUrl, { headers: { Range: 'bytes=99-120' } })
    expect(r4.status).toBe(416)
    expect(r4.headers.get('content-range')).toBe('bytes */16')

    const dlRes = await app.request(`${fileUrl}?download=1`)
    expect(dlRes.status).toBe(200)
    expect(dlRes.headers.get('content-disposition')).toContain('attachment')

    const htmlUp = await uploadSample(app, '<h1>hi</h1>', 'page.html', 'text/html')
    const htmlUrl = (await htmlUp.text()).trim()
    const htmlGet = await app.request(htmlUrl)
    expect(htmlGet.status).toBe(200)
    expect(htmlGet.headers.get('content-disposition')).toContain('attachment')
    expect(htmlGet.headers.get('content-security-policy')).toBe('sandbox')
    expect(htmlGet.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('enforces X-Token auth on POST /:slug management and deletes on request', async () => {
    const up = await uploadSample(app, 'manage me', 'note.txt', 'text/plain')
    const token = up.headers.get('x-token')!
    const fileUrl = (await up.text()).trim()

    // Wrong token -> 403
    const badForm = new FormData()
    badForm.append('token', 'wrong-token')
    badForm.append('delete', '')
    const badRes = await app.request(fileUrl, { method: 'POST', body: badForm })
    expect(badRes.status).toBe(403)

    // Missing delete action -> 400
    const noopForm = new FormData()
    noopForm.append('token', token)
    const noopRes = await app.request(fileUrl, { method: 'POST', body: noopForm })
    expect(noopRes.status).toBe(400)

    // Delete via 0x0.st POST form
    const delForm = new FormData()
    delForm.append('token', token)
    delForm.append('delete', '')
    const delRes = await app.request(fileUrl, { method: 'POST', body: delForm })
    expect(delRes.status).toBe(200)
    expect(await delRes.text()).toBe('deleted\n')

    const afterGet = await app.request(fileUrl)
    expect(afterGet.status).toBe(404)
  })

  it('infers media MIME types and serves OpenGraph/Twitter embed HTML to social crawlers', async () => {
    const imgBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const imgUp = await uploadSample(
      app,
      imgBytes,
      'photo.png',
      'application/octet-stream',
      {},
      { Accept: 'application/json' }
    )
    expect(imgUp.status).toBe(200)
    const imgMeta = (await imgUp.json()) as { url: string; mimeType: string }
    expect(imgMeta.mimeType).toBe('image/png')

    const discordImg = await app.request(imgMeta.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' },
    })
    expect(discordImg.status).toBe(200)
    expect(discordImg.headers.get('content-type')).toContain('text/html')
    const imgHtml = await discordImg.text()
    expect(imgHtml).toContain(`property="og:image" content="${imgMeta.url}?raw=1"`)
    expect(imgHtml).toContain('name="twitter:card" content="summary_large_image"')

    // ?raw=1 returns the actual binary even for crawlers
    const discordRaw = await app.request(`${imgMeta.url}?raw=1`, {
      headers: { 'User-Agent': 'Discordbot/2.0' },
    })
    expect(discordRaw.status).toBe(200)
    expect(discordRaw.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await discordRaw.arrayBuffer())).toEqual(imgBytes)

    // Normal browser/curl requests receive raw media directly
    const normalGet = await app.request(imgMeta.url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
    expect(normalGet.status).toBe(200)
    expect(normalGet.headers.get('content-type')).toBe('image/png')

    // Video MIME inference + TelegramBot/Twitterbot video embed
    const vidBytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])
    const vidUp = await uploadSample(
      app,
      vidBytes,
      'clip.mp4',
      'application/octet-stream',
      {},
      { Accept: 'application/json' }
    )
    const vidMeta = (await vidUp.json()) as { url: string; mimeType: string }
    expect(vidMeta.mimeType).toBe('video/mp4')

    for (const botUa of ['TelegramBot (like TwitterBot)', 'Twitterbot/1.0']) {
      const botRes = await app.request(vidMeta.url, { headers: { 'User-Agent': botUa } })
      expect(botRes.status).toBe(200)
      expect(botRes.headers.get('content-type')).toContain('text/html')
      const botHtml = await botRes.text()
      expect(botHtml).toContain(`property="og:video" content="${vidMeta.url}?raw=1"`)
      expect(botHtml).toContain('property="og:video:type" content="video/mp4"')
      expect(botHtml).toContain(`name="twitter:player:stream" content="${vidMeta.url}?raw=1"`)
    }

    // Audio embed
    const audioUp = await uploadSample(app, 'fake-mp3', 'song.mp3', 'audio/mpeg', {}, { Accept: 'application/json' })
    const audioMeta = (await audioUp.json()) as { url: string }
    const audioBot = await app.request(audioMeta.url, { headers: { 'User-Agent': 'Slackbot-LinkExpanding 1.0' } })
    expect(audioBot.status).toBe(200)
    const audioHtml = await audioBot.text()
    expect(audioHtml).toContain(`property="og:audio" content="${audioMeta.url}?raw=1"`)
  })

  it('derives public URLs from request headers and origin when BASE_URL is unset', async () => {
    const autoApp = createApp({
      db,
      storage,
      config: makeConfig({ baseUrl: undefined }),
    })

    // Reverse proxy headers: X-Forwarded-Proto + Host
    const cliRes = await autoApp.request('http://127.0.0.1:3000/', {
      headers: {
        'User-Agent': 'curl/8.5.0',
        'X-Forwarded-Proto': 'https',
        Host: 'files.example.com',
      },
    })
    expect(cliRes.status).toBe(200)
    expect(await cliRes.text()).toContain("curl -F 'file=@yourfile.png' https://files.example.com")

    const htmlRes = await autoApp.request('http://127.0.0.1:3000/', {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'text/html',
        'X-Forwarded-Proto': 'https',
        Host: 'files.example.com',
      },
    })
    const html = await htmlRes.text()
    expect(html).toContain('<span class="origin">https://files.example.com</span>')
    expect(html).toContain('window.location.origin')

    const form = new FormData()
    form.append('file', new File([new Uint8Array([137, 80, 78, 71])], 'pic.png', { type: 'image/png' }))
    const upRes = await autoApp.request('http://127.0.0.1:3000/', {
      method: 'POST',
      headers: {
        'X-Forwarded-Proto': 'https',
        Host: 'files.example.com',
      },
      body: form,
    })
    expect(upRes.status).toBe(200)
    const uploadedUrl = (await upRes.text()).trim()
    expect(uploadedUrl).toMatch(/^https:\/\/files\.example\.com\/[0-9A-Za-z]{32}\.png$/)

    const slugPath = new URL(uploadedUrl).pathname
    const botRes = await autoApp.request(`http://127.0.0.1:3000${slugPath}`, {
      headers: {
        'User-Agent': 'Discordbot/2.0',
        'X-Forwarded-Proto': 'https',
        Host: 'files.example.com',
      },
    })
    const botHtml = await botRes.text()
    expect(botHtml).toContain(`property="og:image" content="${uploadedUrl}?raw=1"`)

    // Fallback to request origin when forwarded headers are absent
    const fallbackForm = new FormData()
    fallbackForm.append('file', new File(['hello'], 'hi.txt', { type: 'text/plain' }))
    const fallbackRes = await autoApp.request('http://share.local:8080/', {
      method: 'POST',
      body: fallbackForm,
    })
    expect(fallbackRes.status).toBe(200)
    expect((await fallbackRes.text()).trim()).toMatch(
      /^http:\/\/share\.local:8080\/[0-9A-Za-z]{32}\.txt$/
    )
  })
})

describe('ensureStorageChannel', () => {
  function makeMockClient(peers: StorageChannelPeer[]): {
    client: ChannelSetupClient
    createdCalls: Array<{ title: string; description?: string }>
  } {
    const createdCalls: Array<{ title: string; description?: string }> = []
    const client: ChannelSetupClient = {
      async *iterDialogs() {
        for (const peer of peers) {
          yield { peer }
        }
      },
      async createChannel(params) {
        createdCalls.push(params)
        return { id: -100999888777, title: params.title }
      },
    }
    return { client, createdCalls }
  }

  it('reuses an existing channel named "tellshare files" without creating a new one', async () => {
    const { client, createdCalls } = makeMockClient([
      { type: 'user', id: 42 },
      {
        type: 'chat',
        chatType: 'group',
        id: -555,
        title: 'tellshare files',
        isCreator: true,
      },
      {
        type: 'chat',
        chatType: 'channel',
        id: -100111222333,
        title: 'TellShare Files',
        isCreator: true,
      },
    ])

    const result = await ensureStorageChannel(client, 'tellshare files')
    expect(result).toEqual({
      id: -100111222333,
      title: 'TellShare Files',
      created: false,
    })
    expect(createdCalls).toHaveLength(0)
  })

  it('automatically creates "tellshare files" channel when it does not exist', async () => {
    const { client, createdCalls } = makeMockClient([
      {
        type: 'chat',
        chatType: 'channel',
        id: -100444,
        title: 'tellshare files',
        isCreator: false,
        isAdmin: false,
      },
      {
        type: 'chat',
        chatType: 'channel',
        id: -100555,
        title: 'other channel',
        isCreator: true,
      },
    ])

    const result = await ensureStorageChannel(client, 'tellshare files')
    expect(result).toEqual({
      id: -100999888777,
      title: 'tellshare files',
      created: true,
    })
    expect(createdCalls).toEqual([
      {
        title: 'tellshare files',
        description: 'TellShare file storage',
      },
    ])
  })
})

describe('normalizeBareChannelId', () => {
  it('converts negative bare channel IDs to -100-prefixed marked channel IDs', () => {
    expect(normalizeBareChannelId(-2345678901)).toBe(-1002345678901)
    expect(normalizeBareChannelId(-123456789)).toBe(-1000123456789)
  })

  it('returns null for already-marked channel IDs and non-negative user IDs', () => {
    expect(normalizeBareChannelId(-1002345678901)).toBeNull()
    expect(normalizeBareChannelId(123456789)).toBeNull()
    expect(normalizeBareChannelId(0)).toBeNull()
  })
})

describe('isRetryableUploadError', () => {
  it('detects failed part errors and 5xx RPC errors as retryable', () => {
    expect(isRetryableUploadError(new Error('Failed to upload part 794'))).toBe(true)
    expect(isRetryableUploadError(new Error('read ECONNRESET'))).toBe(true)
    expect(isRetryableUploadError(new tl.RpcError(500, 'RPC_CALL_FAIL'))).toBe(true)
  })

  it('returns false for non-retryable client errors', () => {
    expect(isRetryableUploadError(new Error('Invalid argument'))).toBe(false)
    expect(isRetryableUploadError(new tl.RpcError(400, 'CHAT_ID_INVALID'))).toBe(false)
    expect(isRetryableUploadError('plain string')).toBe(false)
  })
})
