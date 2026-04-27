#!/usr/bin/env node
/*
 * Extract CEO Accelerator worksheet PDFs into LLM-ready artifacts.
 *
 * Pipeline (per PDF):
 *   1. pdftotext -layout  → raw.txt   (cheap, lossless on prose)
 *   2. pdftoppm -r 150    → page-NN.png   (one image per page)
 *   3. claude -p          → structured JSON (vision-augmented; uses subscription auth)
 *   4. render             → .md and .txt for humans / embeddings
 *
 * The Claude CLI is invoked headlessly with --json-schema for structured output.
 * ANTHROPIC_API_KEY is stripped from the child env so it falls back to OAuth
 * (i.e. your Claude Max/Pro subscription) instead of API-key billing.
 *
 * Usage:
 *   node scripts/worksheets-extract.js --worksheet 1
 *   node scripts/worksheets-extract.js --all
 *   node scripts/worksheets-extract.js --worksheet 1 --force
 *   node scripts/worksheets-extract.js --worksheet 1 --model opus
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const PDF_DIR = path.join(
  REPO_ROOT,
  "core-data/CEO Accelerator Materials/CEO Accelerator concept worksheets"
);
const OUTPUT_DIR = path.join(REPO_ROOT, "core-data/CEO Accelerator Materials/extracted");
const CACHE_DIR = path.join(REPO_ROOT, "core-data/CEO Accelerator Materials/.extract-cache");

// JSON schema enforced on Claude's output. Kept permissive on optional fields
// so the same shape works across all 10 worksheets (which have different
// exercise types).
const SCHEMA = {
  type: "object",
  required: ["worksheet", "overview", "learningObjectives", "sections", "exercises"],
  properties: {
    worksheet: {
      type: "object",
      required: ["number", "title"],
      properties: {
        number: { type: "integer" },
        title: { type: "string" },
        moduleNumber: { type: "integer" },
        author: { type: "string" },
        pageCount: { type: "integer" },
      },
    },
    overview: { type: "string" },
    learningObjectives: { type: "array", items: { type: "string" } },
    sections: {
      type: "array",
      items: {
        type: "object",
        required: ["heading", "subsections"],
        properties: {
          heading: { type: "string" },
          subsections: {
            type: "array",
            items: {
              type: "object",
              required: ["body"],
              properties: {
                label: { type: "string", description: "Sidebar / key-term label, if present" },
                body: { type: "string", description: "Verbatim prose, no paraphrasing" },
                lists: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["items"],
                    properties: {
                      ordered: { type: "boolean" },
                      items: { type: "array", items: { type: "string" } },
                    },
                  },
                },
                examples: { type: "array", items: { type: "string" } },
                quotes: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["text"],
                    properties: {
                      text: { type: "string" },
                      attribution: { type: "string" },
                    },
                  },
                },
                diagram: {
                  type: "object",
                  required: ["type", "items"],
                  properties: {
                    type: {
                      type: "string",
                      description: "circle | pyramid | flow | hierarchy | other",
                    },
                    description: { type: "string" },
                    items: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
          notesPrompt: { type: "string" },
        },
      },
    },
    exercises: {
      type: "array",
      items: {
        type: "object",
        required: ["type", "title"],
        properties: {
          type: {
            type: "string",
            description:
              "reflection | self-rating | table | identity-practice | assignment | share | freeform",
          },
          title: { type: "string" },
          instructions: { type: "string" },

          // self-rating
          ratingScale: {
            type: "object",
            properties: {
              min: { type: "integer" },
              max: { type: "integer" },
              minLabel: { type: "string" },
              maxLabel: { type: "string" },
            },
          },
          categories: {
            type: "array",
            items: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string" },
                items: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["description"],
                    properties: {
                      label: { type: "string" },
                      description: { type: "string" },
                    },
                  },
                },
              },
            },
          },

          // table
          columns: { type: "array", items: { type: "string" } },
          rows: {
            type: "array",
            items: { type: "array", items: { type: "string" } },
          },

          // reflection / share
          questions: { type: "array", items: { type: "string" } },

          // identity-practice / assignment (multi-domain template)
          domains: { type: "array", items: { type: "string" } },
          rowLabels: {
            type: "array",
            items: {
              type: "object",
              required: ["label"],
              properties: {
                label: { type: "string" },
                description: { type: "string" },
                example: { type: "string" },
              },
            },
          },

          // freeform fallback
          notes: { type: "string" },
        },
      },
    },
  },
};

function slugify(name) {
  return name
    .replace(/\.pdf$/i, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function listWorksheets() {
  return fs
    .readdirSync(PDF_DIR)
    .filter((f) => /^Worksheet\s+\d+/i.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
}

function preprocess(pdfPath, slug) {
  const cacheDir = path.join(CACHE_DIR, slug);
  fs.mkdirSync(cacheDir, { recursive: true });

  const txtPath = path.join(cacheDir, "raw.txt");
  if (!fs.existsSync(txtPath)) {
    process.stderr.write("  pdftotext...\n");
    const r = spawnSync("pdftotext", ["-layout", pdfPath, txtPath]);
    if (r.status !== 0) throw new Error(`pdftotext failed: ${r.stderr.toString()}`);
  }

  const hasPages = fs.readdirSync(cacheDir).some((f) => /^page-\d+\.png$/.test(f));
  if (!hasPages) {
    process.stderr.write("  pdftoppm (rendering pages at 150dpi)...\n");
    const r = spawnSync("pdftoppm", [
      "-r",
      "150",
      "-png",
      pdfPath,
      path.join(cacheDir, "page"),
    ]);
    if (r.status !== 0) throw new Error(`pdftoppm failed: ${r.stderr.toString()}`);
  }

  const imagePaths = fs
    .readdirSync(cacheDir)
    .filter((f) => /^page-\d+\.png$/.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10))
    .map((f) => path.join(cacheDir, f));

  return { txtPath, imagePaths, cacheDir };
}

function buildPrompt(txtPath, imagePaths) {
  return `You are extracting a structured representation of a CEO coaching worksheet PDF for downstream LLM use (RAG, UI rendering, fine-tuning).

INPUTS — you MUST Read all of these before producing output:

  Raw text (layout-preserved, from pdftotext):
    ${txtPath}

  Page images (one per page; Read every single one — diagrams and tables are ONLY recoverable from these):
${imagePaths.map((p) => `    ${p}`).join("\n")}

OUTPUT — JSON conforming to the provided schema. No prose, no markdown, no commentary. Just JSON.

GUIDELINES:

- Use the raw text as ground truth for prose. Be lossless: do not paraphrase, summarize, or skip sentences. Preserve exact wording.
- Use the page images to fix what text extraction loses:
    - DIAGRAMS: circle layouts (e.g. 6 areas around a hub), pyramids (e.g. Maslow's hierarchy), flow charts. For each, set diagram.type, write a one-line description of the layout, and list every label in items.
    - TABLES: capture exact column headers and rows verbatim, including any "E.g." / example row.
    - LISTS: preserve ordered vs. unordered.
- Concept sections (the body of the module, with key-term labels in the left sidebar) go in "sections". Each subsection has a "label" (sidebar term) and "body" (the explanation on the right).
- Exercises (the back of the worksheet — Reflection, self-ratings, assignment templates, Share Your Learnings) go in "exercises" with a typed shape:
    - "reflection": numbered open-ended questions → questions[]
    - "self-rating": rating-scale exercise with categories[].items[]
    - "table": generic table with columns[] and rows[]
    - "identity-practice" / "assignment": multi-domain templates (e.g. Wealth/Work | Health | Relationships) with domains[] and rowLabels[]
    - "share": "Share Your Learnings" / discussion prompts → questions[]
    - "freeform": anything else; put prose in "notes"
- Preserve the order of sections and exercises as they appear in the PDF.
- Skip page numbers and the "TheCEO Accelerator" footer chrome on every page.
- Footer "By Eric Partaker" → worksheet.author.
- "Module #N" → worksheet.moduleNumber, and "N: Title" → worksheet.title.
`;
}

function callClaude({ prompt, addDirs, model, jsonSchema }) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(jsonSchema),
      "--model",
      model,
      "--allowedTools",
      "Read",
      "--permission-mode",
      "bypassPermissions",
      "--no-session-persistence",
      "--append-system-prompt",
      "Output STRICT JSON only — no prose, no markdown fences. Read every file the user provides; do not skip page images.",
    ];
    for (const dir of addDirs) {
      args.push("--add-dir", dir);
    }

    // Force subscription (OAuth) auth by stripping the API key from the child env.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    const child = spawn("claude", args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      const s = chunk.toString();
      stderr += s;
      process.stderr.write(s);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `claude exited with code ${code}\n--- stderr ---\n${stderr.slice(-2000)}\n--- stdout (first 2KB) ---\n${stdout.slice(0, 2000)}`
          )
        );
        return;
      }
      try {
        const wrapper = JSON.parse(stdout);
        if (wrapper.is_error) {
          reject(new Error(`claude returned error: ${wrapper.result || JSON.stringify(wrapper)}`));
          return;
        }
        // With --json-schema, the validated payload is in `structured_output`.
        // Without it, the model emits JSON-as-string into `result`.
        let inner = wrapper.structured_output;
        if (!inner && typeof wrapper.result === "string" && wrapper.result.trim()) {
          inner = JSON.parse(wrapper.result);
        }
        if (!inner) {
          reject(new Error("claude returned no structured_output and no result"));
          return;
        }
        resolve({ data: inner, meta: wrapper });
      } catch (err) {
        reject(
          new Error(
            `failed to parse claude output: ${err.message}\n--- stdout (first 2KB) ---\n${stdout.slice(0, 2000)}`
          )
        );
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function unescapeStrings(node) {
  if (typeof node === "string") {
    return node.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
  }
  if (Array.isArray(node)) return node.map(unescapeStrings);
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = unescapeStrings(v);
    return out;
  }
  return node;
}

function renderMarkdown(data) {
  const lines = [];
  const w = data.worksheet || {};
  lines.push(`# Worksheet ${w.number ?? "?"}: ${w.title ?? ""}`.trim());
  if (w.author) lines.push(`\n*By ${w.author}*`);
  lines.push("");

  if (data.overview) {
    lines.push("## Overview", "", data.overview, "");
  }

  if (Array.isArray(data.learningObjectives) && data.learningObjectives.length) {
    lines.push("## Learning Objectives", "");
    for (const obj of data.learningObjectives) lines.push(`- ${obj}`);
    lines.push("");
  }

  for (const section of data.sections || []) {
    lines.push(`## ${section.heading}`, "");
    for (const sub of section.subsections || []) {
      if (sub.label) lines.push(`### ${sub.label}`, "");
      if (sub.body) lines.push(sub.body, "");
      for (const list of sub.lists || []) {
        const items = list.items || [];
        for (let i = 0; i < items.length; i++) {
          lines.push(`${list.ordered ? `${i + 1}.` : "-"} ${items[i]}`);
        }
        lines.push("");
      }
      for (const ex of sub.examples || []) lines.push(`> Example: ${ex}`, "");
      for (const q of sub.quotes || []) {
        lines.push(`> "${q.text}"${q.attribution ? ` — ${q.attribution}` : ""}`, "");
      }
      if (sub.diagram) {
        lines.push(`**Diagram (${sub.diagram.type}):** ${sub.diagram.description ?? ""}`, "");
        for (const item of sub.diagram.items || []) lines.push(`- ${item}`);
        lines.push("");
      }
    }
    if (section.notesPrompt) lines.push(`> 📝 ${section.notesPrompt}`, "");
  }

  if (Array.isArray(data.exercises) && data.exercises.length) {
    lines.push("## Exercises and Assignments", "");
    for (const ex of data.exercises) {
      lines.push(`### ${ex.title}`, "");
      if (ex.instructions) lines.push(ex.instructions, "");

      switch (ex.type) {
        case "reflection":
        case "share": {
          const qs = ex.questions || [];
          for (let i = 0; i < qs.length; i++) {
            lines.push(`${i + 1}. ${qs[i]}`);
          }
          lines.push("");
          break;
        }
        case "self-rating": {
          if (ex.ratingScale) {
            const s = ex.ratingScale;
            lines.push(
              `Scale: ${s.min ?? "?"}–${s.max ?? "?"} (${s.minLabel ?? ""} → ${s.maxLabel ?? ""})`,
              ""
            );
          }
          for (const cat of ex.categories || []) {
            lines.push(`**${cat.name}**`, "");
            for (const item of cat.items || []) {
              const prefix = item.label ? `*${item.label}:* ` : "";
              lines.push(`- ${prefix}${item.description}`);
            }
            lines.push("");
          }
          break;
        }
        case "table": {
          if (ex.columns && ex.columns.length) {
            lines.push(`| ${ex.columns.join(" | ")} |`);
            lines.push(`| ${ex.columns.map(() => "---").join(" | ")} |`);
            for (const row of ex.rows || []) {
              const cells = row.map((c) =>
                String(c ?? "")
                  .replace(/\n/g, " ")
                  .replace(/\|/g, "\\|")
              );
              lines.push(`| ${cells.join(" | ")} |`);
            }
            lines.push("");
          }
          break;
        }
        case "identity-practice":
        case "assignment": {
          if (ex.domains && ex.rowLabels) {
            lines.push(`|  | ${ex.domains.join(" | ")} |`);
            lines.push(`| --- | ${ex.domains.map(() => "---").join(" | ")} |`);
            for (const r of ex.rowLabels) {
              const head = `**${r.label}**${r.description ? ` — ${r.description}` : ""}${
                r.example ? ` _(e.g., ${r.example})_` : ""
              }`;
              const cells = [head].concat(ex.domains.map(() => "_"));
              lines.push(`| ${cells.join(" | ")} |`);
            }
            lines.push("");
          }
          break;
        }
        default: {
          if (ex.notes) lines.push(ex.notes, "");
        }
      }
    }
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function renderText(data) {
  return renderMarkdown(data)
    .replace(/^#+\s*/gm, "")
    .replace(/\*\*/g, "")
    .replace(/(^|\W)\*(\S[^*]*\S)\*(?=\W|$)/g, "$1$2")
    .replace(/^>\s?/gm, "")
    .replace(/`([^`]+)`/g, "$1");
}

async function processOne(pdfFile, opts) {
  const slug = slugify(pdfFile);
  const pdfPath = path.join(PDF_DIR, pdfFile);
  const jsonOut = path.join(OUTPUT_DIR, `${slug}.json`);

  if (opts.rerender && fs.existsSync(jsonOut)) {
    process.stderr.write(`↻ ${slug} (re-rendering md/txt from existing JSON)\n`);
    const data = JSON.parse(fs.readFileSync(jsonOut, "utf8"));
    const cleaned = unescapeStrings(data);
    fs.writeFileSync(jsonOut, JSON.stringify(cleaned, null, 2) + "\n");
    fs.writeFileSync(path.join(OUTPUT_DIR, `${slug}.md`), renderMarkdown(cleaned));
    fs.writeFileSync(path.join(OUTPUT_DIR, `${slug}.txt`), renderText(cleaned));
    return;
  }

  if (!opts.force && fs.existsSync(jsonOut)) {
    process.stderr.write(`✓ ${slug} (already extracted; pass --force to rerun)\n`);
    return;
  }

  process.stderr.write(`→ ${slug}\n`);
  const { txtPath, imagePaths, cacheDir } = preprocess(pdfPath, slug);
  process.stderr.write(`  ${imagePaths.length} pages cached\n`);

  const prompt = buildPrompt(txtPath, imagePaths);
  process.stderr.write(`  calling claude (${opts.model})...\n`);
  const t0 = Date.now();
  const { data, meta } = await callClaude({
    prompt,
    addDirs: [cacheDir],
    model: opts.model,
    jsonSchema: SCHEMA,
  });
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  const cost = meta.cost_usd ?? meta.total_cost_usd ?? 0;
  process.stderr.write(`  ✓ ${seconds}s${cost ? `, $${cost.toFixed(3)}` : ""}\n`);

  // Models occasionally emit "\\n" (literal backslash + n) instead of a real
  // newline when constrained to JSON output. Walk all strings and undo.
  const cleaned = unescapeStrings(data);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(jsonOut, JSON.stringify(cleaned, null, 2) + "\n");
  fs.writeFileSync(path.join(OUTPUT_DIR, `${slug}.md`), renderMarkdown(cleaned));
  fs.writeFileSync(path.join(OUTPUT_DIR, `${slug}.txt`), renderText(cleaned));
  process.stderr.write(`  → ${slug}.{json,md,txt}\n`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { force: false, model: "sonnet", target: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--force") opts.force = true;
    else if (a === "--rerender") opts.rerender = true;
    else if (a === "--all") opts.target = "all";
    else if (a === "--worksheet") opts.target = args[++i];
    else if (a === "--model") opts.model = args[++i];
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: node scripts/worksheets-extract.js [--worksheet N | --all] [--force] [--model sonnet|opus]\n"
      );
      process.exit(0);
    } else {
      process.stderr.write(`Unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.target) {
    process.stderr.write("Specify --worksheet N or --all (use --help for options)\n");
    process.exit(2);
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const all = listWorksheets();
  const list =
    opts.target === "all"
      ? all
      : all.filter((f) => new RegExp(`^Worksheet\\s+${opts.target}\\b`).test(f));

  if (list.length === 0) {
    process.stderr.write(`No worksheets matched: ${opts.target}\n`);
    process.exit(1);
  }

  for (const f of list) {
    try {
      await processOne(f, opts);
    } catch (err) {
      process.stderr.write(`✗ ${f}: ${err.message}\n`);
    }
  }
}

main();
