#!/usr/bin/env bash
# Runs supabase/burlington-days-SETUP.sql on a throwaway Postgres 17 and
# exercises the loop as anon: save a run, open it with and without the
# group name, rate stops, publish into the library, and every limit in
# between. Same convention as up-for-it's test-sql.sh.
#
#   bash scripts/test-sql.sh                       # starts its own server
#   bash scripts/test-sql.sh "host=/tmp port=5432 user=postgres"
set -u
OWN=0
if [ $# -ge 1 ]; then CONN="$1"; else
  PGDIR="${TMPDIR:-/tmp}/bd-pg-$$"
  initdb -D "$PGDIR" -U postgres --auth=trust >/dev/null 2>&1 || { echo "initdb failed"; exit 1; }
  pg_ctl -D "$PGDIR" -o "-k /tmp -p 54331 -c listen_addresses=" -l "$PGDIR/log" start >/dev/null 2>&1 || { echo "pg_ctl failed"; exit 1; }
  CONN="host=/tmp port=54331 user=postgres"; OWN=1
  sleep 1
fi
DB="bd_test_$$"
cleanup() {
  psql "$CONN" -q -c "drop database if exists $DB;" >/dev/null 2>&1
  [ "$OWN" = 1 ] && { pg_ctl -D "$PGDIR" stop >/dev/null 2>&1; rm -rf "$PGDIR"; }
}
trap cleanup EXIT
psql "$CONN" -q -c "create database $DB;" || exit 1
P() { psql "$CONN dbname=$DB" -v ON_ERROR_STOP=1 -q -X -t -A "$@"; }

# Mirror Supabase: pgcrypto lives in `extensions`, not `public`.
P -c "create schema if not exists extensions; do \$\$ begin create role anon nologin; exception when duplicate_object then null; end \$\$;" >/dev/null
P -f supabase/burlington-days-SETUP.sql >/tmp/bd-setup.log 2>&1 || { echo "setup SQL failed:"; tail -12 /tmp/bd-setup.log; exit 1; }
echo "schema loaded"

pass=0; fail=0
ck() { # ck <name> <sql> <expected>
  local got; got=$(P -c "$2" 2>&1 | tr -d '[:space:]')
  local want; want=$(echo "$3" | tr -d '[:space:]')
  if [ "$got" = "$want" ]; then pass=$((pass+1)); else
    fail=$((fail+1)); echo "FAIL  $1"; echo "      want: $want"; echo "      got : $got"
  fi
}

TOK="0123456789abcdef0123456789abcdef"
TOK2="fedcba9876543210fedcba9876543210"
STOPS='[{"ref":"thing:waterfront-park","min":720},{"ref":"rest:hen-of-the-wood","min":1080}]'

# --- validators ---
ck "valid day passes"            "select bd_valid_day('A Day', null, '$STOPS'::jsonb);" "t"
ck "one stop is not a day"       "select bd_valid_day('A Day', null, '[{\"ref\":\"thing:x\",\"min\":1}]'::jsonb);" "f"
ck "bad ref refused"             "select bd_valid_day('A Day', null, '[{\"ref\":\"nope\",\"min\":1},{\"ref\":\"thing:y\",\"min\":2}]'::jsonb);" "f"
ck "minutes out of range"        "select bd_valid_day('A Day', null, '[{\"ref\":\"thing:x\",\"min\":9999},{\"ref\":\"thing:y\",\"min\":2}]'::jsonb);" "f"
ck "empty name refused"          "select bd_valid_day('   ', null, '$STOPS'::jsonb);" "f"
ck "links stripped from text"    "select bd_clean('go to https://spam.example now', 100);" "gotonow"
ck "note over the limit refused" "select bd_valid_day('A Day', null, ('[{\"ref\":\"thing:x\",\"min\":1,\"note\":\"' || repeat('z',130) || '\"},{\"ref\":\"thing:y\",\"min\":2}]')::jsonb);" "f"

# --- seed a library day ---
P -c "insert into bd_days (slug,name,blurb,author_name,btown_pick,wants,mobility,budget,stops)
      values ('parents','The Parents Are Visiting','Slow.','Btown Brief',true,'{outdoors}','low','mid','$STOPS'::jsonb);" >/dev/null
ck "public list shows it"        "select count(*) from bd_days_public();" "1"
ck "no pct until 5 answers"      "select again_pct is null from bd_days_public();" "t"

# --- saving a run ---
SLUG=$(P -c "select bd_save_run('$TOK','parents','Our Saturday', current_date + 3, '$STOPS'::jsonb, 'davis crew')->>'slug';")
ck "run saved"                   "select count(*) from bd_runs where slug='$SLUG';" "1"
ck "taking a day counts once"    "select did_count from bd_days where slug='parents';" "1"
ck "group name is not stored"    "select count(*) from bd_runs where group_hash ilike '%davis%';" "0"
ck "short token refused"         "select bd_save_run('abc','parents','X', current_date, '$STOPS'::jsonb, null)->>'error';" "bad_token"
ck "past date refused"           "select bd_save_run('$TOK','parents','X', current_date - 9, '$STOPS'::jsonb, null)->>'error';" "bad_date"
ck "far future refused"          "select bd_save_run('$TOK','parents','X', current_date + 400, '$STOPS'::jsonb, null)->>'error';" "bad_date"
ck "one-stop run refused"        "select bd_save_run('$TOK','parents','X', current_date, '[{\"ref\":\"thing:a\",\"min\":1}]'::jsonb, null)->>'error';" "bad_day"

# --- opening it ---
ck "right group name opens"      "select bd_open_run('$SLUG','davis crew','$TOK2')->>'title';" "OurSaturday"
ck "case and space forgiven"     "select bd_open_run('$SLUG','  DAVIS CREW ','$TOK2')->>'title';" "OurSaturday"
ck "wrong group name refused"    "select bd_open_run('$SLUG','nope','$TOK2')->>'error';" "bad_group"
ck "a locked day shows its name"  "select bd_open_run('$SLUG','nope','$TOK2')->>'title';" "OurSaturday"
ck "but never its stops"          "select bd_open_run('$SLUG','nope','$TOK2') ? 'stops';" "f"
ck "unknown slug refused"        "select bd_open_run('nosuch','x','$TOK2')->>'error';" "no_such_day"
ck "locked flag is honest"       "select bd_open_run('$SLUG','davis crew','$TOK2')->>'locked';" "true"

# 20 wrong guesses put the slug to bed
P -c "do \$\$ begin for i in 1..25 loop perform bd_open_run('$SLUG','wrong','$TOK2'); end loop; end \$\$;" >/dev/null
ck "brute force rests"           "select bd_open_run('$SLUG','davis crew','$TOK2')->>'error';" "resting"
P -c "delete from bd_rate_log where kind='openfail';" >/dev/null
ck "and recovers after the rest" "select bd_open_run('$SLUG','davis crew','$TOK2')->>'title';" "OurSaturday"

# an unlocked run opens with no name at all
SLUG2=$(P -c "select bd_save_run('$TOK','parents','Open Day', current_date + 1, '$STOPS'::jsonb, null)->>'slug';")
ck "unlocked run needs no name"  "select bd_open_run('$SLUG2',null,'$TOK2')->>'locked';" "false"

# --- rating ---
VOTES='[{"ref":"thing:waterfront-park","vote":1},{"ref":"rest:hen-of-the-wood","vote":-1}]'
ck "rating counts both stops"    "select bd_rate_run('$TOK2','$SLUG','$VOTES'::jsonb,'thing:waterfront-park',true)->>'counted';" "2"
ck "a stop not in the run is ignored" \
   "select bd_rate_run('$TOK2','$SLUG','[{\"ref\":\"thing:elsewhere\",\"vote\":1}]'::jsonb,null,null)->>'counted';" "0"
ck "would-again recorded once"   "select again_total from bd_days where slug='parents';" "1"
P -c "select bd_rate_run('$TOK','$SLUG','$VOTES'::jsonb,null,true);" >/dev/null
ck "second rating does not double it" "select again_total from bd_days where slug='parents';" "1"
ck "revote replaces, not adds"   "select count(*) from bd_stop_votes where run_id=(select id from bd_runs where slug='$SLUG');" "4"
ck "signal hidden under 3 votes" "select count(*) from bd_signal_public();" "0"

# --- publishing ---
ck "publish needs a rating first" "select bd_publish_run('$TOK','$SLUG2','X','y','me')->>'error';" "rate_first"
ck "only the owner may publish"  "select bd_publish_run('$TOK2','$SLUG','X','y','me')->>'error';" "not_yours"
NEW=$(P -c "select bd_publish_run('$TOK','$SLUG','Our Best Saturday','It worked.','Steve')->>'slug';")
ck "published into the library"  "select count(*) from bd_days where slug='$NEW';" "1"
ck "it remembers its parent"     "select (select slug from bd_days p where p.id=d.parent_id) from bd_days d where d.slug='$NEW';" "parents"
ck "publishing twice is idempotent" "select bd_publish_run('$TOK','$SLUG','Again','x','Steve')->>'already';" "true"
ck "library now has both"        "select count(*) from bd_days_public();" "2"

# --- privacy ---
ck "device hashes never surface" "select count(*) from bd_days_public() d where d::text ilike '%$TOK%';" "0"
ck "mine is token-gated"         "select count(*) from bd_mine('$TOK');" "2"
ck "someone else sees none"      "select count(*) from bd_mine('${TOK2}');" "0"
ck "no unqualified pgcrypto"     "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'bd\\_%' and p.prosrc ~ '(^|[^.])\\m(digest|gen_random_bytes)\\M';" "0"
ck "rls is on for every table"   "select count(*) from pg_tables where schemaname='public' and tablename like 'bd_%' and not rowsecurity;" "0"

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ] || exit 1
