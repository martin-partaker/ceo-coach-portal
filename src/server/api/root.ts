import { createTRPCRouter, createCallerFactory } from './trpc';
import { coachesRouter } from './routers/coaches';
import { ceosRouter } from './routers/ceos';
import { cyclesRouter } from './routers/cycles';

export const appRouter = createTRPCRouter({
  coaches: coachesRouter,
  ceos: ceosRouter,
  cycles: cyclesRouter,
});

export type AppRouter = typeof appRouter;

export const createCaller = createCallerFactory(appRouter);
