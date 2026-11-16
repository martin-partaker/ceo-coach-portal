#!/usr/bin/env bash
#
# Regenerate the audits from the staging database, in one go.
#
#   bash scripts/regenerate-audits.sh              # everything, import as a dry run
#   bash scripts/regenerate-audits.sh --apply      # ...and write the audits
#   bash scripts/regenerate-audits.sh --read       # also have the model read new Session 1 recordings
#
# Run it after a reviewer has set or corrected a session on the audit screen,
# or after a criteria change. It is the four steps that used to be typed by
# hand: export the candidates (which is where a reviewer's word on the session
# is read), optionally read new Session 1 recordings with the model, build the
# audits, import them.
#
# The import is a dry run unless --apply is given: read what it says first.
# --read calls the Anthropic API with the key in .env.staging and costs money
# (about 20 cents a recording); without it a newly placed Session 1 is audited
# with its three model-read findings marked "not read".
#
# The evaluators live outside this repository. Point AUDIT_TOOL_DIR at them if
# they are not in ~/Desktop/zoom-transcripts/tool.
set -euo pipefail
cd "$(dirname "$0")/.."

TOOL="${AUDIT_TOOL_DIR:-$HOME/Desktop/zoom-transcripts/tool}"
WORK="$(dirname "$TOOL")"
APPLY=""
READ=""
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --read) READ=1 ;;
    *) echo "unknown option: $arg (use --apply and/or --read)" >&2; exit 2 ;;
  esac
done

[ -f .env.staging ] || { echo ".env.staging not found in $(pwd)" >&2; exit 1; }
[ -f "$TOOL/make_audit_json.py" ] || { echo "evaluators not found in $TOOL" >&2; exit 1; }

set -a
# shellcheck disable=SC1091
. ./.env.staging
set +a

echo "== 1/4  export candidates (reads any session a reviewer has set)"
pnpm tsx scripts/export-audit-input.ts --out "$WORK/candidates.json"

if [ -n "$READ" ]; then
  echo
  echo "== 2/4  model reading of Session 1 recordings not read yet"
  (cd "$TOOL" && python3 model_read.py --in ../candidates.json --out ../model_readings.json)
else
  echo
  echo "== 2/4  model reading skipped (--read to include it; it calls the Anthropic API)"
fi

echo
echo "== 3/4  build the audits"
# No arrays: macOS ships bash 3.2, where an empty array under `set -u` is an error.
if [ -f "$WORK/model_readings.json" ]; then
  (cd "$TOOL" && python3 make_audit_json.py --in ../candidates.json --out ../audits.json --readings ../model_readings.json)
else
  (cd "$TOOL" && python3 make_audit_json.py --in ../candidates.json --out ../audits.json)
fi

echo
echo "== 4/4  import"
if [ -n "$APPLY" ]; then
  pnpm tsx scripts/import-audits.ts --in "$WORK/audits.json" --apply
else
  pnpm tsx scripts/import-audits.ts --in "$WORK/audits.json"
  echo
  echo "Nothing was written. Run again with --apply to write these audits."
fi
