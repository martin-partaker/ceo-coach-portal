# Developer Guide

> For engineers taking over or extending the CEO Coach Portal. Read [ARCHITECTURE.md](./ARCHITECTURE.md) and [DATA-MODEL.md](./DATA-MODEL.md) alongside this.

---

## 1. Local setup

```bash
pnpm install                # package manager is pnpm (pnpm-lock.yaml)
cp .env.example .env        # then fill in the values (see INFRASTRUCTURE.md)
pnpm dev                    # Next.js dev server on http://localhost:3000
```

- **Node**: 20+ (developed on 20.x; newer works).
- **Type check**: `pnpm exec tsc --noEmit` — this is the reliable gate. (Note: `pnpm lint` is currently broken — ESLint 9+ is installed but there's no `eslint.config.js`; fixing that is a good first cleanup task.)
- **Database schema changes**: edit `src/db/schema.ts`, then `pnpm db:push` (drizzle-kit, no migration files). `pnpm db:studio` opens a DB browser.
- Sign in with a coach account (Neon Auth, email/password; self-signup is disabled — a super-admin creates accounts).

---

## 2. Codebase map

```
src/
├── app/                     # Next.js App Router
│   ├── (app)/               # authed app shell (sidebar + topbar); most pages
│   ├── auth/                # sign-in
│   └── api/
│       ├── trpc/[trpc]/     # tRPC HTTP handler
│       └── reports/[cycleId]/pdf/  # PDF download route (react-pdf)
├── components/
│   ├── admin/               # the operator UI (roster, teams, triage, report modal)
│   │   └── report-modal/    # the report review/edit surface (DocumentRenderer + refine)
│   └── ui/                  # shadcn/ui primitives
├── db/
│   └── schema.ts            # Drizzle schema — SOURCE OF TRUTH for the DB
├── server/api/
│   ├── trpc.ts              # context, procedures (protected/admin)
│   └── routers/             # one file per domain (see below)
├── lib/
│   ├── prompts/v2/          # the AI report pipeline (see §3) ← the heart of the app
│   ├── ingestion/           # Tally + Zoom → raw_inputs → typed tables
│   ├── tally/, zoom/        # source-specific parsing/projectors
│   ├── journal/             # momentum-metrics (well-being scores) + cycle-momentum
│   ├── pdf/                 # cycle-report-pdf.tsx (react-pdf document)
│   ├── markdown/            # markdown → react-pdf renderer
│   ├── anthropic/           # Claude client + model ids
│   ├── cycles/              # cycle-membership date math
│   └── auth/                # Neon Auth server helpers
└── workflows/               # Vercel Workflow durable report generation
```

### tRPC routers (`src/server/api/routers/`)
| Router | Responsibility |
|--------|----------------|
| `coaches` | coach accounts |
| `ceos` | CEOs — create, edit, email aliases, KPIs |
| `teams` | coaching teams — form, edit, add/remove/mark-former members, transfer, archive |
| `cycles` | monthly cycles |
| `roster` | the roster/cycle dashboard queries |
| `reports` | report generation (v2), section refine/raw-edit, versions, momentum |
| `inbox` | Triage — raw_inputs, matching, assign, create-CEO-from-input |
| `actionItems` | commitments / next steps |
| `zoom` | Zoom transcript sync |
| `admin` | super-admin ops (create CEO, coaches, aliases) |

---

## 3. The report pipeline (the important part)

Report generation is a multi-stage pipeline in `src/lib/prompts/v2/`, run as a durable **Vercel Workflow** (`src/workflows/generate-report.ts`) and orchestrated by `orchestrate.ts`. It uses **Anthropic Claude** (`src/lib/anthropic/`).

| Stage | File | What it does |
|-------|------|--------------|
| **A — Extract facts** | `extract-facts.ts` → `schemas.ts` `CycleFactsSchema` | Reads raw inputs, emits typed `CycleFacts` (goal cascade, weekly effort, stakeholders, evidence claims, commitments, coach-review flags). Cached in `cycle_facts`. |
| **B — Match patterns** | `match-patterns.ts` | Compares to prior cycles → cross-month `Patterns`. |
| **C — Draft** | `draft.ts` → `DraftedReportSchema` | Writes the report (both the structured PDF view and the email view), citing Facts + Patterns. The big system prompt + gold-standard few-shots live here. |
| **D — Critique** | `critique.ts` | Scores the draft against the rubric (`RUBRIC_ITEMS` in `schemas.ts`); weak sections get a Stage C rewrite. |
| **E — Refine** | `refine-section.ts` | Per-section coach-driven refinement (the pencil popover). |

**Supporting pieces:**
- `context.ts` — `fetchCycleContext()` gathers everything the pipeline reads (journals, transcripts, KPIs, prior facts, team membership). **Key invariant:** it gathers data across *all* team members but presents/address only *active* members (former members are excluded from the subject — see the succession feature).
- `post-process.ts` — deterministic clean-ups on the model output (em-dash stripping, the "Metrics and what moved" header, the Altitude-tag period placement).
- `instant.ts` — the fast "instant" generation mode.

**Two views of one report:** the model emits both a structured `report` block (rendered as the PDF sections) and an `email` block (copy-paste email). The stored report is `reports.content_json`.

**Facts cache staleness:** `orchestrate.ts` `latestInputTimestamp()` compares input timestamps against `cycle_facts.generatedAt`. Editing inputs (or changing team membership, which bumps `cycles.updatedAt`) forces a fresh Stage A on the next generate.

---

## 4. Ingestion & Triage

`src/lib/ingestion/` + `src/lib/tally/` + `src/lib/zoom/`:
1. Tally form submissions and Zoom recordings land in **`raw_inputs`** with a `match_status`.
2. Matched by **email** (`ceo_email_aliases`). Zoom transcripts carry no email, so they usually land as `pending_ceo` for manual Triage.
3. On assignment, a raw input is **projected** into the typed tables (`journal_entries`, `transcripts`) attached to a CEO + cycle.

The **Momentum Check** well-being scores (energy/focus/stress/highest-leverage) are parsed deterministically from the journal free-text by `src/lib/journal/momentum-metrics.ts` (no LLM).

---

## 5. How to make common changes

- **Add a field to a CEO / cycle:** edit `src/db/schema.ts` → `pnpm db:push` → surface it in the relevant router + admin component.
- **Change the PDF layout:** `src/lib/pdf/cycle-report-pdf.tsx` (react-pdf). Markdown inside sections renders via `src/lib/markdown/render-pdf.tsx`. Remember react-pdf `wrap={false}` keeps a block from splitting across a page.
- **Tune the report wording/rules:** `src/lib/prompts/v2/draft.ts` (system prompt + few-shots in `fewshot/`). For deterministic post-fixes prefer `post-process.ts` over prompt-wrangling.
- **Change the rubric the critic enforces:** `RUBRIC_ITEMS` in `src/lib/prompts/v2/schemas.ts`.
- **Add an operator action:** add a mutation to the relevant router in `src/server/api/routers/`, then wire a component under `src/components/admin/`.

---

## 6. Conventions
- **Named exports** over default exports.
- **Server-only** modules import `'server-only'`.
- The DB schema in `src/db/schema.ts` is the single source of truth — types flow from `$inferSelect`.
- Zod schemas in `prompts/v2/schemas.ts` are the contract between pipeline stages.
- Deploys go through Vercel on push to `main` (see [INFRASTRUCTURE.md](./INFRASTRUCTURE.md)).
