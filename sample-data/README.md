# Sample data (synthetic)

Everything in this directory is **made up** for development/demo purposes, but shaped to match the patterns in the coaching calls (10X goal validation, constraint-led coaching, momentum journals, action items, session scripts, etc.).

## Directory layout

- `roster/`
  - `coaches.json`: fake coaches + roles (coach vs super_admin)
  - `clients.csv`: fake clients (CEOs) mapped to coaches + metadata
  - `cycles.json`: fake cycle objects with realistic “month-like” labels
- `templates/`
  - Intake + 10X goal worksheet templates (blank + filled examples)
  - Weekly momentum journal templates (blank + filled examples)
  - Email templates (welcome, nudge, post-session recap)
- `toolkit/`
  - Session 1 checklist/script + question banks
- `curriculum/`
  - `curriculum.md`: synthetic “framework” content used as LLM context
- `examples/`
  - Example generated outputs (good / average / bad) for different client archetypes
- `transcripts/`
  - Short synthetic `.vtt` snippets (not real client data)

## Notes

- Do not treat these as factual. They are safe placeholders to unblock implementation.
- Keep generated demo outputs deterministic where possible (e.g., fixed dates, stable IDs) so UI tests don’t churn.

