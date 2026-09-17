// Warmer — local server. Static index.html + two proxies that keep the API keys
// server-side. Zero dependencies: node:http, node:fs, node:readline, global fetch.
//
//   node server.mjs   →   http://localhost:3000
//
// Keys live in .env next to this file. On first run with no keys the server
// asks for them and writes .env itself.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST = "127.0.0.1";
const PORT = 3000;
const ENV_PATH = path.join(HERE, ".env");

const REQUIRED_KEYS = ["GOOGLE_PLACES_API_KEY", "ANTHROPIC_API_KEY"];
// Only needed for organization-scoped Anthropic keys, which the API rejects
// without a workspace to bill. Workspace-scoped keys (the usual kind) skip it.
const OPTIONAL_KEYS = ["ANTHROPIC_WORKSPACE_ID"];

function parseDotenv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const name = line.slice(0, eq).trim().replace(/^export\s+/, "");
    const value = line.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    out[name] = value;
  }
  return out;
}

// A real key is printable ASCII. Anything else ("AIzaSyBM••••", "sk-ant-…")
// was copied from a masked or truncated display.
function badCharIn(value) {
  return [...value].find((ch) => ch.charCodeAt(0) < 33 || ch.charCodeAt(0) > 126);
}

function loadKeys() {
  let fromFile = {};
  try {
    fromFile = parseDotenv(fs.readFileSync(ENV_PATH, "utf8"));
  } catch {
    // no .env yet
  }
  // .env wins over the shell: a key exported for another tool (Claude Code,
  // say) must not leak in here just because it shares the variable name.
  const keys = {};
  for (const name of [...REQUIRED_KEYS, ...OPTIONAL_KEYS]) {
    keys[name] = fromFile[name] || process.env[name] || "";
  }
  return keys;
}

async function promptForMissingKeys(keys) {
  const missing = REQUIRED_KEYS.filter((name) => !keys[name]);
  if (!missing.length) return keys;

  if (!process.stdin.isTTY) {
    console.error(
      `Missing ${missing.join(" and ")}.\n` +
        `Run \`node server.mjs\` in a terminal and it will ask for them, or put them in ${ENV_PATH}`,
    );
    process.exit(1);
  }

  console.log("Warmer needs two API keys. Paste each one and press Enter; they are saved to .env (gitignored).\n");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // Ctrl+C / Ctrl+D at the prompt: leave quietly instead of dumping a stack trace.
  rl.on("SIGINT", () => { console.log("\nCancelled — nothing saved."); process.exit(1); });
  const ask = async (q) => {
    try {
      return await rl.question(q);
    } catch (error) {
      if (error?.code === "ABORT_ERR") { console.log("\nCancelled — nothing saved."); process.exit(1); }
      throw error;
    }
  };
  for (const name of missing) {
    const hint = name === "GOOGLE_PLACES_API_KEY"
      ? "Google Cloud Console → APIs & Services → Credentials (starts with AIza)"
      : "console.anthropic.com → Settings → API keys (starts with sk-ant-)";
    for (;;) {
      const value = (await ask(`${name}  [${hint}]\n> `)).trim();
      if (!value) continue;
      const bad = badCharIn(value);
      if (bad) {
        console.log(`  That contains "${bad}", which can't be part of a key — it was probably copied from a masked field. Paste the full key.\n`);
        continue;
      }
      keys[name] = value;
      break;
    }
  }
  rl.close();

  const lines = [...REQUIRED_KEYS, ...OPTIONAL_KEYS].filter((n) => keys[n]).map((n) => `${n}=${keys[n]}`);
  fs.writeFileSync(ENV_PATH, lines.join("\n") + "\n", { mode: 0o600 });
  console.log(`\nSaved to ${ENV_PATH}\n`);
  return keys;
}

const KEYS = await promptForMissingKeys(loadKeys());

for (const name of REQUIRED_KEYS) {
  const bad = badCharIn(KEYS[name]);
  if (bad) {
    console.error(
      `${name} contains "${bad}" (U+${bad.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}), which cannot be part of an API key.\n` +
        `It was probably copied from a masked field. Delete that line from ${ENV_PATH} and run \`node server.mjs\` again to re-enter it.`,
    );
    process.exit(1);
  }
}

const PLACES_KEY = KEYS.GOOGLE_PLACES_API_KEY;
const ANTHROPIC_KEY = KEYS.ANTHROPIC_API_KEY;
let ANTHROPIC_WORKSPACE_ID = KEYS.ANTHROPIC_WORKSPACE_ID;

const fingerprint = (k) => (k.length > 14 ? `${k.slice(0, 14)}…${k.slice(-4)}` : k);
console.log(`Google key ${fingerprint(PLACES_KEY)} · Anthropic key ${fingerprint(ANTHROPIC_KEY)}` +
  (ANTHROPIC_WORKSPACE_ID ? ` · workspace ${ANTHROPIC_WORKSPACE_ID}` : ""));

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 64 * 1024;

// C0 and C1 control characters (plus DEL). Built from code points so the
// source file itself never contains a control character.
const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}-${String.fromCharCode(159)}]`,
  "g",
);

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(Object.assign(new Error("Body must be JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function fail(res, status, message) {
  sendJson(res, status, { error: message });
}

// ---------------------------------------------------------------------------
// POST /api/places — Google Places API (New) Nearby Search proxy
// ---------------------------------------------------------------------------

const PLACES_URL = "https://places.googleapis.com/v1/places:searchNearby";
const PLACE_TYPES = ["restaurant", "cafe", "bakery", "meal_takeaway"];
const RADIUS_M = 900;
const MAX_PLACES = 60;
const CACHE_TTL_MS = 5 * 60 * 1000;

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.location",
  "places.primaryType",
  "places.types",
  "places.rating",
  "places.userRatingCount",
  "places.priceLevel",
  "places.editorialSummary",
  "places.reviews",
  "places.currentOpeningHours.openNow",
].join(",");

const PRICE_LEVELS = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

// Keyed by lat/lng rounded to 3 decimals (~110 m cells) so small pans reuse
// the same result instead of burning quota.
const placesCache = new Map();

function cacheKey(lat, lng) {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`;
}

function pruneCache() {
  const now = Date.now();
  for (const [key, entry] of placesCache) {
    if (now - entry.at > CACHE_TTL_MS) placesCache.delete(key);
  }
}

function isValidCoordinate(lat, lng) {
  return (
    typeof lat === "number" && Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
    typeof lng === "number" && Number.isFinite(lng) && lng >= -180 && lng <= 180
  );
}

async function upstreamError(response, label) {
  let detail = `${response.status}`;
  try {
    const err = await response.json();
    if (err?.error?.message) detail = `${response.status} ${err.error.message}`;
  } catch {
    // keep the bare status code
  }
  return new Error(`${label}: ${detail}`);
}

async function searchNearby(lat, lng, type) {
  const response = await fetch(PLACES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": PLACES_KEY,
      "x-goog-fieldmask": FIELD_MASK,
    },
    body: JSON.stringify({
      includedTypes: [type],
      maxResultCount: 20,
      locationRestriction: {
        circle: { center: { latitude: lat, longitude: lng }, radius: RADIUS_M },
      },
    }),
  });

  if (!response.ok) throw await upstreamError(response, `Places ${type}`);

  const data = await response.json();
  return Array.isArray(data.places) ? data.places : [];
}

function firstReview(reviews) {
  if (!Array.isArray(reviews)) return null;
  for (const review of reviews) {
    const text = review?.text?.text;
    if (typeof text === "string" && text.trim()) {
      return {
        text: text.trim(),
        author: review?.authorAttribution?.displayName || "Google user",
        rating: typeof review?.rating === "number" ? review.rating : null,
      };
    }
  }
  return null;
}

function trimPlace(place) {
  const lat = place?.location?.latitude;
  const lng = place?.location?.longitude;
  if (!isValidCoordinate(lat, lng) || typeof place.id !== "string") return null;
  return {
    id: place.id,
    name: place.displayName?.text || "Unnamed",
    lat,
    lng,
    primaryType: place.primaryType || "restaurant",
    types: Array.isArray(place.types) ? place.types.slice(0, 12) : [],
    rating: typeof place.rating === "number" ? place.rating : null,
    userRatingCount: typeof place.userRatingCount === "number" ? place.userRatingCount : 0,
    priceLevel: PRICE_LEVELS[place.priceLevel] ?? null,
    editorialSummary: place.editorialSummary?.text || null,
    review: firstReview(place.reviews),
    openNow: typeof place.currentOpeningHours?.openNow === "boolean"
      ? place.currentOpeningHours.openNow
      : null,
  };
}

async function handlePlaces(req, res) {
  const body = await readJsonBody(req);
  const { lat, lng } = body;
  if (!isValidCoordinate(lat, lng)) {
    return fail(res, 400, "Body must be { lat, lng } with finite coordinates in range.");
  }

  pruneCache();
  const key = cacheKey(lat, lng);
  const cached = placesCache.get(key);
  if (cached) {
    return sendJson(res, 200, { places: cached.places, cached: true });
  }

  const results = await Promise.allSettled(
    PLACE_TYPES.map((type) => searchNearby(lat, lng, type)),
  );

  const failures = results.filter((r) => r.status === "rejected");
  const succeeded = results.filter((r) => r.status === "fulfilled");
  if (succeeded.length === 0) {
    const reason = failures[0]?.reason?.message || "Places request failed";
    console.error(`[places] ${reason}`);
    return fail(res, 502, reason.slice(0, 200));
  }
  for (const f of failures) console.warn(`[places] partial: ${f.reason?.message}`);

  const byId = new Map();
  for (const r of succeeded) {
    for (const raw of r.value) {
      const place = trimPlace(raw);
      if (place && !byId.has(place.id)) byId.set(place.id, place);
      if (byId.size >= MAX_PLACES) break;
    }
    if (byId.size >= MAX_PLACES) break;
  }

  const places = [...byId.values()];
  placesCache.set(key, { at: Date.now(), places });
  sendJson(res, 200, { places, cached: false });
}

// ---------------------------------------------------------------------------
// POST /api/foodie — Claude proxy
// ---------------------------------------------------------------------------

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const FOODIE_MODEL = "claude-haiku-4-5-20251001";
const MAX_USER_CHARS = 300;
const MAX_PLACES_FOR_MODEL = 60;

const FALLBACK = {
  cuisines: [],
  weights: null,
  reply: "I couldn't work that one out. Try one of the quick prompts, or ask for something like \"cheap and fast\".",
};

const WEIGHT_KEYS = ["selection", "rating", "fast", "cheap"];

function cleanText(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_USER_CHARS);
}

function str(value, max) {
  return typeof value === "string" ? value.replace(CONTROL_CHARS, "").slice(0, max) : "";
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function trimPlacesForModel(places) {
  if (!Array.isArray(places)) return [];
  return places.slice(0, MAX_PLACES_FOR_MODEL).map((p) => ({
    name: str(p?.name, 80),
    cuisine: str(p?.cuisine, 40),
    tier: str(p?.tier, 12),
    minutes: num(p?.minutes),
    price: str(p?.price, 8),
    rating: num(p?.rating),
    distance: str(p?.distance, 12),
  })).filter((p) => p.name);
}

function buildSystemPrompt(places) {
  const list = places
    .map((p) =>
      `- ${p.name} | ${p.cuisine || "food"} | ${p.tier || "unknown"} | ` +
      `${p.minutes ?? "?"} min to food in hand | price ${p.price || "?"} | ` +
      `rating ${p.rating ?? "?"} | ${p.distance || "?"} away`,
    )
    .join("\n");

  return [
    "You are Foodie, the assistant inside Warmer, a map that shows good, fast food nearby as a heat field.",
    "The user is hungry and on foot. Minutes means total time until food is in their hand (prep + walk).",
    "Tiers: perfect and good are warm; average is neutral; coldspot means 20+ minutes or closed and is shown in blue.",
    "",
    "Answer ONLY with a single JSON object, no markdown fences, no prose outside the JSON:",
    "{",
    '  "cuisines": ["mexican"],',
    '  "weights": { "selection": 0.1, "rating": 0.2, "fast": 0.5, "cheap": 0.2 },',
    '  "reply": "one short paragraph"',
    "}",
    "",
    "Rules:",
    "- cuisines: lowercase cuisine or food-type words the user asked for (e.g. pizza, sushi, coffee, mexican). [] if none.",
    "- weights: how much the user cares about each of selection, rating, fast, cheap, values 0..1 summing to about 1. null if they expressed no preference.",
    "- reply: one short paragraph naming the real top 3 places for this request, each with minutes, price, rating and distance taken from the list. Plain text, no lists, no markdown.",
    "- If the user asks what to avoid, name the coldspot places and say why (long wait or closed).",
    "- You may only name places that appear in the list below. Never invent a place, a rating or a time.",
    "- If nothing in the list fits, say so briefly and suggest the closest alternatives from the list.",
    "",
    "Places near the user:",
    list || "(no places loaded yet)",
  ].join("\n");
}

function extractJson(text) {
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("no object");
  return JSON.parse(s.slice(start, end + 1));
}

function normalizeFoodie(parsed) {
  const cuisines = Array.isArray(parsed.cuisines)
    ? parsed.cuisines
        .filter((c) => typeof c === "string")
        .map((c) => c.toLowerCase().trim())
        .filter(Boolean)
        .slice(0, 6)
    : [];

  let weights = null;
  if (parsed.weights && typeof parsed.weights === "object") {
    weights = {};
    let total = 0;
    for (const key of WEIGHT_KEYS) {
      const v = Number(parsed.weights[key]);
      weights[key] = Number.isFinite(v) && v > 0 ? v : 0;
      total += weights[key];
    }
    if (total <= 0) weights = null;
    else for (const key of WEIGHT_KEYS) weights[key] = weights[key] / total;
  }

  const reply = typeof parsed.reply === "string" && parsed.reply.trim()
    ? parsed.reply.trim().slice(0, 900)
    : FALLBACK.reply;

  return { cuisines, weights, reply };
}

const WORKSPACES_URL = "https://api.anthropic.com/v1/organizations/workspaces?limit=20";

// An organization-scoped key can list the org's workspaces; use that to pick
// one to bill instead of making the user go and find the ID.
async function discoverWorkspaceId() {
  const response = await fetch(WORKSPACES_URL, {
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
  });
  if (!response.ok) throw await upstreamError(response, "Workspaces");
  const data = await response.json();
  const live = (Array.isArray(data.data) ? data.data : []).filter((w) => w?.id && !w.archived_at);
  if (!live.length) throw new Error("Workspaces: none found for this key");
  const picked = live[0];
  console.log(`[foodie] key is organization-scoped; billing workspace "${picked.name || picked.id}" (${picked.id})`);
  try {
    fs.appendFileSync(ENV_PATH, `ANTHROPIC_WORKSPACE_ID=${picked.id}\n`);
  } catch {
    // .env not writable — fine, it stays in memory for this run
  }
  return picked.id;
}

function callClaude(payload) {
  return fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      ...(ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": ANTHROPIC_WORKSPACE_ID } : {}),
    },
    body: JSON.stringify(payload),
  });
}

async function handleFoodie(req, res) {
  const body = await readJsonBody(req);
  const text = cleanText(body.text);
  if (!text) return fail(res, 400, "Body must be { text, places } with non-empty text.");
  const places = trimPlacesForModel(body.places);

  const payload = {
    model: FOODIE_MODEL,
    max_tokens: 400,
    system: buildSystemPrompt(places),
    // User text goes in its own turn — never templated into the system prompt.
    messages: [{ role: "user", content: text }],
  };

  let response = await callClaude(payload);

  if (response.status === 400 && !ANTHROPIC_WORKSPACE_ID) {
    const err = await upstreamError(response, "Claude");
    if (!/not scoped to a workspace/i.test(err.message)) {
      console.error(`[foodie] ${err.message}`);
      return fail(res, 502, `Foodie is unavailable (${err.message.slice(0, 240)})`);
    }
    try {
      ANTHROPIC_WORKSPACE_ID = await discoverWorkspaceId();
    } catch (lookupErr) {
      console.error(`[foodie] ${lookupErr.message}`);
      return fail(res, 502, `This Anthropic key is organization-scoped and no workspace could be found for it (${lookupErr.message.slice(0, 120)}). Use a workspace-scoped key, or add ANTHROPIC_WORKSPACE_ID=wrkspc_… to .env.`);
    }
    response = await callClaude(payload);
  }

  if (!response.ok) {
    const err = await upstreamError(response, "Claude");
    console.error(`[foodie] ${err.message}`);
    return fail(res, 502, `Foodie is unavailable (${err.message.slice(0, 240)})`);
  }

  const data = await response.json();
  const raw = Array.isArray(data.content)
    ? data.content.filter((b) => b.type === "text").map((b) => b.text).join("")
    : "";

  try {
    sendJson(res, 200, normalizeFoodie(extractJson(raw)));
  } catch {
    console.warn("[foodie] model reply was not JSON; sending fallback");
    sendJson(res, 200, FALLBACK);
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const INDEX_PATH = path.join(HERE, "index.html");

function serveIndex(res) {
  fs.readFile(INDEX_PATH, (err, html) => {
    if (err) return fail(res, 500, "index.html is missing");
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": html.length,
      "cache-control": "no-store",
    });
    res.end(html);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return serveIndex(res);
    }
    if (req.method === "POST" && url.pathname === "/api/places") {
      return await handlePlaces(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/foodie") {
      return await handleFoodie(req, res);
    }
    fail(res, 404, "Not found");
  } catch (error) {
    const status = error?.status || 500;
    if (status >= 500) console.error(`[server] ${error?.message || error}`);
    if (!res.headersSent) fail(res, status, error?.message || "Server error");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Warmer → http://localhost:${PORT}`);
});
