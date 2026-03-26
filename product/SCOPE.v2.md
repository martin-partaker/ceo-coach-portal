# CEO Coaching Journal — Scope v2 (Coach-operated)

> Last updated: 2026-03-17
> Status: Draft v2 — aligned to coach onboarding + coaching operations

---

## 1. What This Is

An internal web application for executive coaches to manage their CEO coachees, collect cycle inputs (weekly + monthly), and generate AI-powered coaching summaries and next-step plans. The tool is operated directly by coaches. EP team members can intervene via a super-admin account (see §2.1).

**This is a test.** The goal is to validate that the AI can produce useful, high-quality coaching summaries before investing in a full platform. Expect prompt iteration after seeing real outputs.

---

## 2. Users

| Role | Description | Auth |
|---|---|---|
| **Coach** | Manages CEOs, captures inputs, triggers outputs, copies/exports for delivery | Neon Auth |
| **EP Super Admin** | Can view/act as any coach (setup, QA, Wizard-of-Oz support) | Neon Auth |

**No CEO-facing interface in MVP.** CEOs receive their summaries via the coach's existing communication channel (email/doc).

### 2.1 Super Admin ("Wizard-of-Oz") support

- Super Admin can:
  - View all coaches and their CEOs
  - Create/disable coach accounts
  - Access any CEO/cycle and trigger generation
  - Fix/complete missing inputs on behalf of a coach
- Super Admin is **not** a separate UI for the MVP; it’s the same app with elevated permissions.

---

## 3. Core User Flow

```
Coach logs in
  → Selects a CEO from their list
  → Creates or selects the current cycle (not strictly calendar months)
  → Completes a "Session readiness" checklist (see §4.3)
  → Enters / updates inputs for the current cycle:
      - 10x goal (set once, editable)
      - Monthly goals / commitments (per cycle)
      - Weekly momentum journals × up to 5 (pasted in)
      - Monthly reflection (pasted in)
      - Zoom transcript (pulled via Zoom API)
      - Action items / commitments (captured + tracked)
  → Triggers AI generation
  → Reviews generated outputs
  → Copies formatted output text
  → Pastes into email → sends to CEO
```

NOTES:
It is important for us to ensure the UX itself is value adding. We can't assume cooperation completely from the coach; they may skip steps, go too quickly, or be inconsistent. The goal is to add value above normal usage of tools such as ChatGPT by enforcing completeness, consistency, and re-use of prior context. Think todo checklist of context gathering before generating any template etc

---

## 4. Features In Scope

### 4.1 Coach Dashboard
- List of all the coach's CEOs
- Status indicator per CEO: cycle in progress / ready to generate / generated
- Link to each CEO's data + latest cycle view
- Fast "what's missing" visibility

### 4.2 CEO Profile & Data Entry
- Create / manage CEO profile (name, email)
- Persistent fields:
  - 10x goal (set once, editable any time)
- Per-cycle fields (grouped by month/cycle):
  - Cycle label (not necessarily calendar months)
  - Monthly goals / commitments
  - Weekly momentum journals (up to 5 free-text fields)
  - Monthly reflection (free-text)
  - Zoom transcript (auto-pulled or manually confirmed — see §4.6)
  - Action items / commitments (see §4.4)

### 4.3 Session readiness checklist (guardrail UX)

Before generation, the system shows a checklist with:
- 10x goal present (and last updated date)
- Monthly goals/commitments present
- Weekly momentum journals present (or marked "missing")
- Transcript attached (or explicitly marked "no transcript this cycle")
- Previous cycle action items reviewed (checkbox)

Coach can still generate if incomplete, but incomplete items are clearly flagged in the prompt and the output.

### 4.4 Action items / commitments tracker

- Action items belong to a cycle and include:
  - owner (CEO / Coach / Other)
  - description
  - due date (optional)
  - status (open / done / dropped)
- Action items can be:
  - Entered manually by coach
  - Suggested by the AI from transcript + journals, then **confirmed by coach** (no auto-creating without review)
- Generation output includes:
  - Open action items carried forward
  - New action items suggested for the next cycle

### 4.5 Coach toolkit (lightweight, in-app)

To reduce coach anxiety and enforce consistency:
- Session 1 checklist (3–7 bullets)
- Question bank by stage:
  - validate 10x goal
  - identify constraints
  - product / market / delivery framing
  - commitments and follow-ups
- Templates:
  - “missing weekly journal” nudge
  - “post-session recap + commitments” template

This is not a learning platform; it’s quick reference.

### 4.6 Zoom Integration
- Coach connects their Zoom account via OAuth (one-time setup)
- Per CEO cycle: system lists recent Zoom meetings from the coach's account
- Coach selects the relevant meeting → transcript is pulled and stored
- Transcript attached to that CEO's cycle inputs

### 4.7 Generation outputs (v2)

Per CEO per cycle, generate:
1. **Coach-ready summary** (copy/paste)
2. **Commitments recap** (what was agreed, what’s open, what’s next)
3. **Pattern observations** (cross-cycle, if prior cycles exist)
4. **Suggested next steps** (prioritized, aligned to framework)

### 4.8 Report View & Export
- Coach views the generated outputs in-app
- Output is formatted as clean, copy-pasteable text (structured for email)
- No PDF generation in MVP — plain text copy is sufficient

### 4.9 Auth & permissions
- Neon Auth for authentication
- Each coach gets an individual account
- Coaches only see their own CEOs
- EP Super Admin can access all coaches/CEOs (see §2.1)

---

## 5. Report Structure (AI Output)

Generated once per CEO per cycle. Six sections:

1. **Progress Summary** — movement toward 10x goal and monthly goals; concrete changes and decisions; where progress has not been made
2. **Key Wins** — clear, outcome-oriented highlights from the month
3. **Challenges & Constraints** — framed neutrally and constructively
4. **Pattern Observations** — repeated behaviors, bottlenecks, or mindset themes across this month and prior months
5. **Suggested Next Steps** — actionable, prioritized, explicitly aligned with the coaching framework; includes note to discuss at monthly session
6. **Suggested Resources** — curriculum modules or internal resources relevant to the next steps

**Tone:** Professional, reflective, coach-aligned. No diagnostic, therapeutic, legal, or medical language.

---

## 6. AI / Model

- **Model:** LLM API (configurable). Default to Claude Sonnet for production-quality writing.
- **Data privacy:** API-only, no training data sharing. Zero-data-retention where available.
- **Region:** EU (API calls routed via EU endpoints where available)
- **Context:** Program curriculum/frameworks loaded as static system prompt context
- **Curriculum format:** Plain text stored directly in the database at setup; no file storage
- **Guardrails baked into prompt:**
  - Stay within the 10x coaching framework
  - No diagnostic or therapeutic language
  - No legal, medical, or mental health claims
  - Professional and reflective tone

---

## 7. Data Architecture

### 7.1 Database: Neon Postgres (EU region)

```
coaches
  id, neon_auth_user_id, name, email, zoom_oauth_token

ceos
  id, coach_id, name, email, ten_x_goal, created_at

cycles
  id, ceo_id, label (e.g. "Apr 10 → May 10"), period_start, period_end
  monthly_goals, weekly_journal_1..5, monthly_reflection
  zoom_transcript, zoom_meeting_id
  created_at

action_items
  id, cycle_id, owner, item, due_at, status, created_at

reports
  id, cycle_id, generated_at
  content_json (6 sections stored as structured JSON)
  raw_text (copy-paste version)
  model_used, prompt_version

curriculum
  id, title, content_text, created_at
```

### 7.2 Data per CEO ("silo")
Each CEO has an isolated record: their profile, all cycles, all inputs, all generated reports. Coaches only see their own CEOs.

---

## 8. Tech Stack

| Layer | Technology |
|---|---|
| Frontend + Backend | Next.js 14 (App Router), TypeScript |
| Database | Neon Postgres (EU), Drizzle ORM |
| Auth | Neon Auth |
| AI | LLM API (Claude Sonnet default; configurable) |
| Zoom | Zoom OAuth + Meetings API |
| Deployment | Vercel (EU edge) |
| Package manager | pnpm |

---

## 9. Explicitly Out of Scope (MVP)

| Feature | Notes |
|---|---|
| CEO-facing interface | Later — CEOs receive reports via coach email |
| In-app report editing | Coach edits in their own tools after copy-paste |
| Report versioning (draft vs. approved) | Later |
| Fine-grained RBAC | Only two roles in v2: Coach + Super Admin |
| US data storage | EU-only for MVP |
| PDF generation | Plain text copy is sufficient |
| File storage (S3 etc.) | All data stored in Neon Postgres |
| Fireflies integration | Revisit if Zoom transcripts prove insufficient |
| Automated survey ingestion | Coach pastes journals/reflections manually |
| CEO-to-coach direct messaging | Out of scope entirely |
| Aggregated admin dashboards | Later |

---

## 10. Iteration Plan

**Definition of MVP done:** The system reliably generates a well-structured, on-framework cycle summary for a real CEO using real data, and a coach can complete readiness + generate + copy it into an email within 5 minutes.

**Iteration budget:** ~2 days on prompt refinement after seeing real outputs from the first cohort (~30 CEOs).

**Iteration triggers:**
- Report tone is off (too generic, too clinical, wrong framework language)
- Sections are missing key information that was in the inputs
- Pattern observations are shallow or repeat the same point as progress summary
- Suggested next steps are not actionable

**What "good enough" looks like:**
- Coach reads it and says "I would have written something close to this"
- Coach's edits are refinements, not rewrites
- No section requires complete replacement

---

## 11. Infrastructure Costs (Monthly)

| Service | Cost |
|---|---|
| Vercel (Pro, EU) | ~$50/month |
| Neon (EU, Scale) | ~$100/month |
| Claude API | ~$100/month (variable, scales with usage) |
| Zoom Business | ~$29/seat/month per coach |
| **Total (excl. Zoom)** | **~$250/month** |
| **Total (incl. 5 coaches)** | **~$395/month** |

Infrastructure costs (non-LLM) stay flat as CEO count grows. LLM costs scale linearly with report volume.

