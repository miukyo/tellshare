import {
  Cipheriv,
  Decipheriv,
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from 'node:crypto'

const HKDF_INFO = Buffer.from('tellshare-file-v1', 'utf8')
const MASK_128 = (1n << 128n) - 1n

export function parseEncryptionKey(raw: string): Buffer {
  const trimmed = raw.trim()
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex')
  }
  return createHash('sha256').update(trimmed, 'utf8').digest()
}

export function generateFileEncryptionParams(): { salt: string; iv: string } {
  return {
    salt: randomBytes(16).toString('hex'),
    iv: randomBytes(16).toString('hex'),
  }
}

export function deriveFileKey(masterKey: Buffer, saltHex: string): Buffer {
  const derived = hkdfSync('sha256', masterKey, Buffer.from(saltHex, 'hex'), HKDF_INFO, 32)
  return Buffer.from(derived)
}

export function incrementCounter(iv: Buffer, blockOffset: number): Buffer {
  if (iv.length !== 16) {
    throw new Error(`Invalid IV length: expected 16 bytes, got ${iv.length}`)
  }
  if (!Number.isSafeInteger(blockOffset) || blockOffset < 0) {
    throw new Error(`Invalid blockOffset: ${blockOffset}`)
  }
  if (blockOffset === 0) {
    return Buffer.from(iv)
  }
  const base = BigInt(`0x${iv.toString('hex')}`)
  const next = (base + BigInt(blockOffset)) & MASK_128
  return Buffer.from(next.toString(16).padStart(32, '0'), 'hex')
}

export function createFileCipher(masterKey: Buffer, saltHex: string, ivHex: string): Cipheriv {
  const fileKey = deriveFileKey(masterKey, saltHex)
  const iv = Buffer.from(ivHex, 'hex')
  return createCipheriv('aes-256-ctr', fileKey, iv)
}

export function createSeekedDecipher(
  masterKey: Buffer,
  saltHex: string,
  ivHex: string,
  byteOffset: number = 0
): Decipheriv {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
    throw new Error(`Invalid byteOffset: ${byteOffset}`)
  }
  const fileKey = deriveFileKey(masterKey, saltHex)
  const blockIndex = Math.floor(byteOffset / 16)
  const intraBlock = byteOffset % 16
  const counter = incrementCounter(Buffer.from(ivHex, 'hex'), blockIndex)
  const decipher = createDecipheriv('aes-256-ctr', fileKey, counter)
  if (intraBlock > 0) {
    decipher.update(Buffer.alloc(intraBlock))
  }
  return decipher
}

export function createDecryptStream(
  source: ReadableStream<Uint8Array>,
  masterKey: Buffer,
  saltHex: string,
  ivHex: string,
  byteOffset: number = 0
): ReadableStream<Uint8Array> {
  const decipher = createSeekedDecipher(masterKey, saltHex, ivHex, byteOffset)
  const reader = source.getReader()
  let finished = false

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            finished = true
            const tail = decipher.final()
            if (tail.byteLength > 0) {
              controller.enqueue(new Uint8Array(tail.buffer, tail.byteOffset, tail.byteLength))
            }
            controller.close()
            return
          }
          if (value.byteLength === 0) continue
          const out = decipher.update(value)
          if (out.byteLength > 0) {
            controller.enqueue(new Uint8Array(out.buffer, out.byteOffset, out.byteLength))
            return
          }
        }
      } catch (err) {
        finished = true
        reader.cancel().catch(() => {})
        controller.error(err)
      }
    },
    cancel() {
      if (!finished) {
        finished = true
        reader.cancel().catch(() => {})
      }
    },
  })
}
