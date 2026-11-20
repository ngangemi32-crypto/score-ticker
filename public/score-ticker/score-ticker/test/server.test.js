'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp, normalizeEvent, dateRange } = require('../server.js');

// Events shaped like ESPN's scoreboard response.
function ev(id, type, homeScore, awayScore, extra = {}) {
  return {
    id,
    date: extra.date || '2026-11-07T22:00Z',
    competitions: [{
      status: { displayClock: '4:12', period: 3, type: type },
      competitors: [
        { homeAway: 'home', score: homeScore, team: { abbreviation: 'IND', displayName: 'Indiana Pacers' } },
        { homeAway: 'away', score: awayScore, team: { abbreviation: 'DEN', displayName: 'Denver Nuggets' } }
      ]
    }]
  };
}
const PRE = { state: 'pre', name: 'STATUS_SCHEDULED', shortDetail: '11/7 - 5:00 PM EST' };
const LIVE = { state: 'in', name: 'STATUS_IN_PROGRESS', shortDetail: '4:12 - 3rd' };
const FINAL = { state: 'post', name: 'STATUS_FINAL', shortDetail: 'Final/OT' };
const PPD = { state: 'post', name: 'STATUS_POSTPONED', shortDetail: 'Postponed' };

test('normalizeEvent maps scheduled, live, final and postponed games', () => {
  const pre = normalizeEvent(ev('1', PRE, '0', '0'));
  assert.equal(pre.s, 'pre');
  assert.equal(pre.hs, null, 'no score before the game starts');
  assert.equal(pre.h, 'IND');
  assert.equal(pre.an, 'Denver Nuggets');

  const live = normalizeEvent(ev('2', LIVE, '88', '91'));
  assert.equal(live.s, 'live');
  assert.equal(live.hs, 88);
  assert.equal(live.as, 91);
  assert.equal(live.detail, '4:12 - 3rd');

  const fin = normalizeEvent(ev('3', FINAL, '110', '104'));
  assert.equal(fin.s, 'final');
  assert.equal(fin.detail, 'Final/OT');

  assert.equal(normalizeEvent(ev('4', PPD, '0', '0')).s, 'other');
});

test('normalizeEvent skips events it cannot read', () => {
  assert.equal(normalizeEvent({ id: '9' }), null);
  assert.equal(normalizeEvent({ id: '9', competitions: [{ competitors: [] }] }), null);
});

test('dateRange builds a single date or a range', () => {
  const now = new Date('2026-11-07T15:00:00Z');
  assert.equal(dateRange(1, 1, now), '20261106-20261108');
  assert.equal(dateRange(0, 0, now), '20261107');
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}
const getJson = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => resolve(JSON.parse(body)));
  }).on('error', reject);
});

test('polls ESPN, serves scores, survives a failure, and streams over SSE', async () => {
  let mode = 'ok';
  const requests = [];
  const espn = http.createServer((req, res) => {
    requests.push(req.url);
    if (mode === 'fail') { res.writeHead(500); res.end('boom'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ events: [ev('2', LIVE, '88', '91'), ev('1', PRE, '0', '0', { date: '2026-11-07T23:00Z' })] }));
  });
  const espnPort = await listen(espn);
  const app = createApp({
    port: 0, host: '127.0.0.1', espnBase: `http://127.0.0.1:${espnPort}`,
    leagues: ['nba'], pollLiveMs: 40, pollIdleMs: 40, metaMs: 60
  });
  const port = await app.start();
  try {
    const snap = await until(async () => {
      const s = await getJson(port, '/api/scores');
      return s.leagues[0].games.length === 2 ? s : null;
    });
    const lg = snap.leagues[0];
    assert.equal(lg.id, 'nba');
    assert.equal(lg.ok, true);
    assert.equal(lg.games[0].s, 'live', 'sorted by start time');
    assert.match(requests[0], /^\/basketball\/nba\/scoreboard\?dates=\d{8}(-\d{8})?&limit=300$/);

    // SSE: the first message is a full snapshot.
    const first = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/events' }, (res) => {
        assert.match(res.headers['content-type'], /text\/event-stream/);
        res.once('data', (c) => { resolve(String(c)); req.destroy(); });
      });
      req.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
    });
    assert.match(first, /retry: 3000/);

    // A failing feed keeps the last games but flags the league as not ok.
    mode = 'fail';
    const failed = await until(async () => {
      const s = (await getJson(port, '/api/scores')).leagues[0];
      return s.ok === false ? s : null;
    });
    assert.equal(failed.games.length, 2);
    assert.match(failed.error, /HTTP 500/);

    // It recovers by itself.
    mode = 'ok';
    await until(async () => (await getJson(port, '/api/scores')).leagues[0].ok === true);
  } finally {
    await app.stop();
    await new Promise((r) => espn.close(r));
  }
});
