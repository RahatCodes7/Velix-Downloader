const express = require('express');
const router = express.Router();
const ytdl = require('@distube/ytdl-core');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

function extractVideoId(input) {
  if (!input) return null;
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.searchParams.get('v')) return url.searchParams.get('v');
    const parts = url.pathname.split('/').filter(Boolean);
    return parts.pop();
  } catch { return input; }
}

function getYtDlpPath() {
  let p = path.join(__dirname, '../../node_modules/yt-dlp-exec/bin/yt-dlp');
  if (process.platform === 'win32') p += '.exe';
  if (!fs.existsSync(p)) {
    const alt = p.endsWith('.exe') ? p.slice(0,-4) : p + '.exe';
    if (fs.existsSync(alt)) p = alt;
  }
  return p;
}

function ytDlpInfo(url) {
  return new Promise((resolve, reject) => {
    const ytDlpPath = getYtDlpPath();
    let cookiesArgs = [];
    try { cookiesArgs = require('../utils/cookies').getCookiesArgs(); } catch {}
    const args = [url, '--dump-json', '--no-playlist', '--no-warnings', '--no-cache-dir', '--skip-download', '--extractor-args', 'youtube:player_client=web,android,ios,mweb', ...cookiesArgs];
    const proc = spawn(ytDlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => {
      if (code !== 0 && !out) return reject(new Error(err.slice(0,500) || `yt-dlp exit ${code}`));
      try { resolve(JSON.parse(out)); } catch(e){ reject(new Error('Failed to parse yt-dlp json: '+e.message)); }
    });
    proc.on('error', reject);
    setTimeout(() => { proc.kill(); reject(new Error('yt-dlp timeout')); }, 20000);
  });
}

router.get('/:id', async (req, res) => {
  const rawId = req.params.id;
  const videoId = extractVideoId(rawId);
  if (!videoId) return res.status(400).json({ error: 'Invalid video id or url' });
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  // 1) yt-dlp primary (best bypass for 429)
  try {
    const j = await ytDlpInfo(url);
    const thumbBase = `https://img.youtube.com/vi/${videoId}`;
    return res.json({
      id: videoId, url,
      title: j.title,
      description: (j.description||'').slice(0,1000),
      fullDescription: j.description,
      channel: j.uploader || j.channel,
      channelId: j.channel_id || j.uploader_id,
      channelUrl: j.channel_url || j.uploader_url,
      thumbnails: {
        default: `${thumbBase}/default.jpg`, medium: `${thumbBase}/mqdefault.jpg`,
        high: `${thumbBase}/hqdefault.jpg`, standard: `${thumbBase}/sddefault.jpg`,
        maxres: `${thumbBase}/maxresdefault.jpg`, list: j.thumbnails || []
      },
      thumbnail: j.thumbnail || `${thumbBase}/hqdefault.jpg`,
      duration: j.duration, durationFormatted: j.duration_string || new Date(j.duration*1000).toISOString().substr(11,8).replace(/^00:/,''),
      views: j.view_count, publishDate: j.upload_date, category: j.categories?.[0], isLive: j.is_live, available: true, source: 'yt-dlp'
    });
  } catch (e) {
    console.warn('yt-dlp video_info failed:', e.message);
  }

  // 2) play-dl
  try {
    const playdl = await import('play-dl');
    const info = await playdl.video_info(url);
    const d = info.video_details;
    if (d) {
      const thumbBase = `https://img.youtube.com/vi/${videoId}`;
      return res.json({
        id: videoId, url, title: d.title,
        description: d.description?.slice(0,1000), fullDescription: d.description,
        channel: d.channel?.name, channelId: d.channel?.id, channelUrl: d.channel?.url,
        thumbnails: {
          default: `${thumbBase}/default.jpg`, medium: `${thumbBase}/mqdefault.jpg`,
          high: `${thumbBase}/hqdefault.jpg`, standard: `${thumbBase}/sddefault.jpg`,
          maxres: `${thumbBase}/maxresdefault.jpg`, list: d.thumbnails
        },
        thumbnail: d.thumbnails?.[0]?.url || `${thumbBase}/hqdefault.jpg`,
        duration: d.durationInSec, durationFormatted: d.durationRaw, views: d.views, publishDate: d.uploadedAt, isLive: d.live, available: true, source: 'play-dl'
      });
    }
  } catch (e) { console.warn('play-dl video_info failed:', e.message); }

  // 3) ytdl fallback
  try {
    if (!ytdl.validateURL(url)) return res.status(400).json({ error: 'Invalid YouTube URL/ID' });
    let info, lastErr;
    const clients = [['ios','android'],['android'],['ios'],undefined];
    for (const pc of clients) {
      try { info = pc ? await ytdl.getInfo(url,{playerClients:pc}) : await ytdl.getInfo(url); if(info?.videoDetails) break; } catch(e){ lastErr=e; }
    }
    if(!info) throw lastErr||new Error('Failed to fetch video info');
    const d=info.videoDetails;
    const thumbBase=`https://img.youtube.com/vi/${videoId}`;
    return res.json({
      id:videoId,url,title:d.title,description:d.description?.slice(0,1000),fullDescription:d.description,
      channel:d.author?.name,channelId:d.author?.id,channelUrl:d.author?.channel_url,
      thumbnails:{default:`${thumbBase}/default.jpg`,medium:`${thumbBase}/mqdefault.jpg`,high:`${thumbBase}/hqdefault.jpg`,standard:`${thumbBase}/sddefault.jpg`,maxres:`${thumbBase}/maxresdefault.jpg`,list:d.thumbnails},
      thumbnail:`${thumbBase}/hqdefault.jpg`,duration:d.lengthSeconds,durationFormatted:new Date(d.lengthSeconds*1000).toISOString().substr(11,8).replace(/^00:/,''),views:d.viewCount,publishDate:d.publishDate,category:d.category,isLive:d.isLiveContent,available:true,source:'ytdl'
    });
  } catch (err) {
    console.error('Video info error:', err);
    // Return 429 hint
    const is429 = err.message.includes('429') || err.message.includes('Too Many');
    res.status(is429?429:500).json({ error: 'Failed to fetch video info', details: err.message, hint: is429 ? 'YouTube rate-limited (429). Wait 1-2 min and try again, or try different video. Render free IP is shared.' : undefined });
  }
});

module.exports = router;
