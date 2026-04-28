import { createTRPCRouter, createCallerFactory } from './trpc';
import { coachesRouter } from './routers/coaches';
import { ceosRouter } from './routers/ceos';
import { cyclesRouter } from './routers/cycles';
import { zoomRouter } from './routers/zoom';
import { actionItemsRouter } from './routers/actionItems';
import { reportsRouter } from './routers/reports';
import { adminRouter } from './routers/admin';
import { inboxRouter } from './routers/inbox';
import { rosterRouter } from './routers/roster';

export const appRouter = createTRPCRouter({
  coaches: coachesRouter,
  ceos: ceosRouter,
  cycles: cyclesRouter,
  zoom: zoomRouter,
  actionItems: actionItemsRouter,
  reports: reportsRouter,
  admin: adminRouter,
  inbox: inboxRouter,
  roster: rosterRouter,
});

export type AppRouter = typeof appRouter;

export const createCaller = createCallerFactory(appRouter);
