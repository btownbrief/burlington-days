/* app.js — wiring only. The rule of the house: js/core.js picks every place;
   this file moves data onto the screen and invents no facts.

   The design rule of this rewrite: THE DAY IS ALREADY THERE. Opening the app
   is the ask. Chips steer it, ↻ swaps one stop, shuffle deals a new day —
   nobody has to type a word. The ten curated days aren't a shelf to read any
   more; they're what the chips reach for first. */

import * as C from './core.js';
import { loadFeedsStaged, loadSeedDays, statusLine } from './feeds.js';
import { backend, askToConstraints, deviceToken, NetError } from './net.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

/* Eastern wall clock, DST-safe: ask Intl what time it is in Burlington. */
function nowET(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { dateISO: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) };
}

const ICON = {
  clock: '<circle cx="10" cy="10" r="7"/><path d="M10 7v3.4l2.4 1.5"/>',
  pin: '<path d="M10 17s6-4.5 6-9a6 6 0 0 0-12 0c0 4.5 6 9 6 9z"/><circle cx="10" cy="8" r="2"/>',
  tick: '<path d="M4 10.5l4 4 8-8"/>',
  thumb: '<path d="M7 10.5v7.5H4.5v-7.5z"/><path d="M10 18h6.1a1.8 1.8 0 0 0 1.8-1.5l.8-4.7a1.6 1.6 0 0 0-1.6-1.9h-3.4l.5-2.8a1.6 1.6 0 0 0-1.6-1.9h-.3L10 10.4V18z"/>',
  reroll: '<path d="M15.5 8.5A6 6 0 1 0 16 11"/><path d="M16 4.5v4h-4"/>',
};
const svg = (path, size = 13, stroke = 1.7) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

/* ---------- moods: the whole vocabulary of the front door ----------
   Each mood is a set of constraints and, through rankDays, a reach into the
   library. First person, What Now voice. */
const MOODS = [
  { key: 'surprise', label: 'surprise me', c: { wants: ['sit_down_dinner'] } },
  { key: 'broke', label: "I'm broke", adj: 'cheap', c: { budget: 'low', wants: ['cheap', 'free', 'sit_down_dinner'] } },
  { key: 'parents', label: 'parents in town', adj: 'slow, good', c: { mobility: 'low', wants: ['sit_down_dinner', 'quiet'], party: 4 } },
  { key: 'kids', label: 'kids with us', adj: 'kid-proof', c: { wants: ['kids', 'cheap', 'sit_down_dinner'] } },
  { key: 'date', label: 'date night', adj: 'date', c: { wants: ['quiet', 'drinks', 'sit_down_dinner'], party: 2, startMin: 16 * 60, endMin: 22 * 60 } },
  { key: 'rain', label: 'rain-proof', adj: 'dry', c: { wants: ['indoors', 'walkable', 'sit_down_dinner'] } },
  { key: 'outside', label: 'all outside', adj: 'wide-open', c: { wants: ['outdoors', 'water', 'sit_down_dinner'] } },
  { key: 'new', label: "I'm new here", adj: 'first', c: { wants: ['walkable', 'culture', 'sit_down_dinner'] } },
];

const S = {
  world: null, status: {}, days: [], api: null, signal: new Map(),
  date: null, mood: 'surprise', variant: 0, custom: null, customLine: null,
  plan: null, source: null, rerolls: {},           // slotIndex -> [excluded refs]
  run: null, ratings: new Map(), best: null,
  backendReady: true, seedBase: Date.now() % 100000,
};

/* ---------- boot: paint a day before anyone asks ---------- */

async function boot() {
  paintSky();
  renderWhenChips();
  renderMoodChips();
  renderSkeleton();

  const seeds = await loadSeedDays();
  S.api = backend({ seedDays: seeds });
  S.days = seeds.map(fromSeed);

  const staged = await loadFeedsStaged();
  S.status = staged.status;
  S.world = C.indexWorld({ ...staged.feeds, events: [] });
  try { S.mood = localStorage.getItem('bd_mood') || 'surprise'; } catch { /* fine */ }
  syncMoodChips();

  plan();               // ← the whole point: a day, with nothing typed

  // the heavy feed and the backend arrive later and only ever add
  staged.events.then((events) => {
    if (!Array.isArray(events?.events || events)) return;
    S.world = C.indexWorld({ ...staged.feeds, events });
    decorateEvents();
    renderCredit();
  }).catch(() => { /* the day stands without it */ });

  refreshLibrary().then(() => renderKept());
  renderCredit();
  wire();
  route();
}

const fromSeed = (d) => ({
  slug: d.id, name: d.name, blurb: d.blurb, author: d.author, pick: !!d.btownBriefPick,
  wants: d.wants ?? [], mobility: d.mobility ?? 'normal', budget: d.budget ?? 'any',
  season: d.season ?? ['Year-Round'], stops: d.stops, did: d.stats?.did ?? 0, pct: null,
  travel: d.travel ?? 'walk',
});
const fromRow = (r) => ({
  slug: r.slug, name: r.name, blurb: r.blurb, author: r.author_name, pick: !!r.btown_pick,
  wants: r.wants ?? [], mobility: r.mobility ?? 'normal', budget: r.budget ?? 'any',
  season: r.season ?? ['Year-Round'], stops: r.stops, did: r.did_count ?? 0, pct: r.again_pct ?? null,
  travel: r.travel ?? 'walk',
});

async function refreshLibrary() {
  try {
    const rows = await S.api.bd_days_public();
    if (Array.isArray(rows) && rows.length) S.days = rows.map(fromRow);
  } catch (e) {
    S.backendReady = !(e instanceof NetError && e.code === 'not_ready');
  }
  try {
    const sig = await S.api.bd_signal_public();
    S.signal = new Map((sig ?? []).map((r) => [r.ref, r]));
  } catch { /* ranking is a bonus */ }
}

/* ---------- the sky ---------- */

function paintSky() {
  const { min } = nowET();
  const sun = S.world?.weather?.sun;
  const sunsetMin = sun?.sunset ? C.splitStamp(sun.sunset)?.min : null;
  const h = min / 60;
  let phase = 'day';
  if (sunsetMin != null) {
    const ss = sunsetMin / 60;
    if (h < 5) phase = 'night';
    else if (h < 7) phase = 'dawn';
    else if (h < 11) phase = 'morning';
    else if (h < ss - 1.3) phase = 'day';
    else if (h < ss) phase = 'golden';
    else if (h < ss + 1) phase = 'dusk';
    else phase = 'night';
  } else {
    phase = h < 5 ? 'night' : h < 7 ? 'dawn' : h < 11 ? 'morning' : h < 18 ? 'day' : h < 20 ? 'dusk' : 'night';
  }
  document.documentElement.dataset.phase = phase;
}

/* ---------- date + mood chips ---------- */

function dayLabel(iso, todayISO) {
  if (iso === todayISO) return 'today';
  if (iso === C.shiftISO(todayISO, 1)) return 'tomorrow';
  return new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' });
}
function prettyDate(iso) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function renderWhenChips() {
  const { dateISO, min } = nowET();
  if (!S.date) S.date = min < 16 * 60 ? dateISO : C.shiftISO(dateISO, 1);
  const wrap = $('#when-chips');
  wrap.replaceChildren();
  for (let i = 0; i < 5; i++) {
    const iso = C.shiftISO(dateISO, i);
    if (i === 0 && min >= 21 * 60) continue;          // today is over; don't offer it
    const b = el('button', 'chip when', dayLabel(iso, dateISO));
    b.type = 'button';
    b.dataset.date = iso;
    b.setAttribute('aria-pressed', String(iso === S.date));
    b.onclick = () => { S.date = iso; S.variant = 0; S.rerolls = {}; syncWhenChips(); plan(); };
    wrap.append(b);
  }
}
const syncWhenChips = () => $$('#when-chips .chip').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.date === S.date)));

function renderMoodChips() {
  const wrap = $('#mood-chips');
  wrap.replaceChildren();
  for (const m of MOODS) {
    const b = el('button', 'chip', m.label);
    b.type = 'button';
    b.dataset.mood = m.key;
    b.setAttribute('aria-pressed', String(m.key === S.mood));
    b.onclick = () => {
      S.mood = m.key; S.custom = null; S.customLine = null; S.variant = 0; S.rerolls = {};
      try { localStorage.setItem('bd_mood', m.key); } catch { /* fine */ }
      syncMoodChips(); plan();
    };
    wrap.append(b);
  }
}
const syncMoodChips = () => $$('#mood-chips .chip').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mood === S.mood && !S.custom)));

/* ---------- planning: chips → a day on screen ---------- */

function moodConstraints() {
  if (S.custom) return C.normaliseConstraints({ ...S.custom, dateISO: S.date });
  const m = MOODS.find((x) => x.key === S.mood) ?? MOODS[0];
  const c = { ...m.c, wants: [...(m.c.wants ?? [])] };
  if (m.key === 'surprise') {
    const w = C.weatherAt(S.world?.weather, S.date, 14 * 60);
    if (w.known) c.wants.push(C.outdoorOk(w) ? 'outdoors' : 'indoors');
  }
  return C.normaliseConstraints({ ...c, dateISO: S.date });
}

function plan() {
  if (!S.world) return;
  const c = moodConstraints();

  // The library first: curated days that honestly fit this mood and date.
  const ranked = S.custom || S.mood !== 'surprise'
    ? C.rankDays(S.days, c, S.world, { limit: 2, floor: 3 })
    : C.rankDays(S.days, c, S.world, { limit: 2, floor: 5 });

  // Shuffle walks the options in a loop. A named mood reaches for the
  // library first — that's the curation doing its job. Surprise deals a
  // fresh day first, so its greeting never names an occasion nobody chose.
  const templates = ranked.map((r) => () => fromTemplate(r.day, c));
  const fresh = [0, 1, 2].map((k) => () => fromFresh(c, k));
  const options = (S.mood === 'surprise' && !S.custom)
    ? [fresh[0], fresh[1], ...templates, fresh[2]]
    : [...templates, ...fresh];
  let out = null;
  for (let tries = 0; tries < options.length && !out; tries++) {
    out = options[(S.variant + tries) % options.length]();
    if (out && out.plan.stops.length < 3) out = null;   // a gutted day is not a day
  }
  if (!out) out = fromFresh(c, S.variant);              // last resort, even if thin

  S.plan = out.plan;
  S.source = out.source;
  renderDay(out);
}
function fromTemplate(day, c) {
  const p = C.rebuildDay(day, S.world, { dateISO: S.date, constraints: c });
  return { plan: p, source: day };
}
function fromFresh(c, k) {
  const rand = C.mulberry(S.seedBase + S.variant * 13 + k * 7);
  const p = C.shuffleDay(c, S.world, { dateISO: S.date, rand });
  return { plan: p, source: null };
}

/* ---------- rendering the day ---------- */

function moodAdj() { return S.custom ? null : MOODS.find((m) => m.key === S.mood)?.adj ?? null; }

function renderDay({ plan: p, source }) {
  const label = dayLabel(S.date, nowET().dateISO);
  const adj = moodAdj();
  $('#greeting').innerHTML = source
    ? `&ldquo;<em>${esc(source.name)}</em>&rdquo;`
    : adj ? `A <em>${esc(adj)}</em> ${esc(label)}.` : `Your <em>${esc(label)}</em>, handled.`;

  const from = $('#day-from');
  if (source) {
    const bits = [source.pick ? 'a Btown Brief day' : `kept by ${source.author || 'a reader'}`];
    if (source.did > 0) bits.push(`${source.did} did it`);
    if (source.pct != null) bits.push(`${source.pct}% would again`);
    bits.push(`rebuilt for ${prettyDate(S.date)}`);
    from.textContent = bits.join(' · ');
  } else {
    from.textContent = `built fresh for ${prettyDate(S.date)} — every place checked`;
  }
  if (S.customLine) from.textContent = `${S.customLine} · ${from.textContent}`;

  renderCtx();
  renderNotices(p, source);
  renderTimeline(p);
  $('#keep').disabled = p.stops.length < 2;
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function renderCtx() {
  const w = C.weatherAt(S.world?.weather, S.date, 14 * 60);
  const bits = [];
  if (w.known) {
    if (w.tempF != null) bits.push(`${w.tempF}° ${String(w.short || '').toLowerCase()}`.trim());
    if (Number.isFinite(w.pop) && w.pop >= 30) bits.push(`${w.pop}% chance of rain`);
  } else {
    bits.push('past the forecast — weather unchecked');
  }
  const sun = S.world?.weather?.sun;
  if (sun?.sunset && S.date === nowET().dateISO) {
    const m = C.splitStamp(sun.sunset);
    if (m) bits.push(`sunset ${C.clockLabel(m.min)}`);
  }
  $('#ctx').textContent = bits.join(' · ');
}

function renderNotices(p, source) {
  const box = $('#day-notices');
  box.replaceChildren();
  if (p.changes.length) {
    const n = el('div', 'notice');
    const head = p.changes.length === 1 ? 'One thing changed for your date' : `${p.changes.length} things changed for your date`;
    n.innerHTML = `<b>${head}.</b> ` + p.changes.slice(0, 3).map((c) =>
      c.type === 'swapped' ? `${esc(c.from)} &rarr; ${esc(c.to)} (${esc(c.why)})`
      : c.type === 'moved' ? `${esc(c.name)} moved to ${esc(c.to)} (${esc(c.why)})`
      : `${esc(c.name)} dropped (${esc(c.why)})`).join(' · ');
    box.append(n);
  }
  for (const w of p.warnings.slice(0, 2)) box.append(el('div', 'warnline', w));
  if (source?.travel === 'car') box.append(el('div', 'warnline', "This one is spread out — you'll want a car between stops."));
}

function renderSkeleton() {
  const t = $('#timeline');
  t.replaceChildren();
  for (const min of [660, 780, 930, 1080]) {
    const row = el('div', 'stop skel');
    const when = el('div', 'when-col');
    when.append(el('b', null, C.clockLabel(min).replace(':00', '')));
    when.append(el('div', 'rail'));
    row.append(when, el('div', 'body'));
    t.append(row);
  }
  $('#greeting').innerHTML = 'Reading <em>Burlington</em>&hellip;';
}

function renderTimeline(p) {
  const t = $('#timeline');
  t.replaceChildren();
  if (!p.stops.length) {
    const empty = el('div', 'warnline', 'Nothing in the guide fits that combination on that date. Try another day, or loosen the mood.');
    empty.style.margin = '6px 0';
    t.append(empty);
    return;
  }
  p.stops.forEach((s, i) => t.append(stopRow(s, i, i === p.stops.length - 1)));
  decorateEvents();
}

function stopRow(s, i, last) {
  const row = el('div', 'stop');
  const when = el('div', 'when-col');
  when.append(el('b', null, C.clockLabel(s.min).replace(':00', '')));
  if (!last) when.append(el('div', 'rail'));
  const body = el('div', 'body');

  const top = el('div', 'toprow');
  top.append(el('h3', null, s.place.name));
  if (s.swappedFrom) top.append(el('span', 'badge soft', 'swapped in'));
  else if ((S.signal.get(s.ref)?.bests ?? 0) >= 3) top.append(el('span', 'badge', 'best part'));
  const rr = el('button', 'reroll');
  rr.type = 'button';
  rr.title = 'Swap this stop';
  rr.setAttribute('aria-label', `Swap ${s.place.name} for something else`);
  rr.innerHTML = svg(ICON.reroll, 16, 1.8);
  rr.onclick = () => rerollAt(i, body);
  top.append(rr);
  body.append(top);

  const bits = [];
  if (s.fact) bits.push(s.fact);
  if (s.walkFromPrev != null) bits.push(`${s.walkFromPrev} min walk`);
  const sig = S.signal.get(s.ref);
  if (sig && sig.ups >= 3) bits.push(`${sig.ups} liked it`);
  if (bits.length || s.place.category) {
    const why = el('div', 'why');
    why.innerHTML = svg(s.place.hours ? ICON.clock : ICON.pin, 12, 1.8);
    why.append(el('span', null, bits.join(' · ') || s.place.category));
    body.append(why);
  }
  const note = noteFor(s);
  if (note) body.append(el('div', 'note', note));

  row.append(when, body);
  return row;
}

// A curated day's own voice survives the rebuild — but only for the stop it
// was written about, never a swapped-in place.
function noteFor(s) {
  if (!S.source || s.swappedFrom) return null;
  const orig = (S.source.stops || []).find((x) => x.ref === s.ref);
  return orig?.note || null;
}

function rerollAt(i, bodyEl) {
  const exclude = S.rerolls[i] ?? [];
  const next = C.rerollStop(S.plan.stops, i, S.world, {
    dateISO: S.date, constraints: moodConstraints(),
    rand: C.mulberry(Date.now() & 0xffff), exclude,
  });
  if (!next) {
    bodyEl.animate?.([{ transform: 'translateX(0)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }], { duration: 220 });
    flashNotice('Nothing else fits that slot honestly — every alternative is closed, wet, or a hike away.');
    return;
  }
  S.rerolls[i] = [...exclude, S.plan.stops[i].ref];
  // walking legs on both sides change with the swap
  S.plan.stops[i] = next;
  for (let k = 1; k < S.plan.stops.length; k++) {
    S.plan.stops[k].walkFromPrev = C.walkMinutes(S.plan.stops[k - 1].place.coords, S.plan.stops[k].place.coords);
  }
  renderTimeline(S.plan);
  const rows = $$('#timeline .stop .body');
  rows[i]?.classList.add('swapping');
}

function flashNotice(msg) {
  const box = $('#day-notices');
  const n = el('div', 'warnline', msg);
  box.prepend(n);
  setTimeout(() => n.remove(), 5000);
}

function decorateEvents() {
  if (!S.plan || !S.world?.events?.length) return;
  const ev = C.eventsOn(S.world, S.date, moodConstraints()).slice(0, 2);
  $('#timeline .evline')?.remove();
  if (!ev.length) return;
  const line = el('div', 'warnline evline');
  line.style.margin = '4px 0 0';
  line.innerHTML = `<b style="color:var(--gold);font-weight:500">Also on ${esc(dayLabel(S.date, nowET().dateISO))}:</b> ` +
    ev.map((e) => `${esc(e.title)}${e.min != null ? ` (${C.clockLabel(e.min)})` : ''}${e.free ? ' · free' : ''}`).join(' · ');
  $('#timeline').append(line);
}

function renderCredit() {
  $('#credit').textContent = statusLine(S.status) +
    ' Nothing here is made up — if we can\'t check it, we say so.' +
    (S.backendReady ? '' : ' Saving isn\'t switched on yet, so days can\'t be shared or rated.');
}

function renderKept() {
  const kept = S.days.filter((d) => !d.pick);
  const wrap = $('#kept');
  if (!kept.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const shelf = $('#kept-shelf');
  shelf.replaceChildren();
  for (const d of kept.slice(0, 12)) {
    const b = el('button', 'keptcard');
    b.type = 'button';
    b.append(el('b', null, d.name));
    if (d.blurb) b.append(el('small', null, d.blurb));
    const foot = [];
    if (d.author) foot.push(`by ${d.author}`);
    if (d.did > 0) foot.push(`${d.did} did it`);
    if (foot.length) b.append(el('i', null, foot.join(' · ')));
    b.onclick = () => {
      S.custom = null; S.customLine = null; S.variant = 0; S.rerolls = {};
      const c = moodConstraints();
      const out = fromTemplate(d, c);
      S.plan = out.plan; S.source = out.source;
      renderDay(out);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    shelf.append(b);
  }
}

/* ---------- say it in your own words (the one optional keyboard) ---------- */

async function say(text) {
  const today = nowET().dateISO;
  let c, line;
  try {
    c = C.normaliseConstraints(await askToConstraints(text, today));
    line = 'heard you';
  } catch {
    c = C.fallbackParse(text, { todayISO: today });
    line = 'read without the language model — tap a chip if it missed';
  }
  if (c.dateISO) S.date = c.dateISO; else c.dateISO = S.date;
  S.custom = c; S.customLine = line; S.variant = 0; S.rerolls = {};
  renderWhenChips(); syncWhenChips(); syncMoodChips();
  plan();
}

/* ---------- the sheet ---------- */

function askSheet({ title, sub, fields, ok = 'Save' }) {
  return new Promise((resolve) => {
    const box = $('#sheet');
    $('#sheet-title').textContent = title;
    $('#sheet-sub').textContent = sub ?? '';
    $('#sheet-ok').textContent = ok;
    const wrap = $('#sheet-fields');
    wrap.replaceChildren();
    const inputs = fields.map((f) => {
      const lab = el('label');
      lab.append(el('span', null, f.label));
      const i = el('input');
      i.value = f.value ?? ''; i.placeholder = f.placeholder ?? '';
      i.maxLength = f.max ?? 60; i.autocomplete = 'off'; i.name = f.name;
      lab.append(i); wrap.append(lab);
      return [f.name, i];
    });
    box.hidden = false;
    inputs[0]?.[1].focus();
    const close = (val) => {
      box.hidden = true;
      $('#sheet-form').onsubmit = null; $('#sheet-cancel').onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    $('#sheet-cancel').onclick = () => close(null);
    $('#sheet-form').onsubmit = (e) => {
      e.preventDefault();
      close(Object.fromEntries(inputs.map(([k, i]) => [k, i.value.trim()])));
    };
  });
}

/* ---------- keep / share / open ---------- */

async function keepDay() {
  const res0 = await askSheet({
    title: 'Send it to the group',
    sub: 'Anyone you send the link to types this name to get in. Leave it blank to share with no name at all.',
    fields: [{ name: 'group', label: 'Group name', placeholder: 'davis-crew', max: 40 }],
    ok: 'Keep the day',
  });
  if (res0 === null) return;
  const stops = S.plan.stops.map((s) => ({ ref: s.ref, min: s.min, name: s.place.name }));
  const title = S.source?.name ?? (moodAdj() ? `A ${moodAdj()} day` : 'Our day');
  try {
    const res = await S.api.bd_save_run({
      p_token: deviceToken(), p_day_slug: S.source?.slug ?? null,
      p_title: title, p_date: S.date, p_stops: stops, p_group: res0.group || null,
    });
    if (res.error) throw new NetError(res.error);
    S.run = { slug: res.slug, title, date: S.date, stops };
    const url = `${location.origin}${location.pathname}#/run/${res.slug}`;
    if (navigator.share) { try { await navigator.share({ title: 'Our Burlington day', url }); } catch { /* dismissed */ } }
    else { try { await navigator.clipboard.writeText(url); } catch { /* fine */ } }
    location.hash = `#/live/${res.slug}`;
  } catch (e) {
    flashNotice(e.code === 'not_ready'
      ? "Saving isn't switched on yet, so this day can't be shared. Everything above still holds."
      : `Couldn't save that: ${e.code ?? e.message}`);
  }
}

async function openRun(slug) {
  try {
    const res = await S.api.bd_open_run({ p_slug: slug, p_group: null, p_token: deviceToken() });
    if (res.error === 'bad_group') return showGate(slug, res);
    if (res.error) throw new NetError(res.error);
    S.run = { slug, title: res.title, date: res.date, stops: res.stops };
    if (!location.hash.startsWith('#/rate/')) location.hash = `#/live/${slug}`;
    else renderRate();
  } catch (e) {
    if (e.code === 'bad_group') return showGate(slug, e.meta);
    show('v-day');
    flashNotice(e.code === 'not_ready' ? "Shared days aren't switched on yet." : "That link didn't work.");
  }
}

function showGate(slug, meta) {
  $('#gate-title').textContent = meta?.title ?? 'Someone shared a day with you';
  $('#gate-date').textContent = meta?.date ? prettyDate(meta.date) : '';
  $('#gate-error').textContent = '';
  $('#gate-form').dataset.slug = slug;
  show('v-gate');
}

/* ---------- during the day ---------- */

async function renderLive(slug) {
  if (slug && S.run?.slug !== slug) { await openRun(slug); return; }
  if (!S.run) { location.hash = '#/'; return; }
  const { dateISO, min } = nowET();
  const stops = S.run.stops;
  $('#live-clock').textContent = `${C.clockLabel(min)} · ${new Date(`${dateISO}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' })}`;
  $('#live-title').textContent = S.run.title;

  const past = dateISO > S.run.date;
  const isToday = dateISO === S.run.date;
  const future = dateISO < S.run.date;
  const remaining = isToday ? stops.filter((s) => s.min > min - 30) : (future ? stops : []);
  const finished = remaining.length === 0;
  const next = finished ? null : remaining[0];
  const place = next && C.resolve(S.world, next.ref);

  const panel = $('#live-next');
  panel.replaceChildren();
  if (finished) {
    panel.append(el('div', 'eyebrow', past ? 'That was the day' : "That's the day"));
    panel.append(el('h2', null, 'All done'));
    panel.append(Object.assign(el('p', 'small muted'), { textContent: "Tell us which bits were worth it — two taps, and it makes the next person's day better.", style: 'margin:0' }));
  } else {
    panel.append(el('div', 'eyebrow', `${future ? 'First up' : 'Up next'} · ${C.clockLabel(next.min)}`));
    panel.append(el('h2', null, place?.name ?? next.name ?? 'Your next stop'));
    const detail = [];
    if (next.walkFromPrev) detail.push(`${next.walkFromPrev} minutes on foot`);
    if (place && C.factFor(place, S.run.date, next.min)) detail.push(C.factFor(place, S.run.date, next.min));
    panel.append(Object.assign(el('p', 'small muted'), { textContent: detail.join(' · ') || 'Take your time.', style: 'margin:0' }));
  }

  const rail = $('#live-rail');
  rail.replaceChildren();
  stops.forEach((s) => {
    const done = finished || (isToday && s.min <= min - 30 && s !== next);
    const row = el('div', 'row'); row.style.gap = '11px';
    const dot = el('div', `raildot ${done ? 'done' : s === next ? 'next' : 'later'}`);
    if (done) dot.innerHTML = svg(ICON.tick, 12, 2.4);
    const name = el('div', 'small', C.resolve(S.world, s.ref)?.name ?? s.name ?? s.ref);
    name.style.color = done ? 'var(--ink-faint)' : s === next ? 'var(--ink)' : 'var(--ink-soft)';
    if (s === next) name.style.fontWeight = '500';
    row.append(dot, name);
    rail.append(row);
  });

  $('#live-actions-wrap').style.display = finished ? 'none' : '';
  const acts = $('#live-actions');
  acts.replaceChildren();
  for (const [label, mins] of [["we're running late", 30], ['way behind', 60]]) {
    const b = el('button', 'chip', label); b.type = 'button';
    b.onclick = () => { S.run.stops = S.run.stops.map((s) => (next && s.min >= next.min ? { ...s, min: s.min + mins } : s)); renderLive(); };
    acts.append(b);
  }
  const skip = el('button', 'chip', 'skip this one'); skip.type = 'button';
  skip.onclick = () => { if (next) S.run.stops = S.run.stops.filter((s) => s !== next); renderLive(); };
  acts.append(skip);

  $('#live-left').textContent = finished ? 'Nothing left to do' : `${remaining.length} stop${remaining.length === 1 ? '' : 's'} left`;
  $('#live-finish').textContent = finished ? 'Rate the day →' : "Day's done →";
  show('v-live');
}

/* ---------- afterward ---------- */

async function renderRate(slug) {
  if (slug && S.run?.slug !== slug) { await openRun(slug); location.hash = `#/rate/${slug}`; return; }
  if (!S.run) { location.hash = '#/'; return; }
  $('#rate-head').textContent = `How was ${new Date(`${S.run.date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' })}?`;
  const list = $('#rate-list');
  list.replaceChildren();
  for (const s of S.run.stops) {
    const name = C.resolve(S.world, s.ref)?.name ?? s.name ?? s.ref;
    const row = el('div', 'rate-row');
    row.append(Object.assign(el('div', null, name), { style: 'font-size:14.5px;font-weight:450' }));
    const pair = el('div', 'row'); pair.style.cssText = 'gap:6px;flex-shrink:0';
    for (const dir of [1, -1]) {
      const b = el('button', `thumb${dir < 0 ? ' down' : ''}`);
      b.type = 'button';
      b.setAttribute('aria-label', `${dir > 0 ? 'Liked' : 'Did not like'} ${name}`);
      b.setAttribute('aria-pressed', String(S.ratings.get(s.ref) === dir));
      b.innerHTML = svg(ICON.thumb, 18, 1.6);
      b.onclick = () => { S.ratings.set(s.ref, dir); renderRate(); };
      pair.append(b);
    }
    row.append(pair);
    list.append(row);
  }
  const best = $('#rate-best');
  best.replaceChildren();
  for (const s of S.run.stops) {
    const name = C.resolve(S.world, s.ref)?.name ?? s.name ?? s.ref;
    const b = el('button', 'chip', name); b.type = 'button';
    b.setAttribute('aria-pressed', String(S.best === s.ref));
    b.onclick = () => { S.best = S.best === s.ref ? null : s.ref; renderRate(); };
    best.append(b);
  }
  show('v-rate');
}

async function submitRating(publish) {
  const votes = [...S.ratings].map(([ref, vote]) => ({ ref, vote }));
  const wouldAgain = votes.length ? votes.filter((v) => v.vote > 0).length >= votes.length / 2 : null;
  try {
    await S.api.bd_rate_run({ p_token: deviceToken(), p_slug: S.run.slug, p_votes: votes, p_best: S.best, p_would_again: wouldAgain });
    if (!publish) { $('#rate-msg').textContent = 'Kept private. Thanks — the votes still help.'; return; }
    const form = await askSheet({
      title: 'Add it to the library',
      sub: 'Give it a name someone scanning a shelf would understand.',
      fields: [
        { name: 'name', label: 'Call it', value: S.run.title, max: 60 },
        { name: 'blurb', label: 'One line about it', placeholder: 'What should someone know before they take it?', max: 160 },
        { name: 'author', label: 'Your first name (optional)', placeholder: 'Leave blank to stay anonymous', max: 40 },
      ],
      ok: 'Add it',
    });
    if (form === null) return;
    const { name, blurb, author } = form;
    if (!name) { $('#rate-msg').textContent = 'It needs a name.'; return; }
    const res = await S.api.bd_publish_run({ p_token: deviceToken(), p_slug: S.run.slug, p_name: name, p_blurb: blurb, p_author: author });
    if (res.error) throw new NetError(res.error);
    await refreshLibrary();
    renderKept();
    $('#rate-msg').textContent = 'In the library. Somebody will take it.';
  } catch (e) {
    $('#rate-msg').style.color = 'var(--gold)';
    $('#rate-msg').textContent = e.code === 'not_ready'
      ? "Ratings aren't switched on yet — nothing was lost, just not saved."
      : `Couldn't save that: ${e.code ?? e.message}`;
  }
}

/* ---------- mine ---------- */

async function renderMine() {
  const list = $('#mine-list');
  list.replaceChildren();
  try {
    const rows = await S.api.bd_mine({ p_token: deviceToken() });
    if (!rows?.length) list.append(Object.assign(el('p', 'small muted'), { textContent: "You haven't kept a day yet." }));
    for (const r of rows ?? []) {
      const b = el('button', 'keptcard');
      b.type = 'button'; b.style.flex = 'none';
      b.append(el('b', null, r.title));
      b.append(el('small', null, prettyDate(r.on_date) + (r.rated ? ' · rated' : '')));
      b.onclick = () => { location.hash = `#/run/${r.slug}`; };
      list.append(b);
    }
  } catch (e) {
    list.append(Object.assign(el('p', 'small muted'), { textContent: e.code === 'not_ready' ? "Saving isn't switched on yet." : "Couldn't load your days." }));
  }
  show('v-mine');
}

/* ---------- routing + wiring ---------- */

function show(id) {
  $$('.view').forEach((v) => v.removeAttribute('data-active'));
  $(`#${id}`).setAttribute('data-active', '');
  window.scrollTo(0, 0);
}

function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [head, arg] = h.split('/');
  if (head === 'run' && arg) return openRun(arg);
  if (head === 'live') return renderLive(arg);
  if (head === 'rate') return renderRate(arg);
  if (head === 'mine') return renderMine();
  show('v-day');
}

function wire() {
  $('#shuffle').onclick = () => { S.variant += 1; S.rerolls = {}; plan(); };
  $('#keep').onclick = () => keepDay();
  $('#say-toggle').onclick = () => {
    $('#say-form').hidden = false;
    $('#say-toggle-wrap').hidden = true;
    $('#say').focus();
  };
  $('#say-form').onsubmit = (e) => {
    e.preventDefault();
    const v = $('#say').value.trim();
    if (v.length >= 3) say(v);
  };
  $('#gate-form').onsubmit = async (e) => {
    e.preventDefault();
    const slug = e.currentTarget.dataset.slug;
    try {
      const res = await S.api.bd_open_run({ p_slug: slug, p_group: $('#gate-name').value, p_token: deviceToken() });
      if (res.error) { $('#gate-error').textContent = res.error === 'resting' ? 'Too many tries. Give it fifteen minutes.' : "That's not the name."; return; }
      S.run = { slug, title: res.title, date: res.date, stops: res.stops };
      location.hash = `#/live/${slug}`;
    } catch { $('#gate-error').textContent = "Couldn't open that."; }
  };
  $('#live-finish').onclick = () => { location.hash = `#/rate/${S.run?.slug ?? ''}`; };
  $('#rate-publish').onclick = () => submitRating(true);
  $('#rate-private').onclick = () => submitRating(false);
  $$('[data-back]').forEach((b) => { b.onclick = () => { location.hash = '#/'; }; });
  window.addEventListener('hashchange', route);
  setInterval(paintSky, 5 * 60 * 1000);
}

boot().catch((e) => {
  document.body.innerHTML = '<div style="padding:44px 24px;font-family:Georgia,serif;color:#F2F0EA;background:#06080A;min-height:100vh"><h1>Burlington Days</h1><p style="font-family:system-ui;color:#aaa">Something went wrong loading the guide’s data. Try again in a moment.</p></div>';
  console.error(e);
});
