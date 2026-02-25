# Music Web Crawler Backend

Node.js + Playwright backend used by the React Native app downloader.

## What It Does

- Searches tracks/albums through the target web source.
- Queues downloads and reports progress through API endpoints.
- Streams completed downloads to the mobile app.
- Uses temporary download files and removes them after successful stream transfer.

## Run

```bash
npm install
npx playwright install chromium
node server.js
```

Server default: `http://localhost:3001`

## App-Facing API

- `GET /api/search?q=<query>&type=<tracks|albums|playlists>`
- `GET /api/album-tracks?url=<albumUrl>&album=<title>&artist=<artist>&artwork=<url>`
- `POST /api/downloads`
- `GET /api/downloads`
- `GET /api/downloads/:id`
- `POST /api/downloads/:id/retry`
- `POST /api/downloads/:id/cancel`
- `GET /api/stream/:id`

## Notes

- Downloaded files are not persisted into a project `songs/` folder anymore.
- Stream files are short-lived and cleaned up after transfer.

## Timeout Tuning (Optional)

If your host is slow (for example free-tier containers), set these env vars:

- `DOWNLOAD_PIPELINE_TIMEOUT_MS` (default `300000`)
- `RESOLVE_TIMEOUT_MS` (default `18000`)
- `RESOLVE_RETRY_TIMEOUT_MS` (default `28000`)
- `RESOLVE_RECOVERY_NAV_TIMEOUT_MS` (default `20000`)
- `SEARCH_TIMEOUT_MS` (default `18000`)
- `TRACK_FALLBACK_TIMEOUT_MS` (default `12000`)

These help prevent resolver failures when the provider UI loads slowly.
