#!/usr/bin/env bash
#
# Regenerate the audits from the staging database, in one go.
#
#   bash scripts/regenerate-audits.sh              # everything, import as a dry run
#   bash scripts/regenerate-audits.sh --apply      # ...and write the audits
#   bash scripts/regenerate-audits.sh --read       # also have the model read what it has not read yet
#   bash scripts/regenerate-audits.sh --read=3     # ...only Session 3 (1, 2, 3, or 4 for Sessions 4-12; commas allowed)
#
# Run it after a reviewer has set or corrected a session on the audit screen,
# or after a criteria change. The steps:
#
#   1 export   every attributed recording, with the facts about it and any
#              session a reviewer has set                  -> recordings.json
#   2 place    which session each recording is, and how sure -> candidates.json
#   3 read     (only with --read) the model reads sessions it has not read:
#              each outline step, and for Session 1 the order of the business
#              reality and the goal. It calls the Anthropic API with the key in
#              .env.staging and costs money — roughly 20 to 30 cents a session.
#              It prints how many it is about to read before it starts.
#   4 build    the audits, from the rules and from the readings on file
#   5 import   a dry run unless --apply is given: read what it says first.
#
# Without --read nothing is sent anywhere: sessions not read yet are audited
# with their outline steps marked "not read".
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
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --read) READ=1 ;;
    --read=*) READ=1; SESSIONS="${arg#--read=}" ;;
    *) echo "unknown option: $arg (use --apply, --read, --read=3)" >&2; exit 2 ;;
  esac
done

[ -f .env.staging ] || { echo ".env.staging not found in $(pwd)" >&2; exit 1; }
[ -f "$TOOL/make_audit_json.py" ] || { echo "evaluators not found in $TOOL" >&2; exit 1; }

set -a
# shellcheck disable=SC1091
. ./.env.staging
set +a

echo "== 1/5  export every recording (and any session a reviewer has set)"
pnpm tsx scripts/export-audit-input.ts --out "$WORK/recordings.json"

echo
echo "== 2/5  place the sessions"
(cd "$TOOL" && python3 place_sessions.py --in ../recordings.json --out ../candidates.json)

echo
if [ -n "$READ" ]; then
  echo "== 3/5  model reading of what has not been read yet${SESSIONS:+ (sessions: $SESSIONS)}"
  # No arrays: macOS ships bash 3.2, where an empty array under `set -u` is an error.
  if [ -n "$SESSIONS" ]; then
    (cd "$TOOL" && python3 model_read_outline.py --in ../candidates.json --out ../model_readings_outline.json --sessions "$SESSIONS")
  else
    (cd "$TOOL" && python3 model_read_outline.py --in ../candidates.json --out ../model_readings_outline.json)
  fi
  case ",${SESSIONS:-1}," in
    *,1,*) (cd "$TOOL" && python3 model_read.py --in ../candidates.json --out ../model_readings.json) ;;
  esac
else
  echo "== 3/5  model reading skipped (--read to include it; it calls the Anthropic API)"
fi

echo
echo "== 4/5  build the audits"
BUILD="python3 make_audit_json.py --in ../candidates.json --out ../audits.json"
[ -f "$WORK/model_readings.json" ] && BUILD="$BUILD --readings ../model_readings.json"
[ -f "$WORK/model_readings_outline.json" ] && BUILD="$BUILD --outline-readings ../model_readings_outline.json"
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
