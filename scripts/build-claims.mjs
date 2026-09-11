#!/usr/bin/env node
// One record per pack claim: its definition, the research areas it draws on, every measured
// molecule with literature in those areas (graded), the products that carry it, and the
// registered trials in the area. The claim page is built from this; the LLM summary of the
// physiology is added by summarize.mjs --claims.
import fs from "node:fs/promises";
import path from "node:path";
import { grade } from "./lib/evidence.mjs";

const root = path.resolve(import.meta.dirname, "..");
const read = async (p) => JSON.parse(await fs.readFile(path.join(root, p), "utf8"));
const vocabulary = (await read("data/claims/vocabulary.json")).claims;
const catalog = await read("data/products.json");
const molecules = [];
for (const f of await fs.readdir(path.join(root, "data/molecules"))) if (f.endsWith(".json")) molecules.push(await read(`data/molecules/${f}`));
const LEVELS = ["human_trials", "human_observational", "animal", "in_vitro", "review_only", "none_found"];

// Trial conditions that speak to each research area.
const AREA_TRIAL_TERMS = {
  cognition: /cogniti|memory|attention|focus|alert/i, mood: /mood|depress|wellbeing|affect/i,
  anxiety: /anxi|stress|calm|relax/i, sleep: /sleep|insomnia|sedat/i, pain: /pain|analges|nocicept|discomfort/i,
  "anti-inflammatory": /inflamm|arthritis|colitis/i,
};

const out = {};
for (const [tile, spec] of Object.entries(vocabulary)) {
  const backing = [];
  for (const m of molecules) {
    // Terpenoids only. Ethanol has more human trials on cognition than any terpene —
    // about impairment — and would otherwise top the FOCUS page as its leading molecule.
    if (!m.is_terpenoid) continue;
    const claims = (m.research?.claims || []).filter((c) => spec.areas.includes(c.id));
    if (!claims.length) continue;
    const lines = claims.flatMap((c) => c.evidence_lines || []);
    const g = grade(lines);
    const inProducts = catalog.products.filter((p) => (p.terpene_profile?.top || []).some((t) => t.id === m.id) || (p.claim_support || []).some((cs) => cs.backing?.some((b) => b.id === m.id)));
    backing.push({
      id: m.id, name: m.name, papers: claims.reduce((n, c) => n + c.papers, 0),
      areas: claims.map((c) => c.label), evidence_level: g.evidence_level, eco: g.eco?.id || null, oxford: g.oxford?.level || null,
      evidence_lines: lines.map(({ design, papers }) => ({ design, papers })),
      statements: (m.consumer_summary?.structure_function || []).filter((s) => spec.areas.includes(s.claim_id)).map((s) => s.statement),
      hypotheses: (m.consumer_summary?.hypothesized_benefits || []).filter((h) => spec.areas.includes(h.claim_id)).map((h) => ({ hypothesis: h.hypothesis, study: h.study_to_test_it, evidence_level: h.evidence_level })),
      products: inProducts.map((p) => ({ handle: p.handle, name: p.name, percent: (p.terpene_profile?.top || []).find((t) => t.id === m.id)?.percent ?? (p.claim_support || []).flatMap((cs) => cs.backing || []).find((b) => b.id === m.id)?.percent ?? null })),
      pmids: claims.flatMap((c) => c.pmids || []).slice(0, 10),
    });
  }
  // Rank by how much of the chews a compound actually is, times how much literature it has
  // in the area, with a bonus for human evidence. A trace compound with a big literature
  // should not outrank the molecule that makes up a third of the product.
  const share = (b) => Math.max(0, ...b.products.map((p) => p.percent || 0));
  const humanBonus = (b) => (b.evidence_level === "human_trials" ? 2 : b.evidence_level === "human_observational" ? 1.5 : 1);
  for (const b of backing) b.score = Number((Math.log1p(share(b)) * Math.log1p(b.papers) * humanBonus(b)).toFixed(3));
  backing.sort((a, b) => b.score - a.score);
  const trials = [];
  const seen = new Set();
  for (const m of molecules) for (const t of m.trials?.studies || []) {
    if (!m.is_terpenoid || seen.has(t.nct_id)) continue;
    if (spec.areas.some((a) => AREA_TRIAL_TERMS[a]?.test([t.title, ...t.conditions].join(" ")))) { seen.add(t.nct_id); trials.push({ ...t, molecule: m.name, molecule_id: m.id }); }
  }
  const products = catalog.products.filter((p) => (p.claims || []).includes(tile)).map((p) => ({ handle: p.handle, name: p.name, strain: p.strain, support: (p.claim_support || []).find((c) => c.tile === tile) || null }));
  out[tile] = {
    tile, id: tile.toLowerCase(), definition: spec.definition, areas: spec.areas, sense: spec.sense,
    molecules: backing, molecules_with_research: backing.length,
    papers: backing.reduce((n, b) => n + b.papers, 0),
    // Best evidence is the strongest across the backing, not whichever molecule ranks first.
    best_evidence: backing.map((b) => b.evidence_level).sort((a, b) => LEVELS.indexOf(a) - LEVELS.indexOf(b))[0] || "none_found",
    best_oxford: backing.map((b) => b.oxford).filter(Boolean).sort()[0] || null,
    trials, products,
  };
}
await fs.mkdir(path.join(root, "data/claims"), { recursive: true });
for (const rec of Object.values(out)) {
  // Rebuilding the backing must not throw away the written summary.
  const file = path.join(root, `data/claims/${rec.id}.json`);
  const existing = await fs.readFile(file, "utf8").then(JSON.parse).catch(() => ({}));
  if (existing.summary) rec.summary = existing.summary;
  await fs.writeFile(file, `${JSON.stringify(rec, null, 2)}\n`);
}
console.log(Object.values(out).map((c) => `${c.tile}: ${c.molecules_with_research} molecules, ${c.papers} papers, best ${c.best_evidence}, ${c.trials.length} trials, ${c.products.length} products`).join("\n"));
