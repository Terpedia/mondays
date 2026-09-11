#!/usr/bin/env node
// The numbers the homepage leads with, computed from the data rather than typed in.
// Read-only: safe to run while other scripts write molecule records.
import fs from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const read = async (p) => JSON.parse(await fs.readFile(path.join(root, p), "utf8"));
const catalog = await read("data/products.json");
const names = (await read("data/organism-names.json")).organisms;
const molecules = [];
for (const file of await fs.readdir(path.join(root, "data/molecules"))) if (file.endsWith(".json")) molecules.push(await read(`data/molecules/${file}`));

const organisms = new Set(); let papers = 0; let refs = 0; const trials = new Set(); let human = 0;
for (const m of molecules) {
  for (const o of m.occurrence?.organisms || []) organisms.add(o.name);
  refs += m.occurrence?.reference_count || 0;
  if (!m.is_terpenoid) continue;
  papers += m.research?.total || 0;
  human += (m.research?.designs?.human || 0) + (m.research?.designs?.clinical_trial || 0) + (m.research?.designs?.human_observational || 0) + (m.research?.designs?.rct || 0);
  for (const t of m.trials?.studies || []) if (m.is_terpenoid) trials.add(t.nct_id);
}

// Per product: the plants its biggest compounds are reported in, by common name where one
// exists — the "also found in lemon, hops, ginger" line.
const strips = {};
for (const product of catalog.products) {
  if (!product.terpene_profile) continue;
  const profile = await read(product.terpene_profile.path);
  const score = new Map();
  for (const c of profile.compounds.filter((x) => !x.aggregate).slice(0, 10)) {
    const m = molecules.find((x) => x.id === c.id);
    for (const o of (m?.occurrence?.organisms || []).slice(0, 40)) {
      const n = names[o.name]; if (!n?.common_name || !/Plantae|Viridiplantae|Archaeplastida/.test(n.kingdom || "")) continue;
      const e = score.get(o.name) || { name: o.name, common: n.common_name, family: n.family, score: 0 };
      e.score += c.percent_of_profile * Math.log1p(o.reference_count); score.set(o.name, e);
    }
  }
  strips[product.handle] = [...score.values()].sort((a, b) => b.score - a.score).slice(0, 5);
}

await fs.writeFile(path.join(root, "data/stats.json"), `${JSON.stringify({
  generated: new Date().toISOString().slice(0, 10),
  products: catalog.products.length,
  measured_products: catalog.products.filter((p) => p.terpene_profile).length,
  compounds: molecules.length,
  organisms: organisms.size,
  occurrence_references: refs,
  papers, human_papers: human,
  trials: trials.size,
  organism_strips: strips,
}, null, 2)}\n`);
console.log({ compounds: molecules.length, organisms: organisms.size, papers, trials: trials.size });
