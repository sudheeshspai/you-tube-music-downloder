// ──────────────────────────────────────────────
// API Base URL
// When deployed on Netlify, set this to your Railway backend URL.
// Example: const API_BASE = 'https://your-app.up.railway.app';
// When running locally, leave as empty string (uses relative /api paths).
// ──────────────────────────────────────────────
const API_BASE = '';   // ← Replace with your Railway URL after deploying backend

// State
let currentFormat = 'mp3';
let videoInfo = null;
let progressEventSource = null;

// Format selector
function setFormat(fmt) {
  currentFormat = fmt;
  document.querySelectorAll('.fmt-btn').forEach(b => b.classList.remove('active-fmt'));
  document.getElementById(`fmt${fmt.charAt(0).toUpperCase()+fmt.slice(1)}`).classList.add('active-fmt');
  const qualitySelect = document.getElementById('qualitySelect');
  qualitySelect.disabled = fmt !== 'mp3';
  qualitySelect.style.opacity = fmt === 'mp3' ? '1' : '0.4';
}

// Paste from clipboard
async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      document.getElementById('urlInput').value = text.trim();
      showError('');
    }
  } catch {
    // Fallback: focus input so user can paste manually
    document.getElementById('urlInput').focus();
  }
}

// Clear everything
function clearAll() {
  document.getElementById('urlInput').value = '';
  hideAll();
  videoInfo = null;
  showError('');
}

function hideAll() {
  ['infoCard','progressCard','successCard','errorCard'].forEach(id => {
    document.getElementById(id).classList.add('hidden');
  });
}

function showError(msg) {
  const el = document.getElementById('urlError');
  if (msg) { el.textContent = msg; el.classList.remove('hidden'); }
  else { el.classList.add('hidden'); }
}

function showCard(id) {
  hideAll();
  document.getElementById(id).classList.remove('hidden');
}

// Format helpers
function formatDuration(secs) {
  if (!secs) return '';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2,'0')}`;
}
function formatViews(n) {
  if (!n) return '';
  if (n >= 1e9) return (n/1e9).toFixed(1)+'B views';
  if (n >= 1e6) return (n/1e6).toFixed(1)+'M views';
  if (n >= 1e3) return (n/1e3).toFixed(1)+'K views';
  return n+' views';
}
function formatDate(d) {
  if (!d || d.length < 8) return '';
  return `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
}

// Fetch video info
async function fetchInfo() {
  const url = document.getElementById('urlInput').value.trim();
  if (!url) { showError('Please enter a YouTube URL'); return; }

  const btn = document.getElementById('fetchBtn');
  btn.textContent = 'Loading...';
  btn.disabled = true;
  hideAll();
  showError('');

  try {
    const res = await fetch(`${API_BASE}/api/info?url=${encodeURIComponent(url)}`);
    const data = await res.json();

    if (!res.ok) {
      showError(data.error || 'Failed to fetch video info');
      btn.textContent = 'Fetch Info';
      btn.disabled = false;
      return;
    }

    videoInfo = data;
    populateInfoCard(data);
    showCard('infoCard');
  } catch (e) {
    showError('Network error. Is the server running?');
  }

  btn.textContent = 'Fetch Info';
  btn.disabled = false;
}

function populateInfoCard(info) {
  document.getElementById('thumbnail').src = info.thumbnail || '';
  document.getElementById('videoTitle').textContent = info.title || 'Unknown Title';
  document.getElementById('videoUploader').querySelector('span').textContent = info.uploader || 'Unknown';
  document.getElementById('duration').textContent = formatDuration(info.duration);
  document.getElementById('viewCount').innerHTML = `
    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
    ${formatViews(info.view_count)}`;
  document.getElementById('uploadDate').innerHTML = `
    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
    ${formatDate(info.upload_date)}`;
}

// Start download via SSE progress
function startDownload() {
  const url = document.getElementById('urlInput').value.trim();
  if (!url) return;

  const quality = document.getElementById('qualitySelect').value;

  // Close any existing SSE
  if (progressEventSource) { progressEventSource.close(); }

  showCard('progressCard');

  const params = new URLSearchParams({ url, format: currentFormat, quality });
  progressEventSource = new EventSource(`${API_BASE}/api/progress?${params}`);

  progressEventSource.onmessage = (e) => {
    const data = JSON.parse(e.data);
    updateProgress(data);

    if (data.status === 'done') {
      progressEventSource.close();
      setTimeout(() => showCard('successCard'), 800);
    } else if (data.status === 'error') {
      progressEventSource.close();
      document.getElementById('errorMessage').textContent = data.message;
      showCard('errorCard');
    }
  };

  progressEventSource.onerror = () => {
    progressEventSource.close();
    document.getElementById('errorMessage').textContent = 'Connection lost. Please try again.';
    showCard('errorCard');
  };
}

function updateProgress(data) {
  const pct = data.percent || 0;
  document.getElementById('progressBar').style.width = pct + '%';
  document.getElementById('progressPercent').textContent = pct.toFixed(0) + '%';
  document.getElementById('progressMessage').textContent = data.message || 'Processing...';

  if (data.speed && data.eta) {
    document.getElementById('progressSub').textContent = `${data.speed} · ETA ${data.eta}`;
  } else if (data.speed) {
    document.getElementById('progressSub').textContent = data.speed;
  }

  if (data.eta) {
    document.getElementById('progressEta').textContent = `ETA ${data.eta}`;
  }

  // Swap icon on done/convert
  const icon = document.getElementById('progressIcon');
  if (data.status === 'converting') {
    icon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"/>`;
  }
}

// Enter key in input triggers fetch
document.getElementById('urlInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') fetchInfo();
});

// Auto-detect pasted URL
document.getElementById('urlInput').addEventListener('paste', (e) => {
  setTimeout(() => {
    const val = document.getElementById('urlInput').value.trim();
    if (val.includes('youtube.com') || val.includes('youtu.be')) {
      fetchInfo();
    }
  }, 100);
});
