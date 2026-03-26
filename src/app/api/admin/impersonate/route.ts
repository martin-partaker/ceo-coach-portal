import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/server';
import { db } from '@/db';
import { coaches } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { IMPERSONATE_COOKIE } from '@/server/api/trpc';

export async function POST(req: Request) {
  const { data: session } = await auth.getSession();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Verify the real user is a super admin
  const [realCoach] = await db
    .select()
    .from(coaches)
    .where(eq(coaches.neonAuthUserId, session.user.id))
    .limit(1);

  if (!realCoach?.isSuperAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { coachId } = await req.json();

  // Verify target coach exists
  const [target] = await db
    .select()
    .from(coaches)
    .where(eq(coaches.id, coachId))
    .limit(1);

  if (!target) {
    return NextResponse.json({ error: 'Coach not found' }, { status: 404 });
  }

  const response = NextResponse.json({ success: true, coach: target });
  response.cookies.set(IMPERSONATE_COOKIE, coachId, {
    path: '/',
    httpOnly: false, // needs to be readable by client for UI
    sameSite: 'lax',
    maxAge: 60 * 60 * 4, // 4 hours
  });

  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ success: true });
  response.cookies.delete(IMPERSONATE_COOKIE);
  return response;
}
