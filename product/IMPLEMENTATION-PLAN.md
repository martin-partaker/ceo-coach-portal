# CEO Coach Portal — Implementation Plan

> Last updated: 2026-03-18
> Status: Ready to build — all decisions locked

---

## All Decisions

| Decision | Choice |
|---|---|
| Stack | Next.js 16 (App Router), TypeScript, Tailwind, pnpm |
| UI | shadcn/ui + dark/light mode toggle (next-themes) |
| Database | Neon Postgres (EU), Drizzle ORM |
| DB migrations | `drizzle-kit push` (no migration files, fine for MVP) |
| Auth | Neon Auth (email/password) |
| Coach onboarding | Super admin creates coach accounts |
| Super Admin | `is_super_admin` boolean flag on coaches table |
| AI | Direct Anthropic API key, Claude Sonnet (claude-sonnet-4-5 or latest) |
| Zoom | Must work at launch — credentials already registered |
| Zoom token storage | Stored on coaches table (Neon at-rest encryption sufficient) |
| Curriculum | Seeded from `/product/curriculum-seed.md` — refine after first cohort |
| Report output | 6-section JSON + raw_text. Copy-all for email + per-section copy. |
| Timeline | No hard deadline — build it right |

---

## Database Schema

```sql
-- coaches
id, neon_auth_user_id, name, email, zoom_oauth_token, is_super_admin, created_at

-- ceos
id, coach_id, name, email, ten_x_goal, ten_x_goal_updated_at, created_at

-- cycles
id, ceo_id, label (e.g. "Apr 10 → May 10"), period_start, period_end
monthly_goals, weekly_journal_1, weekly_journal_2, weekly_journal_3, weekly_journal_4, weekly_journal_5
monthly_reflection
zoom_transcript, zoom_meeting_id, transcript_skipped (boolean)
created_at

-- action_items
id, cycle_id, owner (CEO|Coach|Other), item, due_at, status (open|done|dropped), created_at

-- reports
id, cycle_id, generated_at
content_json (6 sections as JSON)
raw_text (email copy version)
model_used, prompt_version

-- curriculum
id, title, content_text, created_at
```

---

## Phase 0 — Foundation
**Goal:** Solid infrastructure before any features.
**Estimated effort:** 2–3 days

### Tasks:
- [ ] Install shadcn/ui — `npx shadcn@latest init`
- [ ] Install next-themes for dark/light toggle
- [ ] Install Drizzle ORM + `@neondatabase/serverless` + `drizzle-kit`
- [ ] Write full Drizzle schema in `src/db/schema.ts`
- [ ] Run `pnpm drizzle-kit push` to apply schema
- [ ] Auth middleware — protect all routes, redirect unauthenticated to /sign-in
- [ ] Coach profile auto-creation on first login (link neon_auth_user_id → coaches row)
- [ ] App layout with sidebar navigation + theme toggle
- [ ] Seed curriculum rows from `/product/curriculum-seed.md`

### Deliverable:
App boots, auth works end-to-end, DB schema applied, theme toggle works, coach row created on first login.

---

## Phase 1 — Coach Dashboard & CEO Management
**Goal:** Coach can log in, see their CEOs, add new ones.
**Estimated effort:** 2–3 days

### Tasks:
- [ ] `/dashboard` — list of coach's CEOs with status chip per CEO
  - Status: `In progress` / `Ready to generate` / `Generated`
- [ ] "What's missing" at-a-glance panel (no active cycle, incomplete inputs)
- [ ] Add CEO form (name, email) — modal or page
- [ ] `/ceos/[id]` — CEO profile page (name, email, 10x goal)
- [ ] 10x goal field: set once, editable, shows last-updated date
- [ ] Route structure: `/dashboard` → `/ceos/[id]` → `/ceos/[id]/cycles/[cycleId]`

### Deliverable:
Coach can manage their CEO roster.

---

## Phase 2 — Cycles & Input Collection
**Goal:** Full data entry for a coaching cycle (manual transcript paste as fallback until Phase 3).
**Estimated effort:** 3–4 days

### Tasks:
- [ ] Create cycle form (label, optional period start/end)
- [ ] Cycle list per CEO (most recent first, with status)
- [ ] Cycle input form with auto-save on blur:
  - Monthly goals / commitments (textarea)
  - Weekly journals × 5 (expandable, labeled Week 1–5)
  - Monthly reflection (textarea)
  - Transcript (manual paste — placeholder until Zoom integration)
- [ ] "Mark transcript as skipped" checkbox (sets `transcript_skipped = true`)
- [ ] Input completeness indicator per field (green check / amber warning)
- [ ] Cycle status computed from input completeness

### Deliverable:
Coach can create a cycle and fill in all inputs manually.

---

## Phase 3 — Zoom Integration
**Goal:** Coach connects Zoom once; pulls transcript per cycle.
**Estimated effort:** 2–3 days

### Prerequisites:
- Zoom OAuth app already registered — credentials available
- Need env vars: `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, `ZOOM_REDIRECT_URI`

### Tasks:
- [ ] Coach settings page (`/settings`) with Zoom OAuth connect button
- [ ] Zoom OAuth callback route (`/api/zoom/callback`)
- [ ] Store Zoom access + refresh token on `coaches.zoom_oauth_token` (as JSON)
- [ ] Token refresh middleware (refresh on expiry before API calls)
- [ ] Per cycle: "Link Zoom meeting" button
- [ ] API route to list recent Zoom cloud-recorded meetings (last 30 days)
- [ ] Coach selects meeting → transcript pulled via Zoom API → stored in `cycles.zoom_transcript`
- [ ] Handle errors: no cloud recording, expired token, no transcript available

### Zoom API endpoints needed:
- `GET /v2/users/me/recordings` — list recordings
- `GET /v2/meetings/{meetingId}/recordings` — get transcript download URL
- Download VTT/plain text transcript

### Deliverable:
Coach can pull a Zoom transcript with one click instead of pasting.

---

## Phase 4 — Session Readiness Checklist & Action Items
**Goal:** Guardrail UX before generation. Action items tracked per cycle.
**Estimated effort:** 2–3 days

### Readiness Checklist:
Show before generation trigger. Items:
- [ ] 10x goal present (show date last updated)
- [ ] Monthly goals entered
- [ ] At least one weekly journal entered (or marked "not this cycle")
- [ ] Transcript attached OR explicitly marked as skipped
- [ ] Previous cycle action items reviewed (manual checkbox)

Coach can still generate if incomplete — but items are flagged in prompt + output.

### Action Items Tracker:
- [ ] Action items list per cycle
- [ ] Add/edit action item: owner (CEO | Coach | Other), description, due date, status
- [ ] Status: Open / Done / Dropped
- [ ] Previous cycle's open items shown at top of new cycle for review + carry-forward
- [ ] Post-generation: AI suggests new action items (shown as proposals, coach must confirm before saving)

### Deliverable:
Coach is guided through a completeness check before generating.

---

## Phase 5 — AI Generation & Report
**Goal:** Generate a high-quality 6-section coaching report.
**Estimated effort:** 3–4 days

### Tasks:
- [ ] Install Anthropic SDK: `pnpm add @anthropic-ai/sdk`
- [ ] Add `ANTHROPIC_API_KEY` to env
- [ ] Prompt builder: assemble system prompt (curriculum from DB) + user prompt (cycle inputs)
- [ ] Flag incomplete fields in the prompt explicitly
- [ ] Include previous cycle's report summary if available (for pattern observations)
- [ ] `/api/generate` route — call Claude Sonnet, stream response
- [ ] Store result in `reports` table: `content_json` (6 sections) + `raw_text` + `model_used` + `prompt_version`
- [ ] Report view page: formatted section-by-section layout
- [ ] Copy UX:
  - "Copy full report" button at top (copies `raw_text` formatted for email)
  - Per-section copy button next to each of the 6 sections
- [ ] Incomplete-input warnings shown inline in the output header
- [ ] Action item suggestions shown as proposals after generation

### Report sections (stored in `content_json`):
1. Progress Summary
2. Key Wins
3. Challenges & Constraints
4. Pattern Observations
5. Suggested Next Steps
6. Suggested Resources

### System prompt guardrails:
- Stay within the 10x coaching framework
- No diagnostic or therapeutic language
- No legal, medical, or mental health claims
- Professional and reflective tone
- Use Eric Partaker's language: "best self," "commitment," "constraint," "leverage," "champion proof"

### Deliverable:
Coach can generate and copy a complete coaching report in <5 minutes.

---

## Phase 6 — Coach Toolkit
**Goal:** Quick reference to reduce coach anxiety and enforce consistency.
**Estimated effort:** 1–2 days

### Tasks:
- [ ] Slide-out panel or `/toolkit` page
- [ ] Session 1 checklist (from curriculum seed row 8)
- [ ] Question bank — tabbed by stage (from curriculum seed row 9):
  - Goal Clarity
  - Constraint Identification
  - Product / Market / Delivery
  - Commitments and Follow-ups
  - Leadership Development
  - Personal Performance
- [ ] Templates:
  - "Missing weekly journal" nudge (copy-paste to send to CEO)
  - "Post-session recap + commitments" template

### Deliverable:
Coach has in-app quick reference during sessions.

---

## Phase 7 — Super Admin
**Goal:** EP team can view/manage all coaches and act as any coach.
**Estimated effort:** 1–2 days

### Tasks:
- [ ] `is_super_admin` gate in middleware and all server actions
- [ ] `/admin` route (gated to super admin only)
- [ ] Admin dashboard:
  - All coaches + CEO count + last active
  - Create coach account (name, email → Neon Auth invite)
  - Disable coach account (soft delete or flag)
- [ ] View-as-coach — super admin navigates to `/admin/coaches/[id]` and sees their full dashboard
- [ ] Super admin can edit any CEO/cycle/report on behalf of a coach

### Deliverable:
EP team can do Wizard-of-Oz support, QA, and account management.

---

## Phase 8 — Polish & Prompt Iteration
**Goal:** Tune AI outputs based on real coach feedback. Polish UX.
**Estimated effort:** 2–3 days (after first real usage)

### Tasks:
- [ ] Cross-cycle pattern observations — pass previous cycle reports into prompt
- [ ] Prompt iteration based on real output review
- [ ] Rate limiting on `/api/generate` (prevent accidental double-generation)
- [ ] Error handling + loading states throughout
- [ ] Empty states (no CEOs, no cycles, no report yet)
- [ ] Mobile layout check
- [ ] Accessibility pass (keyboard nav, ARIA labels on forms)

### Iteration triggers (from SCOPE.v2.md):
- Report tone is off (too generic, too clinical, wrong framework language)
- Sections missing key information that was in the inputs
- Pattern observations are shallow or repeat the Progress Summary
- Suggested next steps are not actionable

### Definition of "good enough":
- Coach reads it and says "I would have written something close to this"
- Coach's edits are refinements, not rewrites
- No section requires complete replacement

---

## File Structure

```
src/
  app/
    (auth)/           # sign-in, sign-up (Neon Auth pages)
    (app)/            # protected routes
      dashboard/      # coach dashboard
      ceos/[id]/      # CEO profile
        cycles/[cycleId]/  # cycle inputs + report
      settings/       # Zoom OAuth connect
      toolkit/        # coach toolkit
      admin/          # super admin only
    api/
      generate/       # AI generation endpoint
      zoom/           # Zoom OAuth callback + transcript pull
  db/
    schema.ts         # Drizzle schema
    index.ts          # DB connection
  lib/
    auth/             # Neon Auth helpers (existing)
    prompts/          # prompt builder
  components/
    ui/               # shadcn/ui components
    layout/           # sidebar, header, theme toggle
    readiness/        # session readiness checklist
    report/           # report view + copy buttons
    action-items/     # action items tracker
```

---

## Environment Variables Needed

```bash
# Existing
NEON_AUTH_BASE_URL=
NEON_AUTH_COOKIE_SECRET=
DATABASE_URL=          # Neon connection string

# Phase 3
ZOOM_CLIENT_ID=
ZOOM_CLIENT_SECRET=
ZOOM_REDIRECT_URI=https://your-domain.com/api/zoom/callback

# Phase 5
ANTHROPIC_API_KEY=
```

---

## How to Pick This Up

1. Read this file + `/product/SCOPE.v2.md` for full context
2. Read `/product/eric-partaker-research.md` for coaching framework context
3. Read `/product/curriculum-seed.md` for the content to seed into the DB
4. Check `src/` for what's already built (auth + basic page)
5. Start with **Phase 0**: install shadcn/ui, set up Drizzle, write schema, push to Neon
6. Work through phases in order — each phase has a clear deliverable

**Current branch:** `fix/zoom-transcripts-env`
Consider branching off: `feat/phase-0-foundation` before starting.
