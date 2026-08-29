/* net.js — the backend client. Same Supabase project and publishable key as
   the rest of the fleet; the bd_* RPCs live in
   supabase/burlington-days-SETUP.sql. Until that file is run, every call
   comes back 'not_ready' and the app says so plainly rather than erroring —
   the shelf still works from the seeded days.

   Transports behind one `backend()`:
     network (default)  — fetch to /rest/v1/rpc/<fn>
     ?demo=1            — the in-memory mirror in fake-backend.js

   The per-device token is minted once, kept in localStorage, and only ever
   stored hashed on the server. It is the only account there is. */

import { fake, seed as seedFake } from './fake-backend.js';

const SUPABASE_URL = 'https://jnouvwxomrcffqwilqkq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_RkMJQopffWlV6DSwCRkndQ_Xw6GJMf3';
const ASK_FN = 'bd-ask';
const TIMEOUT_MS = 10000;

export class NetError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.name = 'NetError'; this.code = code; this.detail = detail; }
}

const params = () => new URLSearchParams(globalThis.location?.search ?? '');
export const isDemo = () => params().get('demo') === '1';

function stored(key, make) {
  try {
    let v = localStorage.getItem(key);
    if (!v) { v = make(); localStorage.setItem(key, v); }
    return v;
  } catch { return make(); }   // storage blocked: a session-only identity
}

export const deviceToken = () => stored('bd_token', () => {
  const b = new Uint8Array(16);
  (globalThis.crypto ?? {}).getRandomValues?.(b) ?? b.fill(0);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
});

async function rpc(fn, args) {
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'content-type': 'application/json', apikey: SUPABASE_ANON_KEY,
                 authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify(args ?? {}),
    });
  } catch (e) { throw new NetError('offline', String(e).slice(0, 120)); }

  if (res.status === 404) throw new NetError('not_ready');   // SQL not installed yet
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.message ?? ''; } catch { /* body may be empty */ }
    if (/does not exist|schema cache/i.test(detail)) throw new NetError('not_ready', detail);
    throw new NetError('server', detail || `HTTP ${res.status}`);
  }
  const body = await res.json();
  if (body && typeof body === 'object' && !Array.isArray(body) && body.error) {
    const err = new NetError(body.error, body.detail);
    err.meta = body;      // e.g. a locked day's name and date, for the gate
    throw err;
  }
  return body;
}

export function backend({ seedDays = [] } = {}) {
  if (isDemo()) { seedFake(seedDays); return { ...fake, demo: true }; }
  return {
    demo: false,
    bd_days_public: () => rpc('bd_days_public'),
    bd_signal_public: () => rpc('bd_signal_public'),
    bd_save_run: (a) => rpc('bd_save_run', a),
    bd_open_run: (a) => rpc('bd_open_run', a),
    bd_mine: (a) => rpc('bd_mine', a),
    bd_rate_run: (a) => rpc('bd_rate_run', a),
    bd_publish_run: (a) => rpc('bd_publish_run', a),
  };
}

/* The one place a language model is involved: turning a sentence into
   constraints. It never picks a place. If it is unreachable, unconfigured,
   slow or nonsense, the caller falls back to core.fallbackParse — a rougher
   read of the sentence, never a wrong day. */
export async function askToConstraints(text, todayISO) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${ASK_FN}`, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'content-type': 'application/json', apikey: SUPABASE_ANON_KEY,
               authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    body: JSON.stringify({ text, todayISO }),
  });
  if (!res.ok) throw new NetError('ask_failed', `HTTP ${res.status}`);
  const body = await res.json();
  if (!body?.constraints) throw new NetError(body?.error ?? 'ask_failed');
  return body.constraints;
}
