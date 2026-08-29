# Burlington Days — agent notes

Read `README.md` first. Stephen is non-technical — explain consequential
changes in plain language. Plain static site, no build step, ES modules.

## Rules that will trip you up

- **`js/core.js` is pure, and that purity is the contract.** No DOM, no
  fetch, no `Date.now()` — time is always an argument. Every rule in it is
  covered by `scripts/test-core.mjs`. The subset the server also enforces is
  mirrored one-for-one by `supabase/burlington-days-SETUP.sql`
  (`bd_valid_day`, `bd_clean`, the check constraints) **and** by
  `js/fake-backend.js`. Change all three together and add a case to the
  tests.

- **A language model never chooses anything.** `bd-ask` converts a sentence
  into constraints and nothing else — it may not name a place, a time or a
  fact. If you are tempted to have it write the day, don't: that is the one
  decision this whole project is built around. Prose about stops that are
  already chosen is fine; picking is not.

- **Unknown never means fine.** `openAt` returns `true | false | null` and
  null is never treated as open. `weatherAt` returns `known:false` past the
  forecast, and `outdoorOk` refuses anything it can't see. A restaurant with
  `hours_confidence: 'unverified'` is not schedulable. Keep it that way —
  every one of those was a deliberate choice, and a test will fail if you
  loosen it.

- **We can only check four things**, and the copy must not imply more:
  permanent closure, posted hours for that weekday, the forecast at that
  hour, and the season. A private booking or a one-off closure is invisible
  to us.

- **A seeded day must keep its own promise.** `scripts/check-refs.mjs`
  fails if a `mobility: low` day has a leg over 8 minutes, or any walking
  day has one over 25. A day that genuinely needs driving sets
  `travel: "car"` and has to say so in its blurb.

- **Never invent a count.** Seeded days ship `stats.did = 0`. The checker
  enforces it. `did_count` only moves when a real person takes a day.

- **The device token is the only identity.** 32 hex characters minted into
  localStorage, stored hashed, never shown. No accounts, no recovery.

- **A locked run shows its name and date, never its stops.** That's the
  invitation. The group name is hashed with the run's slug, so the same
  name on two different days gives two different hashes. Twenty wrong
  guesses rest the slug for fifteen minutes.

- **Fail soft, never error-state.** No SQL yet → `not_ready` → "saving isn't
  switched on yet", and the seeded shelf keeps working. No edge function →
  keyword parsing, and the reader is told. A dead feed → cached, then stale,
  then an honest line in the footer.

## Layout

```
js/core.js          the engine — pure, tested, the contract
js/feeds.js         the guide's JSON, cached, timed out, status-reported
js/net.js           bd_* RPCs + the bd-ask edge function
js/fake-backend.js  in-memory mirror of the SQL, for ?demo=1
js/app.js           wiring only; invents no facts
data/days.json      the seeded library
supabase/           schema + the bd-ask function
scripts/            tests and the live-feed checkers
```

## Known limits

- `things.json` carries **no opening hours** for its 213 activities, so an
  activity's hours are never checked. Only restaurants are. If hours are
  ever added to that feed, `eligible()` in core.js should start enforcing
  them the same way.
- Three places (`burlington-records`, `outdoor-gear-exchange`,
  `barge-canal-market`) have no coordinates, so walk times next to them are
  blank rather than wrong. `check-refs` warns about it.
- Internal module imports aren't version-pinned; GitHub Pages serves
  `max-age=600`, so a deploy is at most ten minutes stale. `index.html`
  pins `?v=` on the stylesheet and the entry script — bump those when you
  change either. (Same trap as the hub's v2 cache-bust.)
- The `bd-ask` refine path only reaches the model when the local keyword
  rules find nothing to change, to keep the per-use cost near zero.
