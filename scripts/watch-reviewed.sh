#!/usr/bin/env bash
#
# Keep the audits in step with what reviewers say on the audit page.
#
#   bash scripts/watch-reviewed.sh            # look every 5 minutes
#   bash scripts/watch-reviewed.sh 120        # ...every 2 minutes
#   caffeinate -i bash scripts/watch-reviewed.sh    # ...and keep the Mac awake
#
# When a reviewer sets or corrects a session number, the audit on file was
# judged against the wrong outline: the screens put it aside and say it is
# waiting. Nothing replaces it until `regenerate-audits.sh --reviewed --apply`
# is run. This runs that, by itself, whenever something is waiting — so a
# correction shows its new audit a few minutes later instead of whenever
# someone remembers.
#
# It is a stopgap, and says so: the evaluators live on this machine, so it
# works only while this machine is on and this is running. Stop it with
# Ctrl-C. The lasting answer is running the audit inside the portal.
#
# What a run costs: it reads only the sessions a reviewer has set and that
# have not been read as that session — about 45 cents each, both readings.
# Nothing else is ever read from here.
#
# It does not run twice for the same thing. If a run leaves the same
# recordings waiting (a reading failed, a recording cannot be audited), it
# says so once and waits for something to change.
#
# One thing it does not do: a correction can move the CEO's LATER sessions to
# another outline (a Session 2 that becomes a Session 3). Those are re-placed
# and shown as "steps not read yet"; read them with
# `bash scripts/regenerate-audits.sh --read --standards --apply`.
set -euo pipefail
cd "$(dirname "$0")/.."

EVERY="${1:-300}"
case "$EVERY" in
  ''|*[!0-9]*) echo "usage: bash scripts/watch-reviewed.sh [seconds between looks]" >&2; exit 2 ;;
esac
[ "$EVERY" -ge 60 ] || { echo "not more often than every 60 seconds" >&2; exit 2; }
[ -f .env.staging ] || { echo ".env.staging not found in $(pwd)" >&2; exit 1; }

TOOL="${AUDIT_TOOL_DIR:-$HOME/Desktop/zoom-transcripts/tool}"
LOG="$(dirname "$TOOL")/watch-reviewed.log"

set -a
# shellcheck disable=SC1091
. ./.env.staging
set +a

echo "Watching for sessions set by a reviewer, every $EVERY seconds. Ctrl-C to stop."
echo "Each run is logged in $LOG"
TRIED=""
TOLD=""
while true; do
  if OUT="$(pnpm tsx scripts/pending-reviewed.ts 2>/dev/null | tail -n 1)"; then
    COUNT="${OUT%% *}"
    SIG="${OUT#* }"
    case "$COUNT" in
      ''|*[!0-9]*) echo "$(date '+%H:%M')  could not read what is waiting; trying again later" ;;
      0) TRIED=""; TOLD="" ;;
      *)
        if [ "$SIG" != "$TRIED" ]; then
          echo "$(date '+%H:%M')  $COUNT session(s) set by a reviewer waiting: generating"
          TRIED="$SIG"; TOLD=""
          {
            echo
            echo "=== $(date '+%Y-%m-%d %H:%M')  $COUNT waiting"
          } >> "$LOG"
          if bash scripts/regenerate-audits.sh --reviewed --apply >> "$LOG" 2>&1; then
            echo "$(date '+%H:%M')  done"
          else
            echo "$(date '+%H:%M')  the run failed: see $LOG"
          fi
        elif [ -z "$TOLD" ]; then
          echo "$(date '+%H:%M')  $COUNT still waiting after a run. Not running again for the same thing: see $LOG"
          TOLD=1
        fi
        ;;
    esac
  else
    echo "$(date '+%H:%M')  could not reach the database; trying again later"
  fi
  sleep "$EVERY"
done
