**Major descopes / removed features**

- No editing interface for coaches
- No in‑app editing workflow at all (coach edits externally in docs/email)
- No role‑based access control
- No authentication beyond what’s needed for an internal operator (Wizard‑of‑Oz)
- No US data storage (EU‑only server for now)
- No versioning of reports (no v1/v2 edited storage in MVP, only a question mark about possibly storing edited versions)

**Wizard‑of‑Oz approach**

- Internal team member runs the system, not the coaches:
  - Pulls data from the database
  - Triggers the model
  - Copies the generated report
  - Manually gives it to the coach
- Long‑term automation and editing UIs explicitly pushed to “later version”
- This setup is accepted as “not a good long‑term solution, but fine short term for testing”

**Data inputs & content**

- CEO‑level data over a “month‑like” period (not strictly calendar months):
  - Weekly and monthly qualitative reflections (probably via surveys)
  - Quantitative metrics (from surveys or similar)
  - CEO’s “10x goal”
  - Monthly goals agreed between CEO and coach after their coaching call
  - Transcript of the 1:1 coaching call
  - Program curriculum and frameworks (used as context so the model writes in line with the program)
- Survey tools will likely host many of these inputs (weekly/monthly data, some goals/reflections)
- For some items (10x goal, monthly goals), it’s accepted that the first version might be “manual input” or a simple form/survey

**Zoom vs Fireflies decision**

- Strong preference (from Megan) to use **Zoom Business** for:
  - Centralized, company‑level control and insight into coach calls
  - Cleanliness and consistency of data (all on one platform)
  - Being the standard video tool coaches are used to
- Zoom Business specifics mentioned:
  - Around **$29/seat/month**
  - Has transcripts and summaries available
  - Has an API they think can be used to pull transcripts
- Fireflies:
  - You pointed out possible “team analytics for admins”
  - Megan’s concern is lack of clear org‑level visibility across all coaches
  - They also need an underlying video tool anyway, and prefer Zoom for professionalism and consistency
- Final stance in the call:
  - Use Zoom Business as the baseline
  - Megan will “look back into Fireflies” to see if it makes sense as an extra layer if needed
  - You’re okay with Zoom as long as API access/transcription is workable

**How the MVP is supposed to work (from Megan’s perspective)**

- Internal team member:
  - Has access to the model/tool
  - Pulls all relevant inputs for a given CEO into a database:
    - Survey data (weekly/monthly reflections, quantitative metrics)
    - 10x goal
    - Monthly goals
    - Zoom transcript (or summary)
  - Calls the model for that CEO’s monthly report
  - Stores the generated report alongside the other CEO data
  - Copies the report text into email/doc and gives it to the coach
- Coaches:
  - For MVP, no editing UI, no login
  - Receive reports from the internal team, then:
    - Edit them manually in their own tools
    - Send to CEOs however they already communicate

**Coach/admin data‑entry expectations**

- Megan is okay with:
  - A very simple input flow where coaches or internal staff may have to manually fill a form/survey with:
    - 10x goal
    - Monthly goals
    - Reflections
  - Using a survey form that says “fill this out to get the journal/monthly summary”
- There’s awareness that:
  - Client timelines don’t neatly match calendar months
  - Rhythm is more like:
    - Group calls at fixed times
    - Individual coaching calls at floating times
  - Training will be used to enforce: “after you talk to your CEO, you must fill out this form”

**Storage & region**

- Data stored in EU only for MVP
- US servers explicitly removed from scope for the first version

**Iteration & quality expectations**

- This is framed explicitly as a **test**: “Is it going to work?” and “Can we get good outputs?”
- They expect:
  - Iteration on the model prompts after seeing real outputs
  - You to propose “guardrails for the rounds of iteration and what would count as the MVP being finished”
- Working assumption (discussed):
  - About **2 days total** of iteration time on your side
  - Using outputs from the first ~30 clients as examples of good vs. bad

**Responsibilities / next steps (from Megan’s side)**

- Megan:
  - Think through how to structure “open input” data (10x goal, monthly goals) so it’s not chaotic
  - Potentially coordinate with Nadia by email about data structures and future extensibility
  - Re‑check:
    - Zoom transcripts’ quality
    - Whether an AI notetaker (like Fireflies) should be layered on top
  - Provide:
    - Program curriculum and frameworks
    - Any existing files she already has from her own custom models for curriculum writing
- Future Nadia involvement:
  - Not co‑developing the MVP with you
  - Instead:
    - Give internal perspective on where the product is headed
    - Help think about tech choices that make it easier for her to extend later
    - Potentially handle the “pull from DB and surface to coaches” problem after MVP, if they decide to automate that

**Your commitments that impact scope**

- You will:
  - Send a scope confirmation email (including:
    - Final scoped list
    - High‑end of price range, i.e. ~8k
    - Clarified iteration rounds)
  - Propose explicit iteration boundaries and definition of “MVP finished”
  - Start building as soon as the scope is confirmed and you get:
    - Program curriculum/frameworks
    - Any necessary access/accounts
- You’re open to:
  - Adding a few “nice to haves” if you build faster than expected, but only after the minimal scope is delivered.