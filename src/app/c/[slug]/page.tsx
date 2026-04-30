/**
 * Public read-only curriculum permalink (`/c/{slug}`). Used as the
 * destination for "Suggested Resources" links in the coaching emails —
 * the CEO clicks through and reads the class content without any
 * portal/auth chrome. The content is pedagogical, not personal, so
 * these pages are intentionally unauthenticated.
 *
 * We also set `noindex` so search engines don't surface them.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { marked } from 'marked';
import { db } from '@/db';
import { curriculum } from '@/db/schema';
import { eq } from 'drizzle-orm';

// Configure marked once: GFM (proper bullet/numbered lists), keep
// breaks off so paragraph spacing comes from blank lines (matches the
// extracted markdown's shape).
marked.setOptions({ gfm: true, breaks: false });

interface Props {
  params: Promise<{ slug: string }>;
}

async function loadRow(slug: string) {
  const [row] = await db
    .select()
    .from(curriculum)
    .where(eq(curriculum.slug, slug))
    .limit(1);
  return row ?? null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const row = await loadRow(slug);
  if (!row) return { title: 'Resource not found', robots: { index: false } };
  return {
    title: row.title,
    description: row.summary ?? undefined,
    robots: { index: false, follow: false },
  };
}

export default async function CurriculumPage({ params }: Props) {
  const { slug } = await params;
  const row = await loadRow(slug);
  if (!row) notFound();

  // Parse markdown server-side. The contentText is trusted (admin-
  // seeded from a controlled docx) so we skip sanitisation. marked
  // returns a HTML string; we feed it into our own typographic styles
  // below rather than relying on @tailwindcss/typography.
  const html = await marked.parse(row.contentText);

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <article className="mx-auto max-w-3xl px-6 py-10 sm:py-14">
        <header className="mb-8 border-b border-border pb-5">
          {row.kind === 'class' && row.classNumber !== null && (
            <p className="mb-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              CEO Accelerator · Class {row.classNumber}
              {row.section ? ` · ${row.section}` : ''}
            </p>
          )}
          {row.kind === 'framework' && (
            <p className="mb-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              Framework · ScaleOS
            </p>
          )}
          <h1 className="text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
            {row.title}
          </h1>
          {row.summary && (
            <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">{row.summary}</p>
          )}
        </header>

        <div
          className="curriculum-prose"
          // Curriculum is admin-seeded from a controlled docx — trusted source.
          dangerouslySetInnerHTML={{ __html: html }}
        />

        <footer className="mt-12 border-t border-border pt-4 text-[11px] text-muted-foreground">
          From the ScaleOS / CEO Accelerator program. Shared with you as part of your monthly
          coaching update.
        </footer>
      </article>
    </main>
  );
}
