# Score Ticker

A live sports score ticker. A small Node server polls ESPN's public scoreboard feed and pushes updates to the page, which shows a scrolling marquee plus game cards for the NBA, NHL, NFL, college football and the Premier League.

No dependencies. Needs Node 18 or newer.

## Run it

```bash
cd score-ticker
node server.js
```

Open http://localhost:3000. The page updates by itself as scores change.

## How it works

- `server.js` asks ESPN for each league's scoreboard (yesterday, today and tomorrow, so finished and upcoming games both show).
- It polls every 20 seconds while a game is live or starts within 15 minutes, and every 2 minutes otherwise.
- Changes are pushed to browsers over Server-Sent Events (`/events`). If the stream is unavailable the page falls back to fetching `/api/scores` every 15 seconds.
- If ESPN fails, the server keeps the last scores, backs off (up to 5 minutes between tries) and marks that league **Stale** on the page. A league is never shown as live from old data without that marker.
- `GET /api/scores` returns the current data as JSON. `GET /healthz` returns 200 when at least one league is refreshing.

## Settings (environment variables)

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | 3000 | Port to listen on |
| `HOST` | 127.0.0.1 locally, 0.0.0.0 when `PORT` is set | Address to bind |
| `LEAGUES` | all | Comma list from `nba,nhl,nfl,ncaaf,epl` |
| `POLL_LIVE_MS` | 20000 | Poll interval while games are live |
| `POLL_IDLE_MS` | 120000 | Poll interval when nothing is live |
| `DAYS_BACK` / `DAYS_AHEAD` | 1 / 1 | Days of games to include around today |

Example: `LEAGUES=nba,nhl POLL_LIVE_MS=15000 node server.js`

To add a league, add an entry to `ALL_LEAGUES` in `server.js`. The `path` is the sport and league slug from ESPN's URL, for example `basketball/wnba`.

## Deploy

Any host that runs a Node process works (Render, Fly.io, Railway, a VPS). The start command is `node server.js`. The host sets `PORT` for you. Keep it to a single instance, since each instance polls ESPN on its own.

## Run the tests

```bash
node --test
```

The tests use a local fake ESPN server, so they need no network.

## Things to know

- ESPN's endpoints are public but **unofficial**. They have no published terms for apps like this, can change shape without notice, and may rate-limit or block heavy use. This setup is fine for personal use and small groups. For a public product, use a licensed provider such as Sportradar, SportsDataIO or API-Sports. Only `fetchGames` and `normalizeEvent` in `server.js` would need to change.
- Scores are only as fresh as the poll interval plus ESPN's own delay, so expect a lag of roughly 20 to 40 seconds, not true real time.
- College football returns every division ESPN lists for the day. If you only want the top division, try adding `&groups=80` to the scoreboard URL in `fetchGames` and check the result.
