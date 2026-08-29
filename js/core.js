/* core.js — Burlington Days engine.

   PURE. No DOM, no fetch, no Date.now(). Time is always an argument.
   That purity is the contract: everything here is exercised by
   `node --test scripts/test-core.mjs`, and the pieces the server also
   enforces are mirrored in supabase/burlington-days-SETUP.sql.

   The rule that matters most: THIS FILE PICKS THE PLACES. A language model
   never does. The model turns a sentence into constraints and writes
   sentences about stops that are already chosen — it cannot add a place,
   a time, or a fact. If a fact isn't in the data we leave it out. */

/* ---------- wall-clock time, without timezone math ----------
   Feed timestamps look like "2026-08-28T20:00:00-04:00". We read the wall
   clock straight out of the string instead of converting through UTC, so
   DST can never shift a stop by an hour. */

export function splitStamp(iso) {
  if (typeof iso !== 'string') return null;
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  return { date: m[1], min: Number(m[2]) * 60 + Number(m[3]) };
}

export function hhmm(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function clockLabel(min) {
  const h24 = Math.floor(min / 60), m = min % 60;
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(m).padStart(2, '0')}${h24 < 12 ? 'am' : 'pm'}`;
}

const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function dowOf(dateISO) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateISO || '');
  if (!m) return null;
  // Date.UTC on a bare date is timezone-proof; we only want the weekday.
  return DOW[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
}

export function daysBetween(fromISO, toISO) {
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fromISO || '');
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(toISO || '');
  if (!a || !b) return null;
  const ms = Date.UTC(+b[1], +b[2] - 1, +b[3]) - Date.UTC(+a[1], +a[2] - 1, +a[3]);
  return Math.round(ms / 86400000);
}

/* ---------- distance ---------- */

export function metresBetween(a, b) {
  if (!a || !b) return null;
  const [lat1, lon1] = a, [lat2, lon2] = b;
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return null;
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

// 80 m/min is an unhurried walk. Round up: nobody is annoyed by arriving early.
export function walkMinutes(a, b) {
  const m = metresBetween(a, b);
  return m == null ? null : Math.max(1, Math.ceil(m / 80));
}

/* ---------- opening hours ----------
   restaurants.json carries {mon:[["11:00","21:00"]], ...}. Returns true,
   false, or null for "we don't know" — and null is never treated as open. */

export function openAt(hours, dateISO, min) {
  const day = dowOf(dateISO);
  if (!hours || !day || !Array.isArray(hours[day])) return null;
  const spans = hours[day];
  if (spans.length === 0) return false;              // explicitly closed
  for (const span of spans) {
    if (!Array.isArray(span) || span.length !== 2) continue;
    const a = splitStamp(`2000-01-01T${span[0]}`), b = splitStamp(`2000-01-01T${span[1]}`);
    if (!a || !b) continue;
    const end = b.min <= a.min ? b.min + 1440 : b.min;  // past midnight
    if (min >= a.min && min < end) return true;
  }
  return false;
}

/* ---------- weather ----------
   Hourly covers ~36h; NWS periods cover about a week; past that we know
   nothing and say so. `known:false` never means "probably fine". */

export function weatherAt(weather, dateISO, min) {
  const unknown = { known: false, pop: null, tempF: null, windMph: null, why: 'no forecast that far out' };
  if (!weather) return unknown;

  const hours = weather?.hourly?.hours;
  if (Array.isArray(hours)) {
    let best = null, bestGap = Infinity;
    for (const h of hours) {
      const s = splitStamp(h?.t);
      if (!s || s.date !== dateISO) continue;
      const gap = Math.abs(s.min - min);
      if (gap < bestGap) { best = h; bestGap = gap; }
    }
    if (best && bestGap <= 90) {
      return {
        known: true, source: 'hourly',
        pop: Number.isFinite(best.pop) ? best.pop : null,
        tempF: Number.isFinite(best.temp_f) ? best.temp_f : null,
        windMph: Number.isFinite(best.wind_mph) ? best.wind_mph : null,
        short: typeof best.short === 'string' ? best.short : null,
      };
    }
  }

  const periods = weather?.forecast?.periods;
  if (Array.isArray(periods)) {
    for (const p of periods) {
      const s = splitStamp(p?.startTime || p?.start);
      if (!s || s.date !== dateISO) continue;
      const daytime = p.isDaytime !== false;
      if (daytime !== (min >= 6 * 60 && min < 18 * 60)) continue;
      return {
        known: true, source: 'period',
        pop: Number.isFinite(p?.probabilityOfPrecipitation?.value)
          ? p.probabilityOfPrecipitation.value
          : (Number.isFinite(p?.pop) ? p.pop : null),
        tempF: Number.isFinite(p.temperature) ? p.temperature : null,
        windMph: null,
        short: typeof p.shortForecast === 'string' ? p.shortForecast : null,
      };
    }
  }
  return unknown;
}

// Deliberately conservative. Unknown weather is not outdoor weather.
export function outdoorOk(w) {
  if (!w || !w.known) return false;
  if (Number.isFinite(w.pop) && w.pop >= 50) return false;
  if (Number.isFinite(w.tempF) && (w.tempF < 38 || w.tempF > 92)) return false;
  if (Number.isFinite(w.windMph) && w.windMph >= 28) return false;
  return true;
}

/* ---------- constraints ----------
   The shape the rest of the engine speaks. bd-ask returns this from a
   sentence; fallbackParse produces it without a model so the app still
   works when the function is down or the key is missing. */

export const WANTS = [
  'outdoors', 'indoors', 'sit_down_dinner', 'cheap', 'free', 'kids',
  'lively', 'quiet', 'walkable', 'drinks', 'culture', 'water',
];

export function emptyConstraints() {
  return {
    dateISO: null, startMin: 11 * 60, endMin: 21 * 60,
    party: 2, mobility: 'normal', budget: 'any',
    wants: [], avoid: [], text: '',
  };
}

export function normaliseConstraints(raw) {
  const c = emptyConstraints();
  if (!raw || typeof raw !== 'object') return c;
  if (typeof raw.dateISO === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.dateISO)) c.dateISO = raw.dateISO;
  if (Number.isFinite(raw.startMin)) c.startMin = Math.min(1439, Math.max(0, Math.round(raw.startMin)));
  if (Number.isFinite(raw.endMin)) c.endMin = Math.min(1620, Math.max(c.startMin + 60, Math.round(raw.endMin)));
  if (Number.isFinite(raw.party)) c.party = Math.min(20, Math.max(1, Math.round(raw.party)));
  if (raw.mobility === 'low') c.mobility = 'low';
  if (raw.budget === 'low' || raw.budget === 'mid') c.budget = raw.budget;
  const clean = (xs) => Array.isArray(xs) ? [...new Set(xs.filter((w) => WANTS.includes(w)))] : [];
  c.wants = clean(raw.wants);
  c.avoid = clean(raw.avoid);
  if (typeof raw.text === 'string') c.text = raw.text.slice(0, 500);
  return c;
}

// Keyword fallback. Crude on purpose — it only has to be honest, not clever.
export function fallbackParse(text, { todayISO } = {}) {
  const c = emptyConstraints();
  const t = String(text || '').toLowerCase();
  c.text = String(text || '').slice(0, 500);

  if (/\bcan'?t walk|hard time walking|walker|wheelchair|bad (knee|hip|back)|elderly|seventies|eighties|mobility/.test(t)) c.mobility = 'low';
  if (/\bfree\b|no money|broke/.test(t)) { c.wants.push('free'); c.budget = 'low'; }
  else if (/\bcheap|budget|inexpensive|affordable/.test(t)) { c.wants.push('cheap'); c.budget = 'low'; }
  if (/\bdinner\b|sit.?down|proper meal|nice meal/.test(t)) c.wants.push('sit_down_dinner');
  if (/\boutside|outdoors|outdoor|fresh air|nice out/.test(t)) c.wants.push('outdoors');
  if (/\brain|indoors|inside|rainy/.test(t)) c.wants.push('indoors');
  if (/\bkids?\b|children|toddler|family/.test(t)) c.wants.push('kids');
  if (/\bquiet|talk|conversation|catch up/.test(t)) c.wants.push('quiet');
  if (/\bdrinks?\b|beer|brewery|cider|bar\b|cocktail/.test(t)) c.wants.push('drinks');
  if (/\bmuseum|art|gallery|history|culture/.test(t)) c.wants.push('culture');
  if (/\blake|water|beach|waterfront/.test(t)) c.wants.push('water');

  const party = t.match(/\b(\d{1,2})\s*(?:people|of us|adults|friends|guests)\b/);
  if (party) c.party = Math.min(20, Math.max(1, Number(party[1])));
  else if (/\bmy parents\b|\bthe parents\b/.test(t)) c.party = 4;
  else if (/\bmy (girlfriend|boyfriend|wife|husband|partner)\b|\bdate\b/.test(t)) c.party = 2;

  if (todayISO) {
    const named = t.match(/\b(sun|mon|tues|wednes|thurs|fri|satur)day\b/);
    if (/\btomorrow\b/.test(t)) c.dateISO = shiftISO(todayISO, 1);
    else if (/\btoday|tonight\b/.test(t)) c.dateISO = todayISO;
    else if (named) c.dateISO = nextDow(todayISO, named[1].slice(0, 3));
  }
  if (/\btonight|this evening\b/.test(t)) { c.startMin = 17 * 60; c.endMin = 22 * 60; }
  if (/\bmorning\b/.test(t)) { c.startMin = 9 * 60; c.endMin = 13 * 60; }

  c.wants = [...new Set(c.wants)];
  return normaliseConstraints(c);
}

export function shiftISO(dateISO, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateISO || '');
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + days));
  return d.toISOString().slice(0, 10);
}

export function nextDow(fromISO, dowPrefix) {
  const target = DOW.findIndex((d) => d.startsWith(dowPrefix.slice(0, 3)));
  if (target < 0) return null;
  for (let i = 1; i <= 7; i++) {
    const iso = shiftISO(fromISO, i);
    if (DOW.indexOf(dowOf(iso)) === target) return iso;
  }
  return null;
}

/* ---------- the world ----------
   Places come from the guide's feeds. A stop refers to one by a namespaced
   ref ("thing:waterfront-park", "rest:hen-of-the-wood") so the two feeds
   can never collide. A ref we cannot resolve is a hole we admit to. */

export function indexWorld({ things, restaurants, events, weather } = {}) {
  const places = new Map();

  for (const t of (Array.isArray(things) ? things : [])) {
    if (!t?.id) continue;
    places.set(`thing:${t.id}`, {
      ref: `thing:${t.id}`, kind: 'thing', name: t.name || t.id,
      coords: Array.isArray(t.coords) && t.coords.length === 2 ? t.coords : null,
      hours: null,
      indoor: t.indoor_outdoor === 'Indoor' || t.indoor_outdoor === 'Both',
      outdoor: t.indoor_outdoor === 'Outdoor' || t.indoor_outdoor === 'Both',
      cost: t.cost_tier || null, group: t.group || null, category: t.category || null,
      timeOfDay: Array.isArray(t.time_of_day) ? t.time_of_day : [],
      season: Array.isArray(t.season) ? t.season : [],
      goodFor: Array.isArray(t.good_for) ? t.good_for : [],
      vibe: Array.isArray(t.vibe) ? t.vibe : [],
      neighborhood: t.neighborhood || null, url: t.website || null, closed: false,
    });
  }

  const rows = Array.isArray(restaurants) ? restaurants : (restaurants?.restaurants || []);
  for (const r of rows) {
    if (!r?.id) continue;
    places.set(`rest:${r.id}`, {
      ref: `rest:${r.id}`, kind: 'rest', name: r.name || r.id,
      coords: Array.isArray(r.coords) && r.coords.length === 2 ? r.coords : null,
      hours: r.hours && typeof r.hours === 'object' ? r.hours : null,
      hoursConfidence: r.hours_confidence || null,
      indoor: true, outdoor: !!r.patio,
      cost: r.price || null, group: 'Food & Drink', category: r.cuisine || 'Restaurant',
      timeOfDay: [], season: [], goodFor: [], vibe: [],
      neighborhood: r.neighborhood || null, url: r.links?.website || null,
      closed: r.closed === true, kitchenClose: r.kitchen_close || null,
    });
  }

  const evRows = Array.isArray(events) ? events : (events?.events || []);
  return { places, events: evRows, weather: weather || null };
}

export function resolve(world, ref) {
  return world?.places?.get(ref) || null;
}

/* ---------- matching a saved day to what someone asked for ----------
   Every line shown on screen comes from here, so every line is checkable.
   A day that hides its mismatches is a day nobody trusts twice. */

const WANT_LABEL = {
  outdoors: 'outdoors', indoors: 'an indoor option', sit_down_dinner: 'a sit-down dinner',
  cheap: 'cheap', free: 'free', kids: 'kids', lively: 'somewhere lively',
  quiet: 'somewhere quiet', walkable: 'short walks', drinks: 'drinks',
  culture: 'museums or galleries', water: 'the lake',
};

export function scoreDay(day, constraints, world) {
  const c = normaliseConstraints(constraints);
  const matches = [], mismatches = [];
  let score = 0;

  const dayWants = new Set(Array.isArray(day?.wants) ? day.wants : []);
  for (const w of c.wants) {
    if (dayWants.has(w)) { score += 3; matches.push(WANT_LABEL[w] || w); }
    else mismatches.push(`no ${WANT_LABEL[w] || w}`);
  }
  for (const w of c.avoid) if (dayWants.has(w)) { score -= 4; mismatches.push(`has ${WANT_LABEL[w] || w}`); }

  if (c.mobility === 'low') {
    if (day?.mobility === 'low') { score += 4; matches.push('short walks, places to sit'); }
    else {
      const far = longestWalk(day, world);
      if (far != null && far > 8) mismatches.push(`one ${far}-minute walk in it`);
      else score += 1;
    }
  }

  if (c.budget === 'low') {
    if (day?.budget === 'low') { score += 3; matches.push('costs almost nothing'); }
    else if (day?.budget === 'high') { score -= 2; mismatches.push('an expensive stop or two'); }
  }

  if (c.dateISO && Array.isArray(day?.season) && day.season.length) {
    const mon = Number(c.dateISO.slice(5, 7));
    if (!seasonCovers(day.season, mon)) { score -= 5; mismatches.push('really a different season'); }
  }

  const span = c.endMin - c.startMin;
  const daySpan = daySpanMinutes(day);
  if (daySpan != null && daySpan > span + 90) mismatches.push(`runs about ${Math.round(daySpan / 60)} hours`);

  score += Math.min(3, Math.round((day?.stats?.did || 0) / 15));
  if (Number.isFinite(day?.stats?.wouldAgain)) score += day.stats.wouldAgain >= 0.85 ? 2 : 0;

  return { score, matches: matches.slice(0, 3), mismatches: mismatches.slice(0, 2) };
}

function seasonCovers(season, month) {
  const S = season.map((s) => String(s).toLowerCase());
  if (S.some((s) => s.includes('year'))) return true;
  const inSeason = { spring: [3, 4, 5], summer: [6, 7, 8], fall: [9, 10, 11], autumn: [9, 10, 11], winter: [12, 1, 2] };
  return S.some((s) => Object.entries(inSeason).some(([k, ms]) => s.includes(k) && ms.includes(month)));
}

function daySpanMinutes(day) {
  const stops = Array.isArray(day?.stops) ? day.stops : [];
  if (stops.length < 2) return null;
  return stops[stops.length - 1].min - stops[0].min;
}

function longestWalk(day, world) {
  const stops = Array.isArray(day?.stops) ? day.stops : [];
  let worst = null;
  for (let i = 1; i < stops.length; i++) {
    const a = resolve(world, stops[i - 1].ref), b = resolve(world, stops[i].ref);
    const w = a && b ? walkMinutes(a.coords, b.coords) : null;
    if (w != null && (worst == null || w > worst)) worst = w;
  }
  return worst;
}

export function rankDays(days, constraints, world, { limit = 3, floor = 2 } = {}) {
  return (Array.isArray(days) ? days : [])
    .map((day) => ({ day, ...scoreDay(day, constraints, world) }))
    .filter((r) => r.score >= floor)
    .sort((a, b) => b.score - a.score || (b.day.stats?.did || 0) - (a.day.stats?.did || 0))
    .slice(0, limit);
}

/* ---------- rebuilding a saved day for a real date ----------
   What we can actually check, and nothing beyond it: a place that closed
   for good, posted hours for that weekday, the forecast at that hour, and
   whether the day is in its season. We cannot know about a private booking
   or a one-off closure — so we never claim to. */

const WALK_CAP = { low: 8, normal: 16 };

export function rebuildDay(day, world, { dateISO, constraints } = {}) {
  const c = normaliseConstraints(constraints);
  const date = dateISO || c.dateISO;
  const changes = [], warnings = [];
  const stops = [];
  if (!date) return { date: null, stops: [], changes: [], warnings: ['no date chosen'] };

  const cap = WALK_CAP[c.mobility === 'low' ? 'low' : 'normal'];
  const horizon = null; // set by caller via warnings below
  let weatherKnownSomewhere = false;

  for (const raw of (Array.isArray(day?.stops) ? day.stops : [])) {
    const place = resolve(world, raw.ref);
    if (!place) {
      changes.push({ type: 'dropped', name: raw.name || raw.ref, why: 'not in the guide any more' });
      continue;
    }

    let min = raw.min;
    let swappedFrom = null;
    const w0 = weatherAt(world.weather, date, min);
    if (w0.known) weatherKnownSomewhere = true;

    // 1. Gone for good.
    if (place.closed) {
      const alt = pickAlternative(place, world, { date, min, c, cap, prev: stops[stops.length - 1] });
      if (!alt) { changes.push({ type: 'dropped', name: place.name, why: 'closed for good' }); continue; }
      changes.push({ type: 'swapped', from: place.name, to: alt.name, why: `${place.name} has closed for good` });
      swappedFrom = place.name;
      stops.push(makeStop(alt, min, world, date, stops[stops.length - 1], swappedFrom));
      continue;
    }

    // 2. Posted hours say no. Try to move it inside the day before giving up.
    if (place.hours) {
      const open = openAt(place.hours, date, min);
      if (open === false) {
        const moved = findOpenMinute(place, date, min, c);
        if (moved != null) {
          changes.push({ type: 'moved', name: place.name, from: clockLabel(min), to: clockLabel(moved), why: `it doesn't open until ${clockLabel(moved)} on ${dowLong(date)}s` });
          min = moved;
        } else {
          const alt = pickAlternative(place, world, { date, min, c, cap, prev: stops[stops.length - 1] });
          if (!alt) { changes.push({ type: 'dropped', name: place.name, why: `closed ${dowLong(date)}s` }); continue; }
          changes.push({ type: 'swapped', from: place.name, to: alt.name, why: `${place.name} is closed on ${dowLong(date)}s` });
          swappedFrom = place.name;
          stops.push(makeStop(alt, min, world, date, stops[stops.length - 1], swappedFrom));
          continue;
        }
      }
    }

    // 2b. Priced out of the day, or a kind they asked to leave out. Without
    // this a "too expensive" or "no drinks" change would quietly do nothing.
    const why = tooDear(place, c) ? `${place.name} is dearer than you wanted`
      : avoided(place, c) ? `you asked to leave ${avoidedLabel(place, c)} out`
      : null;
    if (why) {
      const alt = pickAlternative(place, world, { date, min, c, cap, prev: stops[stops.length - 1] });
      if (alt) {
        changes.push({ type: 'swapped', from: place.name, to: alt.name, why });
        stops.push(makeStop(alt, min, world, date, stops[stops.length - 1], place.name));
        continue;
      }
      changes.push({ type: 'dropped', name: place.name, why });
      continue;
    }

    // 3. Outdoor-only stop in weather that won't take it.
    if (place.outdoor && !place.indoor) {
      const w = weatherAt(world.weather, date, min);
      if (!outdoorOk(w)) {
        const dry = findDryMinute(place, world, date, c);
        if (dry != null) {
          changes.push({ type: 'moved', name: place.name, from: clockLabel(min), to: clockLabel(dry), why: w.known ? `rain around ${clockLabel(min)}` : 'no forecast for that hour' });
          min = dry;
        } else if (w.known) {
          const alt = pickAlternative(place, world, { date, min, c, cap, prev: stops[stops.length - 1], indoorOnly: true });
          if (alt) {
            changes.push({ type: 'swapped', from: place.name, to: alt.name, why: `it's wet all day — ${alt.name} is indoors` });
            stops.push(makeStop(alt, min, world, date, stops[stops.length - 1], place.name));
            continue;
          }
          warnings.push(`${place.name} is outdoors and the forecast is poor. We left it in — your call.`);
        }
      }
    }

    stops.push(makeStop(place, min, world, date, stops[stops.length - 1], swappedFrom));
  }

  stops.sort((a, b) => a.min - b.min);
  for (let i = 1; i < stops.length; i++) {
    stops[i].walkFromPrev = walkMinutes(stops[i - 1].place.coords, stops[i].place.coords);
    if (stops[i].walkFromPrev != null && stops[i].walkFromPrev > cap) {
      warnings.push(`${stops[i - 1].place.name} to ${stops[i].place.name} is a ${stops[i].walkFromPrev}-minute walk.`);
    }
  }

  if (!weatherKnownSomewhere) {
    warnings.push('That date is beyond the forecast, so nothing here accounts for weather yet. Open it again closer to the day.');
  }
  const ev = eventsOn(world, date, c);
  return { date, stops, changes, warnings, eventsToday: ev.slice(0, 3) };
}

function makeStop(place, min, world, date, prev, swappedFrom) {
  return {
    min, ref: place.ref, place, swappedFrom: swappedFrom || null,
    walkFromPrev: prev ? walkMinutes(prev.place.coords, place.coords) : null,
    fact: factFor(place, date, min),
  };
}

/* A stop's one line of why. Every one of these is a fact out of the feed —
   an hours row, a forecast hour, a distance. Nothing rhetorical. */
export function factFor(place, date, min) {
  if (place.hours) {
    const day = dowOf(date);
    const spans = place.hours[day];
    if (Array.isArray(spans) && spans.length) {
      const close = spans[spans.length - 1][1];
      const s = splitStamp(`2000-01-01T${close}`);
      if (s) return `Kitchen till ${clockLabel(s.min)}`;
    }
  }
  if (place.cost === 'Free') return 'Free';
  if (place.outdoor && !place.indoor) return 'Outdoors';
  if (place.indoor && !place.outdoor) return 'Indoors';
  return null;
}

function dowLong(date) {
  return { sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' }[dowOf(date)] || 'that day';
}

function findOpenMinute(place, date, wanted, c) {
  for (let delta = 30; delta <= 180; delta += 30) {
    for (const m of [wanted + delta, wanted - delta]) {
      if (m < c.startMin || m > c.endMin) continue;
      if (openAt(place.hours, date, m) === true) return m;
    }
  }
  return null;
}

function findDryMinute(place, world, date, c) {
  for (let m = c.startMin; m <= c.endMin; m += 60) {
    const w = weatherAt(world.weather, date, m);
    if (outdoorOk(w) && (!place.hours || openAt(place.hours, date, m) !== false)) return m;
  }
  return null;
}

function pickAlternative(place, world, { date, min, c, cap, prev, indoorOnly }) {
  const anchor = prev?.place?.coords || place.coords;
  let best = null, bestScore = -Infinity;
  for (const cand of world.places.values()) {
    if (cand.ref === place.ref || cand.closed) continue;
    if (cand.kind !== place.kind) continue;
    if (place.kind === 'rest' && openAt(cand.hours, date, min) !== true) continue;
    if (indoorOnly && !cand.indoor) continue;
    if (cand.outdoor && !cand.indoor && !outdoorOk(weatherAt(world.weather, date, min))) continue;
    if (place.group && cand.group !== place.group) continue;
    if (tooDear(cand, c) || avoided(cand, c)) continue;
    const walk = walkMinutes(anchor, cand.coords);
    if (walk == null || walk > cap) continue;
    let s = 0;
    if (cand.category && cand.category === place.category) s += 3;
    if (cand.neighborhood === place.neighborhood) s += 2;
    if (c.budget === 'low' && (cand.cost === 'Free' || cand.cost === '$')) s += 3;
    if (c.budget === 'low' && (cand.cost === '$$$' || cand.cost === '$$$$')) s -= 4;
    s -= walk / 4;
    if (s > bestScore) { bestScore = s; best = cand; }
  }
  return best;
}

export function eventsOn(world, date, constraints) {
  const c = normaliseConstraints(constraints);
  const out = [];
  for (const e of (world.events || [])) {
    const s = splitStamp(e?.start) || (e?.date === date ? { date, min: null } : null);
    if (!s || s.date !== date) continue;
    if (s.min != null && (s.min < c.startMin - 60 || s.min > c.endMin)) continue;
    if (c.budget === 'low' && e.free !== true && Number(e.minPrice) > 0) continue;
    out.push({ id: e.id, title: e.title, venue: e.venue, min: s.min, free: e.free === true, url: e.url });
  }
  return out.sort((a, b) => (a.min ?? 1e9) - (b.min ?? 1e9));
}

/* ---------- building a day from nothing ----------
   Only runs when the library has nothing close. Same gates as the rebuild:
   a place has to be open, in season, and survivable in that hour's weather
   before it can be chosen at all. */

export function planSlots(c) {
  const slots = [];
  const wantsDinner = c.wants.includes('sit_down_dinner');
  if (c.startMin <= 10 * 60 + 30) slots.push({ min: Math.max(c.startMin, 9 * 60), kind: 'food-light' });
  const dinnerMin = wantsDinner && c.endMin >= 18 * 60 ? Math.min(18 * 60, c.endMin - 90) : null;
  const lastActivity = dinnerMin ? dinnerMin - 90 : c.endMin - 60;
  let m = slots.length ? slots[0].min + 90 : c.startMin;
  while (m <= lastActivity && slots.filter((s) => s.kind === 'activity').length < 4) {
    slots.push({ min: m, kind: 'activity' });
    m += 120;
  }
  if (dinnerMin) slots.push({ min: dinnerMin, kind: 'dinner' });
  return slots.sort((a, b) => a.min - b.min);
}

const SLOT_GROUPS = {
  'food-light': ['Food & Drink'],
  dinner: ['Food & Drink'],
  activity: ['Outdoors', 'Culture', 'Do & Play', 'Live & Events', 'Shopping'],
};

export function buildDay(constraints, world, { dateISO } = {}) {
  const c = normaliseConstraints(constraints);
  const date = dateISO || c.dateISO;
  const warnings = [], stops = [];
  if (!date) return { date: null, stops: [], changes: [], warnings: ['no date chosen'] };

  const cap = WALK_CAP[c.mobility === 'low' ? 'low' : 'normal'];
  const radius = Math.max(3, Math.ceil(cap / 2)); // every stop this close to one anchor,
  // so any two stops are within `cap` of each other by construction.
  const slots = planSlots(c);
  let sawWeather = false;

  // Pass one: who is eligible for each slot at all, distance aside.
  const pools = slots.map((slot) => {
    const w = weatherAt(world.weather, date, slot.min);
    if (w.known) sawWeather = true;
    const out = [];
    for (const p of world.places.values()) {
      if (!eligible(p, slot, date, w, c)) continue;
      out.push({ place: p, score: fitScore(p, slot, c) });
    }
    return out.sort((a, b) => b.score - a.score);
  });

  // Pass two: choose the corner of town where the whole day can happen.
  // Chaining greedily from the first good pick strands the later slots —
  // a park in the South End with no kitchen inside eight minutes of it.
  const anchor = chooseAnchor(pools, radius);
  if (!anchor) {
    return { date, stops: [], changes: [], built: true, eventsToday: eventsOn(world, date, c).slice(0, 3),
      warnings: ['Nothing in the guide fits that combination on that date. Try a wider window or a different day.'] };
  }

  const used = [];
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    let best = null, bestScore = -Infinity;
    for (const { place, score } of pools[i]) {
      if (used.some((u) => u.ref === place.ref)) continue;
      // Two stops in the same park is not an itinerary.
      if (used.some((u) => (metresBetween(u.coords, place.coords) ?? 1e9) < 150)) continue;
      const fromAnchor = walkMinutes(anchor, place.coords);
      if (fromAnchor == null || fromAnchor > radius) continue;
      const prev = used[used.length - 1];
      const leg = prev ? walkMinutes(prev.coords, place.coords) : 0;
      if (prev && (leg == null || leg > cap)) continue;
      // A day of three parks is a walk, not a day out.
      let variety = 0;
      const prevGroup = prev?.group, prevCat = prev?.category;
      if (prevGroup && place.group === prevGroup) variety -= 2;
      if (prevCat && place.category === prevCat) variety -= 3;
      if (used.filter((u) => u.group === place.group).length >= 2) variety -= 3;
      const s = score + variety - (leg || 0) / 5;
      if (s > bestScore) { bestScore = s; best = place; }
    }
    if (!best) { warnings.push(`Nothing open and suitable around ${clockLabel(slot.min)}, so we left that gap alone.`); continue; }
    used.push(best);
    stops.push(makeStop(best, slot.min, world, date, stops[stops.length - 1], null));
  }

  if (!sawWeather) warnings.push('That date is beyond the forecast, so nothing here accounts for weather yet.');
  return { date, stops, changes: [], warnings, eventsToday: eventsOn(world, date, c).slice(0, 3), built: true };
}

function eligible(p, slot, date, w, c) {
  if (p.closed) return false;
  if (slot.kind === 'dinner' && p.kind !== 'rest') return false;
  if (slot.kind === 'activity' && p.kind !== 'thing') return false;
  if (p.group && !SLOT_GROUPS[slot.kind].includes(p.group)) return false;
  // Unknown hours are not "probably open". A kitchen we cannot verify for
  // that weekday never gets scheduled — 50 of the 312 rows are unverified.
  if (p.kind === 'rest' && openAt(p.hours, date, slot.min) !== true) return false;
  if (p.hours && openAt(p.hours, date, slot.min) !== true) return false;
  if (p.outdoor && !p.indoor && !outdoorOk(w)) return false;
  if (p.season?.length && !seasonCovers(p.season, Number(date.slice(5, 7)))) return false;
  if (tooDear(p, c) || avoided(p, c)) return false;
  return true;
}

const DRINKS_RE = /Brewery|Cider|Bar\b|Distiller|Winery|Taproom/i;

export function tooDear(place, c) {
  if (c?.budget !== 'low') return false;
  return place.cost === '$$$' || place.cost === '$$$$';
}

export function avoided(place, c) {
  const avoid = c?.avoid ?? [];
  if (!avoid.length) return false;
  if (avoid.includes('drinks') && DRINKS_RE.test(`${place.category ?? ''} ${place.name ?? ''}`)) return true;
  if (avoid.includes('outdoors') && place.outdoor && !place.indoor) return true;
  if (avoid.includes('indoors') && place.indoor && !place.outdoor) return true;
  if (avoid.includes('culture') && place.group === 'Culture') return true;
  return false;
}

function avoidedLabel(place, c) {
  if ((c?.avoid ?? []).includes('drinks') && DRINKS_RE.test(`${place.category ?? ''} ${place.name ?? ''}`)) return 'drinking';
  return 'that kind of stop';
}

function fitScore(p, slot, c) {
  let s = 0;
  if (c.wants.includes('free') && p.cost === 'Free') s += 5;
  if (c.wants.includes('cheap') && (p.cost === 'Free' || p.cost === '$')) s += 3;
  if (c.wants.includes('outdoors') && p.outdoor) s += 3;
  if (c.wants.includes('indoors') && p.indoor) s += 2;
  if (c.wants.includes('water') && /Waterfront|Lake/i.test(`${p.neighborhood} ${p.name}`)) s += 3;
  if (c.wants.includes('culture') && p.group === 'Culture') s += 3;
  if (c.wants.includes('drinks') && /Brewery|Cider|Bar/i.test(p.category || '')) s += 3;
  if (c.wants.includes('kids') && p.goodFor.some((g) => /Kids|Family/i.test(g))) s += 3;
  if (c.wants.includes('quiet') && p.vibe.some((v) => /Quiet|Cozy/i.test(v))) s += 2;
  if (c.mobility === 'low' && p.vibe.some((v) => /Accessible/i.test(v))) s += 2;
  if (p.timeOfDay.length && matchesTimeOfDay(p.timeOfDay, slot.min)) s += 2;
  if (p.goodFor.includes("Locals' Pick")) s += 1;
  return s;
}

// The best anchor is the one that leaves the fewest slots stranded, with a
// good place in it — not simply the highest-scoring place in town.
function chooseAnchor(pools, radius) {
  const candidates = [];
  for (const pool of pools) for (const { place, score } of pool.slice(0, 12)) {
    if (place.coords) candidates.push({ coords: place.coords, score });
  }
  let best = null, bestKey = [-1, -Infinity];
  for (const cand of candidates) {
    let covered = 0;
    for (const pool of pools) {
      if (pool.some(({ place }) => (walkMinutes(cand.coords, place.coords) ?? 1e9) <= radius)) covered++;
    }
    const key = [covered, cand.score];
    if (key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) { bestKey = key; best = cand.coords; }
  }
  return best;
}

function matchesTimeOfDay(tags, min) {
  const t = tags.map((x) => String(x).toLowerCase());
  if (min < 11 * 60) return t.some((x) => x.includes('morning'));
  if (min < 17 * 60) return t.some((x) => x.includes('afternoon'));
  return t.some((x) => x.includes('evening') || x.includes('night'));
}

/* ---------- what a saved day may contain ----------
   Mirrored by bd_valid_day() in the SQL. Change both together. */

export const DAY_LIMITS = { name: 60, blurb: 160, note: 120, stopsMin: 2, stopsMax: 8, author: 40 };

export function validateDay(day) {
  const errs = [];
  const s = (v) => typeof v === 'string' ? v.trim() : '';
  if (!s(day?.name) || s(day.name).length > DAY_LIMITS.name) errs.push('name');
  if (s(day?.blurb).length > DAY_LIMITS.blurb) errs.push('blurb');
  if (s(day?.author).length > DAY_LIMITS.author) errs.push('author');
  const stops = Array.isArray(day?.stops) ? day.stops : [];
  if (stops.length < DAY_LIMITS.stopsMin || stops.length > DAY_LIMITS.stopsMax) errs.push('stops');
  for (const st of stops) {
    if (!/^(thing|rest):[a-z0-9-]+$/.test(String(st?.ref || ''))) errs.push('ref');
    if (!Number.isFinite(st?.min) || st.min < 0 || st.min > 1620) errs.push('min');
    if (s(st?.note).length > DAY_LIMITS.note) errs.push('note');
  }
  if (day?.travel != null && day.travel !== 'walk' && day.travel !== 'car') errs.push('travel');
  if (/(https?:|www\.)/i.test(`${s(day?.name)} ${s(day?.blurb)}`)) errs.push('links');
  return { ok: errs.length === 0, errs: [...new Set(errs)] };
}
