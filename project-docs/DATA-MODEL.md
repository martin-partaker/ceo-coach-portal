# Data Model

A practical reference for anyone building automations on top of the Coach Portal — Make/Zapier flows, custom scripts, dashboards, exports.

> **Stack:** PostgreSQL (hosted on Neon), Drizzle ORM. Schema lives in [`src/db/schema.ts`](../src/db/schema.ts). Every table id is a UUID v4 unless noted.

---

## 1. Domain at a glance

The portal is a coaching CRM. The core entities and how they nest:

```
coaches
   │
   └── ceos                              ← clients ("CEOs")
          │
          ├── ceo_email_aliases          ← extra emails that route to this CEO
          ├── ceo_kpi_definitions        ← labels/units/targets for metrics
          │       │
          │       └── cycle_kpi_values   ← month-over-month measurements
          │
          └── cycles                     ← monthly coaching periods
                   │
                   ├── journal_entries   ← weekly written reflections
                   ├── transcripts      ← Zoom session transcripts
                   ├── action_items     ← committed next steps
                   └── reports          ← AI-generated monthly summary
```

Plus an **ingestion layer** (`raw_inputs`, `tally_forms`, `ingestion_cursors`) that lands new content and projects it into the right cycle, and a **curriculum** table that the AI reads as context.

**Key invariant:** a `cycle` always belongs to exactly one CEO; a CEO can have many cycles, and cycles can overlap (e.g. a Mar 2026 monthly cycle and a Jan–Mar quarterly retrospective). The downstream content (`journal_entries`, `transcripts`, `action_items`, `cycle_kpi_values`) is owned by a specific cycle but is also visible to any *other* cycle of the same CEO whose `[periodStart, periodEnd]` window contains the entry's effective date — see "Cycle membership" below.

---

## 2. Tables

### `coaches`

The people who use the portal. One row per login.

| column            | type     | nullable | notes                                                            |
| ----------------- | -------- | -------- | ---------------------------------------------------------------- |
| `id`              | uuid     | no       | primary key                                                      |
| `neon_auth_user_id`| text    | yes      | links the row to a Neon Auth identity. Null for invited / pre-created coaches. Unique. |
| `name`            | text     | no       | display name                                                     |
| `email`           | text     | no       | unique. Sign-in email; expected to be on `partaker.com` for internal staff. |
| `zoom_user_email` | text     | yes      | Zoom account email. When set, the cron polls this account for new recordings. Admin-managed. |
| `is_super_admin`  | boolean  | no       | super admins can see/operate on every CEO across every coach unless impersonating. |
| `created_at`      | timestamp| no       |                                                                  |

### `ceos`

The coaches' clients.

| column                  | type      | nullable | notes                                                                                              |
| ----------------------- | --------- | -------- | -------------------------------------------------------------------------------------------------- |
| `id`                    | uuid      | no       |                                                                                                    |
| `coach_id`              | uuid → coaches | yes  | **on delete: set null.** A CEO can sit in the "Unassigned" bucket. Deleting a coach moves them there. |
| `name`                  | text      | no       |                                                                                                    |
| `email`                 | text      | yes      | primary email. NOT unique on its own — see `ceo_email_aliases`.                                    |
| `avatar_url`            | text      | yes      |                                                                                                    |
| `ten_x_goal`            | text      | yes      | the CEO's overarching goal — used as system-prompt context for every report.                       |
| `ten_x_goal_updated_at` | timestamp | yes      | last time the 10x goal was edited.                                                                 |
| `profile_json`          | jsonb     | yes      | reserved for future structured profile fields. Currently unused.                                   |
| `created_at`            | timestamp | no       |                                                                                                    |

### `ceo_email_aliases`

Multiple emails routing to the same CEO. Tally submissions, calendar invites, and forwarded mail are all matched against this list.

| column     | type            | nullable | notes                              |
| ---------- | --------------- | -------- | ---------------------------------- |
| `id`       | uuid            | no       |                                    |
| `ceo_id`   | uuid → ceos     | no       | on delete: cascade                 |
| `email`    | text            | no       | unique across the whole table.     |
| `created_at`| timestamp      | no       |                                    |

### `cycles`

A coaching cycle (typically one calendar month). The unit of work the report is generated against.

| column                            | type      | nullable | notes                                                                                                       |
| --------------------------------- | --------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `id`                              | uuid      | no       |                                                                                                             |
| `ceo_id`                          | uuid → ceos | no     | on delete: cascade                                                                                          |
| `label`                           | text      | no       | free-text, e.g. "Apr 2026" or "Q2 retrospective". The UI also derives a label from the period dates.        |
| `period_start`                    | date      | yes      | start of the cycle window. Used for membership math (which inputs belong to this cycle).                    |
| `period_end`                      | date      | yes      |                                                                                                             |
| `monthly_goals`                   | text      | yes      | the CEO's goals/commitments at the start of the cycle. AI-prefillable from transcripts.                     |
| `monthly_reflection`              | text      | yes      | end-of-cycle reflection. AI-prefillable from journals + transcripts.                                        |
| `additional_context`              | text      | yes      | free-text coach notes / forwarded emails / anything else the AI should know.                                |
| `transcript_skipped`              | boolean   | no       | when true, the prompt's "missing inputs" warning won't flag a missing transcript.                           |
| `monthly_goals_ai_suggested`      | boolean   | no       | true when the current value of `monthly_goals` came from AI prefill. Flips back to false on manual edit.    |
| `monthly_reflection_ai_suggested` | boolean   | no       |                                                                                                             |
| `created_at`                      | timestamp | no       |                                                                                                             |

### `journal_entries`

Weekly reflections from the CEO. Typically one per week of the cycle, ingested from a Tally form or entered manually.

| column                | type            | nullable | notes                                                                                                                                                                                              |
| --------------------- | --------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                  | uuid            | no       |                                                                                                                                                                                                    |
| `cycle_id`            | uuid → cycles   | no       | on delete: cascade. Primary owner.                                                                                                                                                                 |
| `week_number`         | integer         | no       | 1-N within the parent cycle. Legacy; new entries should use `entry_date`.                                                                                                                          |
| `entry_date`          | date            | yes      | exact day this entry refers to. Preferred over `week_number` for chronological sort + cross-cycle membership.                                                                                      |
| `title`               | text            | no       | e.g. "Week 1 — Mar 1 to Mar 7" or just the date.                                                                                                                                                   |
| `content`             | text            | no       | the reflection body. Markdown-ish.                                                                                                                                                                 |
| `source_raw_input_id` | uuid            | yes      | when the entry came from an ingested Tally submission, this points back to that `raw_inputs` row. Manually-added entries leave it null.                                                            |
| `created_at`          | timestamp       | no       |                                                                                                                                                                                                    |

> **Well-being scores are inside `content`, not typed columns.** The weekly Tally journal captures four 1–10 self-ratings as plain `Q:/A:` text within `content`:
> `Q: Energy level` / `Q: Level of focus` / `Q: Stress level` / `Q: How well did I complete highest leverage work this week?`.
> The **Momentum Check** section of the report parses these deterministically (no LLM) and shows the monthly average per metric with a stoplight colour (green 8–10, yellow 5–7, red 1–4; **stress is reversed**), plus the prior month when available. Parser: [`src/lib/journal/momentum-metrics.ts`](../src/lib/journal/momentum-metrics.ts); per-cycle aggregation: [`src/lib/journal/cycle-momentum.ts`](../src/lib/journal/cycle-momentum.ts).

### `transcripts`

Zoom session transcripts (or pasted text). One per session.

| column                | type            | nullable | notes                                                                                |
| --------------------- | --------------- | -------- | ------------------------------------------------------------------------------------ |
| `id`                  | uuid            | no       |                                                                                      |
| `cycle_id`            | uuid → cycles   | no       | on delete: cascade                                                                   |
| `title`               | text            | no       | usually the Zoom meeting topic                                                       |
| `content`             | text            | no       | full transcript text                                                                 |
| `zoom_meeting_id`     | text            | yes      | Zoom's meeting id, when imported from the Zoom API                                   |
| `duration`            | integer         | yes      | minutes                                                                              |
| `recorded_at`         | timestamp       | yes      |                                                                                      |
| `source_raw_input_id` | uuid            | yes      | back-pointer to the `raw_inputs` row when imported via the cron                      |
| `created_at`          | timestamp       | no       |                                                                                      |

### `action_items`

Commitments coming out of a coaching cycle. The AI seeds them from the transcript; the coach reviews/curates.

| column         | type            | nullable | notes                                                                                                          |
| -------------- | --------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `id`           | uuid            | no       |                                                                                                                |
| `cycle_id`     | uuid → cycles   | no       | on delete: cascade                                                                                             |
| `owner`        | text            | no       | free-text — typically "CEO" / "Coach" / "Other"                                                                |
| `item`         | text            | no       | the action itself                                                                                              |
| `due_at`       | date            | yes      |                                                                                                                |
| `status`       | text            | no       | `'open'` / `'done'` / `'dropped'`                                                                              |
| `ai_suggested` | boolean         | no       | true when the AI added this item; false when manually entered. Drives the readiness gate (auto-suggested items must be reviewed by a human before the cycle is "ready"). |
| `reviewed`     | boolean         | no       | flips true when a coach acknowledges the item. Required for AI-suggested items to count toward readiness.      |
| `reviewed_at`  | timestamp       | yes      |                                                                                                                |
| `reviewed_by`  | uuid → coaches  | yes      | on delete: set null                                                                                            |
| `created_at`   | timestamp       | no       |                                                                                                                |

### `reports`

The AI-generated monthly summary. One row per generation; only the latest is shown in the UI but historical generations are kept.

| column           | type            | nullable | notes                                                                                                                                                                                                       |
| ---------------- | --------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | uuid            | no       |                                                                                                                                                                                                             |
| `cycle_id`       | uuid → cycles   | no       | on delete: cascade                                                                                                                                                                                          |
| `generated_at`   | timestamp       | no       |                                                                                                                                                                                                             |
| `content_json`   | jsonb           | no       | the model's full output. **See "JSONB shapes → reports.contentJson" below.**                                                                                                                                |
| `raw_text`       | text            | no       | the email body re-derived from `content_json`. The "Copy email" button copies this verbatim, so coach edits to the JSON re-derive this server-side and stay in sync.                                        |
| `model_used`     | text            | no       | e.g. `claude-sonnet-4-20250514` — the underlying model id.                                                                                                                                                  |
| `prompt_version` | integer         | no       | bumped when the prompt structure changes meaningfully (new fields, new sections). Older reports keep their original number so consumers can branch on shape.                                                |

### `ceo_kpi_definitions`

Per-CEO KPI definitions (label/unit/target/kind). These persist across cycles so month-over-month progression works for `Revenue`, `EBITDA`, etc.

| column         | type            | nullable | notes                                                                                                          |
| -------------- | --------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `id`           | uuid            | no       |                                                                                                                |
| `ceo_id`       | uuid → ceos     | no       | on delete: cascade                                                                                             |
| `label`        | text            | no       | "Revenue", "EBITDA", "Banking relationships" — free-text                                                       |
| `unit`         | text            | yes      | optional hint, e.g. `"$"`, `"%"`                                                                               |
| `target`       | text            | yes      | aspirational target (free-text — can be `"$10M"` or `"5 finalist banks"`)                                      |
| `kind`         | text            | no       | `'number'` / `'currency'` / `'percent'` / `'count'` / `'text'`. Drives input UX; numeric kinds enable trend math + progress bars. |
| `sort_order`   | integer         | no       | manual ordering; lower comes first                                                                             |
| `archived_at`  | timestamp       | yes      | soft-delete. Hides from the editor but keeps historical values intact.                                         |
| `created_at`   | timestamp       | no       |                                                                                                                |

### `cycle_kpi_values`

Per-cycle measurement of a definition. Unique on `(cycle_id, definition_id)`.

| column         | type                          | nullable | notes                                                          |
| -------------- | ----------------------------- | -------- | -------------------------------------------------------------- |
| `id`           | uuid                          | no       |                                                                |
| `cycle_id`     | uuid → cycles                 | no       | on delete: cascade                                             |
| `definition_id`| uuid → ceo_kpi_definitions    | no       | on delete: cascade                                             |
| `value`        | text                          | no       | free-text — `"$5.2M"`, `"12%"`, `"none yet"`. Parsed when needed for trend/progress. |
| `trend`        | text                          | yes      | `'up'` / `'down'` / `'flat'` or null. Auto-derived from numeric delta when possible. |
| `note`         | text                          | yes      | optional context for this measurement                          |
| `created_at`   | timestamp                     | no       |                                                                |

### `curriculum`

Coaching framework + class catalog. Read by the AI as system-prompt context. Two `kind`s today:

| `kind`        | meaning                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `framework`   | Coaching philosophy / 10x methodology. Loaded into the AI system prompt as the coach's voice + pedagogy. Around 9 rows.                              |
| `class`       | Granular class-section chunks from the CEO Accelerator materials. The AI is given titles + summaries and picks 1–3 to surface as Suggested Resources. |

| column         | type    | nullable | notes                                            |
| -------------- | ------- | -------- | ------------------------------------------------ |
| `id`           | uuid    | no       |                                                  |
| `kind`         | text    | no       | `'framework'` (default) or `'class'`             |
| `class_number` | integer | yes      | 1–12 for `class` rows; null for framework        |
| `section`      | text    | yes      | subsection name within a class                   |
| `slug`         | text    | yes      | URL-safe handle                                  |
| `summary`      | text    | yes      | short blurb the AI reads when picking resources  |
| `title`        | text    | no       |                                                  |
| `content_text` | text    | no       | full body                                        |
| `sort_order`   | integer | no       |                                                  |
| `created_at`   | timestamp| no      |                                                  |

### Ingestion layer

#### `raw_inputs`

Every external piece of content lands here first. The downstream tables (`journal_entries`, `transcripts`) are *projections* of these rows once they've been classified and assigned to a CEO + cycle.

| column            | type         | nullable | notes                                                                                                                                |
| ----------------- | ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `id`              | uuid         | no       |                                                                                                                                      |
| `ceo_id`          | uuid → ceos  | yes      | on delete: cascade. Null while pending CEO match.                                                                                    |
| `cycle_id`        | uuid → cycles| yes      | on delete: set null. Null while pending cycle match.                                                                                 |
| `coach_id`        | uuid → coaches | yes    | on delete: set null. Set when a coach submitted on behalf of a CEO.                                                                  |
| `source`          | text         | no       | `'tally'` / `'zoom'` / others later                                                                                                  |
| `content_type`    | text         | no       | `'weekly_journal'` / `'monthly_journal'` / `'transcript'` / `'goal_worksheet'` / `'intake'` / `'self_assessment'` / etc.              |
| `external_id`     | text         | no       | the source's id (Tally submission id, Zoom recording uuid). Unique per `(source, external_id)`.                                      |
| `occurred_at`     | timestamp    | no       | when the event happened in the source — submission time / meeting start                                                              |
| `payload_json`    | jsonb        | no       | full source payload. **See "JSONB shapes → raw_inputs.payloadJson" below.**                                                          |
| `text_content`    | text         | yes      | extracted plain-text body — what we actually feed the matcher                                                                        |
| `match_status`    | text         | no       | `'matched'` / `'pending_ceo'` / `'pending_cycle'` / `'pending_classification'` / `'discarded'` / `'archived'`                         |
| `match_confidence`| integer      | yes      | 0–100. ≥90 → auto-attach. <90 → operator triage.                                                                                     |
| `match_candidates`| jsonb        | yes      | submitter id, fuzzy-match candidates                                                                                                 |
| `classification`  | jsonb        | yes      | LLM classifier verdict (Zoom only) — meeting type, participants summary, include-in-summary flag                                     |
| `ingested_at`     | timestamp    | no       | when we ingested it                                                                                                                  |
| `resolved_at`     | timestamp    | yes      | when an operator (or auto-rule) finished triage                                                                                      |
| `resolved_by`     | uuid → coaches | yes    |                                                                                                                                      |

Indexes: `(source, external_id)` unique; `(match_status)` and `(ceo_id, occurred_at)` for the triage queue + per-CEO timelines.

#### `tally_forms`

The form registry. One row per form discovered on the Tally workspace.

| column                | type      | nullable | notes                                                                                                                                                |
| --------------------- | --------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `form_id`             | text      | no       | primary key. Tally's form id, e.g. `"abcd123"`.                                                                                                      |
| `name`                | text      | no       |                                                                                                                                                      |
| `status`              | text      | no       | `'pending_review'` (default) / `'active'` / `'ignored'`. Drives the cron — only `active` forms get their submissions ingested.                       |
| `content_type`        | text      | no       | what kind of input this form's submissions are projected as (`'weekly_journal'`, `'monthly_journal'`, `'goal_worksheet'`, etc.). Defaults to `unknown`. |
| `email_question_id`   | text      | yes      | id of the form's "what's your email?" question — used to extract the CEO email                                                                       |
| `name_question_id`    | text      | yes      | id of the "what's your name?" question                                                                                                               |
| `projection_enabled`  | boolean   | no       | when true, matched submissions auto-project into the right downstream table (`journal_entries`/`transcripts`)                                        |
| `questions_snapshot`  | jsonb     | yes      | last-seen snapshot of the form's question schema                                                                                                     |
| `notes`               | text      | yes      |                                                                                                                                                      |
| `created_at` / `updated_at` | timestamp | no |                                                                                                                                                      |

#### `ingestion_cursors`

Watermark per source. Used by the cron to know what's already been pulled.

| column            | type      | notes                                                                          |
| ----------------- | --------- | ------------------------------------------------------------------------------ |
| `source`          | text      | primary key. Format: `"tally:<formId>"` or `"zoom:<coachId>"`.                |
| `cursor`          | text      | the most recent ingested external_id                                           |
| `last_run_at`     | timestamp | every run updates                                                              |
| `last_success_at` | timestamp | only successful runs                                                           |
| `last_error`      | text      | most recent error message; cleared on success                                  |

#### `raw_input_ceos`

Many-to-many — used when one raw_input was submitted by/about multiple CEOs (rare but happens with group sessions). Rarely populated; the primary `ceo_id` on `raw_inputs` is usually enough.

---

## 3. JSONB shapes

### `reports.content_json`

The AI returns a single JSON blob with both views — the email-body view and the structured report (which gets rendered as the PDF). Both are addressed to the CEO.

```jsonc
{
  // Email view — coach's voice, ready to copy/paste into Gmail
  "subject_line": "Your April cycle — pattern I want you to sit with",
  "opening": "1-2 paragraph greeting + reflection",
  "wins_and_progress": "Markdown bullets",
  "honest_feedback": "Where you got stuck",
  "key_insight": "The ONE observation",
  "commitments": "Numbered list of next-cycle commitments",
  "going_deeper": "Markdown bullets — 1 per suggested resource",
  "closing": "Sign-off",

  // Structured report — rendered as the PDF Monthly Progress Summary
  "report": {
    "progressSummary": "1-2 paragraph snapshot",
    "keyWins": ["Win 1", "Win 2"],
    "challenges": ["Challenge 1"],
    "patternObservations": "Cross-cycle patterns",
    "suggestedNextSteps": ["Step 1", "Step 2"],
    // 1–3 picks from the curriculum.kind='class' catalog
    "suggestedResourceIds": ["uuid-1", "uuid-2"]
  }
}
```

`promptVersion` is bumped whenever this shape changes meaningfully. Older reports may have only the email keys (no `report` block) — automations should branch on `report` being present.

### `raw_inputs.payload_json`

Source-specific blob. The shape depends on `source`.

**`source = 'tally'`** — full Tally form submission webhook payload:

```jsonc
{
  "formId": "abcd123",
  "submissionId": "sub-uuid",
  "submittedAt": "2026-04-15T10:23:00Z",
  "responses": [
    { "questionId": "q1", "label": "What's your name?", "answer": "Milos Jankovic" },
    { "questionId": "q2", "label": "What was your win?", "answer": "..." }
  ]
}
```

**`source = 'zoom'`** — Zoom recording metadata + transcript:

```jsonc
{
  "meeting": {
    "id": 123,
    "uuid": "...",
    "topic": "Check-in: Milos 90-min",
    "start_time": "2026-04-12T14:00:00Z",
    "duration": 95
  },
  "participants": [
    { "name": "Martin van der Heijden", "user_email": "martin@partaker.com", "internal_user": false },
    { "name": "Milos Jankovic",         "user_email": "milos@koretrust.com",   "internal_user": false }
  ],
  "transcript_url": "https://..."
}
```

### `raw_inputs.classification`

LLM classifier verdict (Zoom only):

```jsonc
{
  "meetingType": "1-on-1 coaching" | "supervision" | "intake" | "group" | ...,
  "participantsSummary": "Martin (coach) + Milos (CEO)",
  "includeInMonthlySummary": true,
  "includeReason": "1-on-1 coaching session with assigned coach"
}
```

### `raw_inputs.match_candidates`

Two shapes depending on whether identity was clean or fuzzy:

- Submitter identity: `{ "email": "...", "name": "..." }`
- Fuzzy candidates: `[{ "candidateName": "...", "candidateEmail": "...", "score": 0.84 }, ...]`

---

## 4. Cycle membership (important for queries)

A `journal_entry`/`transcript`/`action_item`/`cycle_kpi_value` is **owned** by exactly one cycle (`cycle_id` FK), but for the workspace UI + the AI prompt we also include any item from a **sibling** cycle of the same CEO whose effective date sits inside the current cycle's `[period_start, period_end]` window. This means a Mar 2026 transcript naturally lights up in both Mar 2026 (its primary cycle) and a Jan–Mar quarterly cycle that overlaps it.

Effective date by table:

| table              | effective date                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `journal_entries`  | `entry_date` if set; else `parent_cycle.period_start + (week_number - 1) × 7d`; else `created_at` |
| `transcripts`      | `recorded_at` if set; else `created_at`                                                   |
| `action_items`     | `due_at` if set; else `created_at`                                                        |
| `raw_inputs`       | `occurred_at`                                                                             |

If an automation only cares about "this cycle's stuff", filter by `cycle_id`. If it cares about "this CEO's content within this date window", join on `ceos.id` and filter the effective date against the cycle's window.

---

## 5. Common queries

**All CEOs assigned to a coach, with their latest cycle:**

```sql
SELECT ceo.id, ceo.name, ceo.email, c.id AS cycle_id, c.label, c.period_start, c.period_end
FROM ceos ceo
LEFT JOIN LATERAL (
  SELECT * FROM cycles
  WHERE cycles.ceo_id = ceo.id
  ORDER BY period_start DESC NULLS LAST, created_at DESC
  LIMIT 1
) c ON TRUE
WHERE ceo.coach_id = $1;
```

**KPI series for one CEO (long-format, oldest first):**

```sql
SELECT def.label, def.unit, def.target, def.kind,
       cy.label AS cycle_label, cy.period_end,
       v.value, v.trend, v.note
FROM ceo_kpi_definitions def
JOIN cycle_kpi_values v ON v.definition_id = def.id
JOIN cycles cy ON cy.id = v.cycle_id
WHERE def.ceo_id = $1
  AND def.archived_at IS NULL
ORDER BY def.sort_order ASC, cy.period_end ASC NULLS LAST;
```

**Latest report for every cycle of a CEO:**

```sql
SELECT DISTINCT ON (r.cycle_id)
  r.cycle_id, c.label, r.generated_at, r.raw_text, r.content_json
FROM reports r
JOIN cycles c ON c.id = r.cycle_id
WHERE c.ceo_id = $1
ORDER BY r.cycle_id, r.generated_at DESC;
```

**Triage queue (raw inputs awaiting human assignment):**

```sql
SELECT * FROM raw_inputs
WHERE match_status IN ('pending_ceo', 'pending_cycle')
ORDER BY occurred_at DESC;
```

---

## 6. Surfaces for automation

Three places to read the data, in order of "most stable":

### 6a. The export ZIP — easiest

**Endpoint:** `GET /api/export/zip` (browser session required).

Returns a ZIP with the caller's full visible roster as flat files: per-CEO + per-cycle markdown, JSON, and CSV (KPI history). Best when you want a snapshot for archives, audits, or feeding a spreadsheet. See the README inside the ZIP for the folder layout. Coach-scoped for regular coaches; admins get every CEO when not impersonating.

### 6b. tRPC API — all the live read paths

The same tRPC procedures the front-end uses. Stable shapes that follow the schema. The big ones for automations:

| procedure                          | what it returns                                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `roster.cycleSummary`              | every CEO + their cycles + readiness state + submissions strip. Coach- or admin-scoped via the `scope` input.         |
| `roster.cycleDetail`               | one cycle's everything: cycle row, journals, transcripts, action items, KPIs (with multi-month series + prior-cycle), latest report, raw inputs. |
| `reports.getForCycle`              | the latest report row for a cycle.                                                                                    |
| `inbox.triageQueue`                | pending raw inputs with AI suggestions for which CEO + cycle they belong to.                                          |
| `inbox.listForCeo`                 | every assigned input for a CEO — useful when reconstructing what fed into a report.                                   |
| `cycles.listForCeo`                | cycle-by-cycle list, lighter shape than cycleSummary.                                                                 |
| `actionItems.listForCycle`         | action items in their owned-cycle scope.                                                                              |

These ride the same auth/impersonation rules as the UI. A tRPC client (`@trpc/client`) hitting `https://<host>/api/trpc/<procedure>` with a valid session cookie is the supported integration path.

### 6c. Direct DB read — most flexible, most coupled

If automations live close to the database (Make.com Postgres module, a small worker, a notebook), reading the tables directly is fine and often the fastest path. Treat the schema in `src/db/schema.ts` as the source of truth. Apply the cycle-membership rule from §4 if you need "this cycle's effective content" rather than just "rows where `cycle_id = X`".

**Connection string:** `DATABASE_URL` env var. Read-only access can be granted via a Neon role with `SELECT` on the listed tables.

**Don't write directly** unless you've thought through the cascades and the AI-suggested flag invariants — `roster.upsertKpis`, `cycles.update`, `reports.update` etc. encode rules (e.g. clearing `monthly_goals_ai_suggested` when the value is hand-edited) that a raw `UPDATE` statement will break. Prefer the tRPC API for writes.

---

## 7. Things that don't live in the DB

For completeness — what an automation *can't* read from Postgres alone:

- **Auth identities** are managed by Neon Auth. The `coaches.neon_auth_user_id` links to it.
- **Tally form schemas** beyond what's snapshotted in `tally_forms.questions_snapshot`. Live form definitions live on Tally.
- **Zoom recordings** live on Zoom. We pull transcript text into `transcripts.content` and store the meeting metadata in `raw_inputs.payload_json` — but the actual video/audio stays on Zoom.
- **AI generation history** beyond the last few `reports` rows for a cycle. We keep them indefinitely but the UI only surfaces the latest.

---

## Changelog gotchas to know about

A few schema decisions that surprise people:

- **`ceos.coach_id` is nullable.** A CEO can be on the roster without an assigned coach. Filter `WHERE coach_id IS NOT NULL` if you only want assigned ones.
- **A cycle can have no period dates.** Legacy cycles before periods were introduced. Effective-date math falls back to `created_at`.
- **`journal_entries.week_number` is required, but `entry_date` is the source of truth** for new rows. Code that orders journals chronologically should `COALESCE(entry_date, …)`.
- **Reports are append-only.** Re-generating a report inserts a new row; the UI shows the latest by `generated_at`. Old generations are kept for audit.
- **KPI definitions soft-delete.** `WHERE archived_at IS NULL` is required to filter to "active" KPIs.
