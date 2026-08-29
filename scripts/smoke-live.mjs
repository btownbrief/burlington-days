/* Runs the engine against the guide's real feeds. Not a unit test — proof
   that the shapes we assume are the shapes actually being served. */
import * as C from '../js/core.js';

const BASE = 'https://guide.btownbrief.com/data/';
const get = async (p) => {
  const r = await fetch(BASE + p, { signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`);
  return r.json();
};

const [things, restaurants, events, weather] = await Promise.all(
  ['things.json', 'restaurants.json', 'events/events.json', 'weather/latest.json'].map(get));

const world = C.indexWorld({ things, restaurants, events, weather });
console.log(`world: ${world.places.size} places, ${world.events.length} events, weather updated ${weather.updated}`);

const todayISO = C.splitStamp(weather.hourly.hours[0].t).date;
const sat = C.nextDow(todayISO, 'sat');
console.log(`today ${todayISO} · planning ${sat} (${C.dowOf(sat)})\n`);

const ask = "My parents are in town Saturday. They're in their seventies and can't walk far. We'd like to be outside if it's nice, and a proper dinner.";
const c = C.fallbackParse(ask, { todayISO });
console.log('constraints:', JSON.stringify({ ...c, text: undefined }));

const built = C.buildDay({ ...c, dateISO: sat }, world);
console.log(`\nBUILT DAY — ${built.stops.length} stops`);
for (const s of built.stops) {
  console.log(`  ${C.clockLabel(s.min).padStart(7)}  ${s.place.name}` +
    `${s.walkFromPrev ? `  (${s.walkFromPrev} min walk)` : ''}${s.fact ? `  · ${s.fact}` : ''}`);
}
for (const w of built.warnings) console.log('  ! ' + w);
console.log('  events that day:', built.eventsToday.map((e) => e.title).slice(0, 3).join(' | ') || '(none in window)');

const saved = { id: 'x', name: 'Test', wants: ['outdoors'], mobility: 'low', budget: 'mid',
  season: ['Year-Round'], stats: { did: 10 },
  stops: built.stops.slice(0, 4).map((s) => ({ ref: s.ref, min: s.min })) };
const far = C.shiftISO(todayISO, 30);
const re = C.rebuildDay(saved, world, { dateISO: far, constraints: c });
console.log(`\nREBUILT for ${far} (beyond forecast) — ${re.stops.length} stops, ${re.changes.length} changes`);
for (const ch of re.changes) console.log(`  ~ ${ch.type}: ${ch.name || ch.from}${ch.to ? ' -> ' + ch.to : ''} — ${ch.why}`);
for (const w of re.warnings) console.log('  ! ' + w);

const unknownHours = [...world.places.values()].filter((p) => p.kind === 'thing').length;
console.log(`\nnote: ${unknownHours} activity places carry no opening hours (things.json has no hours field).`);
