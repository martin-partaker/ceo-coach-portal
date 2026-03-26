import 'server-only';
import { headers } from 'next/headers';
import { createCaller } from '@/server/api/root';
import { createTRPCContext } from '@/server/api/trpc';

export async function createServerCaller() {
  const hdrs = await headers();
  const ctx = await createTRPCContext({ headers: hdrs });
  return createCaller(ctx);
}
