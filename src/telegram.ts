import { mkdirSync } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import QRCode from 'qrcode'
import {
  BaseTelegramClient,
  FileDownloadLocation,
  FileLocation,
  InputPeerLike,
  MtPeerNotFoundError,
  MtUnsupportedError,
  TelegramClient,
  UploadedFile,
  tl,
} from '@mtcute/bun'
import { AppConfig, assertTelegramConfig, parseStorageChatId } from './config'

export interface UploadedObject {
  chatId: string
  messageId: number
  fileId: string | null
}

export interface DownloadStreamOptions {
  chatId: string
  messageId: number
  fileId: string | null
  fileSize?: number
  offset?: number
  limit?: number
  signal?: AbortSignal
  onRefreshedFileId?: (newFileId: string) => void
}

export interface UploadFileOptions {
  filePath: string
  filename: string
  mimeType: string
  size: number
  caption?: string
  onProgress?: (uploaded: number, total: number) => void
}

export interface StorageBackend {
  isConnected(): boolean
  uploadFile(opts: UploadFileOptions): Promise<UploadedObject>
  downloadStream(opts: DownloadStreamOptions): Promise<ReadableStream<Uint8Array>>
  deleteFile(opts: { chatId: string; messageId: number }): Promise<void>
}

export type SetupStateName =
  | 'idle'
  | 'qr_pending'
  | 'qr_scanned'
  | 'code_sent'
  | 'password_required'
  | 'connected'
  | 'error'

export interface SetupStatus {
  connected: boolean
  state: SetupStateName
  qrAscii?: string
  qrUrl?: string
  qrExpiresAt?: number
  error?: string
  storageChatId?: string | number | null
}

export interface SetupBackend {
  getSetupStatus(): SetupStatus
  startQrLogin(): Promise<SetupStatus>
  sendPhoneCode(phone: string): Promise<SetupStatus>
  submitPhoneCode(code: string): Promise<SetupStatus>
  submitPassword(password: string): Promise<SetupStatus>
}

export class TelegramObjectNotFoundError extends Error {
  constructor(message = 'Stored file was not found in Telegram') {
    super(message)
    this.name = 'TelegramObjectNotFoundError'
  }
}

function extractFileId(media: unknown): string | null {
  if (
    media &&
    typeof media === 'object' &&
    'fileId' in media &&
    typeof (media as { fileId?: unknown }).fileId === 'string'
  ) {
    return (media as { fileId: string }).fileId
  }
  return null
}

function isFileReferenceError(err: unknown): boolean {
  if (err instanceof MtUnsupportedError && /file ref/i.test(err.message)) {
    return true
  }
  if (tl.RpcError.is(err)) {
    return (
      err.text.startsWith('FILE_REFERENCE_') ||
      err.text === 'FILEREF_UPGRADE_NEEDED' ||
      err.text === 'FILE_ID_INVALID'
    )
  }
  if (err instanceof Error) {
    return /FILE_REFERENCE|FILEREF_UPGRADE_NEEDED|file ref expired/i.test(err.message)
  }
  return false
}

function linkAbortSignals(external?: AbortSignal): {
  controller: AbortController
  unlink: () => void
} {
  const controller = new AbortController()
  if (!external) {
    return { controller, unlink: () => {} }
  }
  if (external.aborted) {
    controller.abort(external.reason)
    return { controller, unlink: () => {} }
  }
  const onAbort = () => controller.abort(external.reason)
  external.addEventListener('abort', onAbort, { once: true })
  return {
    controller,
    unlink: () => external.removeEventListener('abort', onAbort),
  }
}

export interface DownloadPlan {
  alignedOffset: number
  skipBytes: number
  partSizeKb: number
  limit?: number
}

export function selectDownloadPlan(
  offset: number,
  maxBytes: number,
  fileSize?: number
): DownloadPlan {
  let partSizeKb: number
  if (maxBytes <= 64 * 1024) {
    partSizeKb = 64
  } else if (maxBytes <= 256 * 1024) {
    partSizeKb = 128
  } else if (offset === 0 && (fileSize ?? maxBytes) >= 1024 * 1024) {
    partSizeKb = 512
  } else {
    partSizeKb = 256
  }

  const chunkSize = partSizeKb * 1024
  const alignedOffset = Math.floor(offset / chunkSize) * chunkSize
  const skipBytes = offset - alignedOffset

  let limit: number | undefined
  const endNeeded = skipBytes + maxBytes
  if (alignedOffset === 0 && Number.isFinite(endNeeded) && endNeeded > 0 && endNeeded <= 1048576) {
    let rounded = 4096
    while (rounded < endNeeded && rounded < 1048576) {
      rounded *= 2
    }
    if (fileSize === undefined || rounded < fileSize) {
      limit = rounded
    }
  }

  return { alignedOffset, skipBytes, partSizeKb, limit }
}

interface ProbedIterable {
  firstChunk: Uint8Array | null
  iterator: AsyncIterableIterator<Uint8Array>
  abortController: AbortController
  unlinkAbort: () => void
  setThrottle: (fn: () => Promise<void> | undefined) => void
}

/**
 * Wraps a single downloadAsIterable stream directly with chunk-aligned slicing and 1 MiB pull-based backpressure.
 */
function createDownloadReadableStream(
  probed: ProbedIterable,
  skipBytes: number,
  maxBytes: number
): ReadableStream<Uint8Array> {
  let skipRemaining = skipBytes
  let bytesRemaining = maxBytes
  let finished = false
  const pullWaiters: Array<() => void> = []

  const wakeAllWaiters = () => {
    while (pullWaiters.length > 0) {
      pullWaiters.pop()!()
    }
  }

  const cleanup = () => {
    if (finished) return
    finished = true
    wakeAllWaiters()
    probed.unlinkAbort()
    probed.abortController.abort()
    void probed.iterator.return?.().catch(() => {})
  }

  const processChunk = (chunk: Uint8Array): Uint8Array | null => {
    let slice = chunk
    if (skipRemaining > 0) {
      if (slice.byteLength <= skipRemaining) {
        skipRemaining -= slice.byteLength
        return null
      }
      slice = slice.subarray(skipRemaining)
      skipRemaining = 0
    }
    if (bytesRemaining !== Infinity) {
      if (bytesRemaining <= 0) {
        return null
      }
      if (slice.byteLength > bytesRemaining) {
        slice = slice.subarray(0, bytesRemaining)
      }
      bytesRemaining -= slice.byteLength
    }
    return slice.byteLength > 0 ? slice : null
  }

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        probed.setThrottle(() => {
          if (finished) return undefined
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            return new Promise<void>((resolve) => {
              pullWaiters.push(resolve)
            })
          }
          return undefined
        })

        ;(async () => {
          try {
            if (probed.firstChunk) {
              const out = processChunk(probed.firstChunk)
              if (out) {
                controller.enqueue(out)
              }
            }

            while (!finished && bytesRemaining > 0) {
              const next = await probed.iterator.next()
              if (finished || next.done || !next.value) {
                break
              }
              const out = processChunk(next.value)
              if (out) {
                controller.enqueue(out)
              }
            }

            if (!finished) {
              cleanup()
              controller.close()
            }
          } catch (err) {
            if (!finished) {
              cleanup()
              controller.error(err)
            }
          }
        })()
      },
      pull() {
        wakeAllWaiters()
      },
      cancel() {
        cleanup()
      },
    },
    {
      highWaterMark: 1024 * 1024,
      size: (chunk) => chunk?.byteLength ?? 0,
    }
  )
}

export interface StorageChannelPeer {
  type: string
  id: number
  chatType?: string
  title?: string
  isCreator?: boolean
  isAdmin?: boolean
  inputPeer?: tl.TypeInputPeer
}

export interface ChannelSetupClient {
  iterDialogs(params?: {
    archived?: 'keep' | 'exclude' | 'only'
  }): AsyncIterable<{ peer: StorageChannelPeer }>
  createChannel(params: {
    title: string
    description?: string
  }): Promise<{ id: number; title: string; inputPeer?: tl.TypeInputPeer }>
}

export function normalizeBareChannelId(chatId: number): number | null {
  if (!Number.isSafeInteger(chatId)) return null
  if (chatId < 0 && chatId >= -999_999_999_999) {
    return -1_000_000_000_000 + chatId
  }
  return null
}

export function isRetryableUploadError(err: unknown): boolean {
  if (tl.RpcError.is(err)) {
    return err.code >= 500 || err.text === 'RPC_CALL_FAIL' || err.text === 'INTERNAL'
  }
  if (err instanceof Error) {
    return /Failed to upload part \d+|RPC_CALL_FAIL|Timeout|ECONNRESET|ETIMEDOUT|EPIPE/i.test(
      err.message
    )
  }
  return false
}

export async function ensureStorageChannel(
  client: ChannelSetupClient,
  channelTitle: string
): Promise<{ id: number; title: string; inputPeer?: tl.TypeInputPeer; created: boolean }> {
  const target = channelTitle.trim().toLowerCase()
  for await (const dialog of client.iterDialogs({ archived: 'keep' })) {
    const { peer } = dialog
    if (
      peer.type === 'chat' &&
      peer.chatType === 'channel' &&
      peer.title?.trim().toLowerCase() === target &&
      (peer.isCreator || peer.isAdmin)
    ) {
      return { id: peer.id, title: peer.title, inputPeer: peer.inputPeer, created: false }
    }
  }

  const created = await client.createChannel({
    title: channelTitle,
    description: 'TellShare file storage',
  })
  return { id: created.id, title: created.title, inputPeer: created.inputPeer, created: true }
}

export class TelegramStorage implements StorageBackend, SetupBackend {
  private readonly client: TelegramClient
  private readonly config: AppConfig
  private resolvedChatId: string | number | null = null
  private resolvedPeer: tl.TypeInputPeer | null = null
  private connected = false

  private setupState: SetupStateName = 'idle'
  private setupError?: string
  private qrAscii?: string
  private qrUrl?: string
  private qrExpiresAt?: number
  private qrAbort: AbortController | null = null
  private pendingPhone?: string
  private pendingPhoneCodeHash?: string
  private pendingQrPasswordResolve: ((pw: string) => void) | null = null
  private pendingQrPasswordReject: ((err: Error) => void) | null = null
  private passwordAttemptNotify: (() => void) | null = null

  constructor(config: AppConfig) {
    assertTelegramConfig(config)
    this.config = config
    mkdirSync(config.dataDir, { recursive: true })
    const baseClient = new BaseTelegramClient({
      apiId: config.apiId,
      apiHash: config.apiHash,
      storage: path.join(config.dataDir, 'telegram.session'),
      updates: false,
      network: {
        connectionCount: (kind) =>
          kind === 'main' ? 0 : kind === 'upload' ? 3 : kind === 'download' ? 2 : 1,
      },
    })
    this.client = new TelegramClient({ client: baseClient })
  }

  isConnected(): boolean {
    return this.connected
  }

  getStorageChatId(): string | number | null {
    return this.resolvedChatId
  }

  getSetupStatus(): SetupStatus {
    return {
      connected: this.connected,
      state: this.connected ? 'connected' : this.setupState,
      qrAscii: this.qrAscii,
      qrUrl: this.qrUrl,
      qrExpiresAt: this.qrExpiresAt,
      error: this.setupError,
      storageChatId: this.resolvedChatId,
    }
  }

  private async resolvePeerOrScanDialogs(target: string | number): Promise<tl.TypeInputPeer> {
    try {
      return await this.client.resolvePeer(target)
    } catch (err) {
      if (err instanceof MtPeerNotFoundError && !this.config.botToken && typeof target === 'number') {
        for await (const dialog of this.client.iterDialogs({ archived: 'keep' })) {
          if (dialog.peer.id === target) {
            return dialog.peer.inputPeer
          }
        }
      }
      throw err
    }
  }

  private async resolveConfiguredStorageTarget(
    target: string | number
  ): Promise<{ chatId: string | number; peer: tl.TypeInputPeer }> {
    const channelFallback = typeof target === 'number' ? normalizeBareChannelId(target) : null

    const tryChannelFallback = async (originalErr: unknown): Promise<{
      chatId: string | number
      peer: tl.TypeInputPeer
    }> => {
      if (channelFallback === null) {
        throw originalErr
      }
      const channelPeer = await this.resolvePeerOrScanDialogs(channelFallback)
      await this.client.getChat(channelPeer)
      console.log(`[tellshare] Normalized bare channel ID ${target} -> ${channelFallback}`)
      return { chatId: channelFallback, peer: channelPeer }
    }

    let peer: tl.TypeInputPeer
    try {
      peer = await this.resolvePeerOrScanDialogs(target)
    } catch (err) {
      return tryChannelFallback(err)
    }

    if (peer._ === 'inputPeerChat') {
      try {
        await this.client.getChat(peer)
        return { chatId: target, peer }
      } catch (err) {
        return tryChannelFallback(err)
      }
    }

    if (peer._ === 'inputPeerChannel') {
      await this.client.getChat(peer)
    }

    return { chatId: target, peer }
  }

  private async initializeStorageTarget(): Promise<void> {
    if (this.config.storageChatId !== undefined) {
      const resolved = await this.resolveConfiguredStorageTarget(this.config.storageChatId)
      this.resolvedChatId = resolved.chatId
      this.resolvedPeer = resolved.peer
    } else {
      const channel = await ensureStorageChannel(this.client, this.config.storageChannelName)
      this.resolvedChatId = channel.id
      this.resolvedPeer = channel.inputPeer ?? null
      console.log(
        `[tellshare] ${channel.created ? 'Created' : 'Found'} Telegram storage channel "${channel.title}" (ID: ${channel.id})`
      )
    }
  }

  async tryStart(): Promise<boolean> {
    if (this.config.botToken) {
      await this.client.start({ botToken: this.config.botToken })
      await this.initializeStorageTarget()
      this.connected = true
      this.setupState = 'connected'
      return true
    }

    await this.client.connect()
    try {
      const me = await this.client.getMe()
      await this.client.notifyLoggedIn(me.raw)
      await this.initializeStorageTarget()
      this.connected = true
      this.setupState = 'connected'
      return true
    } catch (err) {
      if (tl.RpcError.is(err)) {
        if (err.text === 'SESSION_PASSWORD_NEEDED') {
          this.setupState = 'password_required'
          return false
        }
        if (
          err.text === 'SESSION_REVOKED' ||
          err.text === 'USER_DEACTIVATED' ||
          err.text === 'USER_DEACTIVATED_BAN'
        ) {
          await this.client.logOut().catch(() => {})
          this.setupState = 'idle'
          return false
        }
        if (err.text === 'AUTH_KEY_UNREGISTERED') {
          this.setupState = 'idle'
          return false
        }
      }
      throw err
    }
  }

  async start(): Promise<void> {
    const ready = await this.tryStart()
    if (!ready) {
      throw new Error(
        'No authorized Telegram user session found. Run `bun run login` or complete web setup.'
      )
    }
  }

  private cancelQrFlow(): void {
    if (this.qrAbort) {
      this.qrAbort.abort()
      this.qrAbort = null
    }
    if (this.pendingQrPasswordReject) {
      this.pendingQrPasswordReject(new Error('QR login cancelled'))
      this.pendingQrPasswordReject = null
      this.pendingQrPasswordResolve = null
    }
    this.qrAscii = undefined
    this.qrUrl = undefined
    this.qrExpiresAt = undefined
  }

  async startQrLogin(): Promise<SetupStatus> {
    if (this.connected) return this.getSetupStatus()
    if (this.config.botToken) {
      this.setupState = 'error'
      this.setupError = 'QR login is only supported in user-account mode (BOT_TOKEN is set).'
      return this.getSetupStatus()
    }

    this.cancelQrFlow()
    this.pendingPhone = undefined
    this.pendingPhoneCodeHash = undefined
    this.setupError = undefined
    this.setupState = 'idle'

    const abort = new AbortController()
    this.qrAbort = abort

    let resolveFirstQr: (() => void) | null = null
    let rejectFirstQr: ((err: unknown) => void) | null = null
    const firstQrPromise = new Promise<void>((resolve, reject) => {
      resolveFirstQr = resolve
      rejectFirstQr = reject
    })

    let renderChain = Promise.resolve()

    void this.client
      .signInQr({
        abortSignal: abort.signal,
        onUrlUpdated: (url, expires) => {
          renderChain = renderChain.then(async () => {
            const ascii = await QRCode.toString(url, { type: 'utf8' })
            if (abort.signal.aborted) return
            this.qrUrl = url
            this.qrAscii = ascii
            this.qrExpiresAt = expires.getTime()
            if (this.setupState !== 'password_required') {
              this.setupState = 'qr_pending'
            }
            this.setupError = undefined
            resolveFirstQr?.()
            resolveFirstQr = null
            rejectFirstQr = null
          })
        },
        onQrScanned: () => {
          if (abort.signal.aborted) return
          this.setupState = 'qr_scanned'
          this.setupError = undefined
        },
        password: () => {
          this.setupState = 'password_required'
          this.setupError = undefined
          return new Promise<string>((resolve, reject) => {
            this.pendingQrPasswordResolve = resolve
            this.pendingQrPasswordReject = reject
          })
        },
        invalidPasswordCallback: () => {
          this.setupState = 'password_required'
          this.setupError = 'Invalid 2FA password. Please try again.'
          const notify = this.passwordAttemptNotify
          this.passwordAttemptNotify = null
          notify?.()
        },
      })
      .then(async () => {
        if (abort.signal.aborted) return
        await this.initializeStorageTarget()
        this.connected = true
        this.setupState = 'connected'
        this.setupError = undefined
        this.qrAscii = undefined
        this.qrUrl = undefined
        this.qrExpiresAt = undefined
        this.qrAbort = null
        this.pendingQrPasswordResolve = null
        this.pendingQrPasswordReject = null
        const notify = this.passwordAttemptNotify
        this.passwordAttemptNotify = null
        notify?.()
        resolveFirstQr?.()
        resolveFirstQr = null
        rejectFirstQr = null
      })
      .catch((err) => {
        if (abort.signal.aborted) return
        this.setupState = 'error'
        this.setupError = err instanceof Error ? err.message : String(err)
        const notify = this.passwordAttemptNotify
        this.passwordAttemptNotify = null
        notify?.()
        rejectFirstQr?.(err)
        resolveFirstQr = null
        rejectFirstQr = null
      })

    try {
      await Promise.race([firstQrPromise, Bun.sleep(15_000)])
    } catch {
      // setupState and setupError already updated
    }
    return this.getSetupStatus()
  }

  async sendPhoneCode(phone: string): Promise<SetupStatus> {
    if (this.connected) return this.getSetupStatus()
    const normalized = phone.trim()
    if (!normalized) {
      this.setupError = 'Phone number is required (e.g. +1234567890).'
      return this.getSetupStatus()
    }

    this.cancelQrFlow()
    this.setupError = undefined

    try {
      const res = await this.client.sendCode({ phone: normalized })
      if ('phoneCodeHash' in res) {
        this.pendingPhone = normalized
        this.pendingPhoneCodeHash = res.phoneCodeHash
        this.setupState = 'code_sent'
      } else {
        await this.client.notifyLoggedIn(res.raw)
        await this.initializeStorageTarget()
        this.connected = true
        this.setupState = 'connected'
      }
    } catch (err) {
      if (tl.RpcError.is(err, 'SESSION_PASSWORD_NEEDED')) {
        this.setupState = 'password_required'
      } else {
        this.setupState = 'error'
        this.setupError = err instanceof Error ? err.message : String(err)
      }
    }
    return this.getSetupStatus()
  }

  async submitPhoneCode(code: string): Promise<SetupStatus> {
    if (this.connected) return this.getSetupStatus()
    const trimmed = code.trim()
    if (!this.pendingPhone || !this.pendingPhoneCodeHash) {
      this.setupError = 'Send a verification code to your phone first.'
      return this.getSetupStatus()
    }
    if (!trimmed) {
      this.setupError = 'Verification code is required.'
      return this.getSetupStatus()
    }

    this.setupError = undefined
    try {
      await this.client.signIn({
        phone: this.pendingPhone,
        phoneCodeHash: this.pendingPhoneCodeHash,
        phoneCode: trimmed,
      })
      this.pendingPhone = undefined
      this.pendingPhoneCodeHash = undefined
      await this.initializeStorageTarget()
      this.connected = true
      this.setupState = 'connected'
    } catch (err) {
      if (tl.RpcError.is(err, 'SESSION_PASSWORD_NEEDED')) {
        this.pendingPhone = undefined
        this.pendingPhoneCodeHash = undefined
        this.setupState = 'password_required'
      } else {
        this.setupState = 'code_sent'
        this.setupError = err instanceof Error ? err.message : String(err)
      }
    }
    return this.getSetupStatus()
  }

  async submitPassword(password: string): Promise<SetupStatus> {
    if (this.connected) return this.getSetupStatus()
    if (!password) {
      this.setupError = '2FA password is required.'
      return this.getSetupStatus()
    }

    this.setupError = undefined

    if (this.pendingQrPasswordResolve) {
      const attemptDone = new Promise<void>((resolve) => {
        this.passwordAttemptNotify = resolve
      })
      const resolver = this.pendingQrPasswordResolve
      this.pendingQrPasswordResolve = null
      this.pendingQrPasswordReject = null
      resolver(password)
      await Promise.race([attemptDone, Bun.sleep(15_000)])
      return this.getSetupStatus()
    }

    try {
      await this.client.checkPassword(password)
      await this.initializeStorageTarget()
      this.connected = true
      this.setupState = 'connected'
    } catch (err) {
      if (tl.RpcError.is(err, 'PASSWORD_HASH_INVALID')) {
        this.setupState = 'password_required'
        this.setupError = 'Invalid 2FA password. Please try again.'
      } else {
        this.setupState = 'password_required'
        this.setupError = err instanceof Error ? err.message : String(err)
      }
    }
    return this.getSetupStatus()
  }

  async stop(): Promise<void> {
    this.cancelQrFlow()
    this.connected = false
    await this.client.destroy()
  }

  private getPeerForChat(chatId: string): InputPeerLike {
    if (this.resolvedPeer && this.resolvedChatId !== null && chatId === String(this.resolvedChatId)) {
      return this.resolvedPeer
    }
    return parseStorageChatId(chatId) ?? chatId
  }

  async uploadFile(opts: UploadFileOptions): Promise<UploadedObject> {
    const target: InputPeerLike | null = this.resolvedPeer ?? this.resolvedChatId
    if (target === null) {
      throw new Error('TelegramStorage is not started; storage target is unresolved')
    }

    const maxAttempts = 3
    let uploaded: UploadedFile | null = null

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const fh = await open(opts.filePath, 'r')
      let readPos = 0
      const fileReader = {
        async read(into: Uint8Array): Promise<number> {
          const { bytesRead } = await fh.read(into, 0, into.byteLength, readPos)
          readPos += bytesRead
          return bytesRead
        },
      }

      try {
        uploaded = await this.client.uploadFile({
          file: fileReader,
          fileName: opts.filename,
          fileMime: opts.mimeType,
          fileSize: opts.size,
          requestsPerConnection: 2,
          progressCallback: opts.onProgress,
        })
        break
      } catch (err) {
        if (attempt === maxAttempts || !isRetryableUploadError(err)) {
          throw err
        }
        const delayMs = attempt * 2000
        console.warn(
          `[tellshare] Telegram upload attempt ${attempt}/${maxAttempts} failed (${err instanceof Error ? err.message : String(err)}); retrying in ${delayMs}ms...`
        )
        await Bun.sleep(delayMs)
      } finally {
        await fh.close().catch(() => {})
      }
    }

    if (!uploaded) {
      throw new Error('Failed to upload file to Telegram')
    }

    const msg = await this.client.sendMedia(
      target,
      {
        type: 'document',
        file: uploaded,
        fileName: opts.filename,
        fileMime: opts.mimeType,
        fileSize: opts.size,
        caption: opts.caption,
      },
      { silent: true }
    )

    return {
      chatId: String(msg.chat.id),
      messageId: msg.id,
      fileId: extractFileId(msg.media),
    }
  }

  private async resolveMessageLocation(
    chatId: string,
    messageId: number
  ): Promise<{ location: FileDownloadLocation; fileId: string | null }> {
    const peer = this.getPeerForChat(chatId)
    const [msg] = await this.client.getMessages(peer, [messageId])
    if (!msg || !msg.media || !(msg.media instanceof FileLocation)) {
      throw new TelegramObjectNotFoundError(
        `Telegram message ${messageId} in chat ${chatId} has no downloadable media`
      )
    }
    return {
      location: msg.media,
      fileId: extractFileId(msg.media),
    }
  }

  private async openProbedIterable(
    location: FileDownloadLocation,
    plan: DownloadPlan,
    fileSize: number | undefined,
    externalSignal?: AbortSignal
  ): Promise<ProbedIterable> {
    const { controller: abortController, unlink: unlinkAbort } = linkAbortSignals(externalSignal)
    let throttleImpl: (() => Promise<void> | undefined) | null = null
    const iterator = this.client.downloadAsIterable(location, {
      offset: plan.alignedOffset,
      fileSize,
      partSize: plan.partSizeKb,
      limit: plan.limit,
      abortSignal: abortController.signal,
      throttle: () => throttleImpl?.(),
    })

    try {
      const first = await iterator.next()
      if (first.done || !first.value) {
        await iterator.return?.().catch(() => {})
        abortController.abort()
        unlinkAbort()
        return {
          firstChunk: null,
          iterator,
          abortController,
          unlinkAbort,
          setThrottle: () => {},
        }
      }
      return {
        firstChunk: first.value,
        iterator,
        abortController,
        unlinkAbort,
        setThrottle: (fn) => {
          throttleImpl = fn
        },
      }
    } catch (err) {
      await iterator.return?.().catch(() => {})
      abortController.abort()
      unlinkAbort()
      throw err
    }
  }

  async downloadStream(opts: DownloadStreamOptions): Promise<ReadableStream<Uint8Array>> {
    const offset = opts.offset ?? 0
    const maxBytes = opts.limit ?? Infinity
    if (maxBytes <= 0) {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close()
        },
      })
    }

    const plan = selectDownloadPlan(offset, maxBytes, opts.fileSize)

    let location: FileDownloadLocation
    if (opts.fileId) {
      location = opts.fileId
    } else {
      const resolved = await this.resolveMessageLocation(opts.chatId, opts.messageId)
      location = resolved.location
      if (resolved.fileId) {
        opts.onRefreshedFileId?.(resolved.fileId)
      }
    }

    let probed: ProbedIterable
    try {
      probed = await this.openProbedIterable(location, plan, opts.fileSize, opts.signal)
    } catch (err) {
      if (!isFileReferenceError(err)) {
        throw err
      }
      // Refresh expired file reference from the original Telegram message and retry once.
      const resolved = await this.resolveMessageLocation(opts.chatId, opts.messageId)
      if (resolved.fileId) {
        opts.onRefreshedFileId?.(resolved.fileId)
      }
      probed = await this.openProbedIterable(resolved.location, plan, opts.fileSize, opts.signal)
    }

    if (!probed.firstChunk) {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close()
        },
      })
    }

    return createDownloadReadableStream(probed, plan.skipBytes, maxBytes)
  }

  async deleteFile(opts: { chatId: string; messageId: number }): Promise<void> {
    const peer = this.getPeerForChat(opts.chatId)
    await this.client.deleteMessagesById(peer, [opts.messageId], { revoke: true })
  }
}
