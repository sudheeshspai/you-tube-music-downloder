const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Downloads folder
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads', 'YTMusic');
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// ─── Invidious instance management ────────────────────────────────────────────
// These are confirmed working instances with api:true from api.invidious.io
let invidiousInstances = [
  'https://inv.thepixora.com',        // api:true, cors:true
  'https://invidious.nerdvpn.de',     // fallback
  'https://inv.nadeko.net',           // fallback
  'https://yt.chocolatemoo53.com',    // fallback
];

// At startup, refresh instance list from official source
async function refreshInstances() {
  try {
    const res = await fetch('https://api.invidious.io/instances.json', {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return;
    const list = await res.json();
    // Filter: must be https, prefer api:true
    const withApi = list
      .filter(([, d]) => d.type === 'https' && d.api === true && d.monitor && !d.monitor.down)
      .map(([, d]) => d.uri);
    const withoutApi = list
      .filter(([, d]) => d.type === 'https' && d.api !== false && d.monitor && !d.monitor.down)
      .map(([, d]) => d.uri);
    const merged = [...new Set([...withApi, ...withoutApi])];
    if (merged.length > 0) {
      invidiousInstances = merged;
      console.log(`[Invidious] Loaded ${merged.length} instances (${withApi.length} with API)`);
    }
  } catch (e) {
    console.warn('[Invidious] Could not refresh instance list:', e.message);
  }
}

// Call once at startup, refresh every 6 hours
refreshInstances();
setInterval(refreshInstances, 6 * 60 * 60 * 1000);

// ─── Helpers ──────────────────────────────────────────────────────────────────
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

// Fetch video info from Invidious, trying each instance
async function fetchInvidiousInfo(videoId) {
  const errors = [];
  for (const instance of invidiousInstances) {
    try {
      const url = `${instance}/api/v1/videos/${videoId}?fields=title,author,lengthSeconds,viewCount,published,videoThumbnails,adaptiveFormats,description`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(12000),
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.title) {
          console.log(`[Invidious] OK from ${instance}`);
          return { data, instance };
        }
      } else {
        errors.push(`${instance}: HTTP ${res.status}`);
      }
    } catch (e) {
      errors.push(`${instance}: ${e.message}`);
      console.warn(`[Invidious] ${instance} failed: ${e.message}`);
    }
  }
  throw new Error(`All instances failed: ${errors.slice(0, 3).join('; ')}`);
}

// Pick best audio stream from Invidious adaptiveFormats
function pickBestAudio(formats = []) {
  const audioOnly = formats.filter(f => f.type && f.type.startsWith('audio/'));
  // Sort by bitrate descending
  audioOnly.sort((a, b) => (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0));
  return audioOnly[0] || null;
}

// Best thumbnail from Invidious thumbnails array
function bestThumbnail(thumbnails = []) {
  if (!thumbnails.length) return '';
  // Prefer maxresdefault, then hqdefault
  const maxres = thumbnails.find(t => t.quality === 'maxresdefault');
  const hq = thumbnails.find(t => t.quality === 'hqdefault');
  return (maxres || hq || thumbnails[0]).url || '';
}

// ─── GET /api/info ─────────────────────────────────────────────────────────────
app.get('/api/info', async (req, res) => {
  const { url } = req.query;

  if (!url) return res.status(400).json({ error: 'URL is required' });
  if (!isValidYouTubeUrl(url))
    return res.status(400).json({ error: 'Invalid YouTube URL. Paste a youtube.com or youtu.be link.' });

  const videoId = extractVideoId(url);
  if (!videoId)
    return res.status(400).json({ error: 'Could not extract video ID from URL.' });

  try {
    const { data, instance } = await fetchInvidiousInfo(videoId);
    const bestAudio = pickBestAudio(data.adaptiveFormats || []);

    res.json({
      title: data.title,
      uploader: data.author,
      duration: data.lengthSeconds,
      thumbnail: bestThumbnail(data.videoThumbnails || []),
      view_count: data.viewCount,
      upload_date: data.published
        ? new Date(data.published * 1000).toISOString().slice(0, 10).replace(/-/g, '')
        : null,
      description: data.description ? data.description.substring(0, 200) : '',
      webpage_url: `https://www.youtube.com/watch?v=${videoId}`,
      videoId,
      audioUrl: bestAudio ? bestAudio.url : null,
      _instance: instance,
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

  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Could not extract video ID' });

  try {
    const { data } = await fetchInvidiousInfo(videoId);
    const bestAudio = pickBestAudio(data.adaptiveFormats || []);
    if (!bestAudio) return res.status(500).json({ error: 'No audio stream found' });

    const filename = `${safeFilename(data.title)}.${format}`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', format === 'mp3' ? 'audio/mpeg' : 'audio/ogg');
    res.setHeader('X-Filename', filename);

    const ffmpegArgs = buildFfmpegArgs(bestAudio.url, format, quality, 'pipe:1');
    const proc = spawn('ffmpeg', ffmpegArgs);
    proc.stdout.pipe(res);
    proc.stderr.on('data', () => {});
    proc.on('error', (err) => {
      console.error('[ffmpeg error]', err);
      if (!res.headersSent) res.status(500).json({ error: 'Conversion failed' });
    });
    req.on('close', () => proc.kill());
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

  const videoId = extractVideoId(url);
  if (!videoId) {
    send({ status: 'error', message: 'Invalid YouTube URL' });
    return res.end();
  }

  try {
    send({ status: 'starting', percent: 5, message: 'Fetching video info...' });

    const { data } = await fetchInvidiousInfo(videoId);
    const bestAudio = pickBestAudio(data.adaptiveFormats || []);

    if (!bestAudio) {
      send({ status: 'error', message: 'No audio stream available for this video.' });
      return res.end();
    }

    send({ status: 'starting', percent: 20, message: 'Starting download...' });

    const safeTitle = safeFilename(data.title);
    const outputFile = path.join(DOWNLOAD_DIR, `${safeTitle}.${format}`);
    const duration = data.lengthSeconds || 0;

    // ffmpeg reads audio URL, converts, reports progress via stderr
    const ffmpegArgs = buildFfmpegArgs(bestAudio.url, format, quality, outputFile, true);
    const proc = spawn('ffmpeg', ffmpegArgs);
    let killed = false;

    proc.stderr.on('data', (chunk) => {
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

    proc.stdout.on('data', () => {});

    proc.on('close', (code) => {
      if (killed) return;
      if (code === 0) {
        send({ status: 'done', percent: 100, message: 'Download complete! Check your YTMusic folder.' });
      } else {
        send({ status: 'error', message: 'Conversion failed. Please try again.' });
      }
      res.end();
    });

    req.on('close', () => {
      killed = true;
      proc.kill();
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

app.listen(PORT, () => {
  console.log(`\n🎵 YTMusic Downloader running at http://localhost:${PORT}\n`);
});
