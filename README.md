# Burlington Days

A shelf of days people actually had in Burlington. You take one and it gets
rebuilt for your date — checking opening hours, the forecast and what's on —
or you describe the day you need and it finds the closest match, building a
new one only when nothing fits.

Live at `play.btownbrief.com/burlington-days/` once Pages is switched on.

## The one idea

**The ask searches the library first.** Most questions are answered by a day
somebody already had: free to serve, and already vetted by a human who did
it. Only when nothing is close does it build one from scratch. That is what
makes the shelf fill itself — every day someone keeps and publishes becomes
the next person's match.

## The rule that governs everything

**`js/core.js` picks the places. A language model never does.**

The model has exactly one job: turning a sentence ("my parents are in town
Saturday, they can't walk far, we want a proper dinner") into structured
constraints. It cannot name a place, add a stop, or state a fact. Everything
you see on screen — a time, an address, a kitchen's closing hour, a walking
distance — comes out of the guide's own JSON.

If the model is unreachable, unconfigured or slow, `core.fallbackParse` reads
the sentence with keywords instead and the app says so on screen. A rougher
reading, never a wrong day.

Three things follow from that, and they are the reason to trust the output:

- **Unknown is not "probably fine."** A restaurant whose hours we can't
  verify for that weekday is never scheduled (50 of the 312 rows are
  unverified). A date past the forecast produces a warning, not a guess.
- **We only claim what we can check.** Permanent closures, posted hours,
  the forecast, and the season. We cannot know about a private booking or a
  one-off closure, so we never imply that we do.
- **A day keeps its own promise.** `scripts/check-refs.mjs` fails the build
  if a "short walks" day contains a leg longer than eight minutes.

## Running it

No build step. Serve the folder:

```sh
python3 -m http.server 8791     # then open http://127.0.0.1:8791/?demo=1
```

`?demo=1` swaps the Supabase calls for `js/fake-backend.js`, so the whole
loop — save, share, gate, rate, publish — works with nothing installed.

## Checks

```sh
node --test scripts/test-core.mjs   # 23 cases: the engine's rules
bash scripts/test-sql.sh            # 42 cases: the schema, as anon
node scripts/check-refs.mjs         # every seeded ref, against the LIVE feeds
node scripts/smoke-live.mjs         # build a real day from the real guide
```

`check-refs` and `smoke-live` hit `guide.btownbrief.com` and will fail
offline. That is deliberate: they exist to catch a feed that changed shape
under us.

## Switching it on

1. **Database.** Run `supabase/burlington-days-SETUP.sql` on the shared
   project. Until then every write returns `not_ready` and the app says
   plainly that saving isn't switched on — the shelf still works.
2. **The ask.** `supabase functions deploy bd-ask --no-verify-jwt`, then
   `supabase secrets set OPENROUTER_API_KEY=…` (the same key the newsletter
   scripts use, in `~/.config/btownbrief/secrets.env`). Until then the app
   falls back to the keyword parser and tells the reader.
3. **Pages.** Push to `main` and enable Pages; the org's custom domain
   serves it at `play.btownbrief.com/burlington-days/`.
4. **Seed the shelf.** `data/days.json` holds ten hand-built days. Their
   counts start at zero and only real people raise them.

## The library

Ten seeded days, each a Btown Brief pick, each pointing at real ids in
`things.json` and `restaurants.json`. Counts are never invented: a day with
no takers says "Nobody has done this one yet" rather than showing a number
nobody earned.

To add one: edit `data/days.json`, then run `node scripts/check-refs.mjs`.
It will tell you if a place has closed, moved out of walking range, or lost
its verified hours.
