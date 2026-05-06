'use client';

import { useEffect, useState, useLayoutEffect } from 'react';
import { cn } from '@/lib/utils';
import {
  AlertCircle,
  AlertTriangle,
  Check,
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
  // Total document height — used so the gutter's relative container
  // extends far enough that absolutely-positioned comments at the
  // bottom remain inside their parent (and thus inside the scroll).
  const [containerHeight, setContainerHeight] = useState<number>(600);

  // Re-measure on layout, on resize, and whenever comments change.
  useLayoutEffect(() => {
    if (!documentContainer) return;
    const measure = () => {
      const containerRect = documentContainer.getBoundingClientRect();
      setContainerHeight(documentContainer.offsetHeight);
      const out: Record<string, number> = {};
      // Sort comments so deterministic stacking order — global first,
      // then by document order of their target sections.
      const ordered = [...comments].sort((a, b) => {
        if (!a.targetSection && b.targetSection) return -1;
        if (a.targetSection && !b.targetSection) return 1;
        return 0;
      });
      const placed: Array<{ top: number; height: number }> = [];
      const COMMENT_HEIGHT_EST = 96; // includes margin
      const MIN_GAP = 8;
      for (const c of ordered) {
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
        placed.push({ top: candidate, height: COMMENT_HEIGHT_EST });
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
  }, [documentContainer, comments]);

  if (comments.length === 0) {
    return (
      <aside className="hidden w-72 shrink-0 px-3 lg:block">
        <p className="mt-4 text-[11px] text-muted-foreground/60">
          No comments. Looks clean.
        </p>
      </aside>
    );
  }

  return (
    <aside className="relative hidden w-72 shrink-0 px-3 lg:block">
      <div className="sticky top-2 z-10 mb-2 flex items-center gap-1.5 rounded-md bg-muted/40 px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur">
        <MessageSquare className="h-3 w-3" />
        Comments ({comments.length})
      </div>
      <div className="relative" style={{ minHeight: `${containerHeight}px` }}>
        {comments.map((c) => (
          <CommentCard
            key={c.id}
            comment={c}
            top={tops[c.id] ?? 0}
            onHover={() => onHoverSection?.(c.targetSection)}
            onLeave={() => onHoverSection?.(null)}
            onClick={() => onCommentClick?.(c)}
          />
        ))}
      </div>
    </aside>
  );
}

function CommentCard({
  comment: c,
  top,
  onHover,
  onLeave,
  onClick,
}: {
  comment: GutterComment;
  top: number;
  onHover: () => void;
  onLeave: () => void;
  onClick: () => void;
}) {
  const { Icon, accent, label } = kindStyle(c.kind, c.urgency);
  return (
    <div
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      onClick={onClick}
      className={cn(
        'absolute left-0 right-0 cursor-pointer rounded-md border px-2.5 py-2 text-[11.5px] leading-snug shadow-sm transition-all',
        accent,
        'hover:translate-x-[-2px] hover:shadow-md',
      )}
      style={{ top: `${top}px` }}
    >
      <div className="flex items-start gap-1.5">
        <Icon className="mt-0.5 h-3 w-3 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider opacity-70">
            {label}
          </p>
          <p className="mt-0.5 font-medium">{c.title}</p>
          <p className="mt-1 line-clamp-3 opacity-80">{c.body}</p>
        </div>
      </div>
    </div>
  );
}

function kindStyle(kind: CommentKind, urgency?: 'info' | 'attention' | 'urgent') {
  if (kind === 'rubric-pass') {
    return {
      Icon: Check,
      accent:
        'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400',
      label: 'Rubric ✓',
    };
  }
  if (kind === 'rubric-fail') {
    return {
      Icon: AlertTriangle,
      accent:
        'border-amber-500/40 bg-amber-500/8 text-amber-800 dark:text-amber-300',
      label: 'Rubric needs work',
    };
  }
  if (kind === 'top-fix') {
    return {
      Icon: Sparkles,
      accent:
        'border-blue-500/40 bg-blue-500/8 text-blue-800 dark:text-blue-300',
      label: 'Top fix',
    };
  }
  // flag
  if (urgency === 'urgent') {
    return {
      Icon: AlertCircle,
      accent: 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300',
      label: 'Coach review · urgent',
    };
  }
  if (urgency === 'info') {
    return {
      Icon: Info,
      accent: 'border-blue-500/30 bg-blue-500/5 text-blue-700 dark:text-blue-300',
      label: 'Coach review',
    };
  }
  return {
    Icon: Pin,
    accent:
      'border-amber-500/40 bg-amber-500/8 text-amber-800 dark:text-amber-300',
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
