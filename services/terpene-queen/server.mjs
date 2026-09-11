// The TerpeneQueen: a small chat service for mondays.terpedia.com and kb.terpedia.com,
// on Gemini via Vertex AI. It carries the catalog brief and every molecule summary, so an
// answer about sleep is a product recommendation with the compounds and evidence behind
// it — and nothing about CBN, formulation strategy, or compliance consulting.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = process.env.PORT || 8080;
const PROJECT = process.env.GCP_PROJECT || "terpedia-489015";
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const ENDPOINT = `https://aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/global/publishers/google/models/${MODEL}:streamGenerateContent?alt=sse`;
const ALLOWED = new Set((process.env.ALLOWED_ORIGINS || "https://mondays.terpedia.com,https://kb.terpedia.com").split(","));
const dataDir = process.env.DATA_DIR || path.resolve(import.meta.dirname, "data");

// --- knowledge -----------------------------------------------------------------------
const read = (f) => JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf8"));
const catalog = read("products.json");
const molecules = read("molecules.json").molecules;
const LEVEL = { human_trials: "human trials", human_observational: "human observational studies", animal: "animal studies", in_vitro: "lab studies", review_only: "reviews", none_found: "no research yet" };
const AREA = { "Sleep and sedation": "sleep", "Anxiety and calm": "calm and unwinding", "Mood": "mood and uplift", "Focus and memory": "focus and clarity", "Pain relief": "physical comfort and relief", "Anti-inflammatory": "everyday inflammation response", "Antioxidant": "antioxidant support", "Digestive": "digestive comfort", "Neuroprotection": "nervous-system support" };

const scores = {};
for (const p of catalog.products) for (const c of p.claim_support || []) for (const b of c.backing || []) for (const a of b.areas || []) (scores[a] ||= {})[p.name] = ((scores[a] || {})[p.name] || 0) + b.percent * Math.log1p(b.papers);
const ranking = Object.entries(scores).map(([a, by]) => `- ${AREA[a] || a}: ${Object.entries(by).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([n]) => n).join(" > ")}`).join("\n");
const products = catalog.products.map((p) => {
  const claims = (p.claim_support || []).map((c) => `${c.tile}: ${c.definition || ""} — ${c.compounds_with_research} compounds, ${c.papers} papers, best evidence ${LEVEL[c.best_evidence] || c.best_evidence}${c.best_oxford ? ` (Oxford ${c.best_oxford})` : ""}`).join("; ");
  const top = (p.terpene_profile?.top || []).slice(0, 6).map((c) => `${c.name} ${c.percent}% (${c.mg}mg)`).join(", ");
  return `• ${p.name} [${p.type}; ${p.strain}] https://mondays.terpedia.com/?product=${p.handle}\n  Pack claims: ${(p.claims || []).join(", ") || "none"}. ${top ? `Largest measured compounds: ${top}.` : "Botanical, no measured profile."}${claims ? `\n  ${claims}` : ""}${p.terpene_profile?.consumer_summary?.profile_character ? `\n  Character: ${p.terpene_profile.consumer_summary.profile_character}` : ""}`;
}).join("\n");
const moleculeNotes = molecules.filter((m) => m.consumer_summary).map((m) => {
  const cs = m.consumer_summary;
  const sf = (cs.structure_function || []).map((x) => `${x.statement} [${LEVEL[x.evidence_level] || x.evidence_level}${x.oxford?.level ? `, Oxford ${x.oxford.level}` : ""}]`).join(" ");
  const trials = (m.trials?.studies || []).slice(0, 3).map((t) => `${t.nct_id} ${t.status.toLowerCase().replaceAll("_", " ")}: ${t.title}`).join("; ");
  return `• ${m.name}: ${cs.what_it_is} ${cs.found_in} ${sf}${trials ? ` Registered trials: ${trials}.` : ""}`;
}).join("\n");

const SYSTEM = `You are the TerpeneQueen — Terpedia's guide to the molecules in MONDAYS terpene chews. You speak to curious consumers on mondays.terpedia.com and kb.terpedia.com.

Your voice: warm, specific, genuinely delighted by what these molecules might do. Short paragraphs. No headers, no bullet lists unless comparing products, no corporate tone, no "formulation", "stack", "strategy" or "compliance" talk — you are talking to a person who likes these chews, not a manufacturer.

When someone asks what is good for a goal (sleep, focus, calm, relief, a social night), recommend one or at most two MONDAYS products from the catalog, using the best-fit ranking. Say which pack claim and which measured compounds make it the fit, what the research behind those compounds has looked at and at what evidence level, and give the product link. If two are close, say so.

Rules that hold no matter what:
- Structure/function language for benefits: "may support", "is being studied for", "early work points toward". Never say a compound or chew treats, cures or prevents anything.
- Name the evidence level when you cite research, in plain words: human trials, human observational studies, animal studies, lab studies. If a question is still open, say so — and if there is a registered trial on it, mention it.
- MONDAYS chews contain zero THC and zero CBD and are non-intoxicating. Never suggest cannabinoids.
- No medical advice, no dosing, nothing about treating conditions. If asked something medical, say warmly that it is a question for their doctor and offer what the molecules are studied for instead.
- Only use what is below. If it is not here, say you do not have it.

BEST-FIT PRODUCTS BY GOAL (strongest first):
${ranking}

THE CATALOG:
${products}

THE MOLECULES:
${moleculeNotes}`;

// --- Vertex auth via the service account --------------------------------------------
let token = { value: null, expires: 0 };
async function accessToken() {
  if (process.env.GOOGLE_OAUTH_TOKEN) return process.env.GOOGLE_OAUTH_TOKEN;
  if (token.value && Date.now() < token.expires - 60_000) return token.value;
  const r = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", { headers: { "Metadata-Flavor": "Google" } });
  const j = await r.json();
  token = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  return token.value;
}

// --- server ----------------------------------------------------------------------------
const cors = (req, res) => {
  const origin = req.headers.origin;
  if (origin && (ALLOWED.has(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin))) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
};

http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (req.method === "GET" && req.url === "/health") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ ok: true, model: MODEL, products: catalog.products.length, molecules: moleculeNotes.split("\n").length })); }
  if (req.method !== "POST" || req.url !== "/chat") { res.writeHead(404); return res.end(); }

  let body = "";
  for await (const chunk of req) body += chunk;
  let payload;
  try { payload = JSON.parse(body); } catch { res.writeHead(400); return res.end("bad json"); }
  const history = (payload.messages || []).filter((m) => m.role === "user" || m.role === "assistant").slice(-12);
  const context = String(payload.context || "").slice(0, 300);
  if (!history.length) { res.writeHead(400); return res.end("no messages"); }

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  try {
    const upstream = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: `${SYSTEM}\n\nThe reader is currently looking at: ${context || "the catalog homepage"}.` }] },
        contents: history.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.content).slice(0, 4000) }] })),
        generationConfig: { temperature: 0.7, maxOutputTokens: 900 },
        safetySettings: [],
      }),
    });
    if (!upstream.ok || !upstream.body) { res.write(`data: ${JSON.stringify({ error: `upstream ${upstream.status}` })}\n\n`); return res.end("data: [DONE]\n\n"); }
    const reader = upstream.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        try {
          const text = JSON.parse(line.slice(5)).candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
          if (text) res.write(`data: ${JSON.stringify({ delta: text })}\n\n`);
        } catch {}
      }
    }
  } catch (error) {
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
  }
  res.end("data: [DONE]\n\n");
}).listen(PORT, () => console.log(`TerpeneQueen on :${PORT} (${MODEL}), ${catalog.products.length} products, ${molecules.filter((m) => m.consumer_summary).length} molecule summaries`));
