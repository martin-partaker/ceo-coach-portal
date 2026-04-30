/* eslint-disable jsx-a11y/alt-text */
import 'server-only';
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  Font,
} from '@react-pdf/renderer';
import * as React from 'react';

/**
 * The PDF mirrors example-output/10x_sample monthly summary_Tipton Mills.pdf —
 * five sections in the same order, sober black-on-white type, hairline
 * dividers between sections. The structure here intentionally maps 1:1
 * to the AI's structured report output (progressSummary / keyWins /
 * challenges / patternObservations / suggestedNextSteps) plus an
 * additional Goal Summary section sourced from the CEO + cycle rows.
 *
 * Sections degrade gracefully — if nothing for that bucket exists,
 * the section is skipped rather than rendered with a "(none)" line.
 */

// Use Helvetica (built-in to PDF), no font registration needed.

export interface CycleReportPdfData {
  ceo: {
    name: string;
    tenXGoal: string | null;
  };
  cycle: {
    label: string;
    periodStart: string | null;
    periodEnd: string | null;
    monthlyGoals: string | null;
    monthlyReflection: string | null;
  };
  coach: {
    name: string;
  } | null;
  /** AI-emitted "structured report" block (preferred when present). */
  report: {
    progressSummary?: string;
    keyWins?: string[];
    challenges?: string[];
    patternObservations?: string;
    suggestedNextSteps?: string[];
  };
  /** AI-emitted "email view" block. Used as a fallback for any
   *  structured field that wasn't returned, plus the standalone
   *  "Key Insight" section the structured shape doesn't model. */
  email: {
    opening?: string;
    wins_and_progress?: string;
    honest_feedback?: string;
    key_insight?: string;
    commitments?: string;
  };
  generatedAt: Date | null;
}

const styles = StyleSheet.create({
  page: {
    flexDirection: 'column',
    paddingTop: 56,
    paddingBottom: 56,
    paddingHorizontal: 64,
    fontFamily: 'Helvetica',
    fontSize: 11,
    lineHeight: 1.5,
    color: '#0a0a0a',
  },
  title: {
    fontSize: 22,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 6,
    lineHeight: 1.2,
  },
  subtitle: {
    fontSize: 11,
    color: '#444',
    marginBottom: 18,
    lineHeight: 1.5,
  },
  divider: {
    borderBottomWidth: 0.5,
    borderBottomColor: '#9ca3af',
    marginVertical: 16,
  },
  sectionTitle: {
    fontSize: 16,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 10,
  },
  paragraph: {
    marginBottom: 8,
  },
  paragraphLabel: {
    fontFamily: 'Helvetica-Bold',
  },
  bulletRow: {
    flexDirection: 'row',
    marginBottom: 6,
  },
  bulletGlyph: {
    width: 14,
    fontFamily: 'Helvetica-Bold',
  },
  bulletBody: {
    flex: 1,
  },
  flagBox: {
    backgroundColor: '#fff7ed',
    borderLeftWidth: 3,
    borderLeftColor: '#dc2626',
    padding: 8,
    marginTop: 4,
  },
  flagLabel: {
    fontFamily: 'Helvetica-Bold',
    color: '#dc2626',
  },
  footer: {
    marginTop: 18,
    fontSize: 9,
    color: '#777',
  },
});

function formatPeriod(periodStart: string | null, periodEnd: string | null): string | null {
  if (!periodStart || !periodEnd) return null;
  const fmt = (s: string) => {
    const [y, m, d] = s.split('-');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[+m - 1]} ${+d}, ${y}`;
  };
  return `${fmt(periodStart)} – ${fmt(periodEnd)}`;
}

function formatGeneratedAt(d: Date | null): string | null {
  if (!d) return null;
  return d.toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

export function CycleReportPdf({ data }: { data: CycleReportPdfData }) {
  const period = formatPeriod(data.cycle.periodStart, data.cycle.periodEnd);
  const generated = formatGeneratedAt(data.generatedAt);
  const subtitleParts: string[] = [data.cycle.label];
  if (period) subtitleParts.push(`Reporting Period: ${period}`);
  if (data.coach?.name) subtitleParts.push(`Coach: ${data.coach.name}`);

  // Resolve each section by preferring the structured.* field, then
  // falling back to whatever's in the email view. Older reports or runs
  // where the model didn't emit the `report` block still produce a full
  // PDF this way instead of just a Goal Summary + footer.
  const progressText =
    data.report.progressSummary?.trim() || data.email.opening?.trim() || '';
  const wins = (data.report.keyWins ?? [])
    .map((s) => s.trim())
    .filter(Boolean);
  const winsText = wins.length === 0
    ? parseBullets(data.email.wins_and_progress)
    : wins;
  const winsParagraph =
    wins.length === 0 && winsText.length === 0
      ? data.email.wins_and_progress?.trim() || ''
      : '';

  const challenges = (data.report.challenges ?? [])
    .map((s) => s.trim())
    .filter(Boolean);
  const challengesText =
    challenges.length === 0
      ? parseBullets(data.email.honest_feedback)
      : challenges;
  const challengesParagraph =
    challenges.length === 0 && challengesText.length === 0
      ? data.email.honest_feedback?.trim() || ''
      : '';
  const patternsText = data.report.patternObservations?.trim() || '';

  const keyInsight = data.email.key_insight?.trim() || '';

  const nextSteps = (data.report.suggestedNextSteps ?? [])
    .map((s) => s.trim())
    .filter(Boolean);
  const nextStepsText =
    nextSteps.length === 0
      ? parseBullets(data.email.commitments)
      : nextSteps;
  const nextStepsParagraph =
    nextSteps.length === 0 && nextStepsText.length === 0
      ? data.email.commitments?.trim() || ''
      : '';

  const hasGoalSection =
    !!data.ceo.tenXGoal?.trim() || !!data.cycle.monthlyGoals?.trim();
  const hasProgressSection = !!progressText;
  const hasWinsSection = winsText.length > 0 || !!winsParagraph;
  const hasChallengesSection =
    challengesText.length > 0 || !!challengesParagraph || !!patternsText;
  const hasKeyInsightSection = !!keyInsight;
  const hasNextStepsSection = nextStepsText.length > 0 || !!nextStepsParagraph;

  return (
    <Document
      title={`Monthly Progress Summary — ${data.ceo.name}`}
      author={data.coach?.name ?? 'Coach'}
      subject={`${data.cycle.label} progress summary for ${data.ceo.name}`}
    >
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>
          Monthly Progress Summary — {data.ceo.name}
        </Text>
        <Text style={styles.subtitle}>{subtitleParts.join(' | ')}</Text>
        <View style={styles.divider} />

        {hasGoalSection && (
          <>
            <Text style={styles.sectionTitle}>1. Goal Summary</Text>
            {data.ceo.tenXGoal?.trim() && (
              <BulletItem
                label="10x Goal:"
                body={data.ceo.tenXGoal.trim()}
              />
            )}
            {data.cycle.monthlyGoals?.trim() && (
              <View style={styles.paragraph}>
                <Text>
                  <Text style={styles.paragraphLabel}>Monthly goals: </Text>
                  {data.cycle.monthlyGoals.trim()}
                </Text>
              </View>
            )}
            <View style={styles.divider} />
          </>
        )}

        {hasProgressSection && (
          <>
            <Text style={styles.sectionTitle}>
              {sectionNumber(hasGoalSection)} Progress Assessment
            </Text>
            <Paragraphs text={progressText} />
            <View style={styles.divider} />
          </>
        )}

        {hasWinsSection && (
          <>
            <Text style={styles.sectionTitle}>
              {sectionNumber(hasGoalSection, hasProgressSection)} Key Wins
            </Text>
            {winsText.map((w, i) => (
              <BulletItem key={i} body={w} />
            ))}
            {winsParagraph && <Paragraphs text={winsParagraph} />}
            <View style={styles.divider} />
          </>
        )}

        {hasChallengesSection && (
          <>
            <Text style={styles.sectionTitle}>
              {sectionNumber(
                hasGoalSection,
                hasProgressSection,
                hasWinsSection,
              )}{' '}
              Challenges & Patterns
            </Text>
            {challengesText.map((c, i) => (
              <BulletItem key={i} body={c} />
            ))}
            {challengesParagraph && <Paragraphs text={challengesParagraph} />}
            {patternsText && (
              <View style={styles.paragraph}>
                <Text>
                  <Text style={styles.paragraphLabel}>
                    Pattern observations:{' '}
                  </Text>
                  {patternsText}
                </Text>
              </View>
            )}
            <View style={styles.divider} />
          </>
        )}

        {hasKeyInsightSection && (
          <>
            <Text style={styles.sectionTitle}>
              {sectionNumber(
                hasGoalSection,
                hasProgressSection,
                hasWinsSection,
                hasChallengesSection,
              )}{' '}
              Key Insight
            </Text>
            <Paragraphs text={keyInsight} />
            <View style={styles.divider} />
          </>
        )}

        {hasNextStepsSection && (
          <>
            <Text style={styles.sectionTitle}>
              {sectionNumber(
                hasGoalSection,
                hasProgressSection,
                hasWinsSection,
                hasChallengesSection,
                hasKeyInsightSection,
              )}{' '}
              Recommended Next Steps
            </Text>
            {nextStepsText.map((step, i) => (
              <BulletItem key={i} glyph={`${i + 1}.`} body={step} />
            ))}
            {nextStepsParagraph && <Paragraphs text={nextStepsParagraph} />}
          </>
        )}

        {generated && (
          <Text style={styles.footer}>
            Generated {generated}
            {data.coach?.name ? ` by ${data.coach.name}` : ''}.
          </Text>
        )}
      </Page>
    </Document>
  );
}

/**
 * Section numbering that adapts to which sections exist. We don't want
 * to print "Section 4" if Section 3 was skipped. Counts how many of the
 * preceding sections are present and adds 1 for the current section.
 */
function sectionNumber(...precedingPresent: boolean[]): string {
  const idx = precedingPresent.filter(Boolean).length + 1;
  return `${idx}.`;
}

/**
 * Pull bullet-shaped lines out of email-style text. The model often
 * returns wins/feedback/commitments as plain text with `*`, `-`, `•`,
 * or `1.` prefixes, sometimes mixed with prose. We try to extract
 * just the bullet items; if there aren't any clear bullets, callers
 * fall back to rendering the whole thing as a paragraph.
 */
function parseBullets(text: string | undefined): string[] {
  if (!text) return [];
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const bullets: string[] = [];
  for (const line of lines) {
    const m = line.match(/^(?:[•\-*]|\d+[.)])\s+(.+)$/);
    if (m) {
      // Strip stray trailing markdown emphasis markers — they don't
      // render as emphasis in our PDF and look like noise.
      bullets.push(m[1].replace(/\*\*/g, '').trim());
    }
  }
  // If the text is one prose blob with no markers, return [] so the
  // caller renders it as a paragraph instead of a single fake bullet.
  return bullets;
}

function BulletItem({
  glyph = '•',
  label,
  body,
}: {
  glyph?: string;
  label?: string;
  body: string;
}) {
  return (
    <View style={styles.bulletRow}>
      <Text style={styles.bulletGlyph}>{glyph}</Text>
      <View style={styles.bulletBody}>
        <Text>
          {label && <Text style={styles.paragraphLabel}>{label} </Text>}
          {body}
        </Text>
      </View>
    </View>
  );
}

/**
 * Render text that may contain blank-line paragraph breaks. The model
 * tends to split progressSummary into a couple of paragraphs, so we
 * preserve that by rendering each one as its own <Text>.
 */
function Paragraphs({ text }: { text: string }) {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paras.length === 0) return null;
  return (
    <>
      {paras.map((p, i) => (
        <View key={i} style={styles.paragraph}>
          <Text>{p}</Text>
        </View>
      ))}
    </>
  );
}

// `Font` import kept above so consumers can register custom fonts later
// (e.g. the same Inter we use on screen) without re-importing the API.
void Font;
