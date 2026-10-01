// Velix storage janitor — runs every 10 min so disk never fills up.
// Our downloads stream directly (no saved files), but yt-dlp/ffmpeg/os
// still leave temp crumbs (cookies copies, .part, .temp, fragment files).
const fs = require('fs');
const path = require('path');
const os = require('os');

const INTERVAL_MS = 10 * 60 * 1000; // 10 min
const MAX_AGE_MS = 10 * 60 * 1000;  // delete tmp files older than 10 min
const LIVE_NAMES = new Set(['cookies.txt', 'cookies_url.txt']); // re-created on demand, keep fresh ones

const status = {
  enabled: true,
  intervalMin: 10,
  lastRun: null,
  lastFreedBytes: 0,
  lastDeleted: 0,
  totalFreedBytes: 0,
  totalDeleted: 0,
};

function dirSize(p) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(p)) {
      try {
        const fp = path.join(p, f);
        const st = fs.statSync(fp);
        if (st.isFile()) total += st.size;
      } catch {}
    }
  } catch {}
  return total;
}

function tmpDirs() {
  const dirs = [os.tmpdir()];
  try {
    const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
    dirs.push(path.join(cache, 'yt-dlp'));
    if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
      dirs.push(path.join(process.env.LOCALAPPDATA, 'yt-dlp'));
    }
  } catch {}
  // legacy local download folders (unused now, but clean if present)
  dirs.push(path.join(process.cwd(), 'downloads'));
  dirs.push(path.join(process.cwd(), 'tmp'));
  return [...new Set(dirs)];
}

// Patterns that are safe to auto-delete (yt-dlp/ffmpeg/os temp crumbs)
const TMP_PATTERNS = [
  /^cookies.*\.txt$/i,
  /\.part$/i,
  /\.temp$/i,
  /\.tmp$/i,
  /^tmp[a-z0-9_-]*$/i,
  /^ytdl/i,
  /^ffmpeg/i,
  /\.ytdl$/i,
  /\.frag$/i,
  /\.f\d+$/i, // fragment files
];

function shouldDelete(name, fullPath, now) {
  if (!TMP_PATTERNS.some((re) => re.test(name))) return false;
  let st;
  try { st = fs.statSync(fullPath); } catch { return false; }
  if (!st.isFile()) return false;
  // Never delete a fresh live cookies file (in use by running downloads)
  if (LIVE_NAMES.has(name) && now - st.mtimeMs < MAX_AGE_MS) return false;
  return now - st.mtimeMs > MAX_AGE_MS;
}

function sweep() {
  const now = Date.now();
  let deleted = 0, freed = 0;
  for (const dir of tmpDirs()) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const fp = path.join(dir, name);
      try {
        if (!shouldDelete(name, fp, now)) continue;
        const size = fs.statSync(fp).size;
        fs.unlinkSync(fp);
        deleted++; freed += size;
      } catch {}
    }
  }
  status.lastRun = new Date().toISOString();
  status.lastDeleted = deleted;
  status.lastFreedBytes = freed;
  status.totalDeleted += deleted;
  status.totalFreedBytes += freed;
  if (deleted > 0 || process.env.NODE_ENV !== 'production') {
    console.log(`[janitor] cleaned ${deleted} file(s), freed ${(freed / 1024).toFixed(1)} KB (tmp=${(dirSize(os.tmpdir()) / 1024 / 1024).toFixed(1)} MB)`);
  }
  return { deleted, freed };
}

function start() {
  // first sweep shortly after boot (lets startup files settle)
  setTimeout(sweep, 30 * 1000).unref?.();
  const timer = setInterval(sweep, INTERVAL_MS);
  timer.unref?.(); // never keep the process alive just for the janitor
  console.log('[janitor] enabled — sweep every 10 min');
  return timer;
}

function getStatus() {
  return {
    ...status,
    tmpDir: os.tmpdir(),
    tmpSizeMB: +(dirSize(os.tmpdir()) / 1024 / 1024).toFixed(2),
  };
}

module.exports = { start, sweep, getStatus };
