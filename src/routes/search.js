const express = require('express');
const router = express.Router();

function ytDlpSearch(query, limit = 10) {
  return new Promise((resolve, reject) => {
    const path = require('path');
    const fs = require('fs');
    const { spawn } = require('child_process');
    let ytDlpPath = path.join(__dirname, '../../node_modules/yt-dlp-exec/bin/yt-dlp');
    if (process.platform === 'win32') ytDlpPath += '.exe';
    if (!fs.existsSync(ytDlpPath)) {
      const alt = ytDlpPath.endsWith('.exe') ? ytDlpPath.slice(0,-4) : ytDlpPath + '.exe';
      if (fs.existsSync(alt)) ytDlpPath = alt;
    }
    // Use ytsearch: yt-dlp can search youtube - android client bypasses bot-check
    let cookiesArgs = [];
    try { cookiesArgs = require('../utils/cookies').getCookiesArgs(); } catch {}
    const args = [`ytsearch${limit}:${query}`, '--dump-json', '--flat-playlist', '--no-warnings', '--no-cache-dir', '--extractor-args', 'youtube:player_client=web,android,ios,mweb', ...cookiesArgs];
    const proc = spawn(ytDlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => {
      if (code !== 0 && !out) return reject(new Error(err.slice(0,400) || `yt-dlp search exit ${code}`));
      try {
        const lines = out.trim().split('\n').filter(Boolean);
        const videos = lines.map(l => {
          const j = JSON.parse(l);
          return {
            id: j.id,
            title: j.title,
            url: j.url || `https://www.youtube.com/watch?v=${j.id}`,
            thumbnail: j.thumbnail || (j.thumbnails?.[0]?.url) || `https://img.youtube.com/vi/${j.id}/hqdefault.jpg`,
            thumbnails: j.thumbnails || [],
            duration: j.duration ? `${Math.floor(j.duration/60)}:${String(j.duration%60).padStart(2,'0')}` : '',
            seconds: j.duration || 0,
            views: j.view_count || 0,
            ago: j.upload_date || '',
            author: { name: j.uploader || j.channel || '', url: j.channel_url || '' }
          };
        });
        resolve(videos);
      } catch (e) { reject(e); }
    });
    proc.on('error', reject);
    setTimeout(() => { proc.kill(); reject(new Error('yt-dlp search timeout')); }, 15000);
  });
}

router.get('/', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing query param: ?q=keyword' });

  // 1) yt-dlp search first (most stable on Render)
  try {
    const videos = await ytDlpSearch(q, 10);
    if (videos.length) return res.json({ query: q, count: videos.length, videos, source: 'yt-dlp' });
  } catch (e) {
    console.warn('yt-dlp search failed:', e.message);
  }

  // 2) play-dl
  try {
    const playdl = await import('play-dl');
    const results = await playdl.search(q, { limit: 10, source: { youtube: 'video' } });
    const videos = results.map(v => ({
      id: v.id, title: v.title, url: v.url,
      thumbnail: v.thumbnails?.[0]?.url, thumbnails: v.thumbnails,
      duration: v.durationRaw, seconds: v.durationInSec, views: v.views, ago: v.uploadedAt,
      author: { name: v.channel?.name, url: v.channel?.url }
    }));
    if (videos.length) return res.json({ query: q, count: videos.length, videos, source: 'play-dl' });
  } catch (e) {
    console.warn('play-dl search failed:', e.message);
  }

  // 3) yt-search last fallback
  try {
    const ytSearch = require('yt-search');
    const result = await ytSearch(q);
    const videos = result.videos.slice(0, 10).map(v => ({
      id: v.videoId, title: v.title, url: v.url, thumbnail: v.thumbnail,
      duration: v.timestamp, seconds: v.seconds, views: v.views, ago: v.ago,
      author: { name: v.author?.name, url: v.author?.url }
    }));
    return res.json({ query: q, count: videos.length, videos, source: 'yt-search' });
  } catch (err) {
    console.error('All search methods failed:', err);
    return res.status(500).json({ error: 'Search failed', details: err.message });
  }
});

module.exports = router;
