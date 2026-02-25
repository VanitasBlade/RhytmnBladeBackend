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
