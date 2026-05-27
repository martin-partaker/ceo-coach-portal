/**
 * Tiny Markdown subset parser. We parse only what the AI actually emits:
 *
 *  - paragraphs (separated by blank lines, soft line breaks preserved)
 *  - bullet lists  (`- `, `* `, or `• `)
 *  - numbered lists (`1.` / `1)`)
 *  - inline bold (`**foo**`)
 *  - inline italic (`*foo*`, `_foo_`)
 *  - inline code is intentionally NOT parsed — it never shows up in our
 *    coaching prose and supporting it would add edge cases.
 *
 * Output is a small, render-target-agnostic AST that both the PDF
 * renderer and the on-screen renderer consume. Keeping the parser
 * shared means the two surfaces can never disagree on what bold means.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; children: Inline[] }
  | { kind: 'italic'; children: Inline[] };

export type TableAlign = 'left' | 'center' | 'right' | null;
export type Block =
  | { kind: 'paragraph'; lines: Inline[][] }
  | {
      kind: 'list';
      ordered: boolean;
      items: Inline[][];
    }
  | {
      kind: 'table';
      header: Inline[][];
      align: TableAlign[];
      rows: Inline[][][];
    };

/**
 * Top-level: split `text` into blocks. A block is either a list (one
 * or more consecutive bullet/numbered lines) or a paragraph (one or
 * more consecutive non-bullet lines, with single newlines preserved as
 * soft breaks). Blank lines start a new block.
 */
export function parseMarkdown(text: string): Block[] {
  if (!text) return [];
  const normalised = text.replace(/\r\n?/g, '\n').trimEnd();
  const lines = normalised.split('\n');

  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    // GitHub-flavored markdown table: header row | separator | body rows.
    // We detect by looking ahead — the current line must be pipe-delimited
    // AND the next line must be a separator row (`|---|---|` etc.). Without
    // both we treat the line as a normal paragraph (so isolated lines with
    // pipes don't get misinterpreted as one-row tables).
    if (isTableHeader(line, lines[i + 1])) {
      const header = parseTableRow(line);
      const align = parseTableAlign(lines[i + 1], header.length);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(parseTableRow(lines[i]));
        i++;
      }
      blocks.push({ kind: 'table', header, align, rows });
      continue;
    }
    const bullet = matchBullet(line);
    if (bullet) {
      // Consume consecutive bullets of the same ordering.
      const ordered = bullet.ordered;
      const items: Inline[][] = [];
      while (i < lines.length) {
        const m = matchBullet(lines[i]);
        if (!m) break;
        if (m.ordered !== ordered) break;
        items.push(parseInline(m.body));
        i++;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    // Paragraph: collect consecutive non-blank, non-bullet lines.
    const paraLines: Inline[][] = [];
    while (i < lines.length) {
      const cur = lines[i];
      if (cur.trim() === '') break;
      if (matchBullet(cur)) break;
      paraLines.push(parseInline(cur));
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({ kind: 'paragraph', lines: paraLines });
    }
  }

  return blocks;
}

/** A row is "table-shaped" if it has at least one pipe and contains a
 *  non-pipe character somewhere (excludes the separator row). */
function isTableHeader(line: string, next: string | undefined): boolean {
  if (!line || !line.includes('|')) return false;
  if (!next) return false;
  // Separator row: `|---|---|` with optional `:` alignment markers and
  // optional leading/trailing pipes.
  const sep = next.trim();
  if (!sep) return false;
  // Strip optional leading/trailing pipe, then every cell must be
  // dashes-only with optional colon alignment markers.
  const cells = sep.replace(/^\||\|$/g, '').split('|');
  if (cells.length < 1) return false;
  return cells.every((c) => /^\s*:?-+:?\s*$/.test(c));
}

function parseTableRow(line: string): Inline[][] {
  // Strip a single leading and trailing pipe, then split on `|`.
  // Embedded `|` inside cells is not supported (rare in coaching prose).
  const trimmed = line.trim().replace(/^\||\|$/g, '');
  return trimmed.split('|').map((c) => parseInline(c.trim()));
}

function parseTableAlign(line: string, columnCount: number): TableAlign[] {
  const cells = line.trim().replace(/^\||\|$/g, '').split('|');
  const align: TableAlign[] = cells.map((raw) => {
    const c = raw.trim();
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
  // Pad / truncate to match the header column count so the renderer can
  // index align[col] without a bounds check.
  while (align.length < columnCount) align.push(null);
  return align.slice(0, columnCount);
}

function matchBullet(line: string): { ordered: boolean; body: string } | null {
  // Bullet chars: `-`, `*`, `•`. Avoid catching emphasis-only lines like
  // "*hello*" by requiring whitespace AFTER the bullet glyph.
  const m1 = /^\s*([-*•])\s+(.*)$/.exec(line);
  if (m1) return { ordered: false, body: m1[2] };
  const m2 = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
  if (m2) return { ordered: true, body: m2[2] };
  return null;
}

/**
 * Inline pass: parse `**bold**`, `*italic*`, `_italic_` runs out of a
 * line. Plain text falls through as `text` runs.
 *
 * Greedy-but-bounded: we match the **shortest** span between two bold
 * or italic markers so adjacent runs don't accidentally collapse into
 * one ("**a** **b**" → two bolds, not one).
 */
export function parseInline(text: string): Inline[] {
  const runs: Inline[] = [];
  let rest = text;
  while (rest.length > 0) {
    // Bold first — `**` would otherwise match as two single-`*` italics.
    const bold = /\*\*(.+?)\*\*/.exec(rest);
    const italicAst = /(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)/.exec(rest);
    const italicUnd = /(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/.exec(rest);

    // Pick the earliest match of any flavour.
    const candidates = [
      bold ? { m: bold, kind: 'bold' as const } : null,
      italicAst ? { m: italicAst, kind: 'italic' as const } : null,
      italicUnd ? { m: italicUnd, kind: 'italic' as const } : null,
    ].filter((c): c is { m: RegExpExecArray; kind: 'bold' | 'italic' } => c !== null);

    if (candidates.length === 0) {
      runs.push({ kind: 'text', text: rest });
      break;
    }
    candidates.sort((a, b) => a.m.index - b.m.index);
    const { m, kind } = candidates[0];

    if (m.index > 0) {
      runs.push({ kind: 'text', text: rest.slice(0, m.index) });
    }
    runs.push({ kind, children: parseInline(m[1]) });
    rest = rest.slice(m.index + m[0].length);
  }
  return runs;
}

/** Flatten an inline tree to plain text — used for copy/paste paths
 *  that don't care about formatting. */
export function inlineToPlainText(runs: Inline[]): string {
  return runs
    .map((r) => {
      if (r.kind === 'text') return r.text;
      return inlineToPlainText(r.children);
    })
    .join('');
}
