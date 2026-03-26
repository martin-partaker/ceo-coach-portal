# Architectural Decisions

> Record of key technical decisions and their rationale.

## Template

### Decision: [Title]
- **Date:** YYYY-MM-DD
- **Status:** Accepted / Superseded / Deprecated
- **Context:** What prompted the decision
- **Decision:** What was decided
- **Consequences:** What are the trade-offs
- **Alternatives considered:** What else was evaluated

---

### Decision: Use tRPC for API layer
- **Date:** 2026-03-26
- **Status:** Accepted
- **Context:** Needed a type-safe API layer between Next.js frontend and backend. Direct DB queries in server components work for reads but don't scale well for mutations, client-side data fetching, or shared validation logic.
- **Decision:** Use tRPC v11 with React Query v5, superjson transformer, and Zod validation. Server-side callers for RSC pages, React Query hooks for client components.
- **Consequences:** Full end-to-end type safety from DB schema to UI. Adds `@trpc/server`, `@trpc/client`, `@trpc/react-query`, `@tanstack/react-query`, `superjson` as dependencies. All data access goes through tRPC routers with `protectedProcedure` (auth middleware) and `adminProcedure` (super admin check).
- **Alternatives considered:** Next.js Server Actions (less structured for complex queries), REST API with Route Handlers (no type safety), direct DB in RSC only (no client-side mutations).

### Decision: Geist font family
- **Date:** 2026-03-26
- **Status:** Accepted
- **Context:** Needed a clean, professional font for the coaching portal.
- **Decision:** Geist Sans for interface text, Geist Mono for code/metrics/dates. Loaded via `geist` npm package with Next.js font optimization.
- **Consequences:** Consistent typography across light/dark modes. Small bundle impact (~20KB).
- **Alternatives considered:** Inter (good but less distinctive), system fonts (inconsistent cross-platform).

### Decision: Design system based on shadcn/ui + OKLCH tokens
- **Date:** 2026-03-26
- **Status:** Accepted
- **Context:** Initial UI was unstyled/bare. Needed a comprehensive design system that works in both dark and light modes.
- **Decision:** shadcn/ui (New York style) with Tailwind v4, OKLCH color tokens in CSS variables, zinc/neutral palette, opacity-based semantic colors for status indicators. Design documented in `project-docs/DESIGN.md`.
- **Consequences:** Consistent look and feel. All components are source-owned and customizable. Semantic colors (emerald/blue/amber) used sparingly for status only.
- **Alternatives considered:** Radix Themes (opinionated, less customizable), custom components (too much effort for MVP).
