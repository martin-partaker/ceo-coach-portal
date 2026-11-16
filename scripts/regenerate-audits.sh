#!/usr/bin/env bash
#
# Regenerate the audits from the staging database, in one go.
#
#   bash scripts/regenerate-audits.sh              # everything, import as a dry run
#   bash scripts/regenerate-audits.sh --apply      # ...and write the audits
#
# Readings by a model (each calls the Anthropic API and costs money):
#
#   --read            the outline's steps, for every session not read yet
#   --read=3          ...only Session 3 (1, 2, 3, or 4 for Sessions 4-12; commas allowed)
#   --standards       the Coaching Standards, confidentiality and the Momentum
#                     Journal, for every session not read yet
#   --standards=2,3   ...only those sessions
#   --since=2026-10   narrows either reading to sessions recorded in or after that month
#   --only=3          at most that many sessions per reading in this run (for a trial)
#   --reviewed        both readings, and only for the sessions a reviewer has set
#                     on the audit page. This is the one to run after a correction:
#                     it reads those recordings and nothing else.
#
# Run it after a reviewer has set or corrected a session on the audit screen,
# or after a criteria change. The steps:
#
#   1 export   every attributed recording, with the facts about it and any
#              session a reviewer has set                  -> recordings.json
#              and the CEOs' Momentum Journal entries       -> journals.json
#   2 place    which session each recording is, and how sure -> candidates.json
#   3 read     (only when asked) the model reads sessions it has not read.
#              The steps: each step of the session's outline, and for Session 1
#              the order of the business reality and the goal. The standards:
#              five Coaching Standards, confidentiality, and whether the coach
#              used the journal entries the CEO filed since the previous
#              session. Roughly 20 to 30 cents a session for each reading. It
#              prints how many it is about to read before it starts.
#   4 build    the audits, from the rules and from the readings on file
#   5 import   a dry run unless --apply is given: read what it says first.
#
# Without a reading option nothing is sent anywhere: what has not been read
# is shown on the audit as not read.
#
# The evaluators live outside this repository. Point AUDIT_TOOL_DIR at them if
# they are not in ~/Desktop/zoom-transcripts/tool.
set -euo pipefail
cd "$(dirname "$0")/.."

TOOL="${AUDIT_TOOL_DIR:-$HOME/Desktop/zoom-transcripts/tool}"
WORK="$(dirname "$TOOL")"
APPLY=""
READ=""
SESSIONS=""
STD=""
STD_SESSIONS=""
SINCE=""
ONLY=""
REVIEWED=""
USAGE="use --apply, --read, --read=3, --standards, --standards=2,3, --since=2026-10, --only=3, --reviewed"
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --read) READ=1 ;;
    --read=*) READ=1; SESSIONS="${arg#--read=}" ;;
    --standards) STD=1 ;;
    --standards=*) STD=1; STD_SESSIONS="${arg#--standards=}" ;;
    --since=*) SINCE="${arg#--since=}" ;;
    --only=*) ONLY="${arg#--only=}" ;;
    --reviewed) REVIEWED=1; READ=1; STD=1 ;;
    *) echo "unknown option: $arg ($USAGE)" >&2; exit 2 ;;
  esac
done

# Checked here because they are passed on unquoted below.
case "$SESSIONS$STD_SESSIONS" in
  *[!0-9,]*) echo "--read and --standards take session numbers, like --read=3 or --standards=2,3" >&2; exit 2 ;;
esac
case "$SINCE" in
  ""|20[0-9][0-9]-[0-1][0-9]) ;;
  *) echo "--since takes a month, like --since=2026-10" >&2; exit 2 ;;
esac
case "$ONLY" in
  *[!0-9]*) echo "--only takes a number, like --only=3" >&2; exit 2 ;;
esac
if [ -z "$READ$STD" ] && [ -n "$SINCE$ONLY" ]; then
  echo "--since and --only narrow a reading: use them with --read or --standards" >&2; exit 2
fi
[ -f .env.staging ] || { echo ".env.staging not found in $(pwd)" >&2; exit 1; }
[ -f "$TOOL/make_audit_json.py" ] || { echo "evaluators not found in $TOOL" >&2; exit 1; }

set -a
# shellcheck disable=SC1091
. ./.env.staging
set +a

echo "== 1/5  export every recording (and any session a reviewer has set), and the journals"
pnpm tsx scripts/export-audit-input.ts --out "$WORK/recordings.json"
pnpm tsx scripts/export-journals.ts --out "$WORK/journals.json"

echo
echo "== 2/5  place the sessions"
(cd "$TOOL" && python3 place_sessions.py --in ../recordings.json --out ../candidates.json)

# What narrows both readings. No arrays: macOS ships bash 3.2, where an empty
# array under `set -u` is an error.
NARROW=""
[ -n "$SINCE" ] && NARROW="$NARROW --since $SINCE"
[ -n "$ONLY" ] && NARROW="$NARROW --only $ONLY"
[ -n "$REVIEWED" ] && NARROW="$NARROW --reviewed"
SAID="${SINCE:+ (recorded since $SINCE)}${ONLY:+ (at most $ONLY)}${REVIEWED:+ (only sessions set by a reviewer)}"

echo
if [ -n "$READ" ]; then
  echo "== 3/5  model reading of the outline's steps${SESSIONS:+ (sessions: $SESSIONS)}$SAID"
  OUTLINE_ARGS="$NARROW"
  [ -n "$SESSIONS" ] && OUTLINE_ARGS="$OUTLINE_ARGS --sessions $SESSIONS"
  # shellcheck disable=SC2086
  (cd "$TOOL" && python3 model_read_outline.py --in ../candidates.json --out ../model_readings_outline.json $OUTLINE_ARGS)
  # Session 1's three questions. It reads only Session 1s it has not read, so
  # it needs no narrowing — but a trial run (--only) should not start it.
  if [ -z "$ONLY" ]; then
    case ",${SESSIONS:-1}," in
      *,1,*) (cd "$TOOL" && python3 model_read.py --in ../candidates.json --out ../model_readings.json) ;;
    esac
  fi
else
  echo "== 3/5  model reading of the outline's steps skipped (--read to include it; it calls the Anthropic API)"
fi
if [ -n "$STD" ]; then
  echo
  echo "== 3/5  model reading of standards, confidentiality and journal${STD_SESSIONS:+ (sessions: $STD_SESSIONS)}$SAID"
  STD_ARGS="$NARROW"
  [ -n "$STD_SESSIONS" ] && STD_ARGS="$STD_ARGS --sessions $STD_SESSIONS"
  # shellcheck disable=SC2086
  (cd "$TOOL" && python3 model_read_session.py --in ../candidates.json --journals ../journals.json --out ../model_readings_session.json $STD_ARGS)
else
  echo "== 3/5  model reading of standards, confidentiality and journal skipped (--standards to include it)"
fi

echo
echo "== 4/5  build the audits"
BUILD="python3 make_audit_json.py --in ../candidates.json --out ../audits.json"
[ -f "$WORK/model_readings.json" ] && BUILD="$BUILD --readings ../model_readings.json"
[ -f "$WORK/model_readings_outline.json" ] && BUILD="$BUILD --outline-readings ../model_readings_outline.json"
[ -f "$WORK/model_readings_session.json" ] && BUILD="$BUILD --session-readings ../model_readings_session.json"
(cd "$TOOL" && $BUILD)

echo
echo "== 5/5  import"
if [ -n "$APPLY" ]; then
  pnpm tsx scripts/import-audits.ts --in "$WORK/audits.json" --apply
else
  pnpm tsx scripts/import-audits.ts --in "$WORK/audits.json"
  echo
  echo "Nothing was written. Run again with --apply to write these audits."
fi
