import { AppConfig } from './config'
import { formatBytes } from './utils'

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const ASCII_BANNER = [
  '  ______        __  __   _____   __                    ',
  ' /_  __/ ___   / / / /  / ___/  / /_  ____  _____ ___  ',
  '  / /   / _ \\ / / / /   \\__ \\  / __ \\/ __ `/ ___// _ \\ ',
  ' / /   /  __// / / /   ___/ / / / / / /_/ / /   /  __/ ',
  '/_/    \\___//_/ /_/   /____/ /_/ /_/\\__,_/_/    \\___/  ',
].join('\n')

export function renderPlainHelp(
  config: AppConfig,
  stats: { count: number; totalBytes: number },
  baseUrl: string
): string {
  const maxSize = formatBytes(config.maxFileSize)
  const stored = formatBytes(stats.totalBytes)
  const url = baseUrl

  return `${ASCII_BANNER}
TELLSHARE (0x0.st-compatible file host backed by Telegram MTProto)
==================================================================

USAGE
-----
Upload a file:
  curl -F 'file=@yourfile.png' ${url}

Upload from a remote URL:
  curl -F 'url=https://example.com/file.png' ${url}

JSON response:
  curl -H 'Accept: application/json' -F 'file=@yourfile.png' ${url}

MANAGEMENT
----------
Every upload returns an X-Token response header. Save it to delete your file.

Delete file:
  curl -F 'token=YOUR_TOKEN' -F 'delete=' ${url}/<id>
  curl -X DELETE -H 'X-Token: YOUR_TOKEN' ${url}/<id>

Direct raw file / force download:
  ${url}/<id>?raw=1
  ${url}/<id>?download=1

LIMITS & RETENTION
------------------
Max file size:   ${maxSize}
Retention:       unlimited
URL uploads:     ${config.allowUrlUpload ? 'enabled' : 'disabled'}
Media embeds:    enabled (Discord, Telegram, Twitter/X, Slack)
Active files:    ${stats.count} (${stored})

LEGAL & PRIVACY
---------------
- No accounts, cookies, or tracking. Do not upload illegal, copyrighted,
  or malicious content.
- Files are AES-256-CTR encrypted before storage on Telegram; SQLite stores
  only file metadata, encryption parameters, and hashed delete tokens.
- Anyone with a file URL can download it; save X-Token to delete uploads.
- Provided "as-is" without warranty and subject to Telegram ToS.
`
}

export function renderMediaEmbedHtml(opts: {
  title: string
  pageUrl: string
  rawUrl: string
  mimeType: string
  mediaKind: 'image' | 'video' | 'audio'
  size: number
}): string {
  const title = escapeHtml(opts.title)
  const pageUrl = escapeHtml(opts.pageUrl)
  const rawUrl = escapeHtml(opts.rawUrl)
  const mimeType = escapeHtml(opts.mimeType)
  const sizeLabel = escapeHtml(formatBytes(opts.size))

  let mediaTags = ''
  if (opts.mediaKind === 'image') {
    mediaTags = `  <meta property="og:type" content="website">
  <meta property="og:image" content="${rawUrl}">
  <meta property="og:image:secure_url" content="${rawUrl}">
  <meta property="og:image:type" content="${mimeType}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="${rawUrl}">`
  } else if (opts.mediaKind === 'video') {
    mediaTags = `  <meta property="og:type" content="video.other">
  <meta property="og:video" content="${rawUrl}">
  <meta property="og:video:url" content="${rawUrl}">
  <meta property="og:video:secure_url" content="${rawUrl}">
  <meta property="og:video:type" content="${mimeType}">
  <meta name="twitter:card" content="player">
  <meta name="twitter:player:stream" content="${rawUrl}">
  <meta name="twitter:player:stream:content_type" content="${mimeType}">`
  } else {
    mediaTags = `  <meta property="og:type" content="music.song">
  <meta property="og:audio" content="${rawUrl}">
  <meta property="og:audio:secure_url" content="${rawUrl}">
  <meta property="og:audio:type" content="${mimeType}">
  <meta name="twitter:card" content="summary">`
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta property="og:url" content="${pageUrl}">
${mediaTags}
  <meta http-equiv="refresh" content="0;url=${rawUrl}">
</head>
<body>
<pre><a href="${rawUrl}">${title}</a> (${sizeLabel})</pre>
</body>
</html>
`
}

export function renderSetupUi(baseUrl: string): string {
  const safeBaseUrl = escapeHtml(baseUrl)

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TellShare Setup</title>
</head>
<body>
<pre>${escapeHtml(ASCII_BANNER)}
FIRST-TIME TELEGRAM SETUP
=========================
Sign in to your Telegram account to auto-create/use the "tellshare files" storage channel.
Server: <span class="origin">${safeBaseUrl}</span></pre>

<pre>OPTION 1: QR CODE LOGIN (Recommended)
-------------------------------------
Open Telegram on your phone -&gt; Settings -&gt; Devices -&gt; Link Desktop Device.

<button id="qrBtn" type="button">Generate QR Code</button></pre>
<pre id="qrBox"></pre>

<pre>OPTION 2: PHONE NUMBER LOGIN
----------------------------
Phone: <input id="phoneInput" type="tel" placeholder="+1234567890" size="24"> <button id="sendCodeBtn" type="button">Send Code</button>
Code:  <input id="codeInput" type="text" placeholder="12345" size="12"> <button id="verifyCodeBtn" type="button">Verify Code</button><span id="twoFaSection" hidden>
2FA:   <input id="passInput" type="password" placeholder="2FA password" size="24"> <button id="verifyPassBtn" type="button">Submit 2FA</button></span></pre>

<pre id="setupStatus">Checking status...</pre>

<script>
(function () {
  if (window.location && window.location.origin && window.location.origin !== 'null') {
    document.querySelectorAll('.origin').forEach(function (el) {
      el.textContent = window.location.origin;
    });
  }

  var qrBtn = document.getElementById('qrBtn');
  var qrBox = document.getElementById('qrBox');
  var phoneInput = document.getElementById('phoneInput');
  var sendCodeBtn = document.getElementById('sendCodeBtn');
  var codeInput = document.getElementById('codeInput');
  var verifyCodeBtn = document.getElementById('verifyCodeBtn');
  var twoFaSection = document.getElementById('twoFaSection');
  var passInput = document.getElementById('passInput');
  var verifyPassBtn = document.getElementById('verifyPassBtn');
  var statusEl = document.getElementById('setupStatus');
  var pollTimer = null;

  function stopPolling() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function applyStatus(data) {
    if (!data) return;

    if (data.connected || data.state === 'connected') {
      stopPolling();
      qrBox.textContent = '';
      statusEl.textContent = 'Connected! Redirecting to TellShare...';
      setTimeout(function () { window.location.reload(); }, 600);
      return;
    }

    if (data.qrAscii) {
      qrBox.textContent = data.qrAscii;
    } else if (data.state !== 'qr_pending' && data.state !== 'qr_scanned') {
      qrBox.textContent = '';
    }

    twoFaSection.hidden = data.state !== 'password_required';

    if (data.error) {
      statusEl.textContent = 'Error: ' + data.error;
    } else if (data.state === 'qr_pending') {
      statusEl.textContent = 'Waiting for QR scan in Telegram app...';
      startPolling();
    } else if (data.state === 'qr_scanned') {
      statusEl.textContent = 'QR scanned! Finalizing login...';
      startPolling();
    } else if (data.state === 'code_sent') {
      statusEl.textContent = 'Verification code sent. Enter the code above and click Verify Code.';
    } else if (data.state === 'password_required') {
      statusEl.textContent = 'Two-step verification enabled. Enter your 2FA password above.';
      stopPolling();
    } else {
      statusEl.textContent = 'Ready. Choose QR code login or phone login above.';
    }
  }

  function startPolling() {
    if (pollTimer !== null) return;
    pollTimer = setInterval(function () {
      fetch('/setup/status')
        .then(function (r) { return r.json(); })
        .then(applyStatus)
        .catch(function () {});
    }, 1500);
  }

  function postJson(url, body, btn) {
    if (btn) btn.disabled = true;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (btn) btn.disabled = false;
        applyStatus(data);
      })
      .catch(function () {
        if (btn) btn.disabled = false;
        statusEl.textContent = 'Network error communicating with server.';
      });
  }

  qrBtn.addEventListener('click', function () {
    statusEl.textContent = 'Generating QR code...';
    postJson('/setup/qr', {}, qrBtn);
  });

  sendCodeBtn.addEventListener('click', function () {
    stopPolling();
    statusEl.textContent = 'Sending verification code...';
    postJson('/setup/phone', { phone: phoneInput.value }, sendCodeBtn);
  });

  verifyCodeBtn.addEventListener('click', function () {
    statusEl.textContent = 'Verifying code...';
    postJson('/setup/code', { code: codeInput.value }, verifyCodeBtn);
  });

  verifyPassBtn.addEventListener('click', function () {
    statusEl.textContent = 'Checking 2FA password...';
    postJson('/setup/password', { password: passInput.value }, verifyPassBtn);
  });

  fetch('/setup/status')
    .then(function (r) { return r.json(); })
    .then(applyStatus)
    .catch(function () {
      statusEl.textContent = 'Ready. Choose QR code login or phone login above.';
    });
})();
</script>
</body>
</html>
`
}

export function renderWebUi(
  config: AppConfig,
  stats: { count: number; totalBytes: number },
  baseUrl: string
): string {
  const safeBaseUrl = escapeHtml(baseUrl)
  const originTag = `<span class="origin">${safeBaseUrl}</span>`
  const maxSizeLabel = escapeHtml(formatBytes(config.maxFileSize))
  const storedLabel = escapeHtml(formatBytes(stats.totalBytes))
  const urlUploadStatus = config.allowUrlUpload ? 'enabled' : 'disabled'

  const urlFieldLine = config.allowUrlUpload
    ? `\nURL:  <input id="urlInput" type="url" name="url" placeholder="https://example.com/file.png" size="48">`
    : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TellShare</title>
</head>
<body>
<pre>${escapeHtml(ASCII_BANNER)}
TELLSHARE — 0x0.st-compatible file host (Telegram MTProto storage)
=====================================================================
Active files: ${stats.count} (${storedLabel}) | Max size: ${maxSizeLabel} | Retention: unlimited | URL uploads: ${urlUploadStatus}</pre>

<form id="uploadForm" method="POST" action="/" enctype="multipart/form-data">
<pre>UPLOAD
------
File: <input id="fileInput" type="file" name="file">${urlFieldLine}

<button id="submitBtn" type="submit">Upload</button></pre>
</form>

<pre id="output"></pre>

<pre>CURL &amp; HTTP API
---------------
1. Upload a local file (returns plain-text URL + X-Token response header):
   curl -F 'file=@yourfile.png' ${originTag}

2. Upload from a remote HTTP/HTTPS URL:
   curl -F 'url=https://example.com/file.png' ${originTag}

3. Request JSON metadata instead of plain text:
   curl -i -H 'Accept: application/json' -F 'file=@yourfile.png' ${originTag}
   -&gt; { "url": "...", "id": "...", "filename": "...", "size": 123, "mimeType": "...", "token": "..." }

4. Download / stream / partial byte ranges (media files embed on Discord, Telegram &amp; X):
   curl -O ${originTag}/&lt;id&gt;
   curl -O '${originTag}/&lt;id&gt;?raw=1'         (bypass embed HTML for crawlers)
   curl -OJ '${originTag}/&lt;id&gt;?download=1'   (force attachment download)
   curl -r 0-1023 ${originTag}/&lt;id&gt;          (returns HTTP 206 Partial Content)
   curl -I ${originTag}/&lt;id&gt;                 (HEAD metadata only)

5. Delete an uploaded file using its X-Token:
   curl -F 'token=YOUR_TOKEN' -F 'delete=' ${originTag}/&lt;id&gt;
   curl -X DELETE -H 'X-Token: YOUR_TOKEN' ${originTag}/&lt;id&gt;

6. Health check:
   curl ${originTag}/health</pre>

<pre>LEGAL &amp; PRIVACY POLICY
----------------------
- Privacy: No user accounts, cookies, analytics, or tracking. Local SQLite stores
  only file metadata (ID, filename, MIME, size, SHA-256, encryption salt/IV,
  Telegram message reference, hashed X-Token, timestamps, download count).
- Encryption &amp; Access: Files are AES-256-CTR encrypted before upload to Telegram.
  Anyone with the share URL can download the decrypted file; use X-Token to delete.
- Acceptable Use &amp; Warranty: Do not upload illegal, copyrighted, or malicious files.
  Provided "as-is" without warranty; operators may remove content at any time, and
  storage is subject to Telegram's Terms of Service.</pre>

<script>
(function () {
  if (window.location && window.location.origin && window.location.origin !== 'null') {
    document.querySelectorAll('.origin').forEach(function (el) {
      el.textContent = window.location.origin;
    });
  }

  var form = document.getElementById('uploadForm');
  var fileInput = document.getElementById('fileInput');
  var urlInput = document.getElementById('urlInput');
  var submitBtn = document.getElementById('submitBtn');
  var output = document.getElementById('output');

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KiB';
    return (n / (1024 * 1024)).toFixed(2) + ' MiB';
  }

  function asciiBar(pct) {
    var filled = Math.round((pct / 100) * 20);
    var bar = '';
    for (var i = 0; i < 20; i++) {
      bar += i < filled ? '#' : '-';
    }
    return '[' + bar + ']';
  }

  function newUploadId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return String(Date.now()) + '-' + Math.random().toString(36).slice(2);
  }

  if (fileInput && urlInput) {
    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files.length > 0) {
        urlInput.value = '';
      }
    });
    urlInput.addEventListener('input', function () {
      if (urlInput.value.trim() !== '') {
        fileInput.value = '';
      }
    });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    var file = fileInput && fileInput.files ? fileInput.files[0] : null;
    var url = urlInput ? urlInput.value.trim() : '';

    if (!file && !url) {
      output.textContent = 'Error: choose a file or enter a URL.';
      return;
    }
    if (file && url) {
      output.textContent = 'Error: provide either a file or a URL, not both.';
      return;
    }

    var fd = new FormData();
    if (file) {
      fd.append('file', file);
    } else {
      fd.append('url', url);
    }

    var uploadId = newUploadId();
    var pollTimer = null;

    function stopPoll() {
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    function startTelegramPoll() {
      if (pollTimer !== null) return;
      pollTimer = setInterval(function () {
        fetch('/upload-progress/' + encodeURIComponent(uploadId))
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (p) {
            if (!p || !p.total) return;
            var tgPct = Math.min(100, Math.round((p.uploaded / p.total) * 100));
            var totalPct = p.done ? 100 : Math.min(99, 50 + Math.round(tgPct * 0.5));
            output.textContent =
              asciiBar(totalPct) + ' ' + totalPct + '% (' +
              fmtBytes(p.uploaded) + ' / ' + fmtBytes(p.total) + ' -> Telegram)';
          })
          .catch(function () {});
      }, 350);
    }

    submitBtn.disabled = true;
    output.textContent = asciiBar(0) + ' 0%';

    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('X-Upload-Id', uploadId);

    xhr.upload.addEventListener('progress', function (ev) {
      if (ev.lengthComputable && ev.total > 0) {
        var totalPct = Math.min(50, Math.round((ev.loaded / ev.total) * 50));
        output.textContent =
          asciiBar(totalPct) + ' ' + totalPct + '% (' +
          fmtBytes(ev.loaded) + ' / ' + fmtBytes(ev.total) + ')';
        if (ev.loaded >= ev.total) {
          startTelegramPoll();
        }
      }
    });

    xhr.upload.addEventListener('load', function () {
      output.textContent = asciiBar(50) + ' 50% (Saving to Telegram...)';
      startTelegramPoll();
    });

    xhr.addEventListener('load', function () {
      stopPoll();
      submitBtn.disabled = false;
      if (xhr.status < 200 || xhr.status >= 300) {
        output.textContent = 'Error (' + xhr.status + '): ' + (xhr.responseText || 'Upload failed');
        return;
      }

      var data;
      try {
        data = JSON.parse(xhr.responseText);
      } catch (_) {
        output.textContent = xhr.responseText;
        return;
      }

      output.textContent = '';

      var link = document.createElement('a');
      link.href = data.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = data.url;

      output.appendChild(document.createTextNode('RESULT\\n------\\nURL:     '));
      output.appendChild(link);
      output.appendChild(
        document.createTextNode(
          '\\nX-Token: ' + data.token +
          '\\nSize:    ' + data.size + ' B (' + data.mimeType + ')' +
          '\\n\\n'
        )
      );

      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.textContent = 'Delete File';
      delBtn.addEventListener('click', function () {
        delBtn.disabled = true;
        fetch('/' + encodeURIComponent(data.id), {
          method: 'DELETE',
          headers: { 'X-Token': data.token }
        }).then(function (res) {
          if (res.ok) {
            output.textContent = 'Deleted ' + data.url;
          } else {
            delBtn.disabled = false;
            output.appendChild(document.createTextNode('\\nDelete failed (HTTP ' + res.status + ')'));
          }
        }).catch(function () {
          delBtn.disabled = false;
          output.appendChild(document.createTextNode('\\nNetwork error while deleting.'));
        });
      });

      output.appendChild(delBtn);
    });

    xhr.addEventListener('error', function () {
      stopPoll();
      submitBtn.disabled = false;
      output.textContent = 'Network error while uploading.';
    });

    xhr.send(fd);
  });
})();
</script>
</body>
</html>
`
}
