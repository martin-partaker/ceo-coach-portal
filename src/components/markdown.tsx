'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import {
  parseMarkdown,
  type Block,
  type Inline,
} from '@/lib/markdown/parse';

/**
 * On-screen markdown renderer. Mirrors the PDF renderer 1:1 using the
 * same parser, so what the coach sees in the report drawer is what the
 * PDF will produce.
 */

function renderInlines(runs: Inline[]): React.ReactNode {
  return runs.map((run, i) => {
    if (run.kind === 'text') return <React.Fragment key={i}>{run.text}</React.Fragment>;
    if (run.kind === 'bold')
      return (
        <strong key={i} className="font-semibold text-foreground">
          {renderInlines(run.children)}
        </strong>
      );
    if (run.kind === 'italic')
      return (
        <em key={i} className="italic">
          {renderInlines(run.children)}
        </em>
      );
    return null;
  });
}

function renderBlock(block: Block, key: number): React.ReactElement {
  if (block.kind === 'paragraph') {
    return (
      <p key={key} className="leading-relaxed text-foreground/90">
        {block.lines.map((line, li) => (
          <React.Fragment key={li}>
            {renderInlines(line)}
            {li < block.lines.length - 1 && <br />}
          </React.Fragment>
        ))}
      </p>
    );
  }
  if (block.ordered) {
    return (
      <ol key={key} className="grid gap-1.5 leading-relaxed text-foreground/90">
        {block.items.map((item, ii) => (
          <li key={ii} className="flex gap-2.5">
            <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-foreground/10 font-mono text-[10px] tabular-nums text-foreground/70">
              {ii + 1}
            </span>
            <span>{renderInlines(item)}</span>
          </li>
        ))}
      </ol>
    );
  }
  return (
    <ul key={key} className="grid gap-1.5 leading-relaxed text-foreground/90">
      {block.items.map((item, ii) => (
        <li key={ii} className="flex gap-2.5">
          <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/40" />
          <span>{renderInlines(item)}</span>
        </li>
      ))}
    </ul>
  );
}

interface Props {
  text: string;
  /** Optional extra classes on the wrapping div. */
  className?: string;
  /** Default `text-[13px]` matches the existing Prose component. */
  size?: 'sm' | 'base';
}

/** Render markdown text with paragraph, list, bold, italic, and soft
 *  line break support. Empty text → nothing. */
export function Markdown({ text, className, size = 'sm' }: Props) {
  const blocks = React.useMemo(() => parseMarkdown(text), [text]);
  if (blocks.length === 0) return null;
  return (
    <div
      className={cn(
        'grid gap-3',
        size === 'sm' ? 'text-[13px]' : 'text-sm',
        className,
      )}
    >
      {blocks.map((b, i) => renderBlock(b, i))}
    </div>
  );
}

/**
 * Render a single inline span with bold/italic support — used inside
 * existing list-row layouts where we already control bullet chrome and
 * just need the text to support emphasis.
 */
export function MarkdownInline({ text }: { text: string }) {
  const runs = React.useMemo(() => {
    const blocks = parseMarkdown(text);
    if (blocks.length === 0) return [] as Inline[];
    if (blocks[0].kind === 'paragraph') {
      // Flatten all soft-broken lines into one run array.
      return blocks[0].lines.flat();
    }
    return [] as Inline[];
  }, [text]);
  if (runs.length === 0) return <>{text}</>;
  return <>{renderInlines(runs)}</>;
}
