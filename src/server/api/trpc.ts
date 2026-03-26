import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import { ZodError } from 'zod';
import { auth } from '@/lib/auth/server';
import { db } from '@/db';
import { coaches } from '@/db/schema';
import { eq } from 'drizzle-orm';
import type { Coach } from '@/db/schema';

export const IMPERSONATE_COOKIE = 'impersonate_coach_id';

export const createTRPCContext = async (opts: { headers: Headers }) => {
  const { data: session } = await auth.getSession();

  let coach: Coach | null = null;
  let realCoach: Coach | null = null;
  let isImpersonating = false;

  if (session?.user) {
    const results = await db
      .select()
      .from(coaches)
      .where(eq(coaches.neonAuthUserId, session.user.id))
      .limit(1);
    realCoach = results[0] ?? null;
    coach = realCoach;

    // Check for impersonation cookie (super admin only)
    if (realCoach?.isSuperAdmin) {
      const cookieHeader = opts.headers.get('cookie') ?? '';
      const match = cookieHeader.match(new RegExp(`${IMPERSONATE_COOKIE}=([^;]+)`));
      if (match) {
        const impersonateId = match[1];
        const [impersonated] = await db
          .select()
          .from(coaches)
          .where(eq(coaches.id, impersonateId))
          .limit(1);
        if (impersonated) {
          coach = impersonated;
          isImpersonating = true;
        }
      }
    }
  }

  return { db, session, coach, realCoach, isImpersonating };
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

/** Requires is_super_admin = true (checks REAL coach, not impersonated) */
export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  const real = ctx.realCoach ?? ctx.coach;
  if (!real.isSuperAdmin) {
    throw new TRPCError({ code: 'FORBIDDEN' });
  }
  return next({ ctx: { ...ctx, coach: real } });
});
