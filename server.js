const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Temporary downloads folder for server-side processing
const DOWNLOAD_DIR = path.join(os.tmpdir(), 'ytmusic_downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// ─── yt-dlp Helpers ───────────────────────────────────────────────────────────
function fetchYtDlpInfo(url) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', ['--dump-json', '--no-playlist', '--no-warnings', url]);
    let output = '';
    let errorOutput = '';

    proc.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      errorOutput += chunk.toString();
    });

    proc.on('error', (err) => {
      reject(new Error('yt-dlp spawn error: ' + err.message));
    });

    proc.on('close', (code) => {
      if (code === 0) {
        try {
          const info = JSON.parse(output);
          resolve(info);
        } catch (err) {
          reject(new Error('Failed to parse yt-dlp JSON'));
        }
      } else {
        reject(new Error('yt-dlp error: ' + errorOutput));
      }
    });
  });
}

function extractVideoId(url) {
  const match = url.match(
    /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([^&\s?#]+)/
  );
  return match ? match[1] : null;
}

function isValidYouTubeUrl(url) {
  const pattern =
    /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=[\w\-]+|shorts\/[\w\-]+|playlist\?list=[\w\-]+)|youtu\.be\/[\w\-]+)(\?[^\s]*)?$/i;
  return pattern.test(url);
}

function safeFilename(title) {
  return (title || 'audio').replace(/[^\w\s\-\.]/g, '_').trim().substring(0, 100);
}

// ─── GET /api/info ─────────────────────────────────────────────────────────────
app.get('/api/info', async (req, res) => {
  const { url } = req.query;

  if (!url) return res.status(400).json({ error: 'URL is required' });
  if (!isValidYouTubeUrl(url))
    return res.status(400).json({ error: 'Invalid YouTube URL. Paste a youtube.com or youtu.be link.' });

  try {
    const info = await fetchYtDlpInfo(url);

    res.json({
      title: info.title,
      uploader: info.uploader,
      duration: info.duration,
      thumbnail: info.thumbnail || (info.thumbnails && info.thumbnails.length ? info.thumbnails[info.thumbnails.length - 1].url : ''),
      view_count: info.view_count,
      upload_date: info.upload_date,
      description: info.description ? info.description.substring(0, 200) : '',
      webpage_url: info.webpage_url,
      videoId: info.id,
      audioUrl: null,
      _instance: 'yt-dlp',
    });
  } catch (e) {
    console.error('[/api/info error]', e.message);
    res.status(500).json({
      error: 'Could not fetch video info. The video may be unavailable. Try again in a moment.',
    });
  }
});

// ─── POST /api/download ────────────────────────────────────────────────────────
app.post('/api/download', async (req, res) => {
  const { url, format = 'mp3', quality = '320' } = req.body;

  if (!url) return res.status(400).json({ error: 'URL is required' });
  if (!isValidYouTubeUrl(url))
    return res.status(400).json({ error: 'Invalid YouTube URL' });

  try {
    const info = await fetchYtDlpInfo(url);

    const filename = `${safeFilename(info.title)}.${format}`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', format === 'mp3' ? 'audio/mpeg' : 'audio/ogg');
    res.setHeader('X-Filename', filename);

    const ytProc = spawn('yt-dlp', ['-f', 'bestaudio', '-o', '-', '--no-warnings', url]);
    const ffmpegArgs = buildFfmpegArgs('pipe:0', format, quality, 'pipe:1');
    const ffmpegProc = spawn('ffmpeg', ffmpegArgs);

    ytProc.on('error', (err) => {
      console.error('[yt-dlp error]', err);
    });

    ytProc.stdout.pipe(ffmpegProc.stdin);
    ffmpegProc.stdout.pipe(res);

    ytProc.stderr.on('data', () => {});
    ffmpegProc.stderr.on('data', () => {});

    ffmpegProc.on('error', (err) => {
      console.error('[ffmpeg error]', err);
      if (!res.headersSent) res.status(500).json({ error: 'Conversion failed' });
    });

    req.on('close', () => {
      ytProc.kill();
      ffmpegProc.kill();
    });
  } catch (e) {
    console.error('[/api/download error]', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Download failed. Try again.' });
  }
});

// ─── GET /api/progress (SSE) ──────────────────────────────────────────────────
app.get('/api/progress', async (req, res) => {
  const { url, format = 'mp3', quality = '320' } = req.query;

  if (!url) return res.status(400).json({ error: 'URL is required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  if (!isValidYouTubeUrl(url)) {
    send({ status: 'error', message: 'Invalid YouTube URL' });
    return res.end();
  }

  try {
    send({ status: 'starting', percent: 5, message: 'Fetching video info...' });

    const info = await fetchYtDlpInfo(url);

    send({ status: 'starting', percent: 20, message: 'Starting download...' });

    const safeTitle = safeFilename(info.title);
    const fileId = crypto.randomBytes(8).toString('hex');
    const filename = `${safeTitle}_${fileId}.${format}`;
    const outputFile = path.join(DOWNLOAD_DIR, filename);
    const duration = info.duration || 0;

    const ytProc = spawn('yt-dlp', ['-f', 'bestaudio', '-o', '-', '--no-warnings', url]);
    const ffmpegArgs = buildFfmpegArgs('pipe:0', format, quality, outputFile, true);
    const ffmpegProc = spawn('ffmpeg', ffmpegArgs);

    ytProc.on('error', (err) => {
      console.error('[yt-dlp error]', err);
    });

    let killed = false;

    ytProc.stdout.pipe(ffmpegProc.stdin);

    ffmpegProc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      const timeMatch = text.match(/out_time_ms=(\d+)/);
      if (timeMatch && duration > 0) {
        const elapsed = parseInt(timeMatch[1]) / 1000000;
        const pct = Math.min(95, 20 + (elapsed / duration) * 75);
        send({
          status: 'downloading',
          percent: Math.round(pct),
          message: `Converting... ${Math.round(pct)}%`,
        });
      }
    });

    ffmpegProc.on('close', (code) => {
      if (killed) return;
      if (code === 0) {
        send({ 
          status: 'done', 
          percent: 100, 
          message: 'Conversion complete! Starting download...',
          downloadUrl: `/api/serve-file?filename=${encodeURIComponent(filename)}&originalName=${encodeURIComponent(safeTitle + '.' + format)}`
        });
      } else {
        send({ status: 'error', message: 'Conversion failed. Please try again.' });
      }
      res.end();
    });

    req.on('close', () => {
      killed = true;
      ytProc.kill();
      ffmpegProc.kill();
    });
  } catch (e) {
    console.error('[/api/progress error]', e.message);
    send({ status: 'error', message: 'Could not reach video. Try again in a moment.' });
    res.end();
  }
});

// ─── ffmpeg args builder ───────────────────────────────────────────────────────
function buildFfmpegArgs(inputUrl, format, quality, output, withProgress = false) {
  const args = ['-y', '-i', inputUrl];
  if (format === 'mp3') {
    args.push('-vn', '-ar', '44100', '-ac', '2', '-ab', `${quality}k`, '-f', 'mp3');
  } else if (format === 'm4a') {
    args.push('-vn', '-acodec', 'aac', '-f', 'mp4');
  } else {
    // opus / webm passthrough
    args.push('-vn', '-acodec', 'copy', '-f', 'webm');
  }
  if (withProgress) args.push('-progress', 'pipe:2');
  args.push(output);
  return args;
}

// ─── GET /api/serve-file ──────────────────────────────────────────────────────
app.get('/api/serve-file', (req, res) => {
  const { filename, originalName } = req.query;
  if (!filename) return res.status(400).send('Filename missing');
  
  const filePath = path.join(DOWNLOAD_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found or expired.');
  }

  res.download(filePath, originalName || filename, (err) => {
    if (err) {
      console.error('File download error:', err);
    }
    // Clean up the temporary file after it is sent to the client
    fs.unlink(filePath, (unlinkErr) => {
      if (unlinkErr) console.error('Cleanup error:', unlinkErr);
    });
  });
});

app.listen(PORT, () => {
  console.log(`\n🎵 YTMusic Downloader running at http://localhost:${PORT}\n`);
});
