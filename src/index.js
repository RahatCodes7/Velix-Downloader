require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 8080;

// Trust proxy for Render (fixes ERR_ERL_UNEXPECTED_X_FORWARDED_FOR)
app.set('trust proxy', 1);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Rate limiter - 200 req / 15min per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests, try again later' },
  validate: { xForwardedForHeader: false } // disable trust proxy warning
});
app.use('/api/', limiter);

// Optional API_KEY protection (only if set in .env)
app.use('/api/', (req, res, next) => {
  const requiredKey = process.env.API_KEY;
  if (!requiredKey) return next();
  const clientKey = req.headers['x-api-key'] || req.query.key;
  if (clientKey !== requiredKey) {
    return res.status(401).json({ error: 'Unauthorized: Invalid API_KEY' });
  }
  next();
});

// Routes
app.use('/api/search', require('./routes/search'));
app.use('/api/video', require('./routes/video'));
app.use('/api/mp3', require('./routes/mp3'));
app.use('/api/info', require('./routes/universal'));
app.use('/api/dl', require('./routes/dl'));
app.use('/api/shruti', require('./routes/shruti'));

// Storage janitor — auto-cleans temp files every 10 min so disk never fills
try { require('./utils/janitor').start(); } catch (e) { console.warn('janitor disabled:', e.message); }

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString(), shruti: !!(process.env.SHRUTI_API_KEY || true) });
});

app.get('/api/storage', (req, res) => {
  try {
    const out = require('./utils/janitor').getStatus();
    try {
      const cookies = require('./utils/cookies');
      const p = cookies.getCookiesPath();
      out.cookies = { configured: !!p, hasFile: !!(p && require('fs').existsSync(p)) };
    } catch (e) { out.cookies = { configured: false, error: e.message }; }
    res.json(out);
  }
  catch (e) { res.status(500).json({ error: 'janitor unavailable', details: e.message }); }
});

app.get('/api', (req, res) => {
  res.json({
    name: 'Velix API',
    version: '2.0.0',
    platforms: ['youtube', 'tiktok', 'instagram', 'facebook', 'pinterest'],
    endpoints: {
      'GET /api/info?url=LINK': 'Universal info — title, thumbnail, formats for YT/TT/IG/FB/Pinterest',
      'GET /api/dl?url=LINK&format_id=best|mp3': 'Universal download proxy (TT/IG/FB/Pin/YT)',
      'GET /api/shruti/:id?type=audio|video': 'Fast YouTube download via Shruti API',
      'GET /api/search?q=keyword': 'YouTube search',
      'GET /api/video/:id': 'YouTube metadata',
      'GET /api/mp3/:id': 'YouTube MP3 via yt-dlp (fallback)',
      'GET /api/storage': 'Janitor status — tmp size + last 10-min cleanup',
      'GET /api/health': 'Health check'
    },
    frontend: '/'
  });
});

// Unknown /api/* must ALWAYS be JSON (never index.html) so frontend r.json() never crashes
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Unknown API endpoint: ' + req.path });
});

// Serve frontend fallback (non-API only)
app.get('/*splat', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Error handler — always JSON for /api, even if an upstream proxy sent text
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  if (req.path.startsWith('/api')) {
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
  res.status(500).send('Internal server error');
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
