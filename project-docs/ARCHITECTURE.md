# Architecture

> System overview and data flow for the CEO Coach Portal.

## Overview

Next.js 16 App Router application with a tRPC API layer, Neon Postgres database (Drizzle ORM), and Neon Auth for authentication. Deployed on Vercel.

```
Browser → Next.js App Router → tRPC (HTTP handler at /api/trpc/[trpc])
                              → Drizzle ORM → Neon Postgres (EU, aws-eu-west-2)

Auth: Neon Auth (email/password) → session cookie → tRPC context
```

## Components

### Frontend
- **App Shell:** Sidebar navigation (w-60) + topbar + scrollable content area
- **UI Library:** shadcn/ui (New York style) + Tailwind CSS v4 + Geist fonts
- **Theme:** Dark/light mode via next-themes (class strategy)
- **State:** React Query (via tRPC) for server state, React state for local UI

### API Layer (tRPC v11)
- **Context:** Session + coach resolved per-request in `createTRPCContext`
- **Procedures:** `publicProcedure`, `protectedProcedure` (authenticated + coach row), `adminProcedure` (super admin)
- **Routers:** `coaches`, `ceos`, `cycles` (more in later phases: `reports`, `actionItems`, `curriculum`, `zoom`)
- **Server caller:** `createServerCaller()` for RSC pages (no HTTP round-trip)
- **Client:** `trpc` React hooks with `httpBatchLink` + superjson transformer

### Database (Neon Postgres + Drizzle ORM)
- **Tables:** `coaches`, `ceos`, `cycles`, `action_items`, `reports`, `curriculum`
- **Migrations:** `drizzle-kit push` (no migration files for MVP)
- **Schema:** `src/db/schema.ts` with type exports

### Authentication (Neon Auth)
- Email/password sign-in/up
- Session managed via `@neondatabase/auth`
- Coach row auto-created on first login via `ensureCoach()`
- Self-signup disabled — super admin creates accounts

## Data Flow

### Read (Server Component)
```
RSC page → createServerCaller() → tRPC router → Drizzle query → Neon Postgres
```

### Read (Client Component)
```
useQuery (trpc.xxx.useQuery) → HTTP batch → /api/trpc/[trpc] → tRPC router → Drizzle → Neon
```

### Write (Client Component)
```
useMutation (trpc.xxx.useMutation) → HTTP POST → /api/trpc/[trpc] → tRPC router → Drizzle → Neon
```

## Dependencies

| Service | Purpose | Provider |
|---------|---------|----------|
| Database | Postgres | Neon (EU, aws-eu-west-2) |
| Auth | Email/password | Neon Auth |
| Hosting | Deploy + CDN | Vercel |
| AI | Report generation | OpenAI (GPT) |
| Video | Transcript fetch | Zoom (Server-to-Server OAuth) |
