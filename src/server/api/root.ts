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
import { teamsRouter } from './routers/teams';
import { auditRouter } from './routers/audit';

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
  teams: teamsRouter,
  audit: auditRouter,
});

export type AppRouter = typeof appRouter;

export const createCaller = createCallerFactory(appRouter);
