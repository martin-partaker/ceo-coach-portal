/**
 * Load the audit JSON produced by `tool/make_audit_json.py` into
 * `transcript_audits`.
 *
 *   DATABASE_URL=<branch> pnpm tsx scripts/import-audits.ts --in audits.json [--apply]
 *
 * Dry run by default. Three things are refused rather than written, because
 * each would put something on screen that looks like a verdict and is not:
 *
 *  - a contract version this app does not know;
 *  - an audit whose `contentSha256` no longer matches the stored transcript,
 *    since every quote is a line index into that exact text and a changed
 *    transcript moves the lines;
 *  - a quote pointing past the end of the transcript.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import {
  AUDIT_CONTRACT_VERSION,
  isAuditResult,
  type AuditResult,
} from '../src/lib/audit/contract';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const inPath = (() => {
  const i = args.indexOf('--in');
  return i >= 0 && args[i + 1] ? args[i + 1] : 'audits.json';
})();

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('set DATABASE_URL');
  const sql = neon(process.env.DATABASE_URL);

  const parsed: unknown = JSON.parse(readFileSync(inPath, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${inPath} is not a JSON array`);

  const stored = (await sql`
    SELECT id, content FROM transcripts
  `) as unknown as { id: string; content: string }[];
  const contentById = new Map(stored.map((r) => [r.id, r.content]));

  const ready: AuditResult[] = [];
  const rejected: { transcriptId: unknown; why: string }[] = [];

  for (const a of parsed) {
    if (!isAuditResult(a)) {
      rejected.push({
        transcriptId: (a as { transcriptId?: unknown })?.transcriptId,
        why:
          `not a contract v${AUDIT_CONTRACT_VERSION} audit — regenerate with a ` +
          'matching exporter rather than loading it',
      });
      continue;
    }
    const content = contentById.get(a.transcriptId);
    if (content === undefined) {
      rejected.push({ transcriptId: a.transcriptId, why: 'no such transcript' });
      continue;
    }
    const sha = createHash('sha256').update(content, 'utf8').digest('hex');
    if (sha !== a.contentSha256) {
      rejected.push({
        transcriptId: a.transcriptId,
        why: 'transcript content changed since the audit ran — every line index is stale',
      });
      continue;
    }
    // An undetermined session cannot carry verdicts: we do not know which
    // outline it should be judged against. The exporter had this backwards once
    // — a null session number fell back to 1 and all 44 candidates were audited
    // instead of the 30 we can place — so the invariant is enforced here too,
    // where it guards the database rather than one script.
    if (
      a.sessionConfidence === 'undetermined' &&
      (a.findings.length > 0 || a.familiesExamined.length > 0)
    ) {
      rejected.push({
        transcriptId: a.transcriptId,
        why:
          `session undetermined but carries ${a.findings.length} finding(s) and ` +
          `${a.familiesExamined.length} examined family(ies) — it was judged ` +
          'against an outline we cannot show it belongs to',
      });
      continue;
    }
    if (a.sessionConfidence !== 'undetermined' && a.familiesExamined.length === 0) {
      rejected.push({
        transcriptId: a.transcriptId,
        why: `session ${a.sessionConfidence} but no family was examined`,
      });
      continue;
    }

    const lineCount = content.split('\n').length;
    const bad = a.findings.flatMap((f) =>
      f.evidence.filter(
        (e) =>
          e.line < 0 ||
          e.line >= lineCount ||
          (e.lineEnd !== undefined && (e.lineEnd < e.line || e.lineEnd >= lineCount)),
      ),
    );
    if (bad.length) {
      rejected.push({
        transcriptId: a.transcriptId,
        why: `${bad.length} quote(s) point past the transcript's ${lineCount} lines`,
      });
      continue;
    }
    ready.push(a);
  }

  const counts = (a: AuditResult) => ({
    concern: a.findings.filter((f) => f.verdict === 'concern').length,
    review: a.findings.filter((f) => f.verdict === 'review').length,
    notAssessed: a.findings.filter((f) => f.notAssessed).length,
  });

  console.log(`${parsed.length} audits in ${inPath}`);
  console.log(`  ${ready.length} ready`);
  console.log(`  ${rejected.length} rejected`);
  for (const r of rejected.slice(0, 10)) {
    console.log(`    ${String(r.transcriptId).slice(0, 8)}… ${r.why}`);
  }
  if (rejected.length > 10) console.log(`    …and ${rejected.length - 10} more`);

  const tiers = ready.reduce<Record<string, number>>((acc, a) => {
    acc[a.sessionConfidence] = (acc[a.sessionConfidence] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`  tiers: ${JSON.stringify(tiers)}`);
  const tot = ready.reduce(
    (acc, a) => {
      const c = counts(a);
      return {
        concern: acc.concern + c.concern,
        review: acc.review + c.review,
        notAssessed: acc.notAssessed + c.notAssessed,
        quotes: acc.quotes + a.findings.reduce((n, f) => n + f.evidence.length, 0),
      };
    },
    { concern: 0, review: 0, notAssessed: 0, quotes: 0 },
  );
  console.log(
    `  findings: ${tot.concern} concern · ${tot.review} review · ` +
      `${tot.notAssessed} not assessed · ${tot.quotes} quote pointers`,
  );

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write.');
    return;
  }

  let written = 0;
  for (const a of ready) {
    const c = counts(a);
    await sql`
      INSERT INTO transcript_audits (
        transcript_id, contract_version, criteria_version, session_no,
        session_confidence, session_confidence_reason, content_sha256,
        result_json, concern_count, review_count, not_assessed_count
      ) VALUES (
        ${a.transcriptId}, ${a.contractVersion}, ${a.criteriaVersion},
        ${a.sessionNo}, ${a.sessionConfidence}, ${a.sessionConfidenceReason},
        ${a.contentSha256}, ${JSON.stringify(a)}::jsonb,
        ${c.concern}, ${c.review}, ${c.notAssessed}
      )
    `;
    written++;
  }
  console.log(`\n${written} audits written.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
