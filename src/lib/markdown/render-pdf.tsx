/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import * as React from 'react';
import { Text, View, StyleSheet } from '@react-pdf/renderer';
import { parseMarkdown, type Block, type Inline } from './parse';

// `Fragment` import isn't strictly needed (we use the JSX shorthand)
// but it makes the intent below explicit when we return an empty
// fragment.
const { Fragment } = React;

/**
 * React-PDF renderer for our markdown subset. Uses Helvetica family
 * variants for emphasis (the built-in PDF fonts) — no Font.register
 * needed.
 */

const styles = StyleSheet.create({
  paragraph: {
    marginBottom: 6,
  },
  bulletRow: {
    flexDirection: 'row',
    marginBottom: 4,
  },
  bulletGlyph: {
    width: 14,
    fontFamily: 'Helvetica-Bold',
  },
  bulletNumber: {
    width: 18,
    fontFamily: 'Helvetica-Bold',
  },
  bulletBody: {
    flex: 1,
  },
});

const FONT_BOLD = 'Helvetica-Bold';
const FONT_ITALIC = 'Helvetica-Oblique';
const FONT_BOLD_ITALIC = 'Helvetica-BoldOblique';

/**
 * Render an array of inline runs as a single React-PDF Text fragment.
 * Bold-inside-italic and italic-inside-bold combine into a bold-italic
 * font face — falls back to bold otherwise so emphasis never collapses
 * to plain text by accident.
 */
function renderInlines(
  runs: Inline[],
  ctx: { bold?: boolean; italic?: boolean } = {},
): React.ReactNode[] {
  // We never return `null` from here — react-pdf's reconciler crashes
  // with "Cannot read properties of null (reading 'props')" when a
  // child slot is literally null. Unrecognised run kinds become an
  // empty Text instead so the slot is still a valid PDF node.
  return runs.map((run, i) => {
    if (run.kind === 'text') {
      // Plain text inherits the active emphasis context.
      const fontFamily =
        ctx.bold && ctx.italic
          ? FONT_BOLD_ITALIC
          : ctx.bold
            ? FONT_BOLD
            : ctx.italic
              ? FONT_ITALIC
              : undefined;
      return (
        <Text key={i} style={fontFamily ? { fontFamily } : undefined}>
          {run.text}
        </Text>
      );
    }
    if (run.kind === 'bold') {
      return (
        <Fragment key={i}>
          {renderInlines(run.children, { ...ctx, bold: true })}
        </Fragment>
      );
    }
    if (run.kind === 'italic') {
      return (
        <Fragment key={i}>
          {renderInlines(run.children, { ...ctx, italic: true })}
        </Fragment>
      );
    }
    return <Text key={i} />;
  });
}

/** Render a single block (paragraph or list). */
function renderBlock(block: Block, key: number): React.ReactElement {
  if (block.kind === 'paragraph') {
    // Soft line breaks inside a paragraph are preserved as `\n` inside
    // a single Text — React-PDF respects these for line breaks.
    return (
      <View key={key} style={styles.paragraph}>
        <Text>
          {block.lines.map((line, li) => (
            <React.Fragment key={li}>
              {renderInlines(line)}
              {li < block.lines.length - 1 && '\n'}
            </React.Fragment>
          ))}
        </Text>
      </View>
    );
  }
  // List: one row per item, with bullet glyph or number column.
  return (
    <View key={key} style={{ marginBottom: 6 }}>
      {block.items.map((item, ii) => (
        <View key={ii} style={styles.bulletRow}>
          <Text style={block.ordered ? styles.bulletNumber : styles.bulletGlyph}>
            {block.ordered ? `${ii + 1}.` : '•'}
          </Text>
          <View style={styles.bulletBody}>
            <Text>{renderInlines(item)}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * Render markdown text as a stack of PDF blocks. Empty / whitespace-only
 * input renders an invisible placeholder rather than `null` — react-pdf's
 * reconciler crashes ("Cannot read properties of null (reading 'props')")
 * when a child slot is literally null, even though React itself tolerates
 * it. Callers are expected to guard at the section level; the placeholder
 * is just defence-in-depth.
 *
 * We also call `parseMarkdown` synchronously instead of through
 * `useMemo`. Hooks inside react-pdf's reconciler aren't reliable across
 * versions and this AST is cheap to rebuild.
 */
export function MarkdownPdf({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  if (blocks.length === 0) return <Text> </Text>;
  return <>{blocks.map((b, i) => renderBlock(b, i))}</>;
}
