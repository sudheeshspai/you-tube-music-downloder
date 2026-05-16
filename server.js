const express = require('express');
const cors = require('cors');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Downloads folder - use /app/downloads in Docker, otherwise ~/Downloads/YTMusic
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads', 'YTMusic');
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// Helper: sanitize URL
function isValidYouTubeUrl(url) {
  const pattern = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/|playlist\?list=)|youtu\.be\/)[\w\-]+/;
  return pattern.test(url);
}

// GET /api/info - Fetch video metadata
app.get('/api/info', (req, res) => {
  const { url } = req.query;

  if (!url) return res.status(400).json({ error: 'URL is required' });
  if (!isValidYouTubeUrl(url)) return res.status(400).json({ error: 'Invalid YouTube URL' });

  const args = [
    '--dump-json',
    '--no-playlist',
    '--quiet',
    url
  ];

  const proc = spawn('yt-dlp', args);
  let output = '';
  let errOutput = '';

  proc.stdout.on('data', (data) => { output += data.toString(); });
  proc.stderr.on('data', (data) => { errOutput += data.toString(); });

  proc.on('close', (code) => {
    if (code !== 0) {
      console.error('yt-dlp error:', errOutput);
      return res.status(500).json({ error: 'Could not fetch video info. Check the URL and try again.' });
    }
    try {
      const info = JSON.parse(output);
      res.json({
        title: info.title,
        uploader: info.uploader || info.channel,
        duration: info.duration,
        thumbnail: info.thumbnail,
        view_count: info.view_count,
        like_count: info.like_count,
        upload_date: info.upload_date,
        description: info.description ? info.description.substring(0, 200) : '',
        webpage_url: info.webpage_url
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse video info' });
    }
  });
});

// POST /api/download - Stream audio download to client
app.post('/api/download', (req, res) => {
  const { url, format = 'mp3', quality = '320' } = req.body;

  if (!url) return res.status(400).json({ error: 'URL is required' });
  if (!isValidYouTubeUrl(url)) return res.status(400).json({ error: 'Invalid YouTube URL' });

  // First get title for filename
  exec(`yt-dlp --print title --no-playlist "${url}"`, (err, stdout) => {
    const title = stdout ? stdout.trim().replace(/[^a-zA-Z0-9 \-_.]/g, '_') : 'audio';
    const filename = `${title}.${format}`;

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', format === 'mp3' ? 'audio/mpeg' : 'audio/opus');
    res.setHeader('X-Filename', filename);

    let args;
    if (format === 'mp3') {
      args = [
        '--no-playlist',
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', `${quality}K`,
        '-o', '-',
        '--no-warnings',
        url
      ];
    } else {
      // opus/ogg
      args = [
        '--no-playlist',
        '-x',
        '--audio-format', format,
        '-o', '-',
        '--no-warnings',
        url
      ];
    }

    const proc = spawn('yt-dlp', args);

    proc.stdout.pipe(res);

    let errLog = '';
    proc.stderr.on('data', (d) => { errLog += d.toString(); });

    proc.on('error', (err) => {
      console.error('Process error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Download failed' });
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        console.error('Download failed:', errLog);
      }
    });

    req.on('close', () => {
      proc.kill();
    });
  });
});

// SSE progress endpoint
app.get('/api/progress', (req, res) => {
  const { url, format = 'mp3', quality = '320' } = req.query;

  if (!url) return res.status(400).json({ error: 'URL is required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  send({ status: 'starting', message: 'Initializing download...' });

  const args = [
    '--no-playlist',
    '-x',
    '--audio-format', format,
    '--audio-quality', format === 'mp3' ? `${quality}K` : '0',
    '--newline',
    '--progress',
    '-o', path.join(DOWNLOAD_DIR, '%(title)s.%(ext)s'),
    url
  ];

  const proc = spawn('yt-dlp', args);

  proc.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach(line => {
      if (!line.trim()) return;
      // Parse progress line
      const dlMatch = line.match(/\[download\]\s+([\d.]+)%/);
      if (dlMatch) {
        const percent = parseFloat(dlMatch[1]);
        const etaMatch = line.match(/ETA\s+([\d:]+)/);
        const speedMatch = line.match(/([\d.]+\w+\/s)/);
        send({
          status: 'downloading',
          percent,
          eta: etaMatch ? etaMatch[1] : null,
          speed: speedMatch ? speedMatch[1] : null,
          message: `Downloading... ${percent.toFixed(1)}%`
        });
      } else if (line.includes('[ExtractAudio]')) {
        send({ status: 'converting', percent: 95, message: 'Converting to MP3...' });
      } else if (line.includes('[download] Destination')) {
        const fileMatch = line.match(/Destination: (.+)$/);
        if (fileMatch) {
          send({ status: 'saving', percent: 85, message: 'Saving file...' });
        }
      }
    });
  });

  proc.stderr.on('data', (data) => {
    const msg = data.toString();
    if (!msg.includes('WARNING')) {
      send({ status: 'info', message: msg.trim() });
    }
  });

  proc.on('close', (code) => {
    if (code === 0) {
      send({ status: 'done', percent: 100, message: 'Download complete! Check your YTMusic folder.' });
    } else {
      send({ status: 'error', message: 'Download failed. Please try again.' });
    }
    res.end();
  });

  req.on('close', () => {
    proc.kill();
  });
});

app.listen(PORT, () => {
  console.log(`\n🎵 YouTube Music Downloader running at http://localhost:${PORT}\n`);
});
