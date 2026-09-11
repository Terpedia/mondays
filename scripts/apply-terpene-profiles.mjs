#!/usr/bin/env node
// Fold the scraped terpene profiles into data/products.json: hemp SKUs get the
// measured top compounds and a pointer to the full profile; everything else keeps
// its candidate molecule list.
import fs from "node:fs/promises";
import path from "node:path";
import { grade } from "./lib/evidence.mjs";

const root = path.resolve(import.meta.dirname, "..");
const file = path.join(root, "data/products.json");
const data = JSON.parse(await fs.readFile(file, "utf8"));
const TOP = 8;

const claimFile = JSON.parse(await fs.readFile(path.join(root, "data/product-claims.json"), "utf8"));
const imageFile = JSON.parse(await fs.readFile(path.join(root, "data/product-images.json"), "utf8")).images;

for (const product of data.products) {
  const handle = new URL(product.source).pathname.split("/").filter(Boolean).pop();
  product.handle = handle;
  product.claims = claimFile.claims[handle]?.tiles || [];
  product.image = imageFile[handle] || null;
  let profile = null;
  try { profile = JSON.parse(await fs.readFile(path.join(root, `data/terpene-profiles/${handle}.json`), "utf8")); } catch { /* no measured profile */ }
  if (!profile) {
    product.molecules_basis = "candidate";
    delete product.terpene_profile;
    continue;
  }
  const top = profile.compounds.filter((c) => !c.aggregate).slice(0, TOP);
  product.molecules_basis = "measured";
  product.molecules = top.map((c) => c.name);
  product.terpene_profile = {
    path: `data/terpene-profiles/${handle}.json`,
    source: profile.source,
    identified_compounds: profile.identified_compounds,
    listed_compounds: profile.listed_compounds,
    mg_terpenes_per_chew: profile.mg_terpenes_per_chew,
    lab: profile.lab,
    top: top.map((c) => ({ name: c.name, id: c.id, percent: c.percent_of_profile, mg: c.mg_per_chew })),
  };
}

// Reverse index so a molecule page can list the products it was measured in without
// fetching every profile in the browser.
const byMolecule = {};
for (const product of data.products) {
  if (!product.terpene_profile) continue;
  const profile = JSON.parse(await fs.readFile(path.join(root, product.terpene_profile.path), "utf8"));
  const listed = profile.compounds.filter((c) => !c.aggregate);
  listed.forEach((compound, rank) => {
    (byMolecule[compound.id] ||= []).push({
      handle: product.handle,
      product: product.name,
      strain: product.strain,
      type: product.type,
      percent: compound.percent_of_profile,
      mg: compound.mg_per_chew,
      rank: rank + 1,
      of: listed.length,
      claims: product.claims,
    });
  });
}
for (const list of Object.values(byMolecule)) list.sort((a, b) => b.percent - a.percent);
await fs.writeFile(path.join(root, "data/molecule-products.json"), `${JSON.stringify({ generated: new Date().toISOString().slice(0, 10), molecules: byMolecule }, null, 2)}\n`);

// A pack claim, backed. For each tile a product carries, gather the research the measured
// compounds hold in the claim's areas, weight it by share of the profile, and grade the best
// evidence on Oxford CEBM. The tile then links to its receipts rather than a disclaimer.
const vocabulary = JSON.parse(await fs.readFile(path.join(root, "data/claims/vocabulary.json"), "utf8")).claims;
const moleculeRecords = new Map();
for (const file of await fs.readdir(path.join(root, "data/molecules"))) {
  if (!file.endsWith(".json")) continue;
  const record = JSON.parse(await fs.readFile(path.join(root, "data/molecules", file), "utf8"));
  moleculeRecords.set(record.id, record);
}
const ORDER = ["human_trials", "human_observational", "animal", "in_vitro", "review_only", "none_found"];
const strongest = (levels) => ORDER.find((l) => levels.includes(l)) || "none_found";

for (const product of data.products) {
  if (!product.terpene_profile) { product.claim_support = []; continue; }
  const profile = JSON.parse(await fs.readFile(path.join(root, product.terpene_profile.path), "utf8"));
  const listed = profile.compounds.filter((c) => !c.aggregate);
  product.claim_support = (product.claims || []).map((tile) => {
    const spec = vocabulary[tile];
    if (!spec) return { tile, definition: null, backing: [], best_evidence: "none_found" };
    const backing = [];
    for (const compound of listed) {
      const record = moleculeRecords.get(compound.id);
      const claims = (record?.research?.claims || []).filter((c) => spec.areas.includes(c.id));
      if (!claims.length) continue;
      const lines = claims.flatMap((c) => c.evidence_lines || []);
      const graded = grade(lines);
      backing.push({
        id: compound.id, name: compound.name, percent: compound.percent_of_profile, mg: compound.mg_per_chew,
        papers: claims.reduce((n, c) => n + c.papers, 0),
        areas: claims.map((c) => c.label),
        evidence_level: graded.evidence_level, eco: graded.eco?.id || null, oxford: graded.oxford?.level || null,
        pmids: claims.flatMap((c) => c.pmids || []).slice(0, 8),
      });
    }
    backing.sort((a, b) => b.percent - a.percent);
    return {
      tile, definition: spec.definition, areas: spec.areas,
      backing,
      compounds_with_research: backing.length,
      papers: backing.reduce((n, b) => n + b.papers, 0),
      share_of_profile: Number(backing.reduce((n, b) => n + b.percent, 0).toFixed(1)),
      best_evidence: strongest(backing.map((b) => b.evidence_level)),
      best_oxford: backing.map((b) => b.oxford).filter(Boolean).sort()[0] || null,
    };
  });
}

// Molecule pages that a measured profile actually quantifies should say so, instead of
// still promising the number is pending a CoA.
const aliases = { "beta-myrcene": "myrcene", humulene: "alpha-humulene" };
const measured = new Map();
for (const file of await fs.readdir(path.join(root, "data/terpene-profiles"))) {
  if (file === "index.json") continue;
  const profile = JSON.parse(await fs.readFile(path.join(root, "data/terpene-profiles", file), "utf8"));
  for (const compound of profile.compounds) {
    if (compound.aggregate) continue;
    if (!measured.has(compound.id)) measured.set(compound.id, []);
    measured.get(compound.id).push(compound);
  }
}
const skus = (await fs.readdir(path.join(root, "data/terpene-profiles"))).length - 1;
for (const file of await fs.readdir(path.join(root, "data/molecules"))) {
  if (!file.endsWith(".json")) continue; // skip the images/ directory
  const id = file.replace(/\.json$/, "");
  const hits = measured.get(aliases[id] || id);
  const moleculePath = path.join(root, "data/molecules", file);
  const molecule = JSON.parse(await fs.readFile(moleculePath, "utf8"));
  if (!hits) {
    molecule.evidence = "Terpedia identity/profile link; not quantified in any published MONDAYS profile.";
  } else {
    const pct = hits.map((h) => h.percent_of_profile);
    const mg = hits.map((h) => h.mg_per_chew);
    const range = (values) => (Math.min(...values) === Math.max(...values) ? `${Math.min(...values)}` : `${Math.min(...values)}–${Math.max(...values)}`);
    molecule.summary = (molecule.summary || "").replace(" Confirm presence and amount in the product-specific CoA.", "") || null;
    molecule.evidence = `Measured in ${hits.length} of ${skus} MONDAYS hemp SKUs at ${range(pct)}% of total volatiles (${range(mg)}mg per chew).`;
  }
  await fs.writeFile(moleculePath, `${JSON.stringify(molecule)}\n`);
}

data.note = "Hemp SKUs carry the measured terpene profile MONDAYS publishes on each product page (percent of total volatiles from an ISO 17025-accredited lab, milligrams per 20mg-terpene chew); data/terpene-profiles/ holds every listed compound. Botanical SKUs and bundles publish no measured profile, so their molecule arrays remain profile candidates. The linked batch CoAs are cannabinoid/safety panels and do not carry a terpene panel.";
data.snapshot_date = new Date().toISOString().slice(0, 10);
await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
console.log(`${data.products.filter((p) => p.molecules_basis === "measured").length} of ${data.products.length} products now carry measured profiles.`);
