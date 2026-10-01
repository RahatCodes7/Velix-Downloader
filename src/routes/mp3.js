const express = require('express');
const router = express.Router();
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

let ytDlpPath = path.join(__dirname, '../../node_modules/yt-dlp-exec/bin/yt-dlp');
if (process.platform === 'win32') ytDlpPath += '.exe';
if (!fs.existsSync(ytDlpPath)) {
  const alt = ytDlpPath.endsWith('.exe') ? ytDlpPath.slice(0,-4) : ytDlpPath + '.exe';
  if (fs.existsSync(alt)) ytDlpPath = alt;
}
const ffmpegPath = require('ffmpeg-static');
const ffmpegDir = path.dirname(ffmpegPath);
const { getCookiesArgs } = require('../utils/cookies');

function extractVideoId(input) {
  if (!input) return null;
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  try { const u=new URL(input); if(u.searchParams.get('v')) return u.searchParams.get('v'); const p=u.pathname.split('/').filter(Boolean); return p.pop(); } catch { return input; }
}

router.get('/:id', async (req, res) => {
  const videoId = extractVideoId(req.params.id);
  if (!videoId) return res.status(400).json({ error: 'Invalid video id' });
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  if (!fs.existsSync(ytDlpPath)) {
    return res.status(500).json({ error: 'yt-dlp binary not found', details: ytDlpPath });
  }
  if (!fs.existsSync(ffmpegPath)) {
    return res.status(500).json({ error: 'ffmpeg binary not found', details: ffmpegPath });
  }

  const cookiesArgs = getCookiesArgs();
  const baseArgs = [
    '-x', '--audio-format', 'mp3',
    '--audio-quality', '128K',
    '-o', '-',
    '--ffmpeg-location', ffmpegDir,
    '--no-playlist',
    '--no-warnings',
    '--no-cache-dir',
    '--retries', '3',
    '--fragment-retries', '3',
    '--concurrent-fragments', '1',
    '--extractor-args', 'youtube:player_client=web,android,ios,mweb,tv,mediaconnect',
    ...cookiesArgs
  ];
  const retryArgsBase = [
    '-f', 'best',
    '-x', '--audio-format', 'mp3',
    '--audio-quality', '128K',
    '-o', '-',
    '--ffmpeg-location', ffmpegDir,
    '--no-playlist',
    '--no-warnings',
    '--no-cache-dir',
    '--extractor-args', 'youtube:player_client=tv,mediaconnect,web',
  ];
  const args = [url, ...baseArgs];

  console.log('yt-dlp spawn', ytDlpPath, 'for', videoId, 'cookies', cookiesArgs.length ? 'yes' : 'no');

  let proc;
  try {
    proc = spawn(ytDlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to spawn yt-dlp', details: e.message });
  }

  let stderr = '';
  let stdoutStarted = false;
  let hasError = false;
  let headersSent = false;
  const sendHeaders = () => {
    if (!headersSent) {
      headersSent = true;
      res.header('Content-Disposition', `attachment; filename="${videoId}.mp3"`);
      res.header('Content-Type', 'audio/mpeg');
    }
  };

  proc.stderr.on('data', d => { stderr += d.toString(); });
  proc.stdout.on('data', chunk => {
    if (!stdoutStarted) { stdoutStarted = true; sendHeaders(); clearTimeout(timeout); }
  });
  proc.on('error', err => {
    hasError = true; clearTimeout(timeout);
    if (!res.headersSent && !headersSent) res.status(500).json({ error: 'Failed to start yt-dlp', details: err.message });
    else if (!res.writableEnded) { try { res.destroy(); } catch { try { res.end(); } catch {} } }
  });
  req.on('close', () => { if (proc && !proc.killed) proc.kill('SIGKILL'); });

  let responded = false;
  const safeJson = (code, obj) => {
    if (responded || res.headersSent || headersSent || res.writableEnded) return;
    responded = true; res.status(code).json(obj);
  };
  proc.on('close', code => {
    if (hasError) return;
    clearTimeout(timeout);
    console.log('yt-dlp close', {code, stdoutStarted, headersSent, stderr: stderr.slice(0,400)});
    if (code !== 0) {
      const isBot = stderr.includes('Sign in to confirm you') || stderr.includes('not a bot');
      const isFormat = stderr.includes('Requested format is not available');
      if (isFormat && !req._retried) {
        console.log('Retrying with tv/mediaconnect and no cookies for', videoId);
        req._retried = true;
        const retryArgs = [url, ...retryArgsBase];
        const rp = spawn(ytDlpPath, retryArgs, { stdio: ['ignore','pipe','pipe'] });
        let re=''; rp.stderr.on('data',d=>re+=d.toString());
        let rs=false; rp.stdout.on('data',chunk=>{ if(!rs){rs=true; sendHeaders(); clearTimeout(timeout);} if(!res.writableEnded) res.write(chunk); });
        rp.on('close', rc=>{ if(rc===0 && rs){ if(!res.writableEnded) res.end(); } else safeJson(400,{error:'Video format not available', details:re.slice(0,600), hint:'ID '+videoId+' may be invalid'}); });
        req.on('close',()=>{ if(!rp.killed) rp.kill(); });
        return;
      }
      if (headersSent && stdoutStarted) { if (!res.writableEnded) { try { res.destroy(); } catch { try { res.end(); } catch {} } } return; }
      if (!stdoutStarted) {
        if (isBot) return safeJson(500,{error:'YouTube bot-check - cookies expired or IP blocked', details:stderr.slice(0,600), hint:'Update cookies.txt with fresh export'});
        if (isFormat) return safeJson(400,{error:'Video format not available', details:stderr.slice(0,600), hint:'Check video ID valid'});
        return safeJson(500,{error:'Failed to process mp3', details:stderr.slice(0,600)});
      }
      // failed after streaming started but stdout 'end' never fired — destroy, never a truncated file
      if (!res.writableEnded) { try { res.destroy(); } catch { try { res.end(); } catch {} } }
      return;
    } else if (!stdoutStarted) {
      return safeJson(500,{error:'0 bytes - no output', details:stderr.slice(0,600)});
    } else console.log('yt-dlp done for', videoId);
  });

  const timeout = setTimeout(() => {
    if (proc && !proc.killed) {
      proc.kill('SIGKILL');
      if (!res.headersSent && !headersSent) safeJson(504,{error:'Timeout', details:'yt-dlp took too long'});
      else if (!res.writableEnded) { try { res.destroy(); } catch { try { res.end(); } catch {} } }
    }
  }, 90000);

  proc.stdout.on('end', () => clearTimeout(timeout));
  proc.stdout.on('data', chunk => { if (!res.writableEnded) res.write(chunk); });
  proc.stdout.on('end', () => { if (!res.writableEnded) res.end(); });
});
module.exports = router;
