import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { appRouter } from '@/server/api/root';
import { createTRPCContext } from '@/server/api/trpc';

// Vercel function maxDuration. Hobby plan caps at 300s (5min). The v2
// generation pipeline runs after the response is sent via `after()`,
// but still bounded by this value. If the pipeline needs longer than
// 300s in practice (Stage C + 2 revision loops at the upper bound),
// the options are:
//   - upgrade to Pro (raises the cap to 800s)
//   - migrate runGenerationJob to Vercel Workflow (durable, no per-task cap)
//   - drop MAX_REVISIONS in orchestrate.ts from 2 → 1 to fit the budget
export const maxDuration = 300;

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    createContext: () => createTRPCContext({ headers: req.headers }),
  });

export { handler as GET, handler as POST };
