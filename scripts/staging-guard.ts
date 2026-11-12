/**
 * Refuse to run against anything but the staging database.
 *
 * For scripts that hold live Zoom or Tally credentials. Those credentials are
 * deliberately absent from the staging deployment on Vercel, so that nothing
 * and nobody can start a sync from the app; they exist only in a local env
 * file, and these scripts are the one way they get used. The guard makes sure
 * such a script cannot be pointed at production by a stale shell variable or
 * the repo's own `.env`.
 *
 * Identified by the compute endpoint, which is fixed for the life of the
 * branch. A reset from production keeps the endpoint, so this survives one.
 */
const STAGING_ENDPOINT = 'ep-tiny-boat-ab23p6vt';

export function assertStagingDatabase(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error('DATABASE_URL is not a URL — was a placeholder pasted literally?');
  }
  if (!host.startsWith(STAGING_ENDPOINT)) {
    throw new Error(
      `Refusing to run: DATABASE_URL points at ${host}, not the staging endpoint ` +
        `(${STAGING_ENDPOINT}). Load .env.staging first.`,
    );
  }
  return host;
}

/** A value copied from `.env.example` is not a credential. */
export function assertRealSecret(name: string): void {
  const v = process.env[name];
  if (!v || /xxx|your[-_ ]|changeme|placeholder|<[^>]+>/i.test(v)) {
    throw new Error(
      `${name} is missing or still a placeholder. Add the real value to .env.staging.`,
    );
  }
}
