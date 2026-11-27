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
TELLSHARE - file host with Telegram storage backend
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
  <title>${title}</title>
  <meta property="og:site_name" content="TellShare">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${mimeType} (${sizeLabel})">
  <meta property="og:url" content="${pageUrl}">
${mediaTags}
  <meta name="theme-color" content="#38bdf8">
  <meta http-equiv="refresh" content="0;url=${rawUrl}">
</head>
<body>
<pre><a href="${rawUrl}">${title}</a> (${sizeLabel})</pre>
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
TELLSHARE - file host with Telegram storage backend
=====================================================================
Active files: ${stats.count} (${storedLabel}) | Max size: ${maxSizeLabel} | Retention: unlimited | URL uploads: ${urlUploadStatus}</pre>

<form id="uploadForm" method="POST" action="/" enctype="multipart/form-data">
<pre>UPLOAD
------
File: <input id="fileInput" type="file" name="file">${urlFieldLine}

<button id="submitBtn" type="submit">Upload</button> <progress id="progress" value="0" max="100" hidden></progress></pre>
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
  var progress = document.getElementById('progress');
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

  function resetProgress() {
    progress.hidden = true;
    progress.value = 0;
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

    submitBtn.disabled = true;
    progress.hidden = false;
    progress.value = 0;
    output.textContent = asciiBar(0) + ' 0%';

    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/');
    xhr.setRequestHeader('Accept', 'application/json');

    xhr.upload.addEventListener('progress', function (ev) {
      if (ev.lengthComputable && ev.total > 0) {
        var pct = Math.round((ev.loaded / ev.total) * 100);
        if (pct >= 100) {
          progress.removeAttribute('value');
          output.textContent = asciiBar(100) + ' 100% (' + fmtBytes(ev.total) + ') - Saving to Telegram...';
        } else {
          progress.value = pct;
          output.textContent = asciiBar(pct) + ' ' + pct + '% (' + fmtBytes(ev.loaded) + ' / ' + fmtBytes(ev.total) + ')';
        }
      }
    });

    xhr.addEventListener('load', function () {
      submitBtn.disabled = false;
      resetProgress();
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
      submitBtn.disabled = false;
      resetProgress();
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
