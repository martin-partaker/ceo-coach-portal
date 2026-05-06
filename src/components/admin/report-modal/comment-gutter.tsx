'use client';

import * as React from 'react';
import { useEffect, useMemo, useState, useLayoutEffect } from 'react';
import { cn } from '@/lib/utils';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Info,
  MessageSquare,
  Pin,
  Sparkles,
} from 'lucide-react';
import type { DocumentSectionId } from './document-renderer';

/**
 * Right-side gutter that mounts comments anchored to the document's
 * sections. Each comment has a `targetSection` — on layout we measure
 * the section's bounding rect inside the document container and
 * position the comment at the same vertical offset.
 *
 * If two comments target the same section they stack vertically; we
 * also nudge them to avoid overlap with previously placed comments.
 */

export type CommentKind = 'rubric-fail' | 'rubric-pass' | 'flag' | 'top-fix';

export type GutterComment = {
  id: string;
  kind: CommentKind;
  title: string;
  body: string;
  urgency?: 'info' | 'attention' | 'urgent';
  /** Which document section this comment relates to. If null, the
   *  comment floats at the top of the gutter (e.g. global topFix). */
  targetSection: DocumentSectionId | null;
};

type Props = {
  comments: GutterComment[];
  /** Container element holding the document — we read section
   *  positions relative to this so the gutter aligns with each card. */
  documentContainer: HTMLElement | null;
  onHoverSection?: (id: DocumentSectionId | null) => void;
  onCommentClick?: (comment: GutterComment) => void;
};

export function CommentGutter({
  comments,
  documentContainer,
  onHoverSection,
  onCommentClick,
}: Props) {
  // Map: commentId -> top offset (px) within the gutter
  const [tops, setTops] = useState<Record<string, number>>({});
  // Map: commentId -> measured height in px. Populated by each card
  // via ResizeObserver — used in the next measure pass so subsequent
  // cards get pushed down by exactly the card's actual rendered
  // height. Without this, an expanded card's body overlaps the
  // next-sibling card. Default falls back to a 64px estimate when a
  // card hasn't reported its height yet (first paint).
  const [heights, setHeights] = useState<Record<string, number>>({});
  // Total document height — used so the gutter's relative container
  // extends far enough that absolutely-positioned comments at the
  // bottom remain inside their parent (and thus inside the scroll).
  const [containerHeight, setContainerHeight] = useState<number>(600);
  // Per-section expanded flag — when a section anchor has 3+ comments
  // we collapse to the first 2 and a "+N more" chip; click to expand.
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  // Per-CARD expanded state, lifted from the card so the gutter knows
  // which cards are tall and re-measures positions when one opens.
  const [expandedCardIds, setExpandedCardIds] = useState<Set<string>>(new Set());

  // Group comments by their target section so we can collapse dense
  // anchors into a "show more" chip. `__global__` is the bucket for
  // gutter-level comments (top-fix etc).
  const grouped = useMemo(() => {
    const out: Record<string, GutterComment[]> = {};
    for (const c of comments) {
      const key = c.targetSection ?? '__global__';
      (out[key] ??= []).push(c);
    }
    return out;
  }, [comments]);

  // Visible vs hidden per section — the visible ones get measured tops;
  // hidden ones live behind the "+N more" chip until the section is
  // expanded. Always show at least 2 per anchor; expanding shows all.
  const VISIBLE_PER_ANCHOR = 2;
  const visibleComments = useMemo<GutterComment[]>(() => {
    const out: GutterComment[] = [];
    for (const [section, list] of Object.entries(grouped)) {
      const expanded = expandedSections.has(section);
      const limit = expanded ? list.length : Math.min(VISIBLE_PER_ANCHOR, list.length);
      for (let i = 0; i < limit; i++) out.push(list[i]);
    }
    return out;
  }, [grouped, expandedSections]);

  const hiddenCountBySection = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [section, list] of Object.entries(grouped)) {
      const expanded = expandedSections.has(section);
      if (!expanded && list.length > VISIBLE_PER_ANCHOR) {
        out[section] = list.length - VISIBLE_PER_ANCHOR;
      }
    }
    return out;
  }, [grouped, expandedSections]);

  // Re-measure on layout, on resize, and whenever comments change.
  useLayoutEffect(() => {
    if (!documentContainer) return;
    const measure = () => {
      const containerRect = documentContainer.getBoundingClientRect();
      setContainerHeight(documentContainer.offsetHeight);
      const out: Record<string, number> = {};
      // Sort visible comments so deterministic stacking order — global
      // first, then by document order of their target sections.
      const ordered = [...visibleComments].sort((a, b) => {
        if (!a.targetSection && b.targetSection) return -1;
        if (a.targetSection && !b.targetSection) return 1;
        return 0;
      });
      const placed: Array<{ top: number; height: number }> = [];
      const COLLAPSED_EST = 64;
      const MIN_GAP = 6;
      for (const c of ordered) {
        // Use the card's MEASURED height if known — that's the only
        // reliable way to push the next card past an expanded one.
        // Falls back to the collapsed estimate on first paint.
        const cardHeight = heights[c.id] ?? COLLAPSED_EST;
        let raw = 0;
        if (!c.targetSection) {
          raw = 0;
        } else {
          const el = documentContainer.querySelector<HTMLElement>(
            `[data-section="${c.targetSection}"]`,
          );
          if (el) {
            const rect = el.getBoundingClientRect();
            raw = rect.top - containerRect.top + 4;
          }
        }
        // Avoid overlap with previously placed comments.
        let candidate = raw;
        for (const p of placed) {
          if (candidate < p.top + p.height + MIN_GAP) {
            candidate = p.top + p.height + MIN_GAP;
          }
        }
        placed.push({ top: candidate, height: cardHeight });
        out[c.id] = candidate;
      }
      setTops(out);
    };
    measure();

    const ro = new ResizeObserver(measure);
    ro.observe(documentContainer);
    // Also observe descendants — section heights change as text wraps.
    const mo = new MutationObserver(measure);
    mo.observe(documentContainer, { subtree: true, childList: true, characterData: true });
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [documentContainer, visibleComments, heights]);

  if (comments.length === 0) {
    return (
      <aside className="hidden w-72 shrink-0 px-3 lg:block">
        <p className="mt-4 text-[11px] text-muted-foreground/60">
          No comments. Looks clean.
        </p>
      </aside>
    );
  }

  // Compute "+N more" chip positions — anchored just below the last
  // visible card for that section. Done after `tops` is set so the chip
  // sits at the right vertical position.
  const moreChipTops: Record<string, number> = {};
  for (const [section, hiddenCount] of Object.entries(hiddenCountBySection)) {
    if (hiddenCount === 0) continue;
    // Find the bottom of the last visible comment in this section.
    const sectionComments = (grouped[section] ?? []).slice(0, VISIBLE_PER_ANCHOR);
    const lastVisible = sectionComments[sectionComments.length - 1];
    if (!lastVisible) continue;
    const t = tops[lastVisible.id];
    if (typeof t === 'number') moreChipTops[section] = t + 56; // below last card
  }

  return (
    <aside className="relative hidden w-64 shrink-0 px-3 lg:block">
      <div className="sticky top-2 z-10 mb-2 flex items-center gap-1.5 rounded-md bg-muted/40 px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur">
        <MessageSquare className="h-3 w-3" />
        Comments ({comments.length})
      </div>
      <div className="relative" style={{ minHeight: `${containerHeight}px` }}>
        {visibleComments.map((c) => (
          <CommentCard
            key={c.id}
            comment={c}
            top={tops[c.id] ?? 0}
            expanded={expandedCardIds.has(c.id)}
            onToggleExpand={() =>
              setExpandedCardIds((prev) => {
                const next = new Set(prev);
                if (next.has(c.id)) next.delete(c.id);
                else next.add(c.id);
                return next;
              })
            }
            onMeasureHeight={(h) => {
              setHeights((prev) =>
                Math.abs((prev[c.id] ?? 0) - h) < 1 ? prev : { ...prev, [c.id]: h },
              );
            }}
            onHover={() => onHoverSection?.(c.targetSection)}
            onLeave={() => onHoverSection?.(null)}
            onClick={() => onCommentClick?.(c)}
          />
        ))}
        {Object.entries(moreChipTops).map(([section, top]) => (
          <button
            key={`more-${section}`}
            type="button"
            onClick={() =>
              setExpandedSections((s) => {
                const next = new Set(s);
                next.add(section);
                return next;
              })
            }
            className="absolute left-0 right-0 inline-flex items-center justify-center gap-1 rounded-md border border-dashed border-border bg-muted/20 px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            style={{ top: `${top}px` }}
            title={`Show ${hiddenCountBySection[section]} more comment${
              hiddenCountBySection[section] === 1 ? '' : 's'
            } on this section`}
          >
            <ChevronDown className="h-2.5 w-2.5" />
            +{hiddenCountBySection[section]} more
          </button>
        ))}
        {Array.from(expandedSections).map((section) => {
          const t = (grouped[section]?.[0] && tops[grouped[section][0].id]) ?? 0;
          if (!grouped[section] || grouped[section].length <= VISIBLE_PER_ANCHOR) return null;
          // Place "collapse" chip at the very top of this section's stack.
          return (
            <button
              key={`collapse-${section}`}
              type="button"
              onClick={() =>
                setExpandedSections((s) => {
                  const next = new Set(s);
                  next.delete(section);
                  return next;
                })
              }
              className="absolute left-0 right-0 inline-flex items-center justify-center gap-1 rounded-md border border-dashed border-border bg-muted/20 px-2 py-0.5 text-[9px] font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
              style={{ top: `${Math.max(0, t - 18)}px` }}
            >
              <ChevronRight className="h-2.5 w-2.5" />
              collapse
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function CommentCard({
  comment: c,
  top,
  expanded,
  onToggleExpand,
  onMeasureHeight,
  onHover,
  onLeave,
  onClick,
}: {
  comment: GutterComment;
  top: number;
  expanded: boolean;
  onToggleExpand: () => void;
  onMeasureHeight: (h: number) => void;
  onHover: () => void;
  onLeave: () => void;
  onClick: () => void;
}) {
  const { Icon, accentBorder, accentBg, accentText } = kindStyle(c.kind, c.urgency);
  const ref = React.useRef<HTMLDivElement | null>(null);

  // Report height back up so the gutter can re-measure sibling tops.
  // Without this, expanding a card grows it in place but the next
  // card stays at its previously-computed position and overlaps the
  // expanded body. ResizeObserver fires whenever the card's content
  // box changes (i.e. on expand/collapse, on text reflow).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      onMeasureHeight(el.offsetHeight);
    });
    ro.observe(el);
    onMeasureHeight(el.offsetHeight);
    return () => ro.disconnect();
  }, [onMeasureHeight]);

  return (
    <div
      ref={ref}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      onClick={() => {
        onToggleExpand();
        onClick();
      }}
      className={cn(
        'group absolute left-0 right-0 cursor-pointer rounded-md border bg-background px-2 py-1.5 text-[11px] leading-snug shadow-sm transition-all',
        'border-l-[3px]',
        accentBorder,
        'hover:shadow-md hover:translate-x-[-1px]',
        // When expanded, lift above siblings so the rendering stack
        // matches the layout: the expanded card is the foreground item.
        expanded && 'z-20 shadow-lg',
      )}
      style={{ top: `${top}px` }}
    >
      <div className="flex items-start gap-1.5">
        <span
          className={cn(
            'mt-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full',
            accentBg,
            accentText,
          )}
          aria-hidden
        >
          <Icon className="h-2.5 w-2.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className={cn('font-medium text-foreground', expanded ? '' : 'line-clamp-2')}>
            {c.title}
          </p>
          {expanded ? (
            <p className="mt-1.5 whitespace-pre-wrap text-foreground/80">
              {c.body}
            </p>
          ) : (
            <p className="mt-0.5 line-clamp-1 text-[10.5px] text-muted-foreground/80">
              {c.body}
            </p>
          )}
        </div>
        <ChevronDown
          className={cn(
            'mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/50 transition-transform',
            expanded && 'rotate-180',
          )}
        />
      </div>
    </div>
  );
}

function kindStyle(kind: CommentKind, urgency?: 'info' | 'attention' | 'urgent') {
  // Returns the accent palette for the new compact card design:
  //   accentBorder — applied as the 3px left border
  //   accentBg / accentText — the small icon chip color
  // No big background flood; the card body itself is bg-background so
  // a stack of cards reads as a list, not a wall of red.
  if (kind === 'rubric-pass') {
    return {
      Icon: Check,
      accentBorder: 'border-l-emerald-500',
      accentBg: 'bg-emerald-500/15',
      accentText: 'text-emerald-700 dark:text-emerald-400',
      label: 'Rubric ✓',
    };
  }
  if (kind === 'rubric-fail') {
    return {
      Icon: AlertTriangle,
      accentBorder: 'border-l-amber-500',
      accentBg: 'bg-amber-500/15',
      accentText: 'text-amber-700 dark:text-amber-400',
      label: 'Rubric',
    };
  }
  if (kind === 'top-fix') {
    return {
      Icon: Sparkles,
      accentBorder: 'border-l-blue-500',
      accentBg: 'bg-blue-500/15',
      accentText: 'text-blue-700 dark:text-blue-400',
      label: 'Top fix',
    };
  }
  // flag — vary by urgency so the gutter has visual hierarchy when
  // multiple flags exist.
  if (urgency === 'urgent') {
    return {
      Icon: AlertCircle,
      accentBorder: 'border-l-red-500',
      accentBg: 'bg-red-500/15',
      accentText: 'text-red-700 dark:text-red-400',
      label: 'Urgent',
    };
  }
  if (urgency === 'info') {
    return {
      Icon: Info,
      accentBorder: 'border-l-sky-500',
      accentBg: 'bg-sky-500/15',
      accentText: 'text-sky-700 dark:text-sky-400',
      label: 'Note',
    };
  }
  return {
    Icon: Pin,
    accentBorder: 'border-l-amber-500',
    accentBg: 'bg-amber-500/15',
    accentText: 'text-amber-700 dark:text-amber-400',
    label: 'Coach review',
  };
}

// ── helpers to build comments from rubric + flags ────────────────────

const SECTION_TO_DOC: Record<string, DocumentSectionId> = {
  progressSummary: 'progressSummary',
  keyWins: 'keyWins',
  challenges: 'challenges',
  patternObservations: 'patternObservations',
  suggestedNextSteps: 'suggestedNextSteps',
  // Email-only sections collapse to the relevant doc section so the
  // comment still has a place to anchor — a coach editing the email
  // version will recognise them anyway.
  wins_and_progress: 'keyWins',
  honest_feedback: 'challenges',
  key_insight: 'patternObservations',
  opening: 'progressSummary',
  commitments: 'suggestedNextSteps',
};

const RUBRIC_LABELS: Record<string, string> = {
  goalCascade: 'Goal cascade',
  coachReviewFlag: 'Coach review flags',
  quantifiedEffort: 'Effort quantified',
  stakeholderFeedback: 'Per-stakeholder feedback',
  constraintNamed: 'Constraint named',
  specificNumbers: 'Specific numbers in every section',
  counterFactualNextSteps: 'Counter-factual next steps',
  emotionalEventsHandled: 'Emotional context handled',
  crossCycleDelta: 'Cross-cycle delta',
};

const RUBRIC_DEFAULT_SECTION: Record<string, DocumentSectionId> = {
  goalCascade: 'goalSummary',
  coachReviewFlag: 'goalSummary',
  quantifiedEffort: 'progressSummary',
  stakeholderFeedback: 'keyWins',
  constraintNamed: 'challenges',
  specificNumbers: 'progressSummary',
  counterFactualNextSteps: 'suggestedNextSteps',
  emotionalEventsHandled: 'challenges',
  crossCycleDelta: 'patternObservations',
};

export type CritiqueLike = {
  pass: boolean;
  topFix: string | null;
  items?: Array<{
    id: string;
    pass: boolean;
    reason: string;
    fixInSections?: string[];
  }>;
};

/** Translate a critique + a list of coach review flags into the
 *  structured GutterComment[] the gutter renders. */
export function buildComments({
  critique,
  flags,
}: {
  critique: CritiqueLike | null;
  flags: Array<{ title: string; detail: string; urgency?: 'info' | 'attention' | 'urgent' }>;
}): GutterComment[] {
  const out: GutterComment[] = [];

  // Top fix sticks at the top of the gutter as a global comment.
  if (critique && !critique.pass && critique.topFix) {
    out.push({
      id: 'top-fix',
      kind: 'top-fix',
      title: 'Highest-leverage fix',
      body: critique.topFix,
      targetSection: null,
    });
  }

  if (critique?.items) {
    for (const it of critique.items) {
      if (it.pass) continue; // hide passing items in gutter (they show as a strip)
      const target =
        (it.fixInSections?.[0] && SECTION_TO_DOC[it.fixInSections[0]]) ||
        RUBRIC_DEFAULT_SECTION[it.id] ||
        null;
      out.push({
        id: `rubric:${it.id}`,
        kind: 'rubric-fail',
        title: RUBRIC_LABELS[it.id] ?? it.id,
        body: it.reason,
        targetSection: target,
      });
    }
  }

  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    out.push({
      id: `flag:${i}`,
      kind: 'flag',
      title: f.title,
      body: f.detail,
      urgency: f.urgency,
      targetSection: anchorFlagToSection(f.title),
    });
  }

  return out;
}

/** Heuristic: pick a target section based on flag title keywords. */
function anchorFlagToSection(title: string): DocumentSectionId | null {
  const t = title.toLowerCase();
  if (t.includes('goal') || t.includes('drift') || t.includes('cascade'))
    return 'goalSummary';
  if (t.includes('constraint')) return 'challenges';
  if (t.includes('emotional') || t.includes('personal') || t.includes('family'))
    return 'challenges';
  if (t.includes('journal') || t.includes('input') || t.includes('missing'))
    return 'progressSummary';
  if (t.includes('decision')) return 'suggestedNextSteps';
  if (t.includes('cross-cycle') || t.includes('pattern'))
    return 'patternObservations';
  return 'progressSummary';
}
