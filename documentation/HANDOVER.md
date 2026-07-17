# Handover & Access Checklist

> The list of accounts, secrets, and services to transfer for the internal team to own and maintain the CEO Coach Portal. Work through this at final sign-off. **Nothing here should contain actual secrets** — this is an inventory of *where* they live and *who* needs access.

---

## 1. Accounts & services to transfer

| Service | What it's for | Handover action |
|---------|---------------|-----------------|
| **Vercel** | Hosting, deployments, env vars, logs | Add the client as a team member / transfer project ownership. Confirm they can redeploy. |
| **Neon (Postgres)** | Production database (`ceo-portal`, region `aws-eu-west-2`) | Transfer project to the client's Neon org, or add them as a member. Confirm they hold the connection string. |
| **Neon Auth** | User login (email/password) for coaches/admins | Confirm admin access; document how to add/remove coach logins. |
| **Anthropic (Claude API)** | Report generation (the AI pipeline) | Move billing to the client's Anthropic account and reissue the API key under their org. |
| **Zoom** | Session recording/transcript ingestion | Transfer the app/integration credentials; confirm the recording→ingest webhook still points at the deployment. |
| **Tally** | Intake / goal / weekly-journal forms | Transfer form ownership; confirm the form→ingest webhook URL. |
| **Domain / DNS** | Production URL | Transfer the domain or delegate DNS; confirm the Vercel domain binding. |
| **GitHub (repo)** | Source code | Add the client's engineers; transfer or fork the repo as agreed. |

---

## 2. Environment variables

All secrets are configured as environment variables (never committed — see `CLAUDE.md`). The authoritative list lives in Vercel project settings. At minimum expect:

- `DATABASE_URL` — Neon connection string
- Neon Auth keys
- `ANTHROPIC_API_KEY`
- Zoom integration credentials + webhook secret
- Tally webhook secret

**Action:** pull the full list with `vercel env ls`, confirm each has a value in Production, and reissue any key that was created under the vendor account (Anthropic, Zoom, Tally) so the client owns it.

---

## 3. Verify after handover

Run this smoke test once access has moved:

1. **Log in** to the deployed app with a client admin account.
2. **Add a test CEO** (§3 of the Operator Runbook) and confirm it appears.
3. **Submit a test Tally form** with that CEO's email → confirm it auto-matches (no Triage).
4. **Generate a report** for a cycle with data → confirm it produces a draft and the **Download PDF** works.
5. **Redeploy** from Vercel (trivial change) → confirm the build passes.
6. Confirm **Neon** shows recent activity and the client can open the database.

---

## 4. Where to look when something breaks

- **App errors:** Vercel → project → Logs.
- **Data not showing:** check Triage (unmatched) and the CEO's aliases before assuming a bug.
- **Report generation fails:** Vercel logs will show the Anthropic error (often overload/rate-limit — retry, or check the API key/billing).
- **New docs for engineers:** `project-docs/ARCHITECTURE.md`, `DATA-MODEL.md`, `DECISIONS.md`.
- **Day-to-day operations:** `project-docs/OPERATOR-RUNBOOK.md`.
