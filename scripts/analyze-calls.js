#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("node:fs");
const path = require("node:path");

function loadDotEnv(envPath) {
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies, global-require
    require("dotenv").config({ path: envPath });
  } catch (err) {
    if (err && err.code !== "MODULE_NOT_FOUND") throw err;
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}

loadDotEnv(path.resolve(__dirname, "..", ".env"));

function parseArgs(argv) {
  const args = {
    inputDir: path.resolve(__dirname, "..", "transcripts"),
    outDir: path.resolve(__dirname, "..", "analysis"),
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    concurrency: 2,
    maxCharsPerChunk: 12000,
    only: null,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input" || a === "-i") args.inputDir = path.resolve(argv[++i]);
    else if (a === "--out" || a === "-o") args.outDir = path.resolve(argv[++i]);
    else if (a === "--model" || a === "-m") args.model = argv[++i];
    else if (a === "--concurrency" || a === "-c") args.concurrency = Number(argv[++i] || 2);
    else if (a === "--max-chars") args.maxCharsPerChunk = Number(argv[++i] || 12000);
    else if (a === "--only") args.only = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        [
          "Analyze Zoom .vtt transcripts with OpenAI.",
          "",
          "Usage:",
          "  node scripts/analyze-calls.js [options]",
          "",
          "Options:",
          "  --input, -i <dir>         Input directory (default: transcripts/)",
          "  --out, -o <dir>           Output directory (default: analysis/)",
          "  --model, -m <model>       OpenAI model (default: OPENAI_MODEL or gpt-4.1-mini)",
          "  --concurrency, -c <n>     Parallel calls (default: 2)",
          "  --max-chars <n>           Max transcript chars per chunk (default: 12000)",
          "  --only <substring>        Only analyze files containing substring",
          "  --dry-run                 Parse + plan, but do not call OpenAI",
          "",
          "Env vars:",
          "  OPENAI_API_KEY            Required",
          "  OPENAI_MODEL              Optional (overrides default model)",
        ].join("\n")
      );
      process.exit(0);
    }
  }

  if (!Number.isFinite(args.concurrency) || args.concurrency < 1) args.concurrency = 1;
  if (!Number.isFinite(args.maxCharsPerChunk) || args.maxCharsPerChunk < 2000) {
    args.maxCharsPerChunk = 12000;
  }

  return args;
}

function safeMkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function listVttFiles(inputDir) {
  const entries = fs.readdirSync(inputDir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.toLowerCase().endsWith(".vtt")) continue;
    files.push(path.join(inputDir, e.name));
  }
  files.sort();
  return files;
}

function normalizeWhitespace(s) {
  return s.replace(/[ \t]+/g, " ").replace(/\s+\n/g, "\n").trim();
}

function parseVtt(vttText) {
  // Minimal VTT parser for Zoom transcripts (speaker: text lines).
  const lines = vttText.split(/\r?\n/);
  const cues = [];
  let i = 0;

  // Skip WEBVTT header + possible metadata lines until first blank line.
  if (lines[0]?.startsWith("WEBVTT")) i++;
  while (i < lines.length && lines[i].trim() !== "") i++;
  while (i < lines.length && lines[i].trim() === "") i++;

  while (i < lines.length) {
    // Optional cue number.
    if (/^\d+$/.test(lines[i]?.trim() || "")) i++;
    const ts = lines[i] || "";
    const tsMatch = ts.match(
      /^(\d{2}:\d{2}:\d{2}\.\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}\.\d{3})/
    );
    if (!tsMatch) {
      i++;
      continue;
    }
    const start = tsMatch[1];
    const end = tsMatch[2];
    i++;

    const textLines = [];
    while (i < lines.length && lines[i].trim() !== "") {
      textLines.push(lines[i]);
      i++;
    }
    while (i < lines.length && lines[i].trim() === "") i++;

    const rawText = normalizeWhitespace(textLines.join("\n"));
    if (!rawText) continue;

    // Zoom tends to prefix with "Speaker: ..."
    let speaker = null;
    let text = rawText;
    const colonIdx = rawText.indexOf(":");
    if (colonIdx > 0 && colonIdx < 80) {
      const left = rawText.slice(0, colonIdx).trim();
      const right = rawText.slice(colonIdx + 1).trim();
      if (left && right) {
        speaker = left;
        text = right;
      }
    }

    cues.push({ start, end, speaker, text });
  }

  return cues;
}

function cuesToTranscriptText(cues) {
  // Keep speaker tags because they improve downstream extraction.
  // Avoid timestamps to reduce token load; retain order.
  const out = [];
  for (const c of cues) {
    const line = c.speaker ? `${c.speaker}: ${c.text}` : c.text;
    out.push(line);
  }
  return normalizeWhitespace(out.join("\n"));
}

function chunkText(text, maxChars) {
  if (text.length <= maxChars) return [text];

  const chunks = [];
  const lines = text.split("\n");
  let buf = [];
  let bufLen = 0;

  for (const line of lines) {
    const addLen = line.length + 1;
    if (bufLen + addLen > maxChars && buf.length) {
      chunks.push(buf.join("\n"));
      buf = [];
      bufLen = 0;
    }
    buf.push(line);
    bufLen += addLen;
  }
  if (buf.length) chunks.push(buf.join("\n"));
  return chunks;
}

function readJsonIfExists(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function filenameBase(p) {
  const b = path.basename(p);
  return b.replace(/\.vtt$/i, "");
}

function redactPotentialEmails(s) {
  return s.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]");
}

function buildMeetingContext(metadata) {
  const meeting = metadata?.meeting || {};
  const participants = Array.isArray(metadata?.participants) ? metadata.participants : [];
  const participantNames = participants
    .map((p) => p?.name)
    .filter(Boolean)
    .slice(0, 50);

  const ctx = {
    topic: meeting.topic || null,
    start_time: meeting.start_time || null,
    duration_minutes: meeting.duration ?? null,
    participants: participantNames,
  };
  return ctx;
}

function jsonSchemaPrompt() {
  // Ask for strict JSON to keep outputs machine-readable.
  return `
Return ONLY valid JSON (no markdown, no code fences).

Schema:
{
  "title": string | null,
  "one_liner": string,
  "summary": string,
  "key_topics": string[],
  "decisions": string[],
  "action_items": { "owner": string | null, "item": string, "due": string | null }[],
  "people_mentioned": { "name": string, "context": string }[],
  "companies_products_tools": { "name": string, "context": string }[],
  "interesting_moments": string[],
  "risks_or_concerns": string[],
  "quotes": { "speaker": string | null, "quote": string }[],
  "overall_sentiment": "positive" | "neutral" | "mixed" | "negative",
  "coaching_observations": string[],
  "raw_notes": string[]
}

Constraints:
- Keep names as they appear in the transcript when possible.
- If uncertain, omit rather than hallucinate.
- "quotes" must be verbatim short excerpts from the transcript.
`.trim();
}

async function openaiJson({ apiKey, model, meetingContext, chunkTexts }) {
  const input = [
    {
      role: "system",
      content:
        "You analyze call transcripts for summaries, people, topics, and notable insights. Be factual; do not invent details.",
    },
    {
      role: "user",
      content: [
        "Meeting context (metadata):",
        JSON.stringify(meetingContext, null, 2),
        "",
        jsonSchemaPrompt(),
        "",
        "Transcript chunks (in order):",
        ...chunkTexts.map((t, idx) => `--- CHUNK ${idx + 1}/${chunkTexts.length} ---\n${t}`),
      ].join("\n"),
    },
  ];

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input,
      temperature: 0.2,
    }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      `OpenAI request failed (${res.status}): ${JSON.stringify(data)?.slice(0, 500) || "unknown"}`
    );
  }

  const extractText = (resp) => {
    if (resp?.output_text && typeof resp.output_text === "string") return resp.output_text;
    const out = resp?.output;
    if (!Array.isArray(out)) return null;
    const parts = [];
    for (const item of out) {
      if (item?.type !== "message") continue;
      if (!Array.isArray(item?.content)) continue;
      for (const c of item.content) {
        if (!c) continue;
        if (c.type === "output_text" && typeof c.text === "string") parts.push(c.text);
        else if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
        else if (typeof c === "string") parts.push(c);
      }
    }
    return parts.length ? parts.join("\n") : null;
  };

  const text = extractText(data);
  if (!text || typeof text !== "string") {
    throw new Error(
      `OpenAI response missing text content: ${JSON.stringify(data)?.slice(0, 500) || "unknown"}`
    );
  }

  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    // Attempt to salvage first/last JSON braces.
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      const candidate = trimmed.slice(first, last + 1);
      return JSON.parse(candidate);
    }
    throw new Error(`Failed to parse JSON from model output: ${e.message}`);
  }
}

function toMarkdown({ base, vttPath, metadata, analysisJson }) {
  const meeting = metadata?.meeting || {};
  const participants = Array.isArray(metadata?.participants) ? metadata.participants : [];
  const participantNames = participants.map((p) => p?.name).filter(Boolean);

  const lines = [];
  lines.push(`# ${analysisJson.title || meeting.topic || base}`);
  lines.push("");
  lines.push(`- **File**: \`${path.basename(vttPath)}\``);
  if (meeting.start_time) lines.push(`- **Start**: ${meeting.start_time}`);
  if (meeting.duration != null) lines.push(`- **Duration**: ${meeting.duration} min`);
  if (participantNames.length) lines.push(`- **Participants (Zoom)**: ${participantNames.join(", ")}`);
  lines.push("");

  lines.push(`## One-liner`);
  lines.push("");
  lines.push(analysisJson.one_liner || "");
  lines.push("");

  lines.push(`## Summary`);
  lines.push("");
  lines.push(analysisJson.summary || "");
  lines.push("");

  const sections = [
    ["Key topics", analysisJson.key_topics],
    ["Decisions", analysisJson.decisions],
    ["Interesting moments", analysisJson.interesting_moments],
    ["Risks / concerns", analysisJson.risks_or_concerns],
    ["Coaching observations", analysisJson.coaching_observations],
  ];

  for (const [title, arr] of sections) {
    if (!Array.isArray(arr) || arr.length === 0) continue;
    lines.push(`## ${title}`);
    lines.push("");
    for (const item of arr) lines.push(`- ${item}`);
    lines.push("");
  }

  if (Array.isArray(analysisJson.action_items) && analysisJson.action_items.length) {
    lines.push(`## Action items`);
    lines.push("");
    for (const a of analysisJson.action_items) {
      const owner = a.owner ? `**${a.owner}**: ` : "";
      const due = a.due ? ` (due: ${a.due})` : "";
      lines.push(`- ${owner}${a.item}${due}`);
    }
    lines.push("");
  }

  if (Array.isArray(analysisJson.people_mentioned) && analysisJson.people_mentioned.length) {
    lines.push(`## People mentioned`);
    lines.push("");
    for (const p of analysisJson.people_mentioned) lines.push(`- **${p.name}**: ${p.context}`);
    lines.push("");
  }

  if (
    Array.isArray(analysisJson.companies_products_tools) &&
    analysisJson.companies_products_tools.length
  ) {
    lines.push(`## Companies / products / tools`);
    lines.push("");
    for (const c of analysisJson.companies_products_tools) lines.push(`- **${c.name}**: ${c.context}`);
    lines.push("");
  }

  if (Array.isArray(analysisJson.quotes) && analysisJson.quotes.length) {
    lines.push(`## Notable quotes`);
    lines.push("");
    for (const q of analysisJson.quotes.slice(0, 10)) {
      const sp = q.speaker ? `**${q.speaker}**: ` : "";
      lines.push(`- ${sp}"${q.quote}"`);
    }
    lines.push("");
  }

  lines.push(`## Sentiment`);
  lines.push("");
  lines.push(analysisJson.overall_sentiment || "neutral");
  lines.push("");

  return lines.join("\n");
}

async function mapLimit(items, limit, fn) {
  const ret = [];
  const executing = new Set();
  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    ret.push(p);
    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean, clean);
    if (executing.size >= limit) await Promise.race(executing);
  }
  return Promise.all(ret);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.OPENAI_API_KEY;
  if (!args.dryRun && !apiKey) {
    console.error("Missing OPENAI_API_KEY (set it in .env or your shell).");
    process.exit(1);
  }

  if (!fs.existsSync(args.inputDir)) {
    console.error(`Input directory not found: ${args.inputDir}`);
    process.exit(1);
  }

  safeMkdirp(args.outDir);
  const perCallDir = path.join(args.outDir, "calls");
  safeMkdirp(perCallDir);

  const vttFiles = listVttFiles(args.inputDir).filter((p) =>
    args.only ? path.basename(p).includes(args.only) : true
  );
  if (!vttFiles.length) {
    console.log("No .vtt files found to analyze.");
    return;
  }

  console.log(`Found ${vttFiles.length} transcript(s). Model: ${args.model}.`);

  const results = [];

  await mapLimit(vttFiles, args.concurrency, async (vttPath) => {
    const base = filenameBase(vttPath);
    const metadataPath = `${vttPath}.json`;
    const metadata = readJsonIfExists(metadataPath);

    const rawVtt = fs.readFileSync(vttPath, "utf8");
    const cues = parseVtt(rawVtt);
    const transcriptText = cuesToTranscriptText(cues);

    const meetingContext = buildMeetingContext(metadata);
    const chunkTexts = chunkText(transcriptText, args.maxCharsPerChunk).map(redactPotentialEmails);

    const outJsonPath = path.join(perCallDir, `${base}.analysis.json`);
    const outMdPath = path.join(perCallDir, `${base}.summary.md`);

    if (args.dryRun) {
      console.log(`(dry-run) Would analyze: ${path.basename(vttPath)} (${chunkTexts.length} chunk(s))`);
      results.push({
        base,
        vtt: path.basename(vttPath),
        meeting: meetingContext,
        outJson: path.relative(args.outDir, outJsonPath),
        outMd: path.relative(args.outDir, outMdPath),
      });
      return;
    }

    console.log(`Analyzing: ${path.basename(vttPath)} (${chunkTexts.length} chunk(s))`);
    const analysisJson = await openaiJson({
      apiKey,
      model: args.model,
      meetingContext,
      chunkTexts,
    });

    fs.writeFileSync(outJsonPath, JSON.stringify(analysisJson, null, 2) + "\n", "utf8");
    fs.writeFileSync(outMdPath, toMarkdown({ base, vttPath, metadata, analysisJson }), "utf8");

    results.push({
      base,
      vtt: path.basename(vttPath),
      meeting: meetingContext,
      sentiment: analysisJson.overall_sentiment,
      one_liner: analysisJson.one_liner,
      outJson: path.relative(args.outDir, outJsonPath),
      outMd: path.relative(args.outDir, outMdPath),
    });
  });

  results.sort((a, b) => a.vtt.localeCompare(b.vtt));

  const indexLines = [];
  indexLines.push(`# Call analysis`);
  indexLines.push("");
  indexLines.push(`Generated at: ${new Date().toISOString()}`);
  indexLines.push("");
  indexLines.push(`## Calls`);
  indexLines.push("");
  for (const r of results) {
    const title = r.meeting?.topic || r.base;
    indexLines.push(`- **${title}**`);
    indexLines.push(`  - Transcript: \`${r.vtt}\``);
    if (r.one_liner) indexLines.push(`  - One-liner: ${r.one_liner}`);
    if (r.sentiment) indexLines.push(`  - Sentiment: ${r.sentiment}`);
    indexLines.push(`  - Summary: \`${r.outMd}\``);
    indexLines.push(`  - JSON: \`${r.outJson}\``);
  }
  indexLines.push("");

  fs.writeFileSync(path.join(args.outDir, "README.md"), indexLines.join("\n"), "utf8");

  console.log(`\nDone. Wrote outputs to: ${args.outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

