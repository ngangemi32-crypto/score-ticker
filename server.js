'use strict';
/*
 * Score Ticker server.
 * Polls ESPN's public (unofficial) scoreboard endpoints, normalizes the data,
 * and streams it to browsers over Server-Sent Events. No dependencies; needs Node 18+.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ALL_LEAGUES = [
  { id: 'nba', label: 'NBA', short: 'NBA', path: 'basketball/nba', homeFirst: false },
  { id: 'nhl', label: 'NHL', short: 'NHL', path: 'hockey/nhl', homeFirst: false },
  { id: 'nfl', label: 'NFL', short: 'NFL', path: 'football/nfl', homeFirst: false },
  { id: 'ncaaf', label: 'College Football', short: 'NCAAF', path: 'football/college-football', homeFirst: false },
  { id: 'epl', label: 'Premier League', short: 'EPL', path: 'soccer/eng.1', homeFirst: true }
];

const DAY_MS = 86400000;

/** ESPN's `dates` parameter takes calendar dates as YYYYMMDD (US Eastern). */
function etDate(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(d)
    .replaceAll('-', '');
}

function dateRange(daysBack, daysAhead, now = new Date()) {
  const from = etDate(new Date(now.getTime() - daysBack * DAY_MS));
  const to = etDate(new Date(now.getTime() + daysAhead * DAY_MS));
  return from === to ? from : `${from}-${to}`;
}

const toScore = (v) => {
  if (v == null || v === '') return null;
  const n = Number(typeof v === 'object' ? v.value ?? v.displayValue : v);
  return Number.isFinite(n) ? n : null;
};

/** Turn one ESPN event into the compact shape the page uses. Returns null if it can't be read. */
function normalizeEvent(ev) {
  const comp = ev && ev.competitions && ev.competitions[0];
  if (!comp || !Array.isArray(comp.competitors)) return null;
  const home = comp.competitors.find((c) => c.homeAway === 'home');
  const away = comp.competitors.find((c) => c.homeAway === 'away');
  if (!home || !away) return null;

  const status = comp.status || ev.status || {};
  const type = status.type || {};
  const name = String(type.name || '');
  let s = 'pre';
  if (type.state === 'in') s = 'live';
  else if (type.state === 'post') s = 'final';
  if (/POSTPONED|CANCELED|CANCELLED|FORFEIT/i.test(name)) s = 'other';

  const detail = String(type.shortDetail || type.detail || type.description || '');
  const team = (c) => c.team || {};
  const abbr = (c) => String(team(c).abbreviation || team(c).shortDisplayName || team(c).displayName || '?').slice(0, 6);
  const full = (c) => String(team(c).displayName || team(c).shortDisplayName || abbr(c));
  const shows = s === 'live' || s === 'final';

  return {
    id: String(ev.id),
    start: ev.date || comp.date || '',
    s,
    detail,
    h: abbr(home),
    a: abbr(away),
    hn: full(home),
    an: full(away),
    hs: shows ? toScore(home.score) : null,
    as: shows ? toScore(away.score) : null
  };
}

function sortGames(games) {
  return games.sort((x, y) => (Date.parse(x.start) || 0) - (Date.parse(y.start) || 0) || x.id.localeCompare(y.id));
}

function createApp(options = {}) {
  const env = process.env;
  const cfg = {
    port: options.port ?? (Number(env.PORT) || 3000),
    host: options.host ?? (env.HOST || (env.PORT ? '0.0.0.0' : '127.0.0.1')),
    espnBase: (options.espnBase || env.ESPN_BASE || 'https://site.api.espn.com/apis/site/v2/sports').replace(/\/$/, ''),
    pollLiveMs: options.pollLiveMs ?? (Number(env.POLL_LIVE_MS) || 20000),
    pollIdleMs: options.pollIdleMs ?? (Number(env.POLL_IDLE_MS) || 120000),
    daysBack: options.daysBack ?? (env.DAYS_BACK !== undefined ? Number(env.DAYS_BACK) : 1),
    daysAhead: options.daysAhead ?? (env.DAYS_AHEAD !== undefined ? Number(env.DAYS_AHEAD) : 1),
    timeoutMs: options.timeoutMs ?? 8000,
    metaMs: options.metaMs ?? 10000
  };
  const wanted = options.leagues || (env.LEAGUES ? env.LEAGUES.split(',').map((x) => x.trim()) : null);
  const leagues = ALL_LEAGUES.filter((l) => !wanted || wanted.includes(l.id));

  const states = new Map(
    leagues.map((l) => [l.id, { league: l, games: [], key: '[]', updatedAt: 0, ok: false, error: null, failures: 0, pollMs: cfg.pollIdleMs, timer: null, variant: 0 }])
  );
  const clients = new Set();
  let stopped = false;
  let metaTimer = null;
  let heartbeat = null;
  let server = null;

  const leagueView = (st, withGames) => {
    const v = {
      id: st.league.id, label: st.league.label, short: st.league.short, homeFirst: st.league.homeFirst,
      updatedAt: st.updatedAt, ok: st.ok, error: st.error, pollMs: st.pollMs
    };
    if (withGames) v.games = st.games;
    return v;
  };
  const snapshot = () => ({ serverTime: Date.now(), leagues: [...states.values()].map((st) => leagueView(st, true)) });
  const meta = () => ({ serverTime: Date.now(), leagues: [...states.values()].map((st) => leagueView(st, false)) });

  function broadcast(event, payload) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) res.write(msg);
  }

  /** Poll faster while a game is live or about to start. */
  const isActive = (st) => {
    const now = Date.now();
    return st.games.some((g) => g.s === 'live' || (g.s === 'pre' && Date.parse(g.start) - now < 15 * 60000));
  };

  function nextDelay(st) {
    let base = isActive(st) ? cfg.pollLiveMs : cfg.pollIdleMs;
    if (st.failures > 0) base = Math.min(300000, cfg.pollLiveMs * 2 ** Math.min(st.failures, 5));
    st.pollMs = base;
    return Math.round(base * (0.9 + Math.random() * 0.2));
  }

  async function getEvents(url) {
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'score-ticker/1.0' },
      signal: AbortSignal.timeout(cfg.timeoutMs)
    });
    if (!res.ok) {
      let body = '';
      try { body = (await res.text()).replace(/\s+/g, ' ').slice(0, 120); } catch (e) { /* ignore */ }
      const err = new Error(`ESPN returned HTTP ${res.status}${body ? ': ' + body : ''}`);
      err.status = res.status;
      throw err;
    }
    const json = await res.json();
    if (!json || !Array.isArray(json.events)) throw new Error('Unexpected ESPN response');
    return json.events;
  }

  const dayList = () => {
    const out = [];
    for (let d = -cfg.daysBack; d <= cfg.daysAhead; d++) out.push(etDate(new Date(Date.now() + d * DAY_MS)));
    return out;
  };

  // Ways to ask ESPN for games, from most to least efficient. If ESPN answers 400/404 to one,
  // the next is tried, and the one that works is remembered.
  const VARIANTS = [
    () => [`dates=${dateRange(cfg.daysBack, cfg.daysAhead)}&limit=300`],
    () => [`dates=${dateRange(cfg.daysBack, cfg.daysAhead)}`],
    () => dayList().map((d) => `dates=${d}`),
    () => ['']
  ];

  async function fetchGames(st) {
    const league = st.league;
    let lastErr;
    for (let i = st.variant; i < VARIANTS.length; i++) {
      try {
        const events = [];
        for (const q of VARIANTS[i]()) events.push(...(await getEvents(`${cfg.espnBase}/${league.path}/scoreboard${q ? '?' + q : ''}`)));
        st.variant = i;
        const seen = new Set();
        const games = [];
        for (const ev of events) {
          const g = normalizeEvent(ev);
          if (g && !seen.has(g.id)) { seen.add(g.id); games.push(g); }
        }
        return sortGames(games);
      } catch (err) {
        lastErr = err;
        if (err.status !== 400 && err.status !== 404) throw err;
      }
    }
    throw lastErr;
  }

  async function pollLeague(st) {
    if (stopped) return;
    const before = `${st.key}|${st.ok}|${st.error}`;
    try {
      const games = await fetchGames(st);
      st.games = games;
      st.key = JSON.stringify(games);
      st.ok = true;
      st.error = null;
      st.failures = 0;
      st.updatedAt = Date.now();
    } catch (err) {
      st.failures += 1;
      st.ok = false;
      st.error = err && err.name === 'TimeoutError' ? 'ESPN timed out' : String((err && err.message) || err);
    }
    if (stopped) return;
    if (before !== `${st.key}|${st.ok}|${st.error}`) broadcast('scores', snapshot());
    st.timer = setTimeout(() => pollLeague(st), nextDelay(st));
  }

  function serveIndex(req, res) {
    fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, buf) => {
      if (err) { res.writeHead(500); res.end('index.html missing'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
  }

  function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return; }
    const { pathname } = new URL(req.url, 'http://localhost');
    res.setHeader('x-content-type-options', 'nosniff');
    if (pathname === '/' || pathname === '/index.html') return serveIndex(req, res);
    if (pathname === '/api/scores') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(snapshot()));
      return;
    }
    if (pathname === '/healthz') {
      const anyOk = [...states.values()].some((st) => st.ok);
      res.writeHead(anyOk ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: anyOk, leagues: meta().leagues }));
      return;
    }
    if (pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      });
      res.write('retry: 3000\n\n');
      res.write(`event: scores\ndata: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }

  function start() {
    stopped = false;
    server = http.createServer(handle);
    let i = 0;
    for (const st of states.values()) st.timer = setTimeout(() => pollLeague(st), 300 * i++); // stagger first polls
    metaTimer = setInterval(() => broadcast('meta', meta()), cfg.metaMs);
    heartbeat = setInterval(() => { for (const res of clients) res.write(': keep-alive\n\n'); }, 25000);
    metaTimer.unref();
    heartbeat.unref();
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.port, cfg.host, () => resolve(server.address().port));
    });
  }

  function stop() {
    stopped = true;
    clearInterval(metaTimer);
    clearInterval(heartbeat);
    for (const st of states.values()) clearTimeout(st.timer);
    for (const res of clients) res.end();
    clients.clear();
    return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }

  return { start, stop, snapshot, config: cfg };
}

module.exports = { createApp, normalizeEvent, dateRange, ALL_LEAGUES };

if (require.main === module) {
  const app = createApp();
  app.start().then((port) => {
    console.log(`Score Ticker running at http://${app.config.host === '0.0.0.0' ? 'localhost' : app.config.host}:${port}`);
    console.log(`Polling ESPN every ${app.config.pollLiveMs / 1000}s while games are live, every ${app.config.pollIdleMs / 1000}s otherwise.`);
  }).catch((err) => { console.error(err.message); process.exit(1); });
  const quit = () => app.stop().then(() => process.exit(0));
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
}
