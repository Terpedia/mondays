#!/usr/bin/env node
// Fold the scraped terpene profiles into data/products.json: hemp SKUs get the
// measured top compounds and a pointer to the full profile; everything else keeps
// its candidate molecule list.
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const file = path.join(root, "data/products.json");
const data = JSON.parse(await fs.readFile(file, "utf8"));
const TOP = 8;

for (const product of data.products) {
  const handle = new URL(product.source).pathname.split("/").filter(Boolean).pop();
  product.handle = handle;
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
    molecule.summary = molecule.summary.replace(" Confirm presence and amount in the product-specific CoA.", "");
    molecule.evidence = `Measured in ${hits.length} of ${skus} MONDAYS hemp SKUs at ${range(pct)}% of total volatiles (${range(mg)}mg per chew).`;
  }
  await fs.writeFile(moleculePath, `${JSON.stringify(molecule)}\n`);
}

data.note = "Hemp SKUs carry the measured terpene profile MONDAYS publishes on each product page (percent of total volatiles from an ISO 17025-accredited lab, milligrams per 20mg-terpene chew); data/terpene-profiles/ holds every listed compound. Botanical SKUs and bundles publish no measured profile, so their molecule arrays remain profile candidates. The linked batch CoAs are cannabinoid/safety panels and do not carry a terpene panel.";
data.snapshot_date = new Date().toISOString().slice(0, 10);
await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
console.log(`${data.products.filter((p) => p.molecules_basis === "measured").length} of ${data.products.length} products now carry measured profiles.`);
