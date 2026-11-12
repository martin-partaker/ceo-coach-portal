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

  const inThisFile = new Set<string>();
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
    // One recording, one audit per run. Two CEOs coached together share a
    // first transcript, and the exporter once emitted it twice with two
    // different session confidences; which one the list showed was down to
    // insertion order.
    if (inThisFile.has(a.transcriptId)) {
      rejected.push({
        transcriptId: a.transcriptId,
        why: 'a second audit of the same recording in this file',
      });
      continue;
    }
    inThisFile.add(a.transcriptId);

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

  await compareWithStored(sql, ready);
  distributionWarnings(ready);

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

const verdictOf = (f: AuditResult['findings'][number]) =>
  f.notAssessed ? 'not assessed' : f.verdict;

/**
 * What this run changes, against the audit each recording already has.
 *
 * Printed before anything is written, on every run. On 12 Nov 2026 this
 * comparison was done by hand, as an afterthought, and it was the only thing
 * that showed nine stored audits had been produced with every timing at zero
 * — five of them carrying "the 10x Goal was not discussed at all" for
 * sessions where it had been. A change in verdicts is not an error. A change
 * nobody expected is, and this is where it shows.
 */
async function compareWithStored(
  sql: ReturnType<typeof neon<false, false>>,
  ready: AuditResult[],
): Promise<void> {
  const stored = (await sql`
    SELECT DISTINCT ON (transcript_id)
           transcript_id, criteria_version, session_confidence, result_json
    FROM transcript_audits
    ORDER BY transcript_id, generated_at DESC
  `) as unknown as {
    transcript_id: string;
    criteria_version: string;
    session_confidence: string;
    result_json: unknown;
  }[];
  const prevById = new Map(stored.map((r) => [r.transcript_id, r]));

  let fresh = 0;
  let same = 0;
  let changed = 0;
  let tierMoves = 0;
  let sameVersionChanged = 0;
  const transitions = new Map<string, number>();

  for (const a of ready) {
    const prev = prevById.get(a.transcriptId);
    if (!prev || !isAuditResult(prev.result_json)) {
      fresh++;
      continue;
    }
    if (prev.session_confidence !== a.sessionConfidence) tierMoves++;
    const before = new Map(
      prev.result_json.findings.map((f) => [`${f.id}|${f.step ?? ''}`, verdictOf(f)]),
    );
    const after = new Map(
      a.findings.map((f) => [`${f.id}|${f.step ?? ''}`, verdictOf(f)]),
    );
    let differs = false;
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const b = before.get(key) ?? 'absent';
      const n = after.get(key) ?? 'absent';
      if (b === n) continue;
      differs = true;
      const label = `${key.split('|')[0]}: ${b} -> ${n}`;
      transitions.set(label, (transitions.get(label) ?? 0) + 1);
    }
    if (differs) {
      changed++;
      if (prev.criteria_version === a.criteriaVersion) sameVersionChanged++;
    } else {
      same++;
    }
  }

  console.log('\nCompared with the audits already stored:');
  console.log(`  ${same} recordings with every verdict unchanged`);
  console.log(`  ${changed} recordings with at least one verdict changed`);
  if (fresh) console.log(`  ${fresh} recordings audited for the first time`);
  if (tierMoves) console.log(`  ${tierMoves} recordings whose session confidence changed`);
  if (sameVersionChanged) {
    console.log(
      `  ! ${sameVersionChanged} of those changed under the SAME criteria version — ` +
        'the criteria did not move, so the input or the code did',
    );
  }
  const top = [...transitions.entries()].sort((x, y) => y[1] - x[1]);
  for (const [label, n] of top.slice(0, 15)) console.log(`    ${String(n).padStart(3)} x  ${label}`);
  if (top.length > 15) console.log(`    ...and ${top.length - 15} more kinds of change`);
}

/**
 * Findings that track a property of the INPUT rather than of the session.
 *
 * If a criterion raises a concern on most recordings that lack something —
 * cue times, a prep record — and on almost none that have it, the likelier
 * explanation is a check running on missing data, not a pattern in the
 * coaching. Printed as a prompt to look, never as a block: with groups this
 * small a real difference can look the same.
 */
function distributionWarnings(ready: AuditResult[]): void {
  const evaluated = ready.filter((a) => a.familiesExamined.length > 0);
  if (evaluated.length < 4) {
    console.log(
      `\nDistribution check: skipped — only ${evaluated.length} evaluated recordings, ` +
        'too few to compare groups.',
    );
    return;
  }

  const splits: [string, string, (a: AuditResult) => boolean][] = [
    ['without cue times', 'with cue times', (a) => a.totalSec === null],
    [
      'without a prep record',
      'with a prep record',
      (a) => a.findings.some((f) => f.id.startsWith('prep.') && f.notAssessed),
    ],
    ['session inferred', 'session confirmed', (a) => a.sessionConfidence === 'probable'],
  ];
  const ids = new Set(evaluated.flatMap((a) => a.findings.map((f) => f.id)));
  const raises = (a: AuditResult, id: string) =>
    a.findings.some((f) => f.id === id && f.verdict === 'concern' && !f.notAssessed);

  const lines: string[] = [];
  // Which splits could be compared at all. Said out loud below: a check that
  // prints nothing when it finds nothing cannot be told apart from one that
  // never ran, and that is the very failure this function exists to catch.
  const usable = splits.filter(([, , test]) => {
    const k = evaluated.filter(test).length;
    return k >= 2 && evaluated.length - k >= 2;
  });
  for (const id of ids) {
    for (const [yes, no, test] of splits) {
      const inGroup = evaluated.filter(test);
      const outGroup = evaluated.filter((a) => !test(a));
      if (inGroup.length < 2 || outGroup.length < 2) continue;
      const a = inGroup.filter((x) => raises(x, id)).length;
      const b = outGroup.filter((x) => raises(x, id)).length;
      if (Math.abs(a / inGroup.length - b / outGroup.length) >= 0.6) {
        lines.push(
          `  ! ${id}: raised on ${a} of ${inGroup.length} ${yes}, ` +
            `${b} of ${outGroup.length} ${no}`,
        );
      }
    }
    const all = evaluated.filter((x) => raises(x, id)).length;
    if (evaluated.length >= 10 && all / evaluated.length >= 0.9) {
      lines.push(
        `  ! ${id}: raised on ${all} of ${evaluated.length} recordings — a cohort-wide ` +
          'finding, or a check that cannot fail to fire',
      );
    }
  }
  const compared = usable
    .map(([yes, , test]) => `${evaluated.filter(test).length} ${yes}`)
    .join(', ');
  console.log(
    `\nDistribution check: ${ids.size} criteria across ${evaluated.length} evaluated ` +
      `recordings` +
      (usable.length ? ` (${compared})` : ' — no group large enough to compare') +
      '.',
  );
  if (lines.length) {
    console.log('  Worth a look before applying:');
    for (const l of lines) console.log(l);
  } else {
    console.log('  Nothing stands out.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
