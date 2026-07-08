# Infrastructure

> Hosting, database, environment, and deployment details. For the account-transfer checklist see [HANDOVER.md](./HANDOVER.md).

## Environments

| Environment | Where | Notes |
|-------------|-------|-------|
| **Local** | `pnpm dev` → `localhost:3000` | Reads `.env`; connects to the Neon database. |
| **Production** | Vercel | Deployed on push to `main`. |

Preview deployments are created per-branch by Vercel's Git integration (if enabled).

## Hosting — Vercel
- Next.js 16 app, deployed to Vercel.
- **Deploys on push to `main`** via the GitHub integration (confirm in the Vercel dashboard → project → Deployments). Manual deploys: `vercel --prod`.
- Project is linked locally via `.vercel/project.json`.

## Database — Neon Postgres
- Project: **`ceo-portal`**, region **aws-eu-west-2**, Postgres 17.
- ORM: **Drizzle**. Schema is `src/db/schema.ts`; apply changes with `pnpm db:push` (no migration files).
- Additive, nullable columns are safe to push to prod (metadata-only). Anything destructive should be tested on a Neon branch first.
- Connection string lives in `DATABASE_URL`.

## Authentication — Neon Auth
- Email/password. Self-signup is disabled; a super-admin creates coach accounts.
- A coach row is ensured on first login (`ensureCoach()`).

## Environment variables

Configured in Vercel (Production) and locally in `.env`. The authoritative list is in the Vercel project settings — pull it with `vercel env ls`. At minimum:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Neon Postgres connection string |
| *Neon Auth keys* | Authentication (see Neon Auth config) |
| `ANTHROPIC_API_KEY` | Claude — report generation |
| *Zoom credentials* | Server-to-Server OAuth + webhook secret (transcript ingestion) |
| *Tally webhook secret* | Form ingestion (journals, intakes, goal worksheets) |

> **Never commit secrets.** `.env` is gitignored; verify before any commit.

## External services

| Service | Purpose | Notes |
|---------|---------|-------|
| **Vercel** | Hosting, CI/CD, logs | Deploy on push to `main` |
| **Neon** | Postgres + Auth | eu-west-2 |
| **Anthropic (Claude)** | Report generation | `src/lib/anthropic/` |
| **Zoom** | Session transcripts | Server-to-Server OAuth → `raw_inputs` |
| **Tally** | Forms (journals/intakes/goals) | Webhook → `raw_inputs` |

## Monitoring & debugging
- **App logs / errors:** Vercel → project → Logs.
- **Report generation failures:** the Vercel logs surface the Anthropic error (often overload/rate-limit — retry, or check the API key/billing).
- **Data not showing:** check Triage (unmatched inputs) and the CEO's email aliases before assuming a bug (see the Operator Runbook).
- **Database:** the Neon console shows recent activity, query stats, and lets you branch.
