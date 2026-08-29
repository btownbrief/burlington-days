/* app.js — wiring only. Every decision about places, times and swaps is made
   in core.js, which is pure and tested; this file moves data onto the screen
   and never invents a fact of its own. */

import * as C from './core.js';
import { loadFeeds, loadSeedDays, statusLine } from './feeds.js';
import { backend, askToConstraints, deviceToken, NetError, isDemo } from './net.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

/* Eastern wall clock, DST-safe: ask Intl what time it is in Burlington
   rather than doing offset arithmetic. */
function nowET(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { dateISO: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) };
}

const GROUP_COLOUR = {
  'Food & Drink': 'var(--group-food)', Outdoors: 'var(--group-outdoors)', Culture: 'var(--group-culture)',
  'Live & Events': 'var(--group-events)', 'Do & Play': 'var(--group-play)', Shopping: 'var(--group-shopping)',
};

const ICON = {
  clock: '<circle cx="10" cy="10" r="7"/><path d="M10 7v3.4l2.4 1.5"/>',
  pin: '<path d="M10 17s6-4.5 6-9a6 6 0 0 0-12 0c0 4.5 6 9 6 9z"/><circle cx="10" cy="8" r="2"/>',
  rain: '<path d="M6 12.5a3.2 3.2 0 0 1 .6-6.4 4.2 4.2 0 0 1 8 1.1 2.8 2.8 0 0 1-.2 5.3z"/><path d="M8 15.5v2M12 15.5v2"/>',
  swap: '<path d="M3.5 7h11l-3-3"/><path d="M16.5 13h-11l3 3"/>',
  tick: '<path d="M4 10.5l4 4 8-8"/>',
  thumb: '<path d="M7 10.5v7.5H4.5v-7.5z"/><path d="M10 18h6.1a1.8 1.8 0 0 0 1.8-1.5l.8-4.7a1.6 1.6 0 0 0-1.6-1.9h-3.4l.5-2.8a1.6 1.6 0 0 0-1.6-1.9h-.3L10 10.4V18z"/>',
};
const svg = (path, size = 13, stroke = 1.7) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

const S = {
  world: null, status: {}, days: [], api: null, signal: new Map(),
  constraints: null, plan: null, source: null, run: null, ratings: new Map(), best: null,
  askText: '', filter: null, backendReady: true,
};

/* ---------- boot ---------- */

async function boot() {
  const seeds = await loadSeedDays();
  S.api = backend({ seedDays: seeds });
  const { feeds, status } = await loadFeeds();
  S.status = status;
  S.world = C.indexWorld(feeds);

  // Seeded days always show. Published ones join them when the backend is up.
  S.days = seeds.map(fromSeed);
  try {
    const rows = await S.api.bd_days_public();
    if (Array.isArray(rows) && rows.length) S.days = rows.map(fromRow);
  } catch (e) {
    S.backendReady = !(e instanceof NetError && e.code === 'not_ready');
  }
  await refreshLibrary();

  $('#shelf-status').textContent = statusLine(S.status) +
    (S.backendReady ? '' : ' Saving isn\'t switched on yet, so days can\'t be shared or rated.');
  const ask = $('#ask');
  ask.disabled = false;
  ask.placeholder = "Who's coming, and when?";
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
  } catch { /* the seeded days stay on the shelf either way */ }
  try {
    const sig = await S.api.bd_signal_public();
    S.signal = new Map((sig ?? []).map((r) => [r.ref, r]));
  } catch { /* ranking is a bonus */ }
}

/* ---------- routing ---------- */

function show(id) {
  $$('.view').forEach((v) => v.removeAttribute('data-active'));
  $(`#${id}`).setAttribute('data-active', '');
  window.scrollTo(0, 0);
}

function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [head, arg] = h.split('/');
  if (head === 'day' && arg) return openLibraryDay(arg);
  if (head === 'run' && arg) return openRun(arg);
  if (head === 'live') return renderLive(arg);
  if (head === 'rate') return renderRate(arg);
  if (head === 'mine') return renderMine();
  renderShelf();
  show('v-shelf');
}

/* ---------- 1 · the shelf ---------- */

const FILTERS = [
  { key: 'free', label: 'Free' }, { key: 'indoors', label: 'Rainy' },
  { key: 'kids', label: 'Kids' }, { key: 'sit_down_dinner', label: 'Dinner' },
  { key: 'quiet', label: 'Quiet' },
];

function renderShelf() {
  const list = $('#shelf-list');
  list.replaceChildren();
  const days = S.filter ? S.days.filter((d) => d.wants.includes(S.filter)) : S.days;
  $('#shelf-count').textContent = `${S.days.length} saved`;

  if (!days.length) {
    list.append(Object.assign(el('p', 'small muted'), { textContent: 'Nothing saved under that yet.' }));
  }
  for (const d of days.slice(0, 12)) list.append(dayCard(d));

  const f = $('#shelf-filters');
  f.replaceChildren();
  for (const { key, label } of FILTERS) {
    const b = el('button', 'chip sm', label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(S.filter === key));
    b.onclick = () => { S.filter = S.filter === key ? null : key; renderShelf(); };
    f.append(b);
  }
}

function dayCard(d, extra) {
  const card = el('button', 'card');
  card.type = 'button';
  const first = S.world && C.resolve(S.world, d.stops?.[0]?.ref);
  card.style.borderTopColor = GROUP_COLOUR[first?.group] ?? 'var(--group-culture)';
  card.append(el('h3', null, d.name));
  if (d.blurb) card.append(Object.assign(el('p', 'small muted'), { style: 'margin:0', textContent: d.blurb }));
  if (extra) card.append(extra);

  const foot = el('div', 'card-foot');
  if (d.pick) foot.append(el('span', 'pick', 'Btown Brief pick'));
  else if (d.did > 0) {
    foot.append(Object.assign(el('span', null, `${d.did} did it`), { style: 'font-weight:700;color:var(--ink)' }));
    if (d.pct != null) { foot.append(el('span', 'dot', '·')); foot.append(el('span', 'pct', `${d.pct}% would again`)); }
  } else {
    foot.append(el('span', 'faint', 'Nobody has done this one yet'));
  }
  if (d.author && !d.pick) { foot.append(el('span', 'dot', '·')); foot.append(el('span', null, `by ${d.author}`)); }
  card.append(foot);
  card.onclick = () => { location.hash = `#/day/${d.slug}`; };
  return card;
}

/* ---------- 2 · the ask ---------- */

async function doAsk(text) {
  S.askText = text;
  const today = nowET().dateISO;
  let constraints, read;
  try {
    constraints = C.normaliseConstraints(await askToConstraints(text, today));
    read = null;
  } catch {
    constraints = C.fallbackParse(text, { todayISO: today });
    read = 'Read without the language model — it may have missed something. Tap Edit to correct it.';
  }
  if (!constraints.dateISO) constraints.dateISO = today;
  S.constraints = constraints;
  renderMatched(read);
  show('v-matched');
}

function describe(c) {
  const bits = [];
  bits.push(new Date(`${c.dateISO}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }));
  bits.push(`${C.clockLabel(c.startMin)}–${C.clockLabel(c.endMin)}`);
  if (c.party > 1) bits.push(`${c.party} people`);
  if (c.mobility === 'low') bits.push('short walks');
  if (c.budget === 'low') bits.push('cheap');
  return bits.join(' · ');
}

function renderMatched(readNote) {
  $('#matched-ask').textContent = `“${S.askText}”`;
  $('#matched-read').textContent = readNote ? `${describe(S.constraints)} — ${readNote}` : describe(S.constraints);

  const ranked = C.rankDays(S.days, S.constraints, S.world, { limit: 3 });
  $('#matched-head').textContent = ranked.length
    ? (ranked.length === 1 ? 'One day close to that' : `${ranked.length === 2 ? 'Two' : 'Three'} days close to that`)
    : 'Nothing in the library is close';
  $('#matched-fallback-note').textContent = ranked.length
    ? `Neither of those? We'll build one from scratch for ${new Date(`${S.constraints.dateISO}T12:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}.`
    : 'Nobody has saved a day like that yet, so we\'ll make you one.';

  const list = $('#matched-list');
  list.replaceChildren();
  for (const { day, matches, mismatches } of ranked) {
    const lines = el('div', 'stack');
    lines.style.gap = '5px';
    for (const m of matches) lines.append(reasonLine(m, true));
    for (const m of mismatches) lines.append(reasonLine(m, false));
    const card = dayCard(day, lines);
    list.append(card);
  }
}

function reasonLine(text, good) {
  const row = el('div', 'row');
  row.style.cssText = 'gap:8px;align-items:flex-start';
  const mark = el('span');
  mark.style.cssText = `flex-shrink:0;margin-top:2px;color:${good ? 'var(--teal)' : 'var(--coral-dark)'}`;
  mark.innerHTML = good ? svg(ICON.tick, 14, 2) : svg('<path d="M10 5.5v6M10 14.2v.4"/>', 14, 2);
  row.append(mark, Object.assign(el('span', 'small'), { textContent: good ? text : `But: ${text}`, style: good ? 'color:var(--ink-2)' : 'color:var(--ink-3)' }));
  return row;
}

/* ---------- 3 · showing its work ---------- */

async function showBuilding(result) {
  const d = new Date(`${result.date}T12:00:00`);
  $('#building-date').textContent = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const box = $('#building-checks');
  box.replaceChildren();

  const evCount = S.world.events.length;
  const restCount = [...S.world.places.values()].filter((p) => p.kind === 'rest').length;
  const w = C.weatherAt(S.world.weather, result.date, 15 * 60);
  const checks = [
    [`${evCount.toLocaleString()} events checked`, `${result.eventsToday?.length ?? 0} on that day inside your window.`],
    [`${restCount} kitchens checked for ${new Date(`${result.date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' })}`,
      'Anywhere we can\'t verify for that day is left out.'],
    [w.known ? 'Forecast read' : 'No forecast yet',
      w.known ? `${w.pop != null ? `${w.pop}% chance of rain` : 'no rain figure'} mid-afternoon${w.tempF != null ? `, around ${w.tempF}°` : ''}.`
              : 'That date is past the forecast, so nothing here accounts for weather.'],
    [S.constraints?.mobility === 'low' ? 'Nothing over an eight-minute walk' : 'Walking distances checked',
      S.constraints?.mobility === 'low' ? 'You said short walks, so that\'s a hard rule.' : 'Legs kept short between stops.'],
  ];
  for (const [head, sub] of checks) box.append(checkRow(head, sub));
  show('v-building');
  await new Promise((r) => setTimeout(r, 900));
}

function checkRow(head, sub) {
  const row = el('div', 'check');
  const mark = el('div', 'mark');
  mark.innerHTML = svg(ICON.tick, 13, 2.4).replace('currentColor', '#fff');
  const body = el('div', 'stack');
  body.style.gap = '2px';
  body.append(Object.assign(el('div', null, head), { style: 'font-size:15px;font-weight:600' }));
  body.append(Object.assign(el('div', 'small', sub), { style: 'color:var(--ink-3)' }));
  row.append(mark, body);
  return row;
}

/* ---------- 4 · the day ---------- */

async function openLibraryDay(slug) {
  const day = S.days.find((d) => d.slug === slug);
  if (!day) { location.hash = '#/'; return; }
  const c = S.constraints ?? C.normaliseConstraints({ dateISO: nowET().dateISO, mobility: day.mobility, budget: day.budget, wants: day.wants });
  if (!c.dateISO) c.dateISO = nowET().dateISO;
  S.constraints = c;
  S.source = day;
  const plan = C.rebuildDay({ ...day, stops: day.stops }, S.world, { dateISO: c.dateISO, constraints: c });
  await showBuilding(plan);
  S.plan = plan;
  renderPlan();
  show('v-plan');
}

async function buildFresh() {
  const c = S.constraints ?? C.fallbackParse('', { todayISO: nowET().dateISO });
  S.source = null;
  const plan = C.buildDay(c, S.world, { dateISO: c.dateISO });
  await showBuilding(plan);
  S.plan = plan;
  renderPlan();
  show('v-plan');
}

function renderPlan() {
  const p = S.plan;
  const d = new Date(`${p.date}T12:00:00`);
  $('#plan-date').textContent = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  $('#plan-title').textContent = S.source ? S.source.name : 'Your day';
  $('#plan-origin').textContent = S.source
    ? `From ${S.source.author || 'the library'} · rebuilt for this date`
    : 'Built for you from the guide';

  const ch = $('#plan-changes');
  ch.replaceChildren();
  if (p.changes.length) {
    const box = el('div', 'notice');
    box.append(el('div', 'label', p.changes.length === 1 ? 'One thing changed' : `${p.changes.length} things changed`));
    const lines = el('div', 'stack'); lines.style.gap = '5px';
    for (const c of p.changes.slice(0, 4)) {
      const t = c.type === 'swapped' ? `${c.from} → ${c.to} — ${c.why}`
        : c.type === 'moved' ? `${c.name} moved to ${c.to} — ${c.why}`
        : `${c.name} dropped — ${c.why}`;
      lines.append(Object.assign(el('div', 'small'), { textContent: t, style: 'color:var(--ink-2)' }));
    }
    box.append(lines);
    ch.append(box);
  }

  const list = $('#plan-stops');
  list.replaceChildren();
  p.stops.forEach((s, i) => list.append(stopRow(s, i === p.stops.length - 1)));
  if (!p.stops.length) {
    list.append(Object.assign(el('p', 'small muted'), { textContent: 'Nothing in the guide fits that combination on that date. Try a wider window or another day.' }));
  }

  const warn = $('#plan-warnings');
  warn.replaceChildren();
  if (S.source?.travel === 'car') warn.append(el('div', 'warn', "This one is spread out — you'll want a car between stops."));
  for (const w of p.warnings) warn.append(el('div', 'warn', w));

  $('#plan-save').disabled = !p.stops.length || p.stops.length < 2;
}

function stopRow(s, last) {
  const row = el('div', 'stop');
  const when = el('div', 'when');
  when.append(el('b', null, C.clockLabel(s.min).replace(':00', '')));
  if (!last) when.append(el('div', 'rail'));
  const body = el('div', 'body');
  const head = el('div', 'row');
  head.style.cssText = 'gap:7px;flex-wrap:wrap';
  head.append(el('h3', null, s.place.name));
  if (s.swappedFrom) head.append(el('span', 'badge swap', 'Swapped'));
  else if ((S.signal.get(s.ref)?.bests ?? 0) >= 3) head.append(el('span', 'badge', 'Best part'));
  body.append(head);

  const why = el('div', 'why');
  const bits = [];
  if (s.fact) bits.push(s.fact);
  if (s.walkFromPrev != null) bits.push(`${s.walkFromPrev} min walk`);
  const sig = S.signal.get(s.ref);
  if (sig && sig.ups >= 3) bits.push(`${sig.ups} liked it`);
  why.innerHTML = svg(s.place.hours ? ICON.clock : ICON.pin, 12, 1.8);
  why.append(el('span', null, bits.join(' · ') || s.place.category || ''));
  body.append(why);
  row.append(when, body);
  return row;
}

/* ---------- refining by talking ---------- */

async function refine(text) {
  if (!S.plan) return;
  const t = text.toLowerCase();
  const c = { ...S.constraints };
  let touched = false;
  if (/cheap|expensive|too much|less money|budget/.test(t)) { c.budget = 'low'; c.wants = [...new Set([...c.wants, 'cheap'])]; touched = true; }
  if (/rain|indoors|inside/.test(t)) { c.wants = [...new Set([...c.wants, 'indoors'])]; touched = true; }
  if (/walk less|shorter walk|can'?t walk|too far/.test(t)) { c.mobility = 'low'; touched = true; }
  if (/quiet|talk/.test(t)) { c.wants = [...new Set([...c.wants, 'quiet'])]; touched = true; }
  if (/no (drink|alcohol|booze)|sober|non.?alcoholic/.test(t)) { c.avoid = [...new Set([...(c.avoid ?? []), 'drinks'])]; c.wants = c.wants.filter((w) => w !== 'drinks'); touched = true; }
  if (/later/.test(t)) { c.startMin += 60; c.endMin += 60; touched = true; }
  if (/earlier/.test(t)) { c.startMin = Math.max(0, c.startMin - 60); c.endMin -= 60; touched = true; }
  if (/kids?|children/.test(t)) { c.wants = [...new Set([...c.wants, 'kids'])]; touched = true; }

  if (!touched) {
    try { Object.assign(c, await askToConstraints(`${S.askText} ${text}`, nowET().dateISO)); touched = true; }
    catch { /* fall through to the honest message below */ }
  }
  if (!touched) { flash('#plan-warnings', "Couldn't work out what to change. Try \"cheaper\", \"indoors\", \"later\", or \"shorter walks\"."); return; }

  S.constraints = C.normaliseConstraints({ ...c, dateISO: S.plan.date });
  S.plan = S.source
    ? C.rebuildDay(S.source, S.world, { dateISO: S.plan.date, constraints: S.constraints })
    : C.buildDay(S.constraints, S.world, { dateISO: S.plan.date });
  renderPlan();
}

function flash(sel, msg) {
  const box = $(sel);
  const n = el('div', 'warn', msg);
  box.prepend(n);
  setTimeout(() => n.remove(), 6000);
}

/* ---------- the sheet ----------
   Replaces window.prompt: a modal prompt blocks the page, can't be styled,
   and on a phone it looks like the site is broken. */

function askSheet({ title, sub, fields, ok = 'Save' }) {
  return new Promise((resolve) => {
    const box = $('#sheet');
    $('#sheet-title').textContent = title;
    $('#sheet-sub').textContent = sub ?? '';
    $('#sheet-ok').textContent = ok;
    const wrap = $('#sheet-fields');
    wrap.replaceChildren();
    const inputs = fields.map((f) => {
      const row = el('label', 'stack');
      row.style.gap = '5px';
      row.append(Object.assign(el('span', 'label'), { textContent: f.label }));
      const i = el('input', 'ask');
      i.style.cssText = 'min-height:50px;height:50px;font-size:15px';
      i.value = f.value ?? '';
      i.placeholder = f.placeholder ?? '';
      i.maxLength = f.max ?? 60;
      i.autocomplete = 'off';
      i.name = f.name;
      row.append(i);
      wrap.append(row);
      return [f.name, i];
    });
    box.classList.remove('hide');
    inputs[0]?.[1].focus();

    const close = (val) => {
      box.classList.add('hide');
      $('#sheet-form').onsubmit = null;
      $('#sheet-cancel').onclick = null;
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

/* ---------- saving, sharing, opening ---------- */

async function savePlan() {
  const res0 = await askSheet({
    title: 'Send it to the group',
    sub: 'Anyone you send the link to types this name to get in. Leave it blank to share with no name at all.',
    fields: [{ name: 'group', label: 'Group name', placeholder: 'davis-crew', max: 40 }],
    ok: 'Save the day',
  });
  if (res0 === null) return;
  const group = res0.group;
  const stops = S.plan.stops.map((s) => ({ ref: s.ref, min: s.min, name: s.place.name }));
  try {
    const res = await S.api.bd_save_run({
      p_token: deviceToken(), p_day_slug: S.source?.slug ?? null,
      p_title: S.source?.name ?? 'Our day', p_date: S.plan.date, p_stops: stops, p_group: group || null,
    });
    if (res.error) throw new NetError(res.error);
    S.run = { slug: res.slug, title: S.source?.name ?? 'Our day', date: S.plan.date, stops };
    const url = `${location.origin}${location.pathname}#/run/${res.slug}`;
    if (navigator.share) { try { await navigator.share({ title: 'Our Burlington day', url }); } catch { /* dismissed */ } }
    else { try { await navigator.clipboard.writeText(url); } catch { /* fall through */ } }
    location.hash = `#/live/${res.slug}`;
  } catch (e) {
    flash('#plan-warnings', e.code === 'not_ready'
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
    if (!location.hash.startsWith(`#/rate/`)) location.hash = `#/live/${slug}`;
    else renderRate();
  } catch (e) {
    if (e.code === 'bad_group') return showGate(slug, e.meta);
    show('v-shelf');
    flash('#shelf-list', e.code === 'not_ready' ? "Shared days aren't switched on yet." : "That link didn't work.");
  }
}

function showGate(slug, meta) {
  $('#gate-title').textContent = meta?.title ?? 'Someone shared a day with you';
  $('#gate-date').textContent = meta?.date
    ? new Date(`${meta.date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    : '';
  $('#gate-sub').textContent = 'Type the group name to open it.';
  $('#gate-error').textContent = '';
  $('#gate-form').dataset.slug = slug;
  show('v-gate');
}

/* ---------- 6 · during the day ---------- */

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
  // A stop counts as behind you half an hour after it started.
  const remaining = isToday ? stops.filter((s) => s.min > min - 30) : (future ? stops : []);
  const finished = remaining.length === 0;
  const next = finished ? null : remaining[0];
  const place = next && C.resolve(S.world, next.ref);

  const panel = $('#live-next');
  panel.replaceChildren();
  if (finished) {
    panel.append(Object.assign(el('div', 'eyebrow'), { textContent: past ? 'That was the day' : 'That\'s the day' }));
    panel.append(Object.assign(el('h2', null, 'All done'), { style: 'font-size:26px;line-height:1.15' }));
    panel.append(Object.assign(el('p', null, 'Tell us which bits were worth it — two taps, and it makes the next person\'s day better.'), { style: 'margin:0;color:var(--ink-3);font-size:14px' }));
  } else {
    panel.append(Object.assign(el('div', 'eyebrow'), {
      textContent: future ? `First up · ${C.clockLabel(next.min)}` : `Up next · ${C.clockLabel(next.min)}` }));
    panel.append(Object.assign(el('h2', null, place?.name ?? next.name ?? 'Your next stop'), { style: 'font-size:26px;line-height:1.15' }));
    const detail = [];
    if (next.walkFromPrev) detail.push(`${next.walkFromPrev} minutes on foot`);
    if (place && C.factFor(place, S.run.date, next.min)) detail.push(C.factFor(place, S.run.date, next.min));
    panel.append(Object.assign(el('p', null, detail.join(' · ') || 'Take your time.'), { style: 'margin:0;color:var(--ink-3);font-size:14px' }));
  }

  const rail = $('#live-rail');
  rail.replaceChildren();
  stops.forEach((s, i) => {
    const done = finished || (isToday && s.min <= min - 30 && s !== next);
    const row = el('div', 'row'); row.style.gap = '11px';
    const dot = el('div');
    dot.style.cssText = `width:20px;height:20px;border-radius:999px;flex-shrink:0;${done ? 'background:var(--teal);display:flex;align-items:center;justify-content:center' : s === next ? 'border:2px solid var(--coral)' : 'border:2px solid var(--line)'}`;
    if (done) dot.innerHTML = svg(ICON.tick, 12, 2.4).replace('currentColor', '#fff');
    const name = el('div', 'small', C.resolve(S.world, s.ref)?.name ?? s.name ?? s.ref);
    name.style.color = done ? 'var(--ink-4)' : s === next ? 'var(--ink)' : 'var(--ink-2)';
    if (s === next) name.style.fontWeight = '600';
    row.append(dot, name);
    rail.append(row);
  });

  const acts = $('#live-actions');
  acts.replaceChildren();
  acts.parentElement.classList.toggle('hide', finished);
  for (const [label, mins] of [["We're running late", 30], ['Way behind', 60]]) {
    const b = el('button', 'chip', label); b.type = 'button';
    b.onclick = () => { S.run.stops = S.run.stops.map((s) => (next && s.min >= next.min ? { ...s, min: s.min + mins } : s)); renderLive(); };
    acts.append(b);
  }
  const skip = el('button', 'chip', 'Skip this one'); skip.type = 'button';
  skip.onclick = () => { if (next) S.run.stops = S.run.stops.filter((s) => s !== next); renderLive(); };
  acts.append(skip);

  $('#live-left').textContent = finished
    ? 'Nothing left to do'
    : `${remaining.length} stop${remaining.length === 1 ? '' : 's'} left`;
  $('#live-finish').textContent = finished ? 'Rate the day →' : "Day's done →";
  show('v-live');
}

/* ---------- 7 · afterward ---------- */

async function renderRate(slug) {
  if (slug && S.run?.slug !== slug) { await openRun(slug); location.hash = `#/rate/${slug}`; return; }
  if (!S.run) { location.hash = '#/'; return; }
  $('#rate-head').textContent = `How was ${new Date(`${S.run.date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' })}?`;
  const list = $('#rate-list');
  list.replaceChildren();
  for (const s of S.run.stops) {
    const name = C.resolve(S.world, s.ref)?.name ?? s.name ?? s.ref;
    const row = el('div', 'rate-row');
    row.append(Object.assign(el('div', null, name), { style: 'font-size:14.5px;font-weight:500' }));
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
    $('#rate-msg').textContent = 'In the library. Somebody will take it.';
  } catch (e) {
    $('#rate-msg').style.color = 'var(--coral)';
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
    if (!rows?.length) list.append(Object.assign(el('p', 'small muted'), { textContent: "You haven't saved a day yet." }));
    for (const r of rows ?? []) {
      const b = el('button', 'card');
      b.type = 'button';
      b.append(el('h3', null, r.title));
      b.append(Object.assign(el('p', 'small muted'), { style: 'margin:0', textContent: new Date(`${r.on_date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) + (r.rated ? ' · rated' : '') }));
      b.onclick = () => { location.hash = `#/run/${r.slug}`; };
      list.append(b);
    }
  } catch (e) {
    list.append(Object.assign(el('p', 'small muted'), { textContent: e.code === 'not_ready' ? "Saving isn't switched on yet." : "Couldn't load your days." }));
  }
  show('v-mine');
}

/* ---------- wiring ---------- */

function wire() {
  $('#ask-form').onsubmit = (e) => {
    e.preventDefault();
    const v = $('#ask').value.trim();
    if (v.length < 3) return;
    doAsk(v);
  };
  $('#matched-edit').onclick = () => { $('#ask').value = S.askText; show('v-shelf'); $('#ask').focus(); };
  $('#build-new').onclick = () => buildFresh();
  $('#refine-form').onsubmit = (e) => { e.preventDefault(); const v = $('#refine').value.trim(); if (v) { $('#refine').value = ''; refine(v); } };
  $('#plan-save').onclick = () => savePlan();
  $('#plan-share').onclick = () => savePlan();
  $('#live-finish').onclick = () => { location.hash = `#/rate/${S.run?.slug ?? ''}`; };
  $('#rate-publish').onclick = () => submitRating(true);
  $('#rate-private').onclick = () => submitRating(false);
  $('#gate-form').onsubmit = async (e) => {
    e.preventDefault();
    const slug = e.currentTarget.dataset.slug;
    try {
      const res = await S.api.bd_open_run({ p_slug: slug, p_group: $('#gate-name').value, p_token: deviceToken() });
      if (res.error) { $('#gate-error').textContent = res.error === 'resting' ? 'Too many tries. Give it fifteen minutes.' : "That's not the name."; return; }
      S.run = { slug, title: res.title, date: res.date, stops: res.stops };
      location.hash = `#/live/${slug}`;
    } catch (err) { $('#gate-error').textContent = "Couldn't open that."; }
  };
  $$('[data-back]').forEach((b) => { b.onclick = () => history.back(); });
  window.addEventListener('hashchange', route);
}

boot().catch((e) => {
  document.body.innerHTML = '<div style="padding:40px 24px;font-family:system-ui"><h1 style="font-family:Lora,Georgia,serif">Burlington Days</h1><p>Something went wrong loading the guide’s data. Try again in a moment.</p></div>';
  console.error(e);
});
