import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import { ZodError } from 'zod';
import { auth } from '@/lib/auth/server';
import { db } from '@/db';
import { coaches } from '@/db/schema';
import { eq } from 'drizzle-orm';
import type { Coach } from '@/db/schema';

export const createTRPCContext = async (opts: { headers: Headers }) => {
  const { data: session } = await auth.getSession();

  let coach: Coach | null = null;
  if (session?.user) {
    const results = await db
      .select()
      .from(coaches)
      .where(eq(coaches.neonAuthUserId, session.user.id))
      .limit(1);
    coach = results[0] ?? null;
  }

  return { db, session, coach };
};

type Context = Awaited<ReturnType<typeof createTRPCContext>>;

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

export const createTRPCRouter = t.router;
export const createCallerFactory = t.createCallerFactory;
export const publicProcedure = t.procedure;

/** Requires a valid session + a coaches row */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session?.user || !ctx.coach) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }
  return next({
    ctx: {
      ...ctx,
      session: ctx.session,
      coach: ctx.coach,
    },
  });
});

/** Requires is_super_admin = true */
export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (!ctx.coach.isSuperAdmin) {
    throw new TRPCError({ code: 'FORBIDDEN' });
  }
  return next({ ctx });
});
