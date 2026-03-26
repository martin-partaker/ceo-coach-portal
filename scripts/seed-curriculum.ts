/**
 * Seed the curriculum table with Eric Partaker's coaching framework content.
 * Run: pnpm seed:curriculum
 *
 * Based on: /product/curriculum-seed.md
 * This content powers the AI system prompt for report generation.
 */
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { curriculum } from '../src/db/schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql);

const seeds = [
  {
    title: 'The IPA Framework — Identity, Productivity, Antifragility',
    contentText: `The IPA Framework is the foundation of the CEO coaching program. It operates across three pillars:

**Identity** — Sustainable high performance begins with identity, not behavior. Before changing what you do, clarify who you are being. The question is not "What do I need to do?" but "Who do I need to become to achieve this?" Identity drives behavior automatically. When a CEO defines themselves as a world-class leader who ships commitments and shows up with clarity, their daily decisions align accordingly.

**Productivity** — High output comes from planning and consistent execution, not from effort or hours alone. "What gets scheduled gets done." The goal is an Olympic-standard week: every key priority has a dedicated time block. The Olympic Day Planner approach: identify your one most important output for the day, block time for it, protect that block.

**Antifragility** — Resilience is not enough. World-class CEOs become stronger under pressure. Antifragility means stepping into hard conversations, making decisions with incomplete information, and maintaining standards when it would be easier to compromise. Champion proofs — small daily non-negotiable actions — build antifragility over time.

In coaching sessions: Always anchor feedback and next steps to one of the three pillars. A missed commitment is an identity question. A chaotic week is a productivity question. An avoided conversation is an antifragility question.`,
    sortOrder: 1,
  },
  {
    title: 'The 10x Goal — Setting and Tracking the North Star',
    contentText: `The 10x Goal is the CEO's defining long-term ambition — the outcome that would represent a non-linear leap in the business or their leadership. It is not a 10% improvement. It requires fundamentally different thinking, different constraints, and different identity.

**Setting the 10x Goal:**
- Ask: "What would it look like to achieve 10x my current result in [revenue / impact / team / product]?"
- Ask: "What would have to be true for that to happen?"
- Ask: "What is the single biggest constraint preventing that outcome right now?"
- The goal should be compelling, specific, and slightly scary.

**Tracking the 10x Goal:**
- The 10x goal is set once and revisited — not changed every month
- Monthly cycles are measured against progress toward the 10x goal
- The question is not "Did you hit your monthly target?" but "Did this month move you materially toward your 10x goal?"

**Key questions:**
- "What's the highest-leverage action this month toward your 10x?"
- "What constraint, if removed, would most accelerate progress?"
- "Are you working on your 10x, or are you managing the business?"`,
    sortOrder: 2,
  },
  {
    title: 'The Monthly Coaching Cycle — Commitments, Progress, and Next Steps',
    contentText: `Each coaching cycle is structured around a rhythm of commitment and accountability. The cycle is not strictly a calendar month — it is the period between coaching sessions.

**Start of cycle:** Coach and CEO agree on 3–5 specific commitments for the cycle. Commitments are:
- Specific (not vague goals)
- Owned by CEO (not "the team will do X")
- Connected to the 10x goal or a clear constraint
- Written down and visible

**During cycle:** Weekly momentum journals — brief reflections capturing:
- What moved forward this week?
- What got in the way?
- What did I learn or decide?
- What's the one most important thing for next week?

**End of cycle:** Monthly reflection covering:
- Which commitments were kept? Which were not, and why?
- What patterns emerged?
- What surprised me?
- What am I most proud of?
- What do I want to do differently next cycle?

**Coaching session:** Use transcript + journals + reflection to generate the coaching summary and next cycle commitments.`,
    sortOrder: 3,
  },
  {
    title: 'The 3 Life Domains — Health, Wealth, Relationships',
    contentText: `Sustainable high performance requires balance across three domains. A CEO who is winning at work but losing at health or relationships is not operating at their best — it always catches up.

**Health:** Physical energy is the foundation of cognitive performance. Sleep, exercise, and stress management are not optional extras. The CEO's most important asset is their mind, and the mind runs on the body.

Key coaching questions:
- "Are you sleeping enough to make great decisions?"
- "Is your energy level supporting or undermining your performance this cycle?"

**Wealth (Work):** This is the primary focus of the CEO coaching program — building the company, developing as a leader, and performing at the highest level professionally.

**Relationships:** The CEO cannot scale a team if their close relationships are depleted. Family, key partners, and trusted advisors all require intentional investment.

In coaching: Monthly summaries acknowledge all three domains. Ask about health and relationships at least once per cycle.`,
    sortOrder: 4,
  },
  {
    title: 'Identity-Based Change — Becoming the CEO Your Company Needs',
    contentText: `Eric Partaker's core insight: behavior change is hard. Identity change is where sustainable performance begins.

**The identity question:** "Who do you need to be — consistently — to achieve your 10x goal?"

**The process:**
1. Define your "best self CEO" — the version of you operating at your highest level
2. Identify 3 words describing how that version of you behaves (e.g., decisive, clear, courageous)
3. Set one daily champion proof — a single non-negotiable action that proves you are being that version of yourself
4. When you act inconsistently with your identity, ask: "Would my best-self CEO do this?"

**Common CEO identity gaps:**
- The expert who hasn't yet become a leader (still solving problems rather than building the team)
- The founder who hasn't yet become a CEO (still doing, not setting direction)
- The high performer who hasn't yet built recovery into their identity (burning out)

**Coaching language:** Use "who you're becoming" not "what you need to do." Frame feedback as identity observations, not behavioral criticism.`,
    sortOrder: 5,
  },
  {
    title: 'Accountability — The Commitment Loop',
    contentText: `Accountability is not about pressure — it is about creating a system where commitments are taken seriously and learning is extracted from every outcome.

**The commitment loop:**
1. Commit — Specific, written, owned
2. Act — Execute during the cycle
3. Review — What happened? What did you learn?
4. Recommit — What do you commit to next?

**Rules for strong commitments:**
- One owner (never "we will")
- Observable outcome (not "improve communication" — "hold weekly 1:1 with each direct report")
- Connected to a constraint or the 10x goal

**When commitments are missed:**
Do not gloss over missed commitments. Common patterns:
- Overcommitting (too many commitments each cycle)
- External constraint not identified in advance
- Identity gap — the commitment required a version of the CEO they weren't yet being

**Key questions:**
- "What did you commit to last cycle?"
- "What happened — and what does that tell you?"
- "What's the most important commitment for this cycle?"`,
    sortOrder: 6,
  },
  {
    title: 'Finding and Removing Constraints',
    contentText: `At any given time, there is one bottleneck limiting progress toward the 10x goal. Identifying and removing that constraint is the highest-leverage action available.

**Constraint identification questions:**
- "What is the single biggest thing preventing you from hitting your 10x goal?"
- "If you could wave a magic wand and remove one obstacle, what would it be?"
- "What problem, if solved, would make all other problems easier or irrelevant?"
- "Is the constraint in the market, the product, the team, or you?"

**Common CEO constraints:**
- Hiring (the right people aren't in the right seats)
- Clarity (the strategy isn't clear enough for the team to execute without the CEO)
- Energy (the CEO is the bottleneck because they're depleted or overloaded)
- Market fit (the product/service isn't differentiated enough to scale)
- Cash (capital constraints limiting investment in the right areas)

The monthly summary should always name the primary constraint operating in that cycle. Suggested next steps should address the constraint directly.`,
    sortOrder: 7,
  },
  {
    title: 'First Coaching Session — Onboarding Checklist',
    contentText: `The first session with a new CEO sets the tone for the entire coaching relationship. Cover the following:

1. **10x Goal** — Define or refine the CEO's 10x goal. Make it specific, compelling, and slightly scary. Write it down.

2. **Current reality** — Where are they now? Key metrics, team state, personal energy, biggest wins, biggest frustrations.

3. **Primary constraint** — What is the single biggest obstacle to their 10x goal right now?

4. **Identity declaration** — Who do they need to become to achieve the 10x? What 3 words describe their "best self CEO"?

5. **First commitments** — What 3–5 specific commitments will they make for the first cycle?

6. **Rhythm** — Agree on the weekly journal cadence, monthly reflection, and session frequency.

7. **Coaching agreement** — Set expectations: sessions are for accountability, honesty, and forward momentum.`,
    sortOrder: 8,
  },
  {
    title: 'Coaching Question Bank',
    contentText: `**Goal Clarity:**
- "If you achieved your 10x goal, what would be different about your business? Your life?"
- "Is your 10x goal pulling you forward, or does it feel like pressure?"
- "What would have to be true for you to achieve 10x in 3 years?"

**Constraint Identification:**
- "What's the one thing, if removed, that would make everything else easier?"
- "Where is the bottleneck — market, product, team, or you?"
- "What are you tolerating that you shouldn't be?"

**Product / Market / Delivery:**
- "Is the problem you're solving clear enough that your team could explain it without you?"
- "What's your most differentiated offering — and are you doubling down on it?"
- "What would make your delivery 10x faster or cheaper without sacrificing quality?"

**Commitments and Follow-ups:**
- "What did you commit to last session — what happened?"
- "What's the single most important commitment you'll make this cycle?"
- "What will get in the way, and how will you handle it?"

**Leadership Development:**
- "Are you building a team that can operate without you, or are you still the bottleneck?"
- "What conversation are you avoiding — and what would happen if you had it?"
- "What does your team need from you right now that you're not giving them?"

**Personal Performance:**
- "What's your energy level this cycle — and what's driving that?"
- "Are you spending time on your highest-leverage activities, or are you in the weeds?"
- "What would you tell your past self to stop doing?"`,
    sortOrder: 9,
  },
];

async function main() {
  console.log('Seeding curriculum...');

  for (const seed of seeds) {
    await db.insert(curriculum).values(seed).onConflictDoNothing();
  }

  console.log(`✓ Seeded ${seeds.length} curriculum rows`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
