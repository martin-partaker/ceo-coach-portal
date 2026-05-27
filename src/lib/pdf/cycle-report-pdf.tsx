/* eslint-disable jsx-a11y/alt-text */
import 'server-only';
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  Font,
  Svg,
  Polyline,
  Circle,
  Line,
  // SVG-scoped <Text> — share the name with our layout `<Text>` above
  // so we alias it. Used for chart axis + point labels.
  Text as PdfSvgText,
} from '@react-pdf/renderer';
import * as React from 'react';
import { MarkdownPdf } from '@/lib/markdown/render-pdf';

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
    /** Quantitative KPI snapshots for the cycle. When present we render
     *  a small table at the top of Progress Assessment so the metrics
     *  are visible at a glance instead of buried in prose. */
    kpis?: Array<{
      label: string;
      value: string;
      trend?: 'up' | 'down' | 'flat';
      note?: string;
      /** Numeric history across the trailing cycles, oldest → newest,
       *  current cycle last. Each entry pairs a cycle short label
       *  (rendered on the chart's x-axis) with its parsed numeric
       *  value. Hidden when fewer than 2 entries are available. */
      history?: Array<{ label: string; value: number }>;
    }>;
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
    /** Structured goal cascade emitted by the model. When present, the
     *  PDF Goal Summary uses these values (with sub-bullets per CEO for
     *  pair-divergent goals and the goal-drift flag) instead of falling
     *  back to the static `ceo.tenXGoal` + `cycle.monthlyGoals` strings.
     *  Older reports without this block fall through to the legacy
     *  cycle-row values. */
    goalSummary?: {
      tenX?: string;
      ninetyDay?: string | null;
      thirtyDay?: string | null;
      flag?: string | null;
    } | null;
    closing?: {
      sentence: string;
      nextSessionDate: string | null;
    } | null;
  };
  /** AI-emitted "email view" block. Used as a fallback for any
   *  structured field that wasn't returned by older runs. The PDF now
   *  prefers the structured `report` block for every section; the email
   *  fields only come into play when the structured block is partial. */
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
    borderBottomWidth: 0.4,
    borderBottomColor: '#e5e7eb',
    marginVertical: 18,
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
  closingBlock: {
    marginTop: 18,
    paddingTop: 12,
    borderTopWidth: 0.4,
    borderTopColor: '#e5e7eb',
  },
  closingSentence: {
    fontFamily: 'Helvetica-Oblique',
    fontSize: 11,
    lineHeight: 1.5,
    color: '#1f2937',
  },
  closingNext: {
    marginTop: 6,
    fontFamily: 'Helvetica-Bold',
    fontSize: 11,
  },
  kpiGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 4,
    marginBottom: 12,
  },
  kpiCell: {
    flexBasis: '32%',
    flexGrow: 1,
    padding: 8,
    border: '0.5pt solid #d1d5db',
    borderRadius: 4,
    backgroundColor: '#fafafa',
  },
  kpiLabel: {
    fontSize: 9,
    color: '#555',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 2,
  },
  kpiValueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
  },
  kpiValue: {
    fontSize: 14,
    fontFamily: 'Helvetica-Bold',
  },
  kpiTrendUp: { color: '#15803d', fontSize: 10, fontFamily: 'Helvetica-Bold' },
  kpiTrendDown: { color: '#b91c1c', fontSize: 10, fontFamily: 'Helvetica-Bold' },
  kpiTrendFlat: { color: '#6b7280', fontSize: 10, fontFamily: 'Helvetica-Bold' },
  kpiSpark: {
    marginTop: 4,
  },
  kpiNote: {
    fontSize: 9,
    color: '#555',
    marginTop: 2,
  },
});

const TREND_GLYPH = { up: '▲', down: '▼', flat: '•' } as const;
const TREND_STYLE = {
  up: styles.kpiTrendUp,
  down: styles.kpiTrendDown,
  flat: styles.kpiTrendFlat,
} as const;

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

  // Lists from the structured block render as bullets directly. When
  // we fall back to email-view text (older reports), the markdown
  // renderer parses bullets and prose mixed together, so we just hand
  // the raw text in.
  const wins = (data.report.keyWins ?? [])
    .map((s) => s.trim())
    .filter(Boolean);
  const winsFallback =
    wins.length === 0 ? (data.email.wins_and_progress?.trim() || '') : '';

  const challenges = (data.report.challenges ?? [])
    .map((s) => s.trim())
    .filter(Boolean);
  const challengesFallback =
    challenges.length === 0
      ? (data.email.honest_feedback?.trim() || '')
      : '';
  const patternsText = data.report.patternObservations?.trim() || '';

  const keyInsight = data.email.key_insight?.trim() || '';

  const nextSteps = (data.report.suggestedNextSteps ?? [])
    .map((s) => s.trim())
    .filter(Boolean);
  const nextStepsFallback =
    nextSteps.length === 0 ? (data.email.commitments?.trim() || '') : '';

  const kpis = (data.cycle.kpis ?? []).filter(
    (k) => k.label.trim() && k.value.trim(),
  );

  // Prefer the model's structured goalSummary when present — it contains
  // the 10x goal as the model extracted it FROM this month's inputs (not
  // the stored team-profile goal which is often stale or conflicting),
  // plus the 90-day and 30-day cascades and the goal-drift flag. Fall
  // back to the static cycle/CEO rows for legacy reports.
  const modelGoal = data.report.goalSummary ?? null;
  const goalTenX = modelGoal?.tenX?.trim() || data.ceo.tenXGoal?.trim() || '';
  const goalNinety = modelGoal?.ninetyDay?.trim() ?? null;
  const goalThirty = modelGoal?.thirtyDay?.trim() ?? null;
  // `modelGoal.flag` is the "Flag for Coach Review" callout for goal
  // drift / goal-figure conflicts. It is COACH-ONLY by design — the
  // on-screen review modal surfaces it before send, but it must never
  // appear in the PDF that lands in the CEO's inbox. We intentionally
  // do NOT extract `goalFlag` here so it cannot accidentally be
  // rendered downstream. (Source of truth for goal-drift visibility
  // is the on-screen DocumentRenderer + the coachReviewFlags array.)
  // Legacy fallback for very old reports that don't have the structured
  // block — fold monthly goals into a single "Monthly goals" line below
  // the 10x bullet (mirrors the old layout).
  const legacyMonthlyGoals = !modelGoal && data.cycle.monthlyGoals?.trim()
    ? data.cycle.monthlyGoals.trim()
    : null;
  const hasGoalSection =
    !!goalTenX || !!goalNinety || !!goalThirty || !!legacyMonthlyGoals;
  // Progress section now renders if there's prose OR KPIs — a cycle
  // with only KPIs (no narrative yet) still gets its own section.
  const hasProgressSection = !!progressText || kpis.length > 0;
  const hasWinsSection = wins.length > 0 || !!winsFallback;
  // Challenges no longer absorbs patternObservations — Flight Patterns
  // is its own section now.
  const hasChallengesSection =
    challenges.length > 0 || !!challengesFallback;
  const hasFlightPatternsSection = !!patternsText;
  const hasNextStepsSection = nextSteps.length > 0 || !!nextStepsFallback;
  // Key Insight is no longer a distinct PDF section — Eric's polished
  // format weaves the key insight into Momentum Check / Flight Patterns
  // / closing. We keep the email field for legacy/email-view use but
  // don't render it in the PDF.
  void keyInsight;

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
        <Text style={styles.subtitle}>{subtitleParts.join(' · ')}</Text>
        <View style={styles.divider} />

        {hasGoalSection && (
          <>
            <Text style={styles.sectionTitle}>1. Goal Summary</Text>
            {goalTenX && (
              <View style={styles.bulletRow}>
                <Text style={styles.bulletGlyph}>•</Text>
                <View style={styles.bulletBody}>
                  <Text style={styles.paragraphLabel}>10x Goal:</Text>
                  <MarkdownPdf text={goalTenX} />
                </View>
              </View>
            )}
            {goalNinety && (
              <View style={styles.bulletRow}>
                <Text style={styles.bulletGlyph}>•</Text>
                <View style={styles.bulletBody}>
                  <Text style={styles.paragraphLabel}>90-Day Goal:</Text>
                  <MarkdownPdf text={goalNinety} />
                </View>
              </View>
            )}
            {goalThirty && (
              <View style={styles.bulletRow}>
                <Text style={styles.bulletGlyph}>•</Text>
                <View style={styles.bulletBody}>
                  <Text style={styles.paragraphLabel}>30-Day Goal:</Text>
                  <MarkdownPdf text={goalThirty} />
                </View>
              </View>
            )}
            {legacyMonthlyGoals && (
              <View style={styles.paragraph}>
                <Text style={styles.paragraphLabel}>Monthly goals</Text>
                <MarkdownPdf text={legacyMonthlyGoals} />
              </View>
            )}
            <View style={styles.divider} />
          </>
        )}

        {hasProgressSection && (
          <>
            <Text style={styles.sectionTitle}>
              {sectionNumber(hasGoalSection)} Momentum Check
            </Text>
            {kpis.length > 0 && (
              <View style={styles.kpiGrid}>
                {kpis.map((k, i) => (
                  <KpiCell
                    key={`${k.label}-${i}`}
                    label={k.label}
                    value={k.value}
                    trend={k.trend}
                    note={k.note}
                    history={k.history}
                  />
                ))}
              </View>
            )}
            {progressText && <MarkdownPdf text={progressText} />}
            <View style={styles.divider} />
          </>
        )}

        {hasWinsSection && (
          <>
            <Text style={styles.sectionTitle}>
              {sectionNumber(hasGoalSection, hasProgressSection)} Key Wins
            </Text>
            {wins.length > 0 ? (
              wins.map((w, i) => (
                <BulletItem key={i} body={w} />
              ))
            ) : (
              <MarkdownPdf text={winsFallback} />
            )}
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
            {challenges.length > 0 ? (
              challenges.map((c, i) => (
                <BulletItem key={i} body={c} />
              ))
            ) : (
              <MarkdownPdf text={challengesFallback} />
            )}
            <View style={styles.divider} />
          </>
        )}

        {hasFlightPatternsSection && (
          <>
            <Text style={styles.sectionTitle}>
              {sectionNumber(
                hasGoalSection,
                hasProgressSection,
                hasWinsSection,
                hasChallengesSection,
              )}{' '}
              Flight Patterns
            </Text>
            <MarkdownPdf text={patternsText} />
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
                hasFlightPatternsSection,
              )}{' '}
              Flight Plan: Recommended Next Steps
            </Text>
            {nextSteps.length > 0 ? (
              nextSteps.map((step, i) => (
                <BulletItem key={i} glyph={`${i + 1}.`} body={step} />
              ))
            ) : (
              <MarkdownPdf text={nextStepsFallback} />
            )}
          </>
        )}

        {data.report.closing?.sentence?.trim() && (
          <View style={styles.closingBlock}>
            <Text style={styles.closingSentence}>
              {data.report.closing.sentence.trim()}
            </Text>
            {data.report.closing.nextSessionDate?.trim() && (
              <Text style={styles.closingNext}>
                Next session: {data.report.closing.nextSessionDate.trim()}
              </Text>
            )}
          </View>
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

function KpiCell({
  label,
  value,
  trend,
  note,
  history,
}: {
  label: string;
  value: string;
  trend?: 'up' | 'down' | 'flat';
  note?: string;
  history?: Array<{ label: string; value: number }>;
}) {
  return (
    <View style={styles.kpiCell}>
      <Text style={styles.kpiLabel}>{label}</Text>
      <View style={styles.kpiValueRow}>
        <Text style={styles.kpiValue}>{value}</Text>
        {trend && <Text style={TREND_STYLE[trend]}>{TREND_GLYPH[trend]}</Text>}
      </View>
      {history && history.length >= 2 && (
        <ProgressChart history={history} trend={trend} />
      )}
      {note?.trim() && <Text style={styles.kpiNote}>{note.trim()}</Text>}
    </View>
  );
}

/**
 * Compact value formatter. "5,000,000" → "5M". Used for the y-axis
 * labels and the dotted point labels so they fit beside each marker
 * without overflowing the tile.
 */
function formatChartValue(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(1).replace(/\.0$/, '');
}

/**
 * Per-KPI trend chart. Renders a small line chart with:
 *   - polyline through the historical points (trend-coloured)
 *   - a dot at every point (current cycle's dot is filled and slightly
 *     larger so it reads as "where we ended up")
 *   - the formatted value above each dot
 *   - the cycle short label under each dot
 *   - a faint top/bottom grid line + min/max y-axis labels
 *
 * Stays inside the existing 50%-width KPI tile. Hidden by the caller
 * when there are fewer than 2 data points (a single value can't show
 * a trend and the labels become misleading).
 */
function ProgressChart({
  history,
  trend,
}: {
  history: Array<{ label: string; value: number }>;
  trend?: 'up' | 'down' | 'flat';
}) {
  const width = 168;
  const chartH = 56;
  const labelTopH = 12;
  const labelBottomH = 12;
  const padLeft = 26; // room for y-axis labels
  const padRight = 8;
  const height = labelTopH + chartH + labelBottomH;

  const color =
    trend === 'up'
      ? '#15803d'
      : trend === 'down'
        ? '#b91c1c'
        : trend === 'flat'
          ? '#6b7280'
          : '#2563eb';

  const values = history.map((h) => h.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || Math.max(Math.abs(max), 1);
  const innerW = width - padLeft - padRight;

  const coords = history.map((h, i) => {
    const x = history.length === 1
      ? padLeft + innerW / 2
      : padLeft + (i / (history.length - 1)) * innerW;
    const y = labelTopH + chartH - ((h.value - min) / range) * chartH;
    return { x, y, value: h.value, label: h.label };
  });
  const pointStr = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const lastIndex = coords.length - 1;

  return (
    <View style={styles.kpiSpark}>
      <Svg width={width} height={height}>
        {/* y-axis grid lines (top + bottom of the plot) */}
        <Line x1={padLeft} y1={labelTopH} x2={width - padRight} y2={labelTopH} stroke="#e5e7eb" strokeWidth={0.5} />
        <Line x1={padLeft} y1={labelTopH + chartH} x2={width - padRight} y2={labelTopH + chartH} stroke="#e5e7eb" strokeWidth={0.5} />

        {/* y-axis min/max labels */}
        <SvgText x={padLeft - 3} y={labelTopH + 4} textAnchor="end">{formatChartValue(max)}</SvgText>
        <SvgText x={padLeft - 3} y={labelTopH + chartH} textAnchor="end">{formatChartValue(min)}</SvgText>

        {/* line + points */}
        <Polyline points={pointStr} stroke={color} strokeWidth={1.4} fill="none" />
        {coords.map((c, i) => {
          const isLast = i === lastIndex;
          return (
            <Circle
              key={i}
              cx={c.x}
              cy={c.y}
              r={isLast ? 2.5 : 1.8}
              fill={isLast ? color : '#ffffff'}
              stroke={color}
              strokeWidth={isLast ? 0 : 1}
            />
          );
        })}

        {/* x-axis cycle labels — one under each point */}
        {coords.map((c, i) => (
          <SvgText
            key={`x-${i}`}
            x={c.x}
            y={labelTopH + chartH + 9}
            textAnchor="middle"
          >
            {c.label}
          </SvgText>
        ))}

        {/* current point's value, called out above the marker */}
        <SvgText
          x={coords[lastIndex].x}
          y={Math.max(8, coords[lastIndex].y - 4)}
          textAnchor="middle"
          color={color}
        >
          {formatChartValue(coords[lastIndex].value)}
        </SvgText>
      </Svg>
    </View>
  );
}

/**
 * Wrapper around `<Text>` that lays text inside an `<Svg>`. We can't
 * import `Text` from `@react-pdf/renderer` here because we already
 * import the layout `<Text>` for prose; SVG text uses the same name in
 * the @react-pdf SVG primitives, so we keep it scoped via an alias.
 */
function SvgText({
  x,
  y,
  textAnchor,
  color,
  children,
}: {
  x: number;
  y: number;
  textAnchor?: 'start' | 'middle' | 'end';
  color?: string;
  children: React.ReactNode;
}) {
  return (
    <PdfSvgText
      x={x}
      y={y}
      textAnchor={textAnchor ?? 'middle'}
      style={{ fontSize: 7, fill: color ?? '#6b7280', fontFamily: 'Helvetica' }}
    >
      {children}
    </PdfSvgText>
  );
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
        {label && <Text style={styles.paragraphLabel}>{label} </Text>}
        <MarkdownPdf text={body} />
      </View>
    </View>
  );
}

// `Font` import kept above so consumers can register custom fonts later
// (e.g. the same Inter we use on screen) without re-importing the API.
void Font;
