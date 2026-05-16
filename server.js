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

// ─── Piped API instances (fallback list) ──────────────────────────────────────
// Piped is an open-source YouTube proxy — it fetches from YouTube on its own
// unblocked servers so Railway's IP block doesn't matter.
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://piped-api.garudalinux.org',
  'https://api.piped.privacydev.net',
  'https://pipedapi.tokhmi.xyz',
];

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
  return (title || 'audio').replace(/[^\w\s\-\.]/g, '_').trim();
}

// Fetch from Piped, trying each instance until one succeeds
async function fetchPipedInfo(videoId) {
  for (const instance of PIPED_INSTANCES) {
    try {
      const res = await fetch(`${instance}/streams/${videoId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(12000),
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.title) {
          console.log(`[Piped] Fetched from ${instance}`);
          return data;
        }
      }
    } catch (e) {
      console.warn(`[Piped] ${instance} failed: ${e.message}`);
    }
  }
  throw new Error('All Piped instances failed');
}

// Pick best audio stream from Piped response
function pickBestAudio(audioStreams = []) {
  // Prefer opus/webm at highest bitrate, fallback to any
  const sorted = [...audioStreams].sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  return sorted[0] || null;
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
    const data = await fetchPipedInfo(videoId);

    const bestAudio = pickBestAudio(data.audioStreams);

    res.json({
      title: data.title,
      uploader: data.uploader,
      duration: data.duration,
      thumbnail: data.thumbnailUrl,
      view_count: data.views,
      upload_date: null, // Piped doesn't always return this
      description: data.description ? data.description.substring(0, 200) : '',
      webpage_url: `https://www.youtube.com/watch?v=${videoId}`,
      videoId,
      audioUrl: bestAudio ? bestAudio.url : null,
    });
  } catch (e) {
    console.error('[/api/info]', e.message);
    res.status(500).json({
      error: 'Could not fetch video info. The video may be private, age-restricted, or unavailable.',
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
    const data = await fetchPipedInfo(videoId);
    const bestAudio = pickBestAudio(data.audioStreams);
    if (!bestAudio) return res.status(500).json({ error: 'No audio stream found' });

    const filename = `${safeFilename(data.title)}.${format}`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', format === 'mp3' ? 'audio/mpeg' : 'audio/opus');
    res.setHeader('X-Filename', filename);

    const ffmpegArgs = [
      '-y', '-i', bestAudio.url,
      ...(format === 'mp3'
        ? ['-vn', '-ar', '44100', '-ac', '2', '-ab', `${quality}k`, '-f', 'mp3']
        : ['-vn', '-f', format]),
      'pipe:1',
    ];

    const proc = spawn('ffmpeg', ffmpegArgs);
    proc.stdout.pipe(res);
    proc.stderr.on('data', () => {}); // suppress ffmpeg logs
    proc.on('error', (err) => {
      console.error('[ffmpeg error]', err);
      if (!res.headersSent) res.status(500).json({ error: 'Conversion failed' });
    });
    req.on('close', () => proc.kill());
  } catch (e) {
    console.error('[/api/download]', e.message);
    res.status(500).json({ error: 'Download failed. Try again.' });
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

    const data = await fetchPipedInfo(videoId);
    const bestAudio = pickBestAudio(data.audioStreams);

    if (!bestAudio) {
      send({ status: 'error', message: 'No audio stream available for this video.' });
      return res.end();
    }

    send({ status: 'starting', percent: 15, message: 'Starting download...' });

    const safeTitle = safeFilename(data.title);
    const outputFile = path.join(DOWNLOAD_DIR, `${safeTitle}.${format}`);
    const duration = data.duration || 0;

    // ffmpeg: read from piped stream URL, write to file, report progress
    const ffmpegArgs = [
      '-y',
      '-i', bestAudio.url,
      ...(format === 'mp3'
        ? ['-vn', '-ar', '44100', '-ac', '2', '-ab', `${quality}k`, '-f', 'mp3']
        : ['-vn', '-f', format]),
      '-progress', 'pipe:2',
      outputFile,
    ];

    const proc = spawn('ffmpeg', ffmpegArgs);
    let killed = false;

    // ffmpeg sends -progress output to stderr (pipe:2)
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      // parse out_time_ms for progress
      const timeMatch = text.match(/out_time_ms=(\d+)/);
      if (timeMatch && duration > 0) {
        const elapsed = parseInt(timeMatch[1]) / 1000000;
        const pct = Math.min(95, 15 + (elapsed / duration) * 80);
        send({
          status: 'downloading',
          percent: Math.round(pct),
          message: `Processing... ${Math.round(pct)}%`,
        });
      }
    });

    proc.stdout.on('data', () => {}); // suppress

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
    console.error('[/api/progress]', e.message);
    send({ status: 'error', message: 'Could not reach video source. Try again.' });
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`\n🎵 YTMusic Downloader running at http://localhost:${PORT}\n`);
});
