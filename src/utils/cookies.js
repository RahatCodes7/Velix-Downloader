const fs = require('fs');
const path = require('path');
const os = require('os');

let cookiesPath = null;
let cookiesUrlFetched = false;

async function fetchCookiesFromUrl() {
  const url = process.env.YT_COOKIES_URL || process.env.YOUTUBE_COOKIES_URL;
  if (!url || cookiesUrlFetched) return null;
  cookiesUrlFetched = true;
  try {
    console.log('Fetching cookies from URL', url);
    const res = await fetch(url);
    if (!res.ok) throw new Error('Fetch cookies URL failed '+res.status);
    const content = await res.text();
    const tmp = path.join(os.tmpdir(), 'cookies_url.txt');
    fs.writeFileSync(tmp, content, 'utf-8');
    cookiesPath = tmp;
    console.log('Fetched cookies from URL size', content.length);
    return tmp;
  } catch(e){ console.error('Failed to fetch cookies from URL', e.message); return null; }
}
 // auto-fetch at startup (non-blocking)
if (process.env.YT_COOKIES_URL || process.env.YOUTUBE_COOKIES_URL) { fetchCookiesFromUrl(); }

function getCookiesPath() {
  if (cookiesPath && fs.existsSync(cookiesPath)) return cookiesPath;
  // 1) Check env var YT_COOKIES (can be base64 or raw Netscape txt or JSON)
  const envCookies = process.env.YT_COOKIES || process.env.YOUTUBE_COOKIES;
  if (envCookies) {
    try {
      const tmp = path.join(os.tmpdir(), 'cookies.txt');
      let content = envCookies;
      if (!content.includes('# Netscape') && !content.includes('youtube.com') && content.length > 200) {
        try { content = Buffer.from(content, 'base64').toString('utf-8'); } catch {}
      }
      // Validate size - allow smaller exports (some minimal exports are ~3000)
      if (content.length < 800) {
        console.warn('Cookies env var too small ('+content.length+' bytes), likely incomplete export. Ignoring.');
        return null;
      }
      if (!content.includes('# Netscape')) {
        console.warn('Cookies env var does not look like Netscape format (missing header). Ensure you exported via Get cookies.txt LOCALLY');
      }
      fs.writeFileSync(tmp, content, 'utf-8');
      cookiesPath = tmp;
      console.log('Using cookies from env var at', tmp, 'size', content.length);
      return cookiesPath;
    } catch (e) { console.error('Failed to write cookies from env', e.message); }
  }
  // 2) Check local cookies.txt at project root or /app/cookies.txt
  const candidates = [
    path.join(__dirname, '../../cookies.txt'),
    path.join(process.cwd(), 'cookies.txt'),
    '/app/cookies.txt',
    path.join(os.tmpdir(), 'cookies.txt')
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      cookiesPath = p;
      console.log('Using cookies file at', p);
      return p;
    }
  }
  return null;
}

function getCookiesArgs() {
  const p = getCookiesPath();
  if (p && fs.existsSync(p)) return ['--cookies', p];
  // also check if URL fetch produced file
  const tmpUrl = path.join(os.tmpdir(), 'cookies_url.txt');
  if (fs.existsSync(tmpUrl)) return ['--cookies', tmpUrl];
  return [];
}

module.exports = { getCookiesPath, getCookiesArgs };
