const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

function getYtDlpPath() {
  let p = path.join(__dirname, '../../node_modules/yt-dlp-exec/bin/yt-dlp');
  if (process.platform === 'win32') p += '.exe';
  if (!fs.existsSync(p)) {
    const alt = p.endsWith('.exe') ? p.slice(0, -4) : p + '.exe';
    if (fs.existsSync(alt)) p = alt;
  }
  return p;
}
const ffmpegPath = (() => { try { return require('ffmpeg-static'); } catch { return null; } })();
let ffmpegDir = null;
try { if (ffmpegPath) ffmpegDir = path.dirname(ffmpegPath); } catch {}

function safeName(s, ext) {
  s = (s || 'video').replace(/[^\w\-\s\u0980-\u09FF]+/g, '').trim().slice(0, 60) || 'video';
  return `${s}.${ext}`;
}

// GET /api/dl?url=...&format_id=best|mp3|<id>&quality=720p
router.get('/', async (req, res) => {
  const fileUrl = (req.query.url || '').trim();
  if (!fileUrl) return res.status(400).json({ error: 'Missing ?url=' });
  let formatId = (req.query.format_id || 'best').trim();
  const quality = (req.query.quality || '').trim();
  if (quality && /^\d{3,4}p$/.test(quality)) {
    const h = quality.replace('p', '');
    formatId = `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`;
  }

  const ytDlpPath = getYtDlpPath();
  if (!fs.existsSync(ytDlpPath)) return res.status(500).json({ error: 'yt-dlp binary not found' });

  let cookiesArgs = [];
  try { cookiesArgs = require('../utils/cookies').getCookiesArgs(); } catch {}

  const isMp3 = formatId === 'mp3';
  let args;
  if (isMp3) {
    args = [fileUrl, '-x', '--audio-format', 'mp3', '--audio-quality', '128K', '-o', '-',
      '--no-playlist', '--no-warnings', '--no-cache-dir', '--retries', '3',
      '--socket-timeout', '15', ...cookiesArgs];
    if (ffmpegDir) args.push('--ffmpeg-location', ffmpegDir);
  } else {
    let f = formatId;
    const isPin = /pinterest\.|pin\.it/i.test(fileUrl);
    if (f === 'best') f = isPin ? 'best/bestvideo+bestaudio' : 'bestvideo+bestaudio/best';
    args = [fileUrl, '-f', f, '-o', '-', '--no-playlist', '--no-warnings', '--no-cache-dir',
      '--retries', '3', '--fragment-retries', '3', '--socket-timeout', '15',
      ...cookiesArgs];
    if (!isPin) args.push('--remux-video', 'mp4');
    if (ffmpegDir) args.push('--ffmpeg-location', ffmpegDir);
  }

  console.log('dl spawn:', formatId, fileUrl.slice(0, 80));
  let proc;
  try { proc = spawn(ytDlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { return res.status(500).json({ error: 'Failed to spawn yt-dlp', details: e.message }); }

  let stderr = '', started = false, headersSent = false;
  const isPinReq = /pinterest\.|pin\.it/i.test(fileUrl);
  const sendHeaders = (isAudio) => {
    if (headersSent) return; headersSent = true;
    if (isPinReq && !isAudio) {
      res.header('Content-Disposition', `attachment; filename="pinterest-pin"`);
      res.header('Content-Type', 'application/octet-stream');
    } else {
      res.header('Content-Disposition', `attachment; filename="${safeName('download', isAudio ? 'mp3' : 'mp4')}"`);
      res.header('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');
    }
    res.header('Cache-Control', 'no-store');
  };

  const timeout = setTimeout(() => {
    if (proc && !proc.killed) {
      proc.kill('SIGKILL');
      if (!headersSent) { try { res.status(504).json({ error: 'Timeout - video took too long' }); } catch {} }
      else if (!res.writableEnded) res.end();
    }
  }, 120000);

  proc.stderr.on('data', d => { stderr += d.toString(); });
  proc.stdout.on('data', chunk => {
    if (!started) { started = true; clearTimeout(timeout); sendHeaders(isMp3); }
    if (!res.writableEnded) res.write(chunk);
  });
  proc.stdout.on('end', () => { clearTimeout(timeout); if (!res.writableEnded) res.end(); });
  proc.on('error', () => { clearTimeout(timeout); if (!headersSent) { try { res.status(500).json({ error: 'Download failed to start' }); } catch {} } else if (!res.writableEnded) res.end(); });
  proc.on('close', code => {
    clearTimeout(timeout);
    if (code !== 0 && !started) {
      const msg = stderr.slice(0, 600);
      const isBlocked = /login|private|sign in|forbidden|403|rate-limit|empty media/i.test(msg);
      return res.status(isBlocked ? 403 : 500).json({
        error: isBlocked ? 'This link is blocked/private (403 Forbidden)' : 'Failed to download this link',
        details: msg,
        hint: 'Public video/reel link use koro. Instagram/Facebook private ba login-only post support kore na. Onno ekta public link try koro.'
      });
    }
    if (!res.writableEnded) res.end();
  });
  req.on('close', () => { if (proc && !proc.killed) proc.kill('SIGKILL'); });
});

module.exports = router;
