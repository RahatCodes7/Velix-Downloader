# YT Audio API

Express + ytdl-core + yt-search + ffmpeg (128kbps fixed) + Tailwind Frontend. Render ready.

## Run locally
```
npm install
npm start
# http://localhost:3000
```

## API
- `GET /api/search?q=arijit` - search 10 videos
- `GET /api/video/:id` - metadata + thumbnails
- `GET /api/mp3/:id` - download mp3 (128k)
- `GET /api/health` - health

`id` can be `dQw4w9WgXcQ` or full youtube URL.

## Deploy on Render
1. Push to GitHub
2. New Web Service -> Connect repo
3. Runtime: Docker, Health check: `/api/health`
4. Deploy. No extra build command needed.

Optional: set `API_KEY` env to protect `/api/*` with `x-api-key` header.
