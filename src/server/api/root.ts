import { createTRPCRouter, createCallerFactory } from './trpc';
import { coachesRouter } from './routers/coaches';
import { ceosRouter } from './routers/ceos';
import { cyclesRouter } from './routers/cycles';
import { zoomRouter } from './routers/zoom';
import { actionItemsRouter } from './routers/actionItems';
import { reportsRouter } from './routers/reports';

export const appRouter = createTRPCRouter({
  coaches: coachesRouter,
  ceos: ceosRouter,
  cycles: cyclesRouter,
  zoom: zoomRouter,
  actionItems: actionItemsRouter,
  reports: reportsRouter,
});

export type AppRouter = typeof appRouter;

export const createCaller = createCallerFactory(appRouter);
