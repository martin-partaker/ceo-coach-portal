import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { appRouter } from '@/server/api/root';
import { createTRPCContext } from '@/server/api/trpc';

// Vercel function maxDuration. The v2 generation pipeline used to run
// after the response was sent via `after()` and was bounded by this
// value, which made worst-case runs (Stage C + revision loops) hit the
// wall and freeze the job row. The pipeline is now a Vercel Workflow
// — each stage runs in its own function invocation with its own
// budget, so this cap only governs the synchronous tRPC handler itself
// (cheap work). 300s is a comfortable headroom for everything that's
// left.
export const maxDuration = 300;

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    createContext: () => createTRPCContext({ headers: req.headers }),
  });

export { handler as GET, handler as POST };
