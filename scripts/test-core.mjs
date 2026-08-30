import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../js/core.js';

/* Fixtures are hand-written and small so a failure points at one rule.
   Shapes match the real feeds; values do not pretend to be real places. */

const things = [
  { id: 'park', name: 'Waterfront Park', coords: [44.4802, -73.2210], indoor_outdoor: 'Outdoor',
    cost_tier: 'Free', group: 'Outdoors', category: 'Park', season: ['Year-Round'],
    time_of_day: ['Morning', 'Afternoon'], good_for: ["Locals' Pick"], vibe: ['Lakeside'], neighborhood: 'Waterfront' },
  { id: 'museum', name: 'A Museum', coords: [44.4790, -73.2200], indoor_outdoor: 'Indoor',
    cost_tier: '$$', group: 'Culture', category: 'Museum', season: ['Year-Round'],
    time_of_day: ['Afternoon'], good_for: [], vibe: [], neighborhood: 'Waterfront' },
  { id: 'gallery', name: 'A Gallery', coords: [44.4795, -73.2190], indoor_outdoor: 'Indoor',
    cost_tier: 'Free', group: 'Culture', category: 'Museum', season: ['Year-Round'],
    time_of_day: ['Afternoon'], good_for: [], vibe: [], neighborhood: 'Waterfront' },
  { id: 'beach', name: 'A Beach', coords: [44.4900, -73.2300], indoor_outdoor: 'Outdoor',
    cost_tier: 'Free', group: 'Outdoors', category: 'Beach', season: ['Summer'],
    time_of_day: ['Afternoon'], good_for: [], vibe: [], neighborhood: 'New North End' },
];

const restaurants = { restaurants: [
  { id: 'supper', name: 'Supper Club', coords: [44.4780, -73.2120], price: '$$$',
    hours: { sat: [['17:00', '22:00']], sun: [] }, hours_confidence: 'google', closed: false },
  { id: 'diner', name: 'The Diner', coords: [44.4782, -73.2125], price: '$',
    hours: { sat: [['08:00', '23:00']], sun: [['08:00', '15:00']] }, hours_confidence: 'google', closed: false },
  { id: 'gone', name: 'Gone Fishing', coords: [44.4781, -73.2124], price: '$$',
    hours: { sat: [['11:00', '21:00']] }, closed: true },
] };

const weatherDry = { hourly: { hours: Array.from({ length: 14 }, (_, i) => ({
  t: `2026-09-12T${String(8 + i).padStart(2, '0')}:00:00-04:00`, temp_f: 70, wind_mph: 6, pop: 5, short: 'Sunny' })) } };

const weatherWetPM = { hourly: { hours: Array.from({ length: 14 }, (_, i) => {
  const h = 8 + i; return { t: `2026-09-12T${String(h).padStart(2, '0')}:00:00-04:00`,
    temp_f: 68, wind_mph: 8, pop: h >= 15 ? 80 : 5, short: h >= 15 ? 'Rain' : 'Sunny' }; }) } };

const world = (weather) => C.indexWorld({ things, restaurants, events: [], weather });

test('wall clock is read from the string, never converted', () => {
  assert.deepEqual(C.splitStamp('2026-09-12T20:30:00-04:00'), { date: '2026-09-12', min: 1230 });
  assert.equal(C.splitStamp('nope'), null);
  assert.equal(C.clockLabel(0), '12:00am');
  assert.equal(C.clockLabel(12 * 60), '12:00pm');
  assert.equal(C.clockLabel(13 * 60 + 5), '1:05pm');
});

test('weekday and date shifts', () => {
  assert.equal(C.dowOf('2026-09-12'), 'sat');
  assert.equal(C.shiftISO('2026-09-12', 1), '2026-09-13');
  assert.equal(C.shiftISO('2026-12-31', 1), '2027-01-01');
  assert.equal(C.nextDow('2026-09-12', 'sat'), '2026-09-19');
  assert.equal(C.daysBetween('2026-09-12', '2026-09-15'), 3);
});

test('openAt: open, shut, unknown, and past midnight', () => {
  const h = { sat: [['17:00', '22:00']], sun: [], fri: [['20:00', '02:00']] };
  assert.equal(C.openAt(h, '2026-09-12', 18 * 60), true);
  assert.equal(C.openAt(h, '2026-09-12', 16 * 60), false);
  assert.equal(C.openAt(h, '2026-09-13', 18 * 60), false, 'empty array means closed that day');
  assert.equal(C.openAt(h, '2026-09-14', 18 * 60), null, 'no row means unknown, not open');
  assert.equal(C.openAt(null, '2026-09-12', 18 * 60), null);
  assert.equal(C.openAt(h, '2026-09-11', 24 * 60 + 30), true, 'span crossing midnight');
});

test('weatherAt admits when it does not know', () => {
  const w = C.weatherAt(weatherDry, '2026-09-12', 12 * 60);
  assert.equal(w.known, true);
  assert.equal(w.pop, 5);
  assert.equal(C.weatherAt(weatherDry, '2026-10-30', 12 * 60).known, false);
  assert.equal(C.weatherAt(null, '2026-09-12', 12 * 60).known, false);
});

test('outdoorOk is conservative — unknown is not fine', () => {
  assert.equal(C.outdoorOk({ known: false }), false);
  assert.equal(C.outdoorOk({ known: true, pop: 80, tempF: 70, windMph: 5 }), false);
  assert.equal(C.outdoorOk({ known: true, pop: 5, tempF: 20, windMph: 5 }), false);
  assert.equal(C.outdoorOk({ known: true, pop: 5, tempF: 70, windMph: 40 }), false);
  assert.equal(C.outdoorOk({ known: true, pop: 5, tempF: 70, windMph: 6 }), true);
});

test('walking distance', () => {
  assert.equal(C.walkMinutes([44.4802, -73.2210], [44.4802, -73.2210]), 1);
  assert.equal(C.walkMinutes([44.4802, -73.2210], null), null);
  assert.ok(C.walkMinutes([44.4802, -73.2210], [44.4900, -73.2300]) > 8);
});

test('fallbackParse reads the obvious things without a model', () => {
  const c = C.fallbackParse("My parents are in town Saturday. They're in their seventies and can't walk far. We want a proper dinner.", { todayISO: '2026-09-08' });
  assert.equal(c.mobility, 'low');
  assert.ok(c.wants.includes('sit_down_dinner'));
  assert.equal(c.party, 4);
  assert.equal(c.dateISO, '2026-09-12');
  const b = C.fallbackParse('cheap date tonight, somewhere quiet', { todayISO: '2026-09-08' });
  assert.equal(b.budget, 'low');
  assert.equal(b.party, 2);
  assert.ok(b.wants.includes('quiet'));
  assert.equal(b.startMin, 17 * 60);
});

test('normaliseConstraints throws away anything it does not recognise', () => {
  const c = C.normaliseConstraints({ wants: ['outdoors', 'teleportation'], party: 999, mobility: 'zzz', dateISO: 'nope' });
  assert.deepEqual(c.wants, ['outdoors']);
  assert.equal(c.party, 20);
  assert.equal(c.mobility, 'normal');
  assert.equal(c.dateISO, null);
});

const sampleDay = {
  id: 'slow', name: 'A Slow Day', wants: ['outdoors', 'sit_down_dinner'], mobility: 'low',
  budget: 'mid', season: ['Year-Round'], stats: { did: 30, wouldAgain: 0.9 },
  stops: [
    { ref: 'thing:park', min: 12 * 60 },
    { ref: 'thing:museum', min: 14 * 60 },
    { ref: 'rest:supper', min: 18 * 60 },
  ],
};

test('scoreDay reports what does NOT fit, not just what does', () => {
  const w = world(weatherDry);
  const r = C.scoreDay(sampleDay, { wants: ['outdoors', 'sit_down_dinner', 'free'], mobility: 'low' }, w);
  assert.ok(r.score > 0);
  assert.ok(r.matches.length >= 2);
  assert.ok(r.mismatches.some((m) => m.includes('free')), 'must admit it is not free');
});

test('a day out of season scores itself down', () => {
  const w = world(weatherDry);
  const summer = { ...sampleDay, season: ['Summer'] };
  const r = C.scoreDay(summer, { dateISO: '2026-01-10', wants: [] }, w);
  assert.ok(r.mismatches.some((m) => m.includes('season')));
});

test('rebuild: a place closed that weekday is swapped, not silently kept', () => {
  const w = world(weatherDry);
  const day = { ...sampleDay, stops: [{ ref: 'rest:supper', min: 18 * 60 }, { ref: 'thing:museum', min: 20 * 60 }] };
  const out = C.rebuildDay(day, w, { dateISO: '2026-09-13', constraints: { startMin: 11 * 60, endMin: 21 * 60 } });
  const swap = out.changes.find((c) => c.type === 'swapped' || c.type === 'dropped' || c.type === 'moved');
  assert.ok(swap, 'Sunday closure must produce a change');
  assert.ok(!out.stops.some((s) => s.ref === 'rest:supper' && s.min === 18 * 60));
});

test('rebuild: an outdoor stop in the rain gets moved to a dry hour', () => {
  const w = world(weatherWetPM);
  const day = { ...sampleDay, stops: [{ ref: 'thing:park', min: 16 * 60 }, { ref: 'rest:diner', min: 19 * 60 }] };
  const out = C.rebuildDay(day, w, { dateISO: '2026-09-12', constraints: { startMin: 9 * 60, endMin: 21 * 60 } });
  const moved = out.changes.find((c) => c.type === 'moved' && c.name === 'Waterfront Park');
  assert.ok(moved, 'the park should move out of the rain');
  const park = out.stops.find((s) => s.ref === 'thing:park');
  assert.ok(park.min < 15 * 60);
});

test('rebuild: a permanently closed place is replaced', () => {
  const w = world(weatherDry);
  const day = { ...sampleDay, stops: [{ ref: 'rest:gone', min: 12 * 60 }, { ref: 'thing:museum', min: 14 * 60 }] };
  const out = C.rebuildDay(day, w, { dateISO: '2026-09-12', constraints: {} });
  assert.ok(out.changes.some((c) => /closed for good/.test(c.why)));
  assert.ok(!out.stops.some((s) => s.ref === 'rest:gone'));
});

test('rebuild: beyond the forecast it says so instead of guessing', () => {
  const w = world(weatherDry);
  const out = C.rebuildDay(sampleDay, w, { dateISO: '2026-11-20', constraints: {} });
  assert.ok(out.warnings.some((x) => /beyond the forecast/.test(x)));
});

test('rebuild: a missing ref is admitted, not skipped quietly', () => {
  const w = world(weatherDry);
  const day = { ...sampleDay, stops: [{ ref: 'thing:vanished', min: 12 * 60, name: 'Vanished' }, { ref: 'thing:museum', min: 14 * 60 }] };
  const out = C.rebuildDay(day, w, { dateISO: '2026-09-12', constraints: {} });
  assert.ok(out.changes.some((c) => c.type === 'dropped' && c.name === 'Vanished'));
});

test('build: a low budget never lands on an expensive room', () => {
  const w = world(weatherDry);
  const out = C.buildDay({ dateISO: '2026-09-12', budget: 'low', wants: ['cheap', 'sit_down_dinner'], startMin: 11 * 60, endMin: 20 * 60 }, w);
  assert.ok(!out.stops.some((s) => s.place.cost === '$$$'));
});

test('build: low mobility keeps every leg short', () => {
  const w = world(weatherDry);
  const out = C.buildDay({ dateISO: '2026-09-12', mobility: 'low', wants: ['outdoors'], startMin: 11 * 60, endMin: 20 * 60 }, w);
  for (const s of out.stops) if (s.walkFromPrev != null) assert.ok(s.walkFromPrev <= 8, `leg of ${s.walkFromPrev} min`);
});

test('build: an out-of-season place is never chosen', () => {
  const w = world(weatherDry);
  const out = C.buildDay({ dateISO: '2026-01-10', wants: ['outdoors'], startMin: 11 * 60, endMin: 18 * 60 }, w);
  assert.ok(!out.stops.some((s) => s.ref === 'thing:beach'));
});

test('validateDay refuses junk and link farms', () => {
  assert.equal(C.validateDay(sampleDay).ok, true);
  assert.equal(C.validateDay({ ...sampleDay, name: '' }).ok, false);
  assert.equal(C.validateDay({ ...sampleDay, stops: [{ ref: 'thing:park', min: 60 }] }).ok, false);
  assert.equal(C.validateDay({ ...sampleDay, stops: [{ ref: 'bogus', min: 60 }, { ref: 'thing:park', min: 90 }] }).ok, false);
  assert.equal(C.validateDay({ ...sampleDay, blurb: 'see https://spam.example' }).ok, false);
});

test('a day may declare how you get around, and nothing else', () => {
  assert.equal(C.validateDay({ ...sampleDay, travel: 'car' }).ok, true);
  assert.equal(C.validateDay({ ...sampleDay, travel: 'walk' }).ok, true);
  assert.equal(C.validateDay({ ...sampleDay, travel: 'helicopter' }).ok, false);
});

test('rebuild: "too expensive" actually swaps the expensive stop', () => {
  const w = world(weatherDry);
  const day = { ...sampleDay, stops: [{ ref: 'thing:museum', min: 14 * 60 }, { ref: 'rest:supper', min: 18 * 60 }] };
  const plain = C.rebuildDay(day, w, { dateISO: '2026-09-12', constraints: { budget: 'any' } });
  assert.ok(plain.stops.some((s) => s.ref === 'rest:supper'), 'stays put when budget is open');

  const cheap = C.rebuildDay(day, w, { dateISO: '2026-09-12', constraints: { budget: 'low' } });
  assert.ok(!cheap.stops.some((s) => s.ref === 'rest:supper'), 'the $$$ room must go');
  assert.ok(cheap.changes.some((c) => /dearer than you wanted/.test(c.why)));
  assert.ok(cheap.stops.some((s) => s.ref === 'rest:diner'), 'and be replaced by the cheap one');
});

test('rebuild: an avoided kind of place is swapped out', () => {
  const w = world(weatherDry);
  const day = { ...sampleDay, stops: [{ ref: 'thing:museum', min: 12 * 60 }, { ref: 'thing:gallery', min: 15 * 60 }] };
  const out = C.rebuildDay(day, w, { dateISO: '2026-09-12', constraints: { avoid: ['culture'] } });
  assert.equal(out.stops.filter((s) => s.place.group === 'Culture').length, 0);
});

test('a replacement is never itself over budget', () => {
  const w = world(weatherDry);
  const day = { ...sampleDay, stops: [{ ref: 'rest:gone', min: 18 * 60 }, { ref: 'thing:museum', min: 20 * 60 }] };
  const out = C.rebuildDay(day, w, { dateISO: '2026-09-12', constraints: { budget: 'low' } });
  for (const s of out.stops) assert.ok(!['$$$', '$$$$'].includes(s.place.cost));
});

test('rerollStop: a different, still-legal stop — never a closed or wet one', () => {
  const w = world(weatherDry);
  const built = C.buildDay({ dateISO: '2026-09-12', wants: ['culture'], startMin: 11 * 60, endMin: 20 * 60 }, w);
  const i = built.stops.findIndex((s) => s.place.group === 'Culture');
  assert.ok(i >= 0, 'need a culture stop to reroll');
  const before = built.stops[i].ref;
  const swapped = C.rerollStop(built.stops, i, w, { dateISO: '2026-09-12', constraints: {}, rand: C.mulberry(7) });
  if (swapped) {
    assert.notEqual(swapped.ref, before);
    assert.equal(swapped.min, built.stops[i].min, 'time slot holds');
    assert.ok(!swapped.place.closed);
  } // a tiny fixture may honestly have no alternative — null is allowed
});

test('rerollStop: dinner rerolls to dinner, within budget', () => {
  const w = world(weatherDry);
  const stops = [
    { ref: 'thing:museum', min: 14 * 60, place: C.resolve(w, 'thing:museum') },
    { ref: 'rest:supper', min: 18 * 60, place: C.resolve(w, 'rest:supper') },
  ];
  const out = C.rerollStop(stops, 1, w, { dateISO: '2026-09-12', constraints: { budget: 'low' }, rand: C.mulberry(1) });
  assert.ok(out, 'the diner is open and cheap');
  assert.equal(out.place.kind, 'rest');
  assert.ok(!['$$$', '$$$$'].includes(out.place.cost));
});

test('rerollStop: honest null when nothing else fits', () => {
  const w = world(weatherDry);
  const stops = [{ ref: 'rest:diner', min: 9 * 60, place: C.resolve(w, 'rest:diner') }];
  // 9am Saturday: the only other restaurants are closed (supper) or gone
  const out = C.rerollStop(stops, 0, w, { dateISO: '2026-09-12', constraints: {}, rand: C.mulberry(1) });
  assert.equal(out, null);
});

test('shuffleDay: different seeds can differ, gates always hold', () => {
  const w = world(weatherWetPM);
  const days = [1, 2, 3, 4, 5].map((seed) =>
    C.shuffleDay({ dateISO: '2026-09-12', wants: ['culture'], startMin: 11 * 60, endMin: 20 * 60 }, w, { rand: C.mulberry(seed) }));
  for (const d of days) {
    for (const s of d.stops) {
      if (s.place.outdoor && !s.place.indoor) {
        const wx = C.weatherAt(w.weather, '2026-09-12', s.min);
        assert.ok(C.outdoorOk(wx), 'no shuffle may put an outdoor stop in the rain');
      }
    }
  }
});

test('mulberry is deterministic', () => {
  const a = C.mulberry(42), b = C.mulberry(42);
  assert.equal(a(), b());
  assert.equal(a(), b());
});
