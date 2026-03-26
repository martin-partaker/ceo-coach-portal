import { createTRPCRouter, createCallerFactory } from './trpc';
import { coachesRouter } from './routers/coaches';
import { ceosRouter } from './routers/ceos';
import { cyclesRouter } from './routers/cycles';
import { zoomRouter } from './routers/zoom';

export const appRouter = createTRPCRouter({
  coaches: coachesRouter,
  ceos: ceosRouter,
  cycles: cyclesRouter,
  zoom: zoomRouter,
});

export type AppRouter = typeof appRouter;

export const createCaller = createCallerFactory(appRouter);
