-- Burlington Days — schema. Prefix bd_ on the shared project.
-- Mirrors js/core.js: bd_valid_day() enforces the same limits as
-- validateDay(), and js/fake-backend.js mirrors both. Change all three.
--
-- Identity is a device token, hashed. No accounts, no recovery, no email.
-- A run (one group's day) is opened with a slug plus the group name; the
-- name is never stored in the clear.

-- Supabase ships pgcrypto in the `extensions` schema. Everything below
-- qualifies its calls, so this file behaves the same on a bare Postgres
-- and on the hosted project. scripts/test-sql.sh mirrors that layout.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------- helpers ----------

-- Public text is stripped of links so the library can't become a link farm.
create or replace function bd_clean(t text, lim int)
returns text language sql immutable as $$
  select nullif(btrim(regexp_replace(
    regexp_replace(coalesce(t, ''), '(https?://|www\.)\S*', '', 'gi'),
    '\s+', ' ', 'g')), '')::text
$$;

create or replace function bd_trunc(t text, lim int)
returns text language sql immutable as $$
  select left(bd_clean(t, lim), lim)
$$;

create or replace function bd_hash(t text)
returns text language sql immutable as $$
  select encode(extensions.digest(coalesce(t, ''), 'sha256'), 'hex')
$$;

-- The same shape check js/core.js validateDay() makes, on the server side.
create or replace function bd_valid_day(p_name text, p_blurb text, p_stops jsonb)
returns boolean language plpgsql immutable as $$
declare s jsonb; n int;
begin
  if bd_clean(p_name, 60) is null or length(bd_clean(p_name, 60)) > 60 then return false; end if;
  if coalesce(length(bd_clean(p_blurb, 160)), 0) > 160 then return false; end if;
  if jsonb_typeof(p_stops) <> 'array' then return false; end if;
  n := jsonb_array_length(p_stops);
  if n < 2 or n > 8 then return false; end if;
  for s in select * from jsonb_array_elements(p_stops) loop
    if (s->>'ref') !~ '^(thing|rest):[a-z0-9-]+$' then return false; end if;
    if (s->>'min') is null then return false; end if;
    if (s->>'min')::numeric < 0 or (s->>'min')::numeric > 1620 then return false; end if;
    if coalesce(length(bd_clean(s->>'note', 120)), 0) > 120 then return false; end if;
  end loop;
  return true;
end $$;

-- ---------- tables ----------

create table if not exists bd_days (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique not null,
  name          text not null,
  blurb         text,
  author_name   text,
  btown_pick    boolean not null default false,
  wants         text[] not null default '{}',
  mobility      text not null default 'normal' check (mobility in ('low','normal')),
  budget        text not null default 'any'    check (budget in ('low','mid','high','any')),
  season        text[] not null default '{Year-Round}',
  stops         jsonb not null,
  parent_id     uuid references bd_days(id) on delete set null,
  device_hash   text,
  status        text not null default 'public' check (status in ('public','hidden')),
  did_count     int not null default 0 check (did_count >= 0),
  again_yes     int not null default 0 check (again_yes >= 0),
  again_total   int not null default 0 check (again_total >= 0),
  created_at    timestamptz not null default now(),
  constraint bd_days_shape check (bd_valid_day(name, blurb, stops))
);
create index if not exists bd_days_status_idx on bd_days (status, did_count desc);

-- One group's actual day. `stops` is frozen at save time so a later feed
-- change can never rewrite what somebody already did.
create table if not exists bd_runs (
  id             uuid primary key default gen_random_uuid(),
  slug           text unique not null,
  day_id         uuid references bd_days(id) on delete set null,
  title          text not null,
  on_date        date not null,
  stops          jsonb not null,
  group_hash     text,                       -- sha256(slug || ':' || lower(group name))
  device_hash    text not null,
  rated_at       timestamptz,
  published_id   uuid references bd_days(id) on delete set null,
  created_at     timestamptz not null default now(),
  constraint bd_runs_shape check (bd_valid_day(title, null, stops))
);
create index if not exists bd_runs_device_idx on bd_runs (device_hash, created_at desc);

create table if not exists bd_stop_votes (
  run_id       uuid not null references bd_runs(id) on delete cascade,
  ref          text not null check (ref ~ '^(thing|rest):[a-z0-9-]+$'),
  device_hash  text not null,
  vote         smallint not null check (vote in (-1, 1)),
  best         boolean not null default false,
  created_at   timestamptz not null default now(),
  primary key (run_id, ref, device_hash)
);

-- Rolling per-ref signal. This is what makes the engine better over time.
create or replace view bd_stop_signal as
  select ref,
         count(*) filter (where vote = 1)  as ups,
         count(*) filter (where vote = -1) as downs,
         count(*) filter (where best)      as bests
  from bd_stop_votes group by ref;

create table if not exists bd_rate_log (
  device_hash text not null,
  kind        text not null,
  at          timestamptz not null default now()
);
create index if not exists bd_rate_log_idx on bd_rate_log (device_hash, kind, at desc);

alter table bd_days       enable row level security;
alter table bd_runs       enable row level security;
alter table bd_stop_votes enable row level security;
alter table bd_rate_log   enable row level security;
-- No policies: every path below is security definer. Direct table reads
-- from the anon key get nothing.

-- ---------- rate limiting ----------

create or replace function bd_rate_ok(p_device text, p_kind text, p_max int, p_window interval)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  delete from bd_rate_log where at < now() - interval '2 days';
  select count(*) into n from bd_rate_log
   where device_hash = p_device and kind = p_kind and at > now() - p_window;
  if n >= p_max then return false; end if;
  insert into bd_rate_log (device_hash, kind) values (p_device, p_kind);
  return true;
end $$;

-- ---------- public reads ----------

create or replace function bd_days_public()
returns table (slug text, name text, blurb text, author_name text, btown_pick boolean,
               wants text[], mobility text, budget text, season text[], stops jsonb,
               did_count int, again_pct int)
language sql security definer set search_path = public, extensions as $$
  select d.slug, d.name, d.blurb, d.author_name, d.btown_pick,
         d.wants, d.mobility, d.budget, d.season, d.stops,
         d.did_count,
         case when d.again_total >= 5
              then round(100.0 * d.again_yes / d.again_total)::int
              else null end
  from bd_days d
  where d.status = 'public'
  order by d.btown_pick desc, d.did_count desc, d.created_at desc
  limit 200
$$;

-- Per-stop signal, for ranking. Counts only, never who.
create or replace function bd_signal_public()
returns table (ref text, ups bigint, downs bigint, bests bigint)
language sql security definer set search_path = public, extensions as $$
  select ref, ups, downs, bests from bd_stop_signal
   where ups + downs >= 3
$$;

-- ---------- saving and opening a day ----------

create or replace function bd_save_run(
  p_token text, p_day_slug text, p_title text, p_date date,
  p_stops jsonb, p_group text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_device text; v_slug text; v_day uuid; v_id uuid;
begin
  v_device := bd_hash(p_token);
  if length(coalesce(p_token, '')) < 16 then return jsonb_build_object('error','bad_token'); end if;
  if not bd_rate_ok(v_device, 'save', 20, interval '1 hour') then
    return jsonb_build_object('error','slow_down');
  end if;
  if not bd_valid_day(p_title, null, p_stops) then
    return jsonb_build_object('error','bad_day');
  end if;
  if p_date < current_date - 1 or p_date > current_date + 365 then
    return jsonb_build_object('error','bad_date');
  end if;

  select id into v_day from bd_days where slug = p_day_slug and status = 'public';
  v_slug := lower(encode(extensions.gen_random_bytes(6), 'hex'));
  insert into bd_runs (slug, day_id, title, on_date, stops, group_hash, device_hash)
  values (v_slug, v_day, bd_trunc(p_title, 60), p_date, p_stops,
          case when bd_clean(p_group, 40) is null then null
               else bd_hash(v_slug || ':' || lower(bd_clean(p_group, 40))) end,
          v_device)
  returning id into v_id;

  if v_day is not null then
    update bd_days set did_count = did_count + 1 where id = v_day;
  end if;
  return jsonb_build_object('slug', v_slug);
end $$;

-- Open someone else's day. The group name is the key; a wrong one rests
-- the whole slug for a quarter of an hour after twenty tries.
create or replace function bd_open_run(p_slug text, p_group text, p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r bd_runs%rowtype; v_device text; v_fails int;
begin
  v_device := bd_hash(coalesce(p_token, p_slug));
  select * into r from bd_runs where slug = p_slug;
  if not found then return jsonb_build_object('error','no_such_day'); end if;

  if r.group_hash is not null then
    select count(*) into v_fails from bd_rate_log
     where device_hash = v_device and kind = 'openfail' and at > now() - interval '15 minutes';
    if v_fails >= 20 then return jsonb_build_object('error','resting'); end if;

    if r.group_hash <> bd_hash(p_slug || ':' || lower(coalesce(bd_clean(p_group, 40), ''))) then
      insert into bd_rate_log (device_hash, kind) values (v_device, 'openfail');
      -- Name and date are the invitation; the stops stay locked.
      return jsonb_build_object('error','bad_group', 'title', r.title, 'date', r.on_date);
    end if;
  end if;

  return jsonb_build_object(
    'slug', r.slug, 'title', r.title, 'date', r.on_date, 'stops', r.stops,
    'rated', r.rated_at is not null, 'locked', r.group_hash is not null);
end $$;

create or replace function bd_mine(p_token text)
returns table (slug text, title text, on_date date, rated boolean)
language sql security definer set search_path = public, extensions as $$
  select slug, title, on_date, rated_at is not null
  from bd_runs where device_hash = bd_hash(p_token)
  order by on_date desc limit 50
$$;

-- ---------- rating ----------

create or replace function bd_rate_run(
  p_token text, p_slug text, p_votes jsonb, p_best text, p_would_again boolean)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r bd_runs%rowtype; v_device text; v jsonb; v_ref text; v_vote int; n int := 0;
begin
  v_device := bd_hash(p_token);
  select * into r from bd_runs where slug = p_slug;
  if not found then return jsonb_build_object('error','no_such_day'); end if;
  if not bd_rate_ok(v_device, 'rate', 40, interval '1 hour') then
    return jsonb_build_object('error','slow_down');
  end if;
  if jsonb_typeof(p_votes) <> 'array' or jsonb_array_length(p_votes) > 8 then
    return jsonb_build_object('error','bad_votes');
  end if;

  for v in select * from jsonb_array_elements(p_votes) loop
    v_ref := v->>'ref';
    v_vote := case when (v->>'vote')::int > 0 then 1 else -1 end;
    if v_ref !~ '^(thing|rest):[a-z0-9-]+$' then continue; end if;
    -- Only stops that are actually in this run may be voted on.
    if not exists (select 1 from jsonb_array_elements(r.stops) s where s->>'ref' = v_ref) then continue; end if;
    insert into bd_stop_votes (run_id, ref, device_hash, vote, best)
    values (r.id, v_ref, v_device, v_vote, coalesce(v_ref = p_best, false))
    on conflict (run_id, ref, device_hash)
      do update set vote = excluded.vote, best = excluded.best;
    n := n + 1;
  end loop;

  -- "Would you do it again" counts once per run, not once per tap.
  if r.rated_at is null and r.day_id is not null and p_would_again is not null then
    update bd_days set again_total = again_total + 1,
                       again_yes = again_yes + case when p_would_again then 1 else 0 end
     where id = r.day_id;
  end if;
  update bd_runs set rated_at = coalesce(rated_at, now()) where id = r.id;
  return jsonb_build_object('ok', true, 'counted', n);
end $$;

-- ---------- putting a finished day into the library ----------

create or replace function bd_publish_run(
  p_token text, p_slug text, p_name text, p_blurb text, p_author text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r bd_runs%rowtype; v_device text; v_slug text; v_id uuid; v_parent uuid; v_wants text[]; v_mob text;
begin
  v_device := bd_hash(p_token);
  select * into r from bd_runs where slug = p_slug;
  if not found then return jsonb_build_object('error','no_such_day'); end if;
  if r.device_hash <> v_device then return jsonb_build_object('error','not_yours'); end if;
  if r.published_id is not null then
    return jsonb_build_object('slug', (select slug from bd_days where id = r.published_id), 'already', true);
  end if;
  if r.rated_at is null then return jsonb_build_object('error','rate_first'); end if;
  if not bd_rate_ok(v_device, 'publish', 5, interval '24 hours') then
    return jsonb_build_object('error','slow_down');
  end if;
  if not bd_valid_day(p_name, p_blurb, r.stops) then return jsonb_build_object('error','bad_day'); end if;

  select wants, mobility into v_wants, v_mob from bd_days where id = r.day_id;
  v_slug := regexp_replace(lower(bd_trunc(p_name, 60)), '[^a-z0-9]+', '-', 'g')
            || '-' || lower(encode(extensions.gen_random_bytes(3), 'hex'));
  insert into bd_days (slug, name, blurb, author_name, wants, mobility, budget, stops, parent_id, device_hash)
  values (v_slug, bd_trunc(p_name, 60), bd_trunc(p_blurb, 160), bd_trunc(p_author, 40),
          coalesce(v_wants, '{}'), coalesce(v_mob, 'normal'), 'any', r.stops, r.day_id, v_device)
  returning id into v_id;
  update bd_runs set published_id = v_id where id = r.id;
  return jsonb_build_object('slug', v_slug);
end $$;

grant execute on function bd_days_public, bd_signal_public, bd_save_run,
  bd_open_run, bd_mine, bd_rate_run, bd_publish_run to anon;
