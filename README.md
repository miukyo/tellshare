# TellShare

A `0x0.st`-compatible file-sharing service using **Telegram MTProto** for lossless, unlimited-retention file storage, built with **Bun**, **Hono**, **@mtcute/bun**, and **bun:sqlite**.

## Features

- **`0x0.st`-compatible HTTP & CLI API**: upload via `file=@...` or `url=...`, and delete files with `X-Token`.
- **Automatic `"tellshare files"` storage channel**: in user-account mode, TellShare automatically finds or creates a private Telegram channel named `"tellshare files"` if `STORAGE_CHAT_ID` is not set.
- **Unlimited retention**: uploaded files never expire automatically; files stay stored until explicitly deleted with their management token.
- **Rich social media embeds**: image, video, and audio files automatically serve OpenGraph & Twitter Card metadata to Discord, Telegram, Twitter/X, Slack, and WhatsApp crawlers (`?raw=1` returns the raw media bytes).
- **Telegram MTProto storage (`@mtcute/bun`)**: uploads files as Telegram `document` messages (no compression or re-encoding), streams downloads back to HTTP clients, and automatically refreshes expired `file_id` references from the stored message.
- **HTTP Range requests (`206 Partial Content`)**: seeks directly to the nearest 4 KiB MTProto chunk boundary and streams exact byte ranges for resumable downloads and media playback.
- **Content deduplication (SHA-256)**: identical uploads reuse the existing Telegram message and reference-count deletions.
- **Minimal zero-CSS Web UI**: plain `<pre>`, `<input>`, `<button>`, and `<progress>` upload bar with `curl`/API documentation when opened in a browser (`curl`/CLI clients receive plain-text help).
- **Security defaults**: SSRF validation (including redirect checks) on remote URL uploads, timing-safe token verification, and `Content-Disposition: attachment` + `Content-Security-Policy: sandbox` for active HTML/SVG/XML/JS MIME types.

## Setup

### 1. Prerequisites

- [Bun](https://bun.sh) v1.1+
- Telegram `API_ID` and `API_HASH` from <https://my.telegram.org>

### 2. Install & Configure

```bash
bun install
cp .env.example .env
```

Edit `.env` with your credentials. You can run TellShare in either **User Account mode** (recommended; up to 2 GiB/4 GiB per file and auto-creates the `"tellshare files"` channel) or **Bot mode** (requires a channel/group ID where the bot is admin):

- **User Account mode** (recommended):
  1. Leave `BOT_TOKEN=` and `STORAGE_CHAT_ID=` empty (TellShare will automatically create/reuse the `"tellshare files"` channel).
  2. Authenticate once interactively:
     ```bash
     bun run login
     ```
- **Bot mode**:
  1. Set `BOT_TOKEN=123456:ABC...` from `@BotFather`.
  2. Add the bot as an admin to a private Telegram channel and set `STORAGE_CHAT_ID=-1001234567890` (or the channel's `@username`).

### 3. Start the Server

```bash
bun run dev
# or for production:
bun run start
```

## Usage (`0x0.st` compatible)

```bash
# Upload a local file
curl -F 'file=@hello.png' http://localhost:3000

# Upload from a remote URL
curl -F 'url=https://example.com/archive.tar.gz' http://localhost:3000

# Capture X-Token header & JSON output
curl -i -H 'Accept: application/json' -F 'file=@hello.png' http://localhost:3000

# Delete file using X-Token (POST or DELETE)
curl -F 'token=YOUR_TOKEN' -F 'delete=' http://localhost:3000/abc12.png
curl -X DELETE -H 'X-Token: YOUR_TOKEN' http://localhost:3000/abc12.png

# Direct raw stream (bypasses crawler embed HTML) / force download
curl -O 'http://localhost:3000/abc12.png?raw=1'
curl -OJ 'http://localhost:3000/abc12.png?download=1'
```

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Listen address |
| `BASE_URL` | `http://localhost:3000` | Public base URL returned on uploads |
| `API_ID` | — | Telegram API ID (required) |
| `API_HASH` | — | Telegram API Hash (required) |
| `BOT_TOKEN` | — | Optional BotFather token (omit for user session) |
| `STORAGE_CHAT_ID` | — | Optional target chat/channel ID or `@username` (auto-creates `STORAGE_CHANNEL_NAME` when omitted in user mode) |
| `STORAGE_CHANNEL_NAME` | `tellshare files` | Channel title used for auto-creation/lookup when `STORAGE_CHAT_ID` is unset |
| `DATA_DIR` | `./data` | Directory for `tellshare.db` and `telegram.session` |
| `MAX_FILE_SIZE` | `536870912` | Max upload size in bytes (default 512 MiB) |
| `ALLOW_URL_UPLOAD` | `true` | Enable/disable `url=` uploads |

## Development

```bash
bun run typecheck
bun test
```
