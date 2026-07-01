# Operator Runbook

> A task-oriented guide for the internal team running the CEO Coach Portal day to day. Covers the workflows operators actually perform: adding CEOs, routing incoming data, managing teams, and producing reports. For system architecture see [`ARCHITECTURE.md`](./ARCHITECTURE.md); for the database schema see [`DATA-MODEL.md`](./DATA-MODEL.md).

---

## 1. Core concepts (read this first)

| Term | What it is |
|------|-----------|
| **CEO** | A coaching client. Lives in the `ceos` table. Every CEO has a name, an email, and (usually) an assigned coach. |
| **Coach** | The advisor who runs sessions and sends reports. |
| **Team** | Two or more CEOs coached together (e.g. co-founders). One shared 10x goal, one joint report per month. |
| **Cycle** | One month of coaching for a CEO or team. Reports are generated per cycle. |
| **Weekly journal** | The CEO's weekly Tally check-in (energy/focus/stress/leverage scores + reflections). |
| **Transcript** | A Zoom session recording's text. |
| **Triage / Inbox** | The holding area for incoming data (journals, transcripts) that the system couldn't automatically match to a CEO. |
| **Alias** | An extra email address that routes to a CEO, so their inputs auto-match even when they submit from a different address. |

**Golden rule:** incoming data is matched to a CEO **by email**. Anything without a recognized email lands in Triage for a human to route.

---

## 2. How data gets into the system

Two automated pipelines feed the portal:

1. **Tally forms** (intakes, goal worksheets, weekly journals) → matched by the email on the submission.
2. **Zoom recordings** (session transcripts) → these **do not carry an email**, only speaker names, so they frequently land in Triage and need manual assignment.

When a piece of data can't be matched, it appears in **Triage** with a status of "pending". Your job is to route it.

---

## 3. Add a CEO manually

You do **not** need to wait for a form or transcript to arrive — you can create a CEO at any time.

1. Go to **Admin → CEOs** (`/admin/ceos`).
2. Click **"Add CEO"** (top right).
3. Enter **Name** and **Email** (email is what future inputs match on — get it right). Optionally pick a **Coach** and enter a **10x goal**.
4. Click **Add CEO**.

> **This is the fix for "I only see one of a pair"** — if a company has two CEOs but only one shows up, the second was simply never added. Add them here.

---

## 4. Add an email alias (so future data auto-matches)

If a CEO submits journals from more than one email, add each address as an alias so nothing lands in Triage.

1. **Admin → CEOs** → find the CEO's row.
2. Click the **⋯** menu on the right → **Edit profile**.
3. In the drawer, scroll to **Email aliases**.
4. Type the extra email → **Add**. (The primary email can't be removed; extra aliases can.)

---

## 5. Route a Triage item

When a transcript or form is sitting in Triage:

1. Go to **Admin → Triage / Inbox**.
2. Open the pending item. The system suggests likely CEOs.
3. Click **Match** and pick the correct CEO. The item is assigned and projected into that CEO's cycle.

**If the CEO doesn't exist yet** (e.g. a brand-new group member whose transcript arrived before they were set up):

1. First add them via **§3 Add a CEO** (use the email from the session if you have it).
2. Return to Triage and **Match** the item to the CEO you just created.
3. Add the session email as an **alias** (§4) so their future data auto-routes.

> **Tip:** Zoom transcripts have no email, so expect them in Triage. Adding the speaker's real email as an alias won't auto-match past Zoom items (they never had an email), but it will catch their **Tally** submissions going forward.

---

## 6. Teams

### Form a team
**Admin → Teams → "Form Team"**. Pick two or more CEOs who share the **same coach** and are not already on a team. Their existing months are merged into joint cycles.

### Edit a team
**Teams →** team **⋯ → Edit team**. Here you can change the name, company, shared 10x goal, and each member's role.

### Add or remove a member
In the **Edit team** dialog:
- **Add:** pick an unassigned CEO from the "Add a member…" dropdown → **Add**.
- **Remove:** click the **remove (–person)** icon next to a member.

Removing a member turns them back into a solo CEO and **preserves all their past sessions** as their own solo history.

### Swap a coachee (succession)
Scenario: a program CEO steps into a board role and a new CEO takes over the seat.

1. In **Edit team**, **Add** the new CEO as a member.
2. **Remove** the outgoing CEO.

The outgoing CEO keeps their historical sessions (as solo history), and from now on the team's reports run off the new member's data.

---

## 7. Generate, review, edit, and send a report

1. **Admin → Roster / Cycles** → open the CEO/team's current month.
2. Click **Generate** (choose Instant / Quick / Full depending on how much refinement you want).
3. When the draft appears, **review each section**. Every section has an **edit (pencil) icon** — click it to:
   - **AI refine:** tell the model what to change ("tighten to 3 bullets", "soften the personal note").
   - **Edit raw:** type the exact wording yourself.
4. The **Momentum Check** section shows the month's average energy / focus / stress / highest-leverage scores with stoplight colours (green 8–10, yellow 5–7, red 1–4; stress is reversed), and the prior month when available. These come straight from the weekly journals.
5. **Goal Summary** is derived from the underlying goal data. To change it, edit the CEO's **10x goal** or the cycle's **monthly goals** (in the roster/cycle editors), then regenerate.
6. When it reads well, click **Download PDF**. The PDF is the CEO-facing copy — it does **not** include internal coach/generation metadata.

> **Coach Review Flags** (amber callouts in the on-screen view) are for the coach only. They never appear in the CEO's PDF.

---

## 8. Common issues → first thing to check

| Symptom | Check this first |
|---------|------------------|
| A CEO is missing from a pair | They were never added — **§3 Add a CEO**. |
| A new group member isn't in the list | Same — add them, then route their Triage items (**§5**). |
| A transcript can't be assigned | The CEO doesn't exist yet. Add them, then Match (**§5**). |
| Journals keep landing in Triage | Missing an **alias** for the submission email (**§4**). |
| Momentum Check table is empty | No weekly journals for that month yet, or the journal form didn't capture the 1–10 scores. |
| Report says data is missing | Add the missing inputs (journal/transcript) and regenerate. |

---

## 9. Where things live (quick map)

- **CEOs:** `/admin/ceos` — add, edit profile, aliases, KPIs, 10x goal.
- **Teams:** `/admin/teams` — form, edit, add/remove members, transfer coach, archive.
- **Triage / Inbox:** incoming unmatched data.
- **Roster / Cycles:** monthly cycles, generate & open reports.
- **Report modal:** review, per-section edit, download PDF.
