/* feeds.js — everything about Burlington comes from the guide's public JSON.
   Cached in localStorage so a second open is instant, hard timeouts so one
   stalled feed can't hold the app at "loading", and every feed reports what
   it actually is — live, cached, stale or absent — so the footer can tell
   the truth instead of implying freshness we don't have. */

const BASE = 'https://guide.btownbrief.com/data/';
const PREFIX = 'bd_feed_';
const FRESH_MS = 10 * 60 * 1000;
const STALE_MAX_MS = 24 * 3600 * 1000;
const TIMEOUT_MS = 9000;

const ENDPOINTS = {
  things: 'things.json',
  restaurants: 'restaurants.json',
  events: 'events/events.json',
  weather: 'weather/latest.json',
};

function cacheGet(key) {
  try { const raw = localStorage.getItem(PREFIX + key); return raw ? JSON.parse(raw) : null; }
  catch { return null; }
}
function cacheSet(key, data) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify({ at: Date.now(), data })); }
  catch { /* private mode or full — we just refetch next time */ }
}

async function one(key, path, now) {
  const cached = cacheGet(key);
  if (cached && now - cached.at < FRESH_MS) return { key, data: cached.data, status: 'cached' };
  try {
    const res = await fetch(BASE + path, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    cacheSet(key, data);
    return { key, data, status: 'live' };
  } catch (err) {
    if (cached && now - cached.at < STALE_MAX_MS) return { key, data: cached.data, status: 'stale' };
    return { key, data: null, status: 'absent', err: String(err) };
  }
}

export async function loadFeeds({ now = Date.now() } = {}) {
  const results = await Promise.all(
    Object.entries(ENDPOINTS).map(([k, p]) => one(k, p, now)));
  const feeds = {}, status = {};
  for (const r of results) { feeds[r.key] = r.data; status[r.key] = r.status; }
  return { feeds, status, ok: !!(feeds.things && feeds.restaurants) };
}

/* The library: seeded days shipped with the app, plus whatever people have
   published. If the backend isn't reachable we still have the seeds — the
   shelf is never empty. */
export async function loadSeedDays() {
  try {
    const res = await fetch('data/days.json', { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    return Array.isArray(j?.days) ? j.days : [];
  } catch { return []; }
}

export function statusLine(status) {
  const absent = Object.entries(status).filter(([, v]) => v === 'absent').map(([k]) => k);
  const stale = Object.entries(status).filter(([, v]) => v === 'stale').map(([k]) => k);
  if (absent.length) return `Couldn't reach ${absent.join(' and ')} — some of this may be out of date.`;
  if (stale.length) return `Working from a saved copy of ${stale.join(' and ')}.`;
  return 'Live from the Burlington guide.';
}
