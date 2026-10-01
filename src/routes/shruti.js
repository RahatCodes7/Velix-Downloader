const express = require('express');
const router = express.Router();

const SHRUTI_API_URL = process.env.SHRUTI_API_URL || 'https://api01.shrutibots.site';
const SHRUTI_API_KEY = process.env.SHRUTI_API_KEY || 'ShrutiBotsxWnI7qu8mp6KKll6to7F';

function extractId(input) {
  if (!input) return null;
  input = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  try {
    const u = new URL(input);
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).split('/')[0];
    if (u.pathname.includes('/shorts/')) return u.pathname.split('/shorts/')[1].split('/')[0];
    const p = u.pathname.split('/').filter(Boolean);
    return p.pop();
  } catch { return input; }
}

// GET /api/shruti/:id?type=audio|video — proxy to Shruti API (hides API key, same-origin download)
router.get('/:id', async (req, res) => {
  const id = extractId(req.params.id);
  const type = (req.query.type || 'audio') === 'video' ? 'video' : 'audio';
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  const target = `${SHRUTI_API_URL}/download?url=${encodeURIComponent(id)}&type=${type}&api_key=${encodeURIComponent(SHRUTI_API_KEY)}`;
  try {
    const upstream = await fetch(target);
    if (!upstream.ok) {
      const t = await upstream.text().catch(() => '');
      return res.status(upstream.status).json({ error: 'Shruti API failed', details: t.slice(0, 300) });
    }
    const ext = type === 'video' ? 'mp4' : 'mp3';
    res.header('Content-Disposition', `attachment; filename="${id}.${ext}"`);
    res.header('Content-Type', type === 'video' ? 'video/mp4' : 'audio/mpeg');
    res.header('Cache-Control', 'no-store');
    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.send(buf);
  } catch (e) {
    return res.status(500).json({ error: 'Shruti proxy failed', details: e.message });
  }
});

module.exports = router;
