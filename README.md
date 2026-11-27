# TellShare

A `0x0.st`-compatible file-sharing app backed by **Telegram MTProto** with **AES-256-CTR** streaming encryption, built with **Bun**, **Hono**, **@mtcute/bun**, and **bun:sqlite**.

## Quick Start

1. Install dependencies and create `.env`:
   ```bash
   bun install
   cp .env.example .env
   ```
2. Generate an `ENCRYPTION_KEY`:
   ```bash
   bun -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
3. Set `API_ID`, `API_HASH` (from <https://my.telegram.org>), and `ENCRYPTION_KEY` in `.env`.
4. Start the server:
   ```bash
   bun run start
   ```
5. Open the app in your browser to finish first-time setup via **QR code** or **phone login** (or run `bun run login`). TellShare will automatically create or reuse a Telegram channel named `"tellshare files"`.

> **Bot mode (optional):** Set `BOT_TOKEN` and `STORAGE_CHAT_ID` in `.env` if you prefer using a bot that is already an admin of a channel.

## Usage (`curl`)

```bash
# Upload a file
curl -F 'file=@hello.png' https://your-host

# Upload from a remote URL
curl -F 'url=https://example.com/file.png' https://your-host

# JSON output + X-Token header
curl -i -H 'Accept: application/json' -F 'file=@hello.png' https://your-host

# Delete a file with X-Token
curl -X DELETE -H 'X-Token: YOUR_TOKEN' https://your-host/<id>
curl -F 'token=YOUR_TOKEN' -F 'delete=' https://your-host/<id>
```

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `BASE_URL` | — | Optional public URL (auto-detected from request/proxy headers if empty) |
| `API_ID` | — | Telegram API ID (required) |
| `API_HASH` | — | Telegram API Hash (required) |
| `ENCRYPTION_KEY` | — | Required 64-char hex key (or passphrase) for AES-256-CTR encryption |
| `BOT_TOKEN` | — | Optional BotFather token (omit for user account + QR/phone setup) |
| `STORAGE_CHAT_ID` | — | Optional chat/channel ID or `@username` (auto-creates `"tellshare files"` if empty) |
| `STORAGE_CHANNEL_NAME` | `tellshare files` | Channel name for automatic creation/lookup |
| `DATA_DIR` | `./data` | Directory for `tellshare.db` and `telegram.session` |
| `MAX_FILE_SIZE` | `0` | Max upload size in bytes (`0` = unlimited) |
| `PART_SIZE` | `536870912` | Part split size in bytes for >2 GB streaming uploads (default 512 MiB) |
| `ALLOW_URL_UPLOAD` | `true` | Enable/disable `url=` uploads |

## Legal & Privacy Policy

- **No accounts or tracking:** TellShare does not use accounts, cookies, analytics, or tracking.
- **Stored metadata:** Only file ID, filename, MIME type, size, plaintext SHA-256, per-file encryption salt/IV, Telegram message references, hashed `X-Token`, creation timestamp, and download count are stored in `DATA_DIR/tellshare.db`.
- **Encryption & access:** Files are encrypted server-side with AES-256-CTR before upload to Telegram under random opaque `.bin` filenames unrelated to the share URL. Anyone with the share URL can download the file; `X-Token` grants deletion rights. Back up `ENCRYPTION_KEY` and `tellshare.db` — files cannot be decrypted without them.
- **Operator access & trust:** Because encryption is server-side (not zero-knowledge), the server operator technically has access to stored metadata and can decrypt files if required (for example, for abuse moderation or legal compliance). The operator does not actively browse or share user files; for sensitive data, encrypt files client-side before uploading (e.g., `age`, `gpg`, or an encrypted archive). TellShare is open-source at https://github.com/miukyo/tellshare — you can audit the code or self-host your own instance.
- **Acceptable use & disclaimer:** Do not upload illegal, copyrighted, or malicious content. Software and hosted instances are provided "as-is" without warranty, operators may remove files at any time, and backend storage is subject to Telegram's Terms of Service.
