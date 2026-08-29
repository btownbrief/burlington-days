/* fake-backend.js — an in-memory stand-in for the bd_* RPCs.

   Mirrors supabase/burlington-days-SETUP.sql one for one: the same limits,
   the same error codes, the same rules about what a stranger can see. Two
   jobs: `?demo=1` for showing the thing without touching the real database,
   and keeping the app usable before the SQL is installed. When you change a
   rule, change it here, in core.js and in the SQL together. */

import { validateDay } from './core.js';

const runs = new Map();
const days = new Map();
const votes = new Map();          // `${slug}|${ref}|${device}` -> {vote, best}
const fails = new Map();          // slug -> wrong group-name attempts

const hash = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) | 0; return String(h); };
const clean = (t, lim) => String(t ?? '').replace(/(https?:\/\/|www\.)\S*/gi, '').replace(/\s+/g, ' ').trim().slice(0, lim);
const slugId = () => Math.random().toString(16).slice(2, 14);

export function seed(seedDays) {
  for (const d of seedDays) {
    days.set(d.id, { ...d, slug: d.id, did_count: d.stats?.did ?? 0, again_yes: 0, again_total: 0 });
  }
}

export const fake = {
  async bd_days_public() {
    return [...days.values()].map((d) => ({
      slug: d.slug, name: d.name, blurb: d.blurb, author_name: d.author,
      btown_pick: !!d.btownBriefPick, wants: d.wants ?? [], mobility: d.mobility ?? 'normal',
      budget: d.budget ?? 'any', season: d.season ?? ['Year-Round'], stops: d.stops,
      did_count: d.did_count, again_pct: d.again_total >= 5 ? Math.round(100 * d.again_yes / d.again_total) : null,
    }));
  },

  async bd_signal_public() {
    const tally = new Map();
    for (const [k, v] of votes) {
      const ref = k.split('|')[1];
      const t = tally.get(ref) ?? { ref, ups: 0, downs: 0, bests: 0 };
      v.vote > 0 ? t.ups++ : t.downs++;
      if (v.best) t.bests++;
      tally.set(ref, t);
    }
    return [...tally.values()].filter((t) => t.ups + t.downs >= 3);
  },

  async bd_save_run({ p_token, p_day_slug, p_title, p_date, p_stops, p_group }) {
    if (String(p_token ?? '').length < 16) return { error: 'bad_token' };
    if (!validateDay({ name: p_title, stops: p_stops }).ok) return { error: 'bad_day' };
    const slug = slugId();
    runs.set(slug, {
      slug, day_slug: p_day_slug, title: clean(p_title, 60), on_date: p_date, stops: p_stops,
      group_hash: clean(p_group, 40) ? hash(`${slug}:${clean(p_group, 40).toLowerCase()}`) : null,
      device: hash(p_token), rated_at: null, published: null,
    });
    const d = days.get(p_day_slug);
    if (d) d.did_count += 1;
    return { slug };
  },

  async bd_open_run({ p_slug, p_group, p_token }) {
    const r = runs.get(p_slug);
    if (!r) return { error: 'no_such_day' };
    if (r.group_hash) {
      if ((fails.get(p_slug) ?? 0) >= 20) return { error: 'resting' };
      if (r.group_hash !== hash(`${p_slug}:${clean(p_group, 40).toLowerCase()}`)) {
        fails.set(p_slug, (fails.get(p_slug) ?? 0) + 1);
        return { error: 'bad_group', title: r.title, date: r.on_date };
      }
    }
    return { slug: r.slug, title: r.title, date: r.on_date, stops: r.stops,
      rated: !!r.rated_at, locked: !!r.group_hash };
  },

  async bd_mine({ p_token }) {
    const me = hash(p_token);
    return [...runs.values()].filter((r) => r.device === me)
      .map((r) => ({ slug: r.slug, title: r.title, on_date: r.on_date, rated: !!r.rated_at }));
  },

  async bd_rate_run({ p_token, p_slug, p_votes, p_best, p_would_again }) {
    const r = runs.get(p_slug);
    if (!r) return { error: 'no_such_day' };
    if (!Array.isArray(p_votes) || p_votes.length > 8) return { error: 'bad_votes' };
    const me = hash(p_token);
    let counted = 0;
    for (const v of p_votes) {
      if (!/^(thing|rest):[a-z0-9-]+$/.test(v?.ref ?? '')) continue;
      if (!r.stops.some((s) => s.ref === v.ref)) continue;
      votes.set(`${p_slug}|${v.ref}|${me}`, { vote: v.vote > 0 ? 1 : -1, best: v.ref === p_best });
      counted++;
    }
    const d = days.get(r.day_slug);
    if (!r.rated_at && d && typeof p_would_again === 'boolean') {
      d.again_total += 1;
      if (p_would_again) d.again_yes += 1;
    }
    r.rated_at = r.rated_at ?? Date.now();
    return { ok: true, counted };
  },

  async bd_publish_run({ p_token, p_slug, p_name, p_blurb, p_author }) {
    const r = runs.get(p_slug);
    if (!r) return { error: 'no_such_day' };
    if (r.device !== hash(p_token)) return { error: 'not_yours' };
    if (r.published) return { slug: r.published, already: true };
    if (!r.rated_at) return { error: 'rate_first' };
    if (!validateDay({ name: p_name, blurb: p_blurb, stops: r.stops }).ok) return { error: 'bad_day' };
    const parent = days.get(r.day_slug);
    const slug = `${clean(p_name, 60).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${slugId().slice(0, 6)}`;
    days.set(slug, {
      slug, name: clean(p_name, 60), blurb: clean(p_blurb, 160), author: clean(p_author, 40),
      btownBriefPick: false, wants: parent?.wants ?? [], mobility: parent?.mobility ?? 'normal',
      budget: 'any', season: ['Year-Round'], stops: r.stops, did_count: 0, again_yes: 0, again_total: 0,
    });
    r.published = slug;
    return { slug };
  },
};

export function resetFake() { runs.clear(); days.clear(); votes.clear(); fails.clear(); }
