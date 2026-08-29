/* bd-ask — turns a sentence into constraints. That is its whole job.

   It never picks a place, never names one, never invents an hour. The
   engine in js/core.js does all of that from the guide's feeds. If this
   function is down, missing a key, or returns nonsense, the client falls
   back to core.fallbackParse and the app keeps working — a worse parse,
   never a wrong day.

   Deploy:  supabase functions deploy bd-ask --no-verify-jwt
   Secret:  supabase secrets set OPENROUTER_API_KEY=...   (same key the
            newsletter scripts use; see ~/.config/btownbrief/secrets.env) */

const MODEL = Deno.env.get('BD_ASK_MODEL') ?? 'openai/gpt-5.6-luna';
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_CHARS = 500;

const CORS = {
  'access-control-allow-origin': '*',
  // The browser sends apikey + authorization on a Supabase call; leaving
  // them out of the preflight makes every request from the page fail
  // silently and fall back to keyword parsing.
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-max-age': '86400',
  'access-control-allow-methods': 'POST, OPTIONS',
};

const WANTS = ['outdoors', 'indoors', 'sit_down_dinner', 'cheap', 'free', 'kids',
  'lively', 'quiet', 'walkable', 'drinks', 'culture', 'water'];

const SYSTEM = `You convert one sentence about a day out in Burlington, Vermont into JSON constraints.

Return ONLY this JSON object, no prose:
{"dateISO":"YYYY-MM-DD"|null,"startMin":int,"endMin":int,"party":int,
 "mobility":"low"|"normal","budget":"low"|"mid"|"any","wants":[...],"avoid":[...]}

Rules:
- startMin/endMin are minutes past midnight (11am = 660). Default 660 to 1260.
- "wants" and "avoid" may ONLY contain: ${WANTS.join(', ')}.
- mobility "low" for anyone who cannot walk far: age, a walker, a wheelchair, a bad knee, small children in tow.
- Resolve weekday names and "tomorrow" against the supplied today's date. If no date is stated, use null.
- Never name a place, a venue, a restaurant or an event. You are not choosing anything.
- If something is not stated, leave the default. Do not infer a budget from the tone.`;

// One in-memory bucket per instance. Crude, and enough: the client falls
// back to its own parser the moment this says no.
const hits = new Map<string, number[]>();
function throttled(ip: string): boolean {
  const now = Date.now(), win = 60_000, max = 12;
  const seen = (hits.get(ip) ?? []).filter((t) => now - t < win);
  seen.push(now);
  hits.set(ip, seen);
  if (hits.size > 5000) hits.clear();
  return seen.length > max;
}

function clean(raw: unknown, todayISO: string | null) {
  const o = (raw ?? {}) as Record<string, unknown>;
  const int = (v: unknown, lo: number, hi: number, dflt: number) =>
    Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v as number))) : dflt;
  const list = (v: unknown) => Array.isArray(v)
    ? [...new Set(v.filter((x) => typeof x === 'string' && WANTS.includes(x)))].slice(0, 6)
    : [];
  let dateISO: string | null = null;
  if (typeof o.dateISO === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.dateISO)) {
    // Never accept a date in the past or more than a year out.
    if (!todayISO || (o.dateISO >= todayISO && o.dateISO <= bump(todayISO, 365))) dateISO = o.dateISO;
  }
  const startMin = int(o.startMin, 0, 1380, 660);
  return {
    dateISO,
    startMin,
    endMin: Math.max(startMin + 60, int(o.endMin, 60, 1620, 1260)),
    party: int(o.party, 1, 20, 2),
    mobility: o.mobility === 'low' ? 'low' : 'normal',
    budget: o.budget === 'low' || o.budget === 'mid' ? o.budget : 'any',
    wants: list(o.wants),
    avoid: list(o.avoid),
  };
}

function bump(iso: string, days: number) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'post_only' }, 405);

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (throttled(ip)) return json({ error: 'slow_down' }, 429);

  let body: { text?: string; todayISO?: string };
  try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }

  const text = String(body.text ?? '').slice(0, MAX_CHARS).trim();
  if (text.length < 3) return json({ error: 'empty' }, 400);
  const todayISO = /^\d{4}-\d{2}-\d{2}$/.test(String(body.todayISO ?? '')) ? String(body.todayISO) : null;

  const key = Deno.env.get('OPENROUTER_API_KEY');
  if (!key) return json({ error: 'not_configured' }, 503);

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: AbortSignal.timeout(12_000),
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'http-referer': 'https://play.btownbrief.com/burlington-days/',
        'x-title': 'Burlington Days',
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: 400,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `Today is ${todayISO ?? 'unknown'}.\n\n${text}` },
        ],
      }),
    });
    if (!res.ok) return json({ error: 'upstream', status: res.status }, 502);
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return json({ error: 'no_content' }, 502);
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { return json({ error: 'unparsable' }, 502); }
    return json({ constraints: clean(parsed, todayISO), model: MODEL });
  } catch (e) {
    return json({ error: 'unreachable', detail: String(e).slice(0, 120) }, 502);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'content-type': 'application/json' },
  });
}
