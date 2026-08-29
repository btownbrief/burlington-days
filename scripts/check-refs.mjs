/* Every ref in data/days.json must resolve against the LIVE feeds, every
   seeded day must pass validateDay, and every restaurant stop must be
   inside posted hours on a day that day could plausibly run. Run before
   shipping a change to the library — a dead ref is a hole a reader sees. */
import { readFileSync } from 'node:fs';
import * as C from '../js/core.js';

const BASE = 'https://guide.btownbrief.com/data/';
const get = async (p) => {
  const r = await fetch(BASE + p, { signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`);
  return r.json();
};

const [things, restaurants] = await Promise.all(['things.json', 'restaurants.json'].map(get));
const world = C.indexWorld({ things, restaurants, events: [], weather: null });
const { days } = JSON.parse(readFileSync(new URL('../data/days.json', import.meta.url), 'utf8'));

let bad = 0;
const seen = new Set();
for (const day of days) {
  if (seen.has(day.id)) { console.log(`FAIL ${day.id}: duplicate id`); bad++; }
  seen.add(day.id);

  const v = C.validateDay(day);
  if (!v.ok) { console.log(`FAIL ${day.id}: validateDay -> ${v.errs.join(', ')}`); bad++; }

  if (day.stats?.did !== 0 || day.stats?.wouldAgain !== null) {
    console.log(`FAIL ${day.id}: seeded counts must start at zero — never ship an invented number`); bad++;
  }

  let last = -1;
  for (const st of day.stops) {
    const p = C.resolve(world, st.ref);
    if (!p) { console.log(`FAIL ${day.id}: ${st.ref} is not in the feeds`); bad++; continue; }
    if (p.closed) { console.log(`FAIL ${day.id}: ${p.name} is flagged closed for good`); bad++; }
    if (!p.coords) { console.log(`WARN ${day.id}: ${p.name} has no coordinates — walk times will be blank`); }
    if (st.min <= last) { console.log(`FAIL ${day.id}: ${p.name} is out of time order`); bad++; }
    last = st.min;

    if (p.kind === 'rest') {
      // Check the day's own weekdays, not just any weekday.
      const dates = ['2026-09-12', '2026-09-13', '2026-09-16'];  // sat, sun, wed
      const anyOpen = dates.some((d) => C.openAt(p.hours, d, st.min) === true);
      if (!anyOpen) {
        console.log(`FAIL ${day.id}: ${p.name} is not open at ${C.clockLabel(st.min)} on any of sat/sun/wed`);
        bad++;
      }
      if (p.hoursConfidence === 'unverified') {
        console.log(`FAIL ${day.id}: ${p.name} has unverified hours — don't seed it`); bad++;
      }
    }
  }
  // A day must keep the promise it makes. A "short walks" day with a
  // twenty-minute leg in it is worse than no day at all.
  const cap = day.travel === 'car' ? Infinity : (day.mobility === 'low' ? 8 : 25);
  if (day.travel === 'car' && !/\bcar\b/i.test(day.blurb ?? '')) {
    console.log(`FAIL ${day.id}: a car day has to say so in its blurb`); bad++;
  }
  for (let i = 1; i < day.stops.length; i++) {
    const a = C.resolve(world, day.stops[i - 1].ref);
    const b = C.resolve(world, day.stops[i].ref);
    const w = a && b ? C.walkMinutes(a.coords, b.coords) : null;
    if (w != null && w > cap) {
      console.log(`FAIL ${day.id}: ${a.name} to ${b.name} is a ${w}-minute walk (cap ${cap} for mobility "${day.mobility ?? 'normal'}")`);
      bad++;
    }
  }
}

console.log(bad === 0
  ? `\nok — ${days.length} days, ${days.reduce((n, d) => n + d.stops.length, 0)} stops, every ref live`
  : `\n${bad} problem(s)`);
process.exit(bad === 0 ? 0 : 1);
