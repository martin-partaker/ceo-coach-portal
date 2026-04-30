/**
 * Extract the bundled CEO Accelerator classes docx into one Markdown
 * file per class so we can curate the chunks before seeding the
 * curriculum table.
 *
 * Run: pnpm tsx --env-file=.env scripts/extract-curriculum.ts
 *
 * Output: core-data/CEO Accelerator Materials/extracted/class-{N}-{slug}.md
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
// `convertToMarkdown` is missing from mammoth's type bundle even though
// it ships in the runtime — cast to access it without `any`.
import mammothLib from 'mammoth';
const mammoth = mammothLib as typeof mammothLib & {
  convertToMarkdown: (
    input: { buffer: Buffer },
    opts?: { convertImage?: unknown },
  ) => Promise<{ value: string; messages: Array<{ type: string; message: string }> }>;
};

const SRC =
  'core-data/CEO Accelerator Materials/Bundled_CEO Accelerator_Classes.docx';
const OUT_DIR = 'core-data/CEO Accelerator Materials/extracted';

/**
 * Mammoth aggressively escapes punctuation (e.g. `\-`, `\.`, `\(`) and
 * leaves empty image markdown like `![]()`. Strip the noise + collapse
 * multi-blank-line runs so the output is read-friendly.
 */
function tidy(md: string): string {
  return md
    // Drop mammoth's heading-anchor tags.
    .replace(/<a id="[^"]*"><\/a>/g, '')
    // Drop empty image refs left behind by our convertImage hook.
    .replace(/!\[[^\]]*\]\(\s*\)/g, '')
    // Drop any inline data: URIs that slipped past the hook.
    .replace(/!\[[^\]]*\]\(data:[^)]+\)/g, '')
    // Unescape mammoth's punctuation backslashes (those that aren't
    // legitimate markdown escapes).
    .replace(/\\([-_+().!&'"#:|~`<>=?])/g, '$1')
    // Collapse 3+ blank lines to 2.
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Strip mammoth's `<a id="…"></a>` anchor that gets injected into every
 * heading and remove the markdown escape backslashes so the heading
 * reads cleanly.
 */
function cleanHeadingText(s: string): string {
  return s
    .replace(/<a id="[^"]*"><\/a>/g, '')
    .replace(/\\([-_+().!&'"])/g, '$1')
    // Strip surrounding bold markers ("__Title__" / "**Title**").
    .replace(/^\*\*(.+)\*\*$/, '$1')
    .replace(/^__(.+)__$/, '$1')
    .trim();
}

/**
 * Recognise H2s that are just dangling time markers ("- 15 mins",
 * "5 mins", "(buffer if running behind)"). These are noise — fold their
 * content into the previous real section so the chunked output reads
 * sensibly.
 */
function looksLikeTimeMarker(section: string): boolean {
  const s = section.trim().replace(/^[-–—\s]+/, '');
  return /^\d+\s*(min|mins|minutes?)\b/i.test(s) || s.length === 0;
}

/**
 * Split a flat markdown blob into per-class chunks. The bundled docx
 * uses H1s like `# 1: Develop the Mindset of a World-Class CEO` as
 * class delimiters (mammoth emits an `<a id="…"></a>` anchor right
 * after the `#`). We treat anything before the first H1 class header
 * as front matter and discard.
 */
function splitByClass(md: string): Array<{ n: number; title: string; body: string }> {
  const lines = md.split('\n');
  const classes: Array<{ n: number; title: string; body: string[] }> = [];
  let current: { n: number; title: string; body: string[] } | null = null;

  for (const line of lines) {
    // Class headers are H1s shaped like:
    //   # <a id="_xxx"></a>1: Title…
    // We deliberately do NOT accept H2/H3/inline matches — those are
    // the competency-framework list items ("1: Entry", "2: Developing")
    // and other numbered content inside a class.
    const m = line.match(/^#\s+(?:<a id="[^"]*"><\/a>)?(\d{1,2}):\s*(.+?)\s*$/);
    if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) {
      if (current) classes.push(current);
      current = { n: Number(m[1]), title: cleanHeadingText(m[2]), body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) classes.push(current);

  return classes.map((c) => ({
    n: c.n,
    title: c.title,
    body: c.body.join('\n').trim(),
  }));
}

/**
 * Within a class body, split by H2 heading. Mammoth emits each H2 with
 * an anchor. We strip the anchor and clean up backslash escapes so the
 * resulting markdown reads naturally. Returned shape mirrors what we'll
 * eventually seed into `curriculum`: one chunk per H2 section.
 */
interface Chunk {
  section: string;   // section title (cleaned H2 text)
  slug: string;
  contentText: string;
}

function chunkClassBody(body: string): Chunk[] {
  const lines = body.split('\n');
  const chunks: Array<{ section: string; lines: string[] }> = [];
  let current: { section: string; lines: string[] } | null = null;

  for (const line of lines) {
    const h2 = line.match(/^##\s+(?:<a id="[^"]*"><\/a>)?(.+?)\s*$/);
    if (h2) {
      const section = cleanHeadingText(h2[1]);
      // Time-marker H2s ("- 15 mins") are noise — fold their content
      // into the previous section instead of starting a new chunk.
      if (looksLikeTimeMarker(section)) {
        if (current) current.lines.push('', `_${section}_`);
        continue;
      }
      if (current) chunks.push(current);
      current = { section, lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
    else {
      // Pre-H2 prose: wrap as an "Overview" chunk.
      if (chunks.length === 0 && line.trim()) {
        current = { section: 'Overview', lines: [line] };
      }
    }
  }
  if (current) chunks.push(current);

  return chunks
    .map((c) => ({
      section: c.section,
      slug: slugify(c.section),
      contentText: c.lines.join('\n').trim(),
    }))
    .filter((c) => c.contentText.length > 40); // drop bare time-markers
}

async function main() {
  const repoRoot = process.cwd();
  const srcPath = path.join(repoRoot, SRC);
  const outDir = path.join(repoRoot, OUT_DIR);

  await fs.mkdir(outDir, { recursive: true });

  console.log(`Reading ${srcPath}…`);
  const buf = await fs.readFile(srcPath);

  // Use convertToMarkdown so the output is something a human can read +
  // edit. The default style map promotes Heading1 → "# ", Heading2 →
  // "## ", etc., which is exactly what we need for downstream chunking.
  // We drop image bytes — they balloon the file by ~12MB and aren't
  // useful for AI prompt context.
  // The `convertImage` option is accepted at runtime but not declared
  // on mammoth's input type — squeeze it in via the second arg.
  const result = await mammoth.convertToMarkdown(
    { buffer: buf },
    { convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: '' })) },
  );
  if (result.messages.length > 0) {
    console.log(`mammoth produced ${result.messages.length} warning(s):`);
    for (const m of result.messages.slice(0, 5)) {
      console.log(`  ${m.type}: ${m.message}`);
    }
  }

  const fullMd = tidy(result.value);
  const fullPath = path.join(outDir, '_full.md');
  await fs.writeFile(fullPath, fullMd, 'utf8');
  console.log(`wrote ${fullPath} (${fullMd.length.toLocaleString()} chars)`);

  const classes = splitByClass(fullMd);
  console.log(`\nfound ${classes.length} class block(s):`);

  // Also emit a single index.json that summarises every class and chunk
  // so the seeding step (which we'll write next) doesn't have to re-parse
  // markdown — it just consumes the JSON.
  const indexEntries: Array<{
    classNumber: number;
    classTitle: string;
    chunks: Chunk[];
  }> = [];

  for (const c of classes) {
    const slug = slugify(c.title);
    const file = path.join(outDir, `class-${String(c.n).padStart(2, '0')}-${slug}.md`);
    const chunks = chunkClassBody(c.body);
    const header = `# Class ${c.n}: ${c.title}\n\n_${chunks.length} chunk(s) detected._\n\n`;
    await fs.writeFile(file, header + c.body, 'utf8');
    indexEntries.push({ classNumber: c.n, classTitle: c.title, chunks });
    console.log(
      `  ${String(c.n).padStart(2, ' ')}. ${c.title}  (${c.body.length.toLocaleString()} chars, ${chunks.length} chunks) → ${path.relative(repoRoot, file)}`,
    );
  }

  const indexPath = path.join(outDir, 'index.json');
  await fs.writeFile(indexPath, JSON.stringify(indexEntries, null, 2), 'utf8');
  console.log(`\nwrote ${path.relative(repoRoot, indexPath)} (${indexEntries.reduce((n, e) => n + e.chunks.length, 0)} chunks total)`);

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
