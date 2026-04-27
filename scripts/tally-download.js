const fs = require("node:fs");
const path = require("node:path");

function loadDotEnv(envPath) {
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies, global-require
    require("dotenv").config({ path: envPath });
    return;
  } catch (err) {
    if (err && err.code !== "MODULE_NOT_FOUND") throw err;
  }

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

loadDotEnv(path.resolve(__dirname, "..", ".env"));

const API_KEY = process.env.TALLY_API_KEY;
const BASE_URL = "https://api.tally.so";
const PAGE_SIZE = 100;

// Tally rate limit is 100 req/min — stay well below it.
const REQUEST_DELAY_MS = 250;

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing required env var: ${name}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeFilename(s) {
  return String(s).replace(/[^a-z0-9._-]/gi, "_").slice(0, 100);
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function tallyFetch(pathAndQuery) {
  await sleep(REQUEST_DELAY_MS);
  const url = pathAndQuery.startsWith("http") ? pathAndQuery : `${BASE_URL}${pathAndQuery}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Accept: "application/json",
    },
  });

  // Light handling for 429s — back off and retry once.
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after")) || 30;
    console.warn(`  ⏳ 429 — sleeping ${retryAfter}s`);
    await sleep(retryAfter * 1000);
    return tallyFetch(pathAndQuery);
  }

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`GET ${pathAndQuery} → ${res.status}: ${JSON.stringify(data).slice(0, 400)}`);
  }
  return data;
}

// Paginate through endpoints that return { <itemsKey>, page, limit, hasMore, ... }.
// `itemsKey` defaults to "items". Workspaces don't accept `limit`, so set sendLimit=false.
async function fetchAllPages(endpoint, options = {}) {
  const {
    itemsKey = "items",
    sendLimit = true,
    extraQuery = {},
    onPage, // optional callback({ page, data }) for capturing per-page metadata
  } = options;

  const all = [];
  let page = 1;
  const MAX_PAGES = 1000;

  while (page <= MAX_PAGES) {
    const params = new URLSearchParams({
      page: String(page),
      ...(sendLimit ? { limit: String(PAGE_SIZE) } : {}),
      ...extraQuery,
    });
    const data = await tallyFetch(`${endpoint}?${params}`);

    const items = Array.isArray(data[itemsKey])
      ? data[itemsKey]
      : Array.isArray(data.items)
        ? data.items
        : Array.isArray(data)
          ? data
          : [];

    all.push(...items);
    if (onPage) onPage({ page, data });

    const hasMore =
      typeof data.hasMore === "boolean" ? data.hasMore : items.length >= PAGE_SIZE;

    if (!hasMore || items.length === 0) break;
    page++;
  }

  return all;
}

async function main() {
  requireEnv("TALLY_API_KEY", API_KEY);

  const outDir = path.resolve(__dirname, "..", "tally-data");
  fs.mkdirSync(outDir, { recursive: true });

  console.log("→ Tally export starting");
  console.log(`  output: ${outDir}`);

  // --- Workspaces (rejects `limit` — only `page` is allowed) ---
  console.log("\n• Workspaces");
  let workspaces = [];
  try {
    workspaces = await fetchAllPages("/workspaces", { sendLimit: false });
    writeJson(path.join(outDir, "workspaces.json"), workspaces);
    console.log(`  ✓ ${workspaces.length} workspace(s)`);
  } catch (err) {
    console.warn(`  ✗ workspaces: ${err.message}`);
  }

  // --- Forms (list) ---
  console.log("\n• Forms");
  let forms = [];
  try {
    forms = await fetchAllPages("/forms");
    writeJson(path.join(outDir, "forms.json"), forms);
    console.log(`  ✓ ${forms.length} form(s)`);
  } catch (err) {
    console.warn(`  ✗ forms: ${err.message}`);
  }

  // --- Per-form: details, questions, submissions ---
  const formsDir = path.join(outDir, "forms");
  let totalSubmissions = 0;

  for (const form of forms) {
    const formId = form.id;
    if (!formId) continue;
    const slug = `${safeFilename(form.name || form.title || "form")}_${safeFilename(formId)}`;
    const dir = path.join(formsDir, slug);
    fs.mkdirSync(dir, { recursive: true });

    console.log(`\n  ↳ form: ${form.name || form.title || formId}`);

    try {
      const details = await tallyFetch(`/forms/${formId}`);
      writeJson(path.join(dir, "form.json"), details);
    } catch (err) {
      console.warn(`    ✗ details: ${err.message}`);
    }

    try {
      const questions = await tallyFetch(`/forms/${formId}/questions`);
      writeJson(path.join(dir, "questions.json"), questions);
    } catch (err) {
      console.warn(`    ✗ questions: ${err.message}`);
    }

    try {
      // Submissions response shape: { submissions, questions, page, limit, hasMore, totalNumberOfSubmissionsPerFilter }
      // We capture the questions schema from the first page (it's repeated on every page).
      let questionsSchema = null;
      let totalPerFilter = null;
      const submissions = await fetchAllPages(`/forms/${formId}/submissions`, {
        itemsKey: "submissions",
        onPage: ({ page, data }) => {
          if (page === 1) {
            questionsSchema = data.questions ?? null;
            totalPerFilter = data.totalNumberOfSubmissionsPerFilter ?? null;
          }
        },
      });
      writeJson(path.join(dir, "submissions.json"), {
        questions: questionsSchema,
        totalNumberOfSubmissionsPerFilter: totalPerFilter,
        submissions,
      });
      totalSubmissions += submissions.length;
      console.log(`    ✓ ${submissions.length} submission(s)`);
    } catch (err) {
      console.warn(`    ✗ submissions: ${err.message}`);
    }
  }

  // --- Webhooks + delivery events ---
  console.log("\n• Webhooks");
  let webhooks = [];
  try {
    webhooks = await fetchAllPages("/webhooks");
    writeJson(path.join(outDir, "webhooks.json"), webhooks);
    console.log(`  ✓ ${webhooks.length} webhook(s)`);
  } catch (err) {
    console.warn(`  ✗ webhooks: ${err.message}`);
  }

  const webhooksDir = path.join(outDir, "webhooks");
  for (const wh of webhooks) {
    const whId = wh.id;
    if (!whId) continue;
    try {
      const events = await fetchAllPages(`/webhooks/${whId}/events`);
      writeJson(path.join(webhooksDir, `${safeFilename(whId)}.events.json`), events);
      console.log(`    ✓ webhook ${whId}: ${events.length} event(s)`);
    } catch (err) {
      console.warn(`    ✗ webhook ${whId} events: ${err.message}`);
    }
  }

  // --- Manifest ---
  writeJson(path.join(outDir, "_manifest.json"), {
    generated_at: new Date().toISOString(),
    counts: {
      workspaces: workspaces.length,
      forms: forms.length,
      submissions: totalSubmissions,
      webhooks: webhooks.length,
    },
  });

  console.log("\n✅ Tally export complete");
  console.log(
    `   workspaces=${workspaces.length} forms=${forms.length} submissions=${totalSubmissions} webhooks=${webhooks.length}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
