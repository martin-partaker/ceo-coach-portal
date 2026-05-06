// NOTE: intentionally NOT `import 'server-only'`. The shared client is
// also imported by `extract-ten-x-goal.ts` which is invoked from a tsx
// backfill script (Node, not Next.js) where the `server-only` shim
// throws. The v2 stage files that import this module DO have their own
// `import 'server-only'` directive, so the client-side import guard is
// preserved at the call sites that need it.
import Anthropic from '@anthropic-ai/sdk';

/**
 * Shared Anthropic client.
 *
 * Default `maxRetries` in the SDK is 2 with short backoff — not enough
 * during sustained `overloaded_error` (HTTP 529) episodes that hit
 * Opus 4.7 during peak US business hours. Bumping to 5 absorbs most
 * transient overloads invisibly.
 *
 * For long streaming calls (the v2 pipeline stages) the SDK's built-in
 * retry only covers the initial request handshake; once a stream is
 * established it doesn't retry mid-stream failures. So those call sites
 * additionally wrap their streams with `streamWithOverloadRetry` below
 * for an explicit overload-only retry-with-backoff at the call level.
 */
export const anthropic = new Anthropic({ maxRetries: 5 });

/** Backoffs between attempts (ms). Five total attempts = these four
 *  delays then a final shot. Cumulative max wait ≈ 30s before the
 *  caller sees a hard failure, which still fits well inside the 300s
 *  function deadline. */
const OVERLOAD_BACKOFFS_MS = [2_000, 4_000, 8_000, 16_000];

/** Anthropic emits HTTP 529 with `type: 'overloaded_error'` when its
 *  inference cluster is at capacity. We detect both — status code is
 *  the canonical signal but we belt-and-suspenders the body type
 *  string in case the SDK ever maps the status differently. */
export function isOverloadError(err: unknown): boolean {
  if (!(err instanceof Anthropic.APIError)) return false;
  if (err.status === 529) return true;
  const body = err.error as
    | { type?: string; error?: { type?: string } }
    | null
    | undefined;
  if (body?.type === 'overloaded_error') return true;
  if (body?.error?.type === 'overloaded_error') return true;
  return false;
}

type StreamParams = Parameters<typeof anthropic.messages.stream>[0];

/**
 * Run `anthropic.messages.stream(params).finalMessage()` with explicit
 * retry on `overloaded_error`. Other errors propagate immediately —
 * we don't want to swallow real bugs (schema validation, rate-limit,
 * auth) by quietly retrying them.
 */
export async function streamWithOverloadRetry(
  params: StreamParams,
  stage: string,
): Promise<Anthropic.Message> {
  const maxAttempts = OVERLOAD_BACKOFFS_MS.length + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await anthropic.messages.stream(params).finalMessage();
    } catch (err) {
      const isLast = attempt === maxAttempts;
      if (isLast || !isOverloadError(err)) throw err;
      const delay = OVERLOAD_BACKOFFS_MS[attempt - 1];
      console.warn(
        `${stage}: Anthropic overloaded (attempt ${attempt}/${maxAttempts}); retrying in ${delay}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  // Unreachable — the loop either returns or throws.
  throw new Error('streamWithOverloadRetry: exhausted attempts unexpectedly');
}
