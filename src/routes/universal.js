const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const SHRUTI_API_URL = process.env.SHRUTI_API_URL || 'https://api01.shrutibots.site';
const SHRUTI_API_KEY = process.env.SHRUTI_API_KEY || 'ShrutiBotsxWnI7qu8mp6KKll6to7F';

function getYtDlpPath() {
  let p = path.join(__dirname, '../../node_modules/yt-dlp-exec/bin/yt-dlp');
  if (process.platform === 'win32') p += '.exe';
  if (!fs.existsSync(p)) {
    const alt = p.endsWith('.exe') ? p.slice(0, -4) : p + '.exe';
    if (fs.existsSync(alt)) p = alt;
  }
  return p;
}

function detectPlatform(url = '') {
  const u = url.toLowerCase();
  if (u.includes('youtube.com') || u.includes('youtu.be') || u.includes('youtube.') || /^[a-zA-Z0-9_-]{11}$/.test(url.trim())) return 'youtube';
  if (u.includes('tiktok.com') || u.includes('vt.tiktok')) return 'tiktok';
  if (u.includes('instagram.com')) return 'instagram';
  if (u.includes('facebook.com') || u.includes('fb.watch') || u.includes('fb.com')) return 'facebook';
  if (u.includes('twitter.com') || u.includes('x.com')) return 'twitter';
  if (u.includes('pinterest.') || u.includes('pin.it')) return 'pinterest';
  return 'unknown';
}

function extractYoutubeId(input) {
  if (!input) return null;
  input = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  try {
    const u = new URL(input);
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).split('/')[0].split('?')[0];
    if (u.pathname.includes('/shorts/')) return u.pathname.split('/shorts/')[1].split('/')[0].split('?')[0];
    if (u.pathname.includes('/embed/')) return u.pathname.split('/embed/')[1].split('/')[0].split('?')[0];
    const parts = u.pathname.split('/').filter(Boolean);
    const last = parts.pop();
    if (last && /^[a-zA-Z0-9_-]{11}$/.test(last)) return last;
    return null;
  } catch { return null; }
}

function ytDlpInfo(url, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const ytDlpPath = getYtDlpPath();
    let cookiesArgs = [];
    try { cookiesArgs = require('../utils/cookies').getCookiesArgs(); } catch {}
    const args = [url, '--dump-json', '--no-playlist', '--no-warnings', '--no-cache-dir', '--skip-download', '--socket-timeout', '15', ...extraArgs, ...cookiesArgs];
    const proc = spawn(ytDlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d.toString(); if (out.length > 2_000_000) proc.kill(); });
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => {
      if (code !== 0 && !out) return reject(new Error(err.slice(0, 400) || `yt-dlp exit ${code}`));
      try {
        // yt-dlp may output multiple JSON lines; take first valid
        const firstLine = out.trim().split('\n')[0];
        resolve(JSON.parse(firstLine));
      } catch (e) { reject(new Error('Failed to parse yt-dlp json')); }
    });
    proc.on('error', reject);
    setTimeout(() => { try { proc.kill(); } catch {} reject(new Error('yt-dlp timeout')); }, 25000);
  });
}

function guessExt(u = '') {
  const m = u.split('?')[0].match(/\.(mp4|mov|webm|m4a|mp3|jpg|jpeg|png|webp)$/i);
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'mp4';
}

// Every format carries the REAL file URL on the source CDN/API.
// The app downloads it with the USER's own internet (browser fetch) —
// this server only fetches lightweight metadata, never the file bytes.
function pickFormats(j, platform, originalUrl, videoId) {
  const formats = [];
  if (platform === 'youtube' && videoId) {
    const shrutiAudio = `${SHRUTI_API_URL}/download?url=${videoId}&type=audio&api_key=${SHRUTI_API_KEY}`;
    const shrutiVideo = `${SHRUTI_API_URL}/download?url=${videoId}&type=video&api_key=${SHRUTI_API_KEY}`;
    formats.push(
      { id: 'shruti-mp4', label: 'MP4 Video', quality: 'HD', ext: 'mp4', type: 'video', url: shrutiVideo, direct: true, recommended: true },
      { id: 'shruti-mp3', label: 'MP3 Audio', quality: '128kbps', ext: 'mp3', type: 'audio', url: shrutiAudio, direct: true }
    );
    // Direct googlevideo MP4s (user's internet, no server in the middle)
    if (j && j.formats) {
      const withAudio = j.formats.filter(f => f.url && f.url.startsWith('http') && f.vcodec !== 'none' && f.acodec !== 'none' && (f.ext === 'mp4' || f.ext === 'webm'));
      const seen = new Set();
      for (const f of withAudio.sort((a, b) => (b.height || 0) - (a.height || 0))) {
        const h = f.height || 0;
        if (!h || seen.has(h)) continue;
        seen.add(h);
        formats.push({
          id: 'yt-' + f.format_id, label: `MP4 ${h}p`, quality: h + 'p', ext: 'mp4', type: 'video',
          url: f.url, direct: true, size: f.filesize || f.filesize_approx || null
        });
        if (seen.size >= 3) break;
      }
    }
    return formats;
  }

  // TikTok / Instagram / Facebook / Pinterest — direct CDN urls from yt-dlp
  if (j) {
    // Pinterest image pin → direct image URL (no video tracks)
    if (platform === 'pinterest') {
      const hasVideo = (j.formats || []).some(f => f.vcodec && f.vcodec !== 'none');
      if (!hasVideo) {
        const cand = [...(j.thumbnails || []), ...(j.thumbnail ? [{ url: j.thumbnail }] : [])]
          .map(t => t.url).filter(u => u && u.startsWith('http'));
        const bestImg = cand.sort((a, b) => b.length - a.length)[0]
          || (j.url && /^https?:.*\.(jpg|jpeg|png|webp)(\?|$)/i.test(j.url) ? j.url : null);
        if (bestImg) {
          formats.push({ id: 'img-hd', label: 'HD Image', quality: 'HD', ext: guessExt(bestImg), type: 'image', url: bestImg, direct: true, recommended: true });
          return formats;
        }
      }
    }
    const vids = (j.formats || []).filter(f => f.url && f.url.startsWith('http') && f.vcodec && f.vcodec !== 'none' && ['mp4', 'mov', 'webm'].includes(f.ext));
    const withAudio = vids.filter(f => f.acodec && f.acodec !== 'none').sort((a, b) => (b.height || 0) - (a.height || 0));
    const pool = withAudio.length ? withAudio : vids.sort((a, b) => (b.height || 0) - (a.height || 0));
    const seen = new Set();
    for (const f of pool.slice(0, 8)) {
      const q = f.height ? f.height + 'p' : (f.format_note || String(f.format_id));
      if (seen.has(q)) continue;
      seen.add(q);
      formats.push({
        id: String(f.format_id),
        label: (platform === 'tiktok' && formats.length === 0) ? 'MP4 No Watermark' : `MP4 ${q}`,
        quality: q, ext: 'mp4', type: 'video',
        url: f.url, direct: true,
        recommended: platform === 'tiktok' && formats.length === 0,
        size: f.filesize || f.filesize_approx || null
      });
      if (seen.size >= 4) break;
    }
    // Direct audio-only stream (no server conversion needed)
    const audioOnly = (j.formats || []).find(f => f.url && f.url.startsWith('http') && (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none');
    if (audioOnly) {
      formats.push({ id: 'audio-' + audioOnly.format_id, label: 'Audio', quality: audioOnly.abr ? Math.round(audioOnly.abr) + 'kbps' : 'Audio', ext: audioOnly.ext === 'mp4' ? 'm4a' : (audioOnly.ext || 'm4a'), type: 'audio', url: audioOnly.url, direct: true, size: audioOnly.filesize || audioOnly.filesize_approx || null });
    }
    if (formats.length && !formats.some(f => f.recommended)) formats[0].recommended = true;
    return formats;
  }

  // No info at all — nothing direct to offer (server proxy intentionally not used)
  return [];
}

// YouTube oEmbed — super fast title/author/thumbnail, no cookies, no 429.
// Makes Get Link near-instant; yt-dlp runs only as a short enrichment race.
async function ytOembed(canonical, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => { try { ctrl.abort(); } catch {} }, ms);
  try {
    const r = await fetch('https://www.youtube.com/oembed?url=' + encodeURIComponent(canonical) + '&format=json', { signal: ctrl.signal });
    if (!r.ok) throw new Error('oembed ' + r.status);
    return await r.json(); // { title, author_name, thumbnail_url, ... }
  } finally { clearTimeout(t); }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout after ' + ms + 'ms')), ms)),
  ]);
}
// GET /api/info?url=...
router.get('/', async (req, res) => {
  const originalUrl = (req.query.url || '').trim();
  if (!originalUrl) return res.status(400).json({ error: 'Missing ?url= parameter' });
  const platform = detectPlatform(originalUrl);
  if (platform === 'unknown') return res.status(400).json({ error: 'Unsupported link. Supported: YouTube, TikTok, Instagram, Facebook, Pinterest' });

  const videoId = platform === 'youtube' ? extractYoutubeId(originalUrl) : null;
  if (platform === 'youtube' && !videoId) return res.status(400).json({ error: 'Invalid YouTube link' });
  const canonical = platform === 'youtube' ? `https://www.youtube.com/watch?v=${videoId}` : originalUrl;

  let j = null;
  let meta = null; // fast oEmbed info (YouTube only)
  if (platform === 'youtube') {
    // Race: oEmbed answers in ~1s; yt-dlp gets max 7s for extras (duration/views/direct qualities)
    const results = await Promise.allSettled([
      withTimeout(ytOembed(canonical, 6000), 6500),
      withTimeout(ytDlpInfo(canonical, ['--extractor-args', 'youtube:player_client=web,android,ios,mweb']), 7000),
    ]);
    if (results[0].status === 'fulfilled') meta = results[0].value;
    if (results[1].status === 'fulfilled') j = results[1].value;
    else console.warn('universal info yt-dlp failed:', results[1].reason?.message);
  } else {
    try {
      j = await ytDlpInfo(canonical, []);
    } catch (e) {
      console.warn('universal info yt-dlp failed:', e.message);
      // No direct file URL available without metadata — frontend will show guidance instead of a dead button
      const titles = { tiktok: 'TikTok Video', instagram: 'Instagram Reel/Post', facebook: 'Facebook Video', pinterest: 'Pinterest Pin', twitter: 'X Video' };
      return res.json({
        platform,
        url: originalUrl,
        title: titles[platform] || 'Video',
        thumbnail: '',
        duration: null, durationFormatted: '',
        uploader: '', views: null,
        formats: [],
        source: 'generic-fallback',
        warning: 'Link er info ana jayni — public link kina check koro, abar try koro. Details: ' + e.message.slice(0, 120)
      });
    }
  }

  // Build unified response
  if (platform === 'youtube') {
    const thumbBase = `https://img.youtube.com/vi/${videoId}`;
    return res.json({
      platform,
      url: canonical,
      id: videoId,
      title: j?.title || meta?.title || 'YouTube Video',
      description: (j?.description || '').slice(0, 500),
      thumbnail: j?.thumbnail || meta?.thumbnail_url || `${thumbBase}/hqdefault.jpg`,
      thumbnails: { default: `${thumbBase}/default.jpg`, medium: `${thumbBase}/mqdefault.jpg`, high: `${thumbBase}/hqdefault.jpg`, maxres: `${thumbBase}/maxresdefault.jpg` },
      duration: j?.duration || null,
      durationFormatted: j?.duration_string || (j?.duration ? `${Math.floor(j.duration / 60)}:${String(j.duration % 60).padStart(2, '0')}` : ''),
      uploader: j?.uploader || j?.channel || meta?.author_name || '',
      views: j?.view_count ?? null,
      uploadDate: j?.upload_date || null,
      formats: pickFormats(j, platform, canonical, videoId),
      embed: `https://www.youtube.com/embed/${videoId}`,
      source: j ? 'yt-dlp+shruti' : (meta ? 'oembed+shruti' : 'shruti-only')
    });
  }

  // tiktok / insta / fb / pinterest
  return res.json({
    platform,
    url: originalUrl,
    id: j?.id || null,
    title: j?.title || j?.description?.slice(0, 80) || (platform === 'tiktok' ? 'TikTok Video' : platform === 'instagram' ? 'Instagram Media' : platform === 'pinterest' ? 'Pinterest Pin' : 'Facebook Video'),
    description: (j?.description || '').slice(0, 500),
    thumbnail: j?.thumbnail || j?.thumbnails?.[0]?.url || '',
    duration: j?.duration || null,
    durationFormatted: j?.duration_string || (j?.duration ? `${Math.floor(j.duration / 60)}:${String(j.duration % 60).padStart(2, '0')}` : ''),
    uploader: j?.uploader || j?.uploader_id || j?.channel || '',
    views: j?.view_count ?? null,
    width: j?.width, height: j?.height,
    formats: pickFormats(j, platform, originalUrl, null),
    source: 'yt-dlp'
  });
});

module.exports = router;
