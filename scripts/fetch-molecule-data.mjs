#!/usr/bin/env node
// Enrich data/molecules/<id>.json from public chemistry and literature sources:
// PubChem (identity, description, structure image, assay targets), UniProt (target
// names), PubMed (literature). Only compounds that carry real weight in a MONDAYS
// profile are enriched; the rest keep the bare identity record.
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const PUBCHEM = "https://pubchem.ncbi.nlm.nih.gov/rest/pug";
const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// NCBI asks for no more than a few requests a second from anonymous clients.
let queue = Promise.resolve();
const throttled = (url, init) => {
  const run = queue.then(() => wait(350)).then(() => fetch(url, init));
  queue = run.catch(() => {});
  return run;
};
// A rate-limited or flaky response must not read as "this compound has no data" —
// that silently wipes a good record on the next run. Retry, then report the failure.
async function json(url, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await throttled(url, { headers: { "user-agent": "terpedia-mondays (dan@terpedia.com)" } });
      if (response.ok) return await response.json();
      // 4xx other than rate limiting is a real answer: no such record, or an id this
      // service does not own (UniProt 400s on GenBank accessions). Retrying is waste.
      if (response.status !== 429 && response.status < 500) return null;
      if (attempt === attempts) { console.warn(`  ! ${response.status} ${url}`); return undefined; }
    } catch (error) {
      if (attempt === attempts) { console.warn(`  ! ${error.message} ${url}`); return undefined; }
    }
    await wait(attempt * 1500);
  }
  return undefined;
}
// undefined means "we failed to find out"; null means "asked, nothing there".
const keep = (fresh, existing) => (fresh === undefined ? existing ?? null : fresh ?? existing ?? null);

// PubChem indexes the ascii spelling, not the Greek letter.
const searchName = (name) => name
  .replaceAll("β", "beta-").replaceAll("α", "alpha-").replaceAll("γ", "gamma-").replaceAll("δ", "delta-")
  .replace(/-+/g, "-").trim();

async function pubchem(name) {
  const query = encodeURIComponent(searchName(name));
  const cids = await json(`${PUBCHEM}/compound/name/${query}/cids/JSON`);
  if (cids === undefined) return undefined; // lookup failed; keep whatever is on file
  const cid = cids?.IdentifierList?.CID?.[0];
  if (!cid) return null;
  const properties = await json(`${PUBCHEM}/compound/cid/${cid}/property/MolecularFormula,MolecularWeight,ConnectivitySMILES,InChIKey,IUPACName/JSON`);
  if (properties === undefined || !properties?.PropertyTable) return undefined;
  const props = properties.PropertyTable.Properties?.[0] || {};
  const descriptions = await json(`${PUBCHEM}/compound/cid/${cid}/description/JSON`);
  // PubChem intermittently answers 200 with a fault payload instead of the record.
  // Without this shape check that reads as "no summary" and overwrites a good one.
  if (descriptions === undefined || !descriptions?.InformationList) return undefined;
  const info = descriptions.InformationList.Information || [];
  const described = info.find((entry) => entry.Description);
  return {
    cid,
    title: info.find((entry) => entry.Title)?.Title || null,
    formula: props.MolecularFormula || null,
    molecular_weight: props.MolecularWeight ? Number(props.MolecularWeight) : null,
    smiles: props.ConnectivitySMILES || null,
    inchikey: props.InChIKey || null,
    iupac_name: props.IUPACName || null,
    image: `${PUBCHEM}/compound/cid/${cid}/PNG`,
    url: `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}`,
    description: described?.Description || null,
    description_source: described ? { name: described.DescriptionSourceName, url: described.DescriptionURL } : null,
  };
}

// Only assays PubChem marks Active, so the page never presents a negative or
// unscreened result as an interaction.
async function targets(cid) {
  const summary = await json(`${PUBCHEM}/compound/cid/${cid}/assaysummary/JSON`);
  if (summary === undefined) return undefined;
  const table = summary?.Table;
  if (!table) return [];
  const index = Object.fromEntries(table.Columns.Column.map((column, i) => [column, i]));
  const best = new Map();
  for (const { Cell: cell } of table.Row) {
    if (cell[index["Activity Outcome"]] !== "Active") continue;
    const accession = cell[index["Target Accession"]];
    if (!accession || accession === "NULL") continue;
    const value = Number(cell[index["Activity Value [uM]"]]);
    const record = {
      accession,
      activity: cell[index["Activity Name"]] || null,
      value_um: Number.isFinite(value) ? value : null,
      assay: cell[index["Assay Name"]] || null,
      aid: cell[index.AID],
      pmid: cell[index["PubMed ID"]] ? String(cell[index["PubMed ID"]]) : null,
    };
    const prior = best.get(accession);
    // Keep the most potent measurement per target.
    if (!prior || (record.value_um !== null && (prior.value_um === null || record.value_um < prior.value_um))) best.set(accession, record);
  }
  for (const record of best.values()) {
    const entry = await json(`https://rest.uniprot.org/uniprotkb/${record.accession}.json?fields=protein_name,gene_primary,organism_name`);
    if (!entry) continue;
    record.protein = entry.proteinDescription?.recommendedName?.fullName?.value || null;
    record.gene = entry.genes?.[0]?.geneName?.value || null;
    record.organism = entry.organism?.scientificName || null;
    record.url = `https://www.uniprot.org/uniprotkb/${record.accession}`;
    record.source = "UniProt";
  }
  // PubChem also reports GenBank/RefSeq protein accessions, which UniProt will not
  // resolve by id. NCBI names those, so a real target is not dropped for lack of a name.
  const unnamed = [...best.values()].filter((record) => !record.protein);
  if (unnamed.length) {
    const summary = await json(`${EUTILS}/esummary.fcgi?db=protein&retmode=json&id=${unnamed.map((r) => r.accession).join(",")}`);
    const byCaption = new Map(Object.values(summary?.result || {}).filter((r) => r?.caption).map((r) => [r.caption, r]));
    for (const record of unnamed) {
      const entry = byCaption.get(record.accession);
      if (!entry) continue;
      record.protein = (entry.title || "").replace(/\s*\[[^\]]*\]\s*$/, "") || null;
      record.organism = entry.organism || null;
      record.url = `https://www.ncbi.nlm.nih.gov/protein/${record.accession}`;
      record.source = "NCBI Protein";
    }
  }
  return [...best.values()]
    .filter((record) => record.protein) // never show a bare accession as an interaction
    .sort((a, b) => (a.value_um ?? Infinity) - (b.value_um ?? Infinity));
}

async function literature(name, limit = 6) {
  const term = encodeURIComponent(`${searchName(name)}[All Fields]`);
  const search = await json(`${EUTILS}/esearch.fcgi?db=pubmed&retmode=json&sort=relevance&retmax=${limit}&term=${term}`);
  if (search === undefined) return undefined;
  const ids = search?.esearchresult?.idlist || [];
  if (!ids.length) return { total: 0, papers: [] };
  const summary = await json(`${EUTILS}/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}`);
  const result = summary?.result || {};
  return {
    total: Number(search.esearchresult.count) || ids.length,
    search_url: `https://pubmed.ncbi.nlm.nih.gov/?term=${term}`,
    papers: ids.filter((id) => result[id]).map((id) => ({
      pmid: id,
      title: result[id].title?.replace(/\.$/, "") || null,
      journal: result[id].source || null,
      year: (result[id].pubdate || "").slice(0, 4) || null,
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
    })),
  };
}

// Which compounds are worth the round trips: anything in a product's headline
// eight, anything at half a percent or more, and anything already on file.
const profileDir = path.join(root, "data/terpene-profiles");
const names = new Map();
for (const file of await fs.readdir(profileDir)) {
  if (file === "index.json") continue;
  const profile = JSON.parse(await fs.readFile(path.join(profileDir, file), "utf8"));
  const listed = profile.compounds.filter((c) => !c.aggregate);
  listed.forEach((compound, i) => {
    if (i < 8 || compound.percent_of_profile >= 0.5) names.set(compound.id, compound.name);
  });
}
const moleculeDir = path.join(root, "data/molecules");
for (const file of await fs.readdir(moleculeDir)) {
  if (!file.endsWith(".json")) continue; // skip the images/ directory
  const id = file.replace(/\.json$/, "");
  if (!names.has(id)) names.set(id, JSON.parse(await fs.readFile(path.join(moleculeDir, file), "utf8")).name);
}

// Structure images are copied into the repo rather than hotlinked: the catalog is a
// static snapshot, and a visitor should not have to reach NCBI for the page to render.
const imageDir = path.join(moleculeDir, "images");
async function localImage(id, record) {
  if (!record.pubchem?.cid) return;
  await fs.mkdir(imageDir, { recursive: true });
  const file = path.join(imageDir, `${id}.png`);
  const response = await throttled(`${PUBCHEM}/compound/cid/${record.pubchem.cid}/PNG`, { headers: { "user-agent": "terpedia-mondays (dan@terpedia.com)" } }).catch(() => null);
  if (!response?.ok) { console.warn(`  ! image ${id}`); return; }
  await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
  record.pubchem.image = `data/molecules/images/${id}.png`;
  record.pubchem.image_source = `${PUBCHEM}/compound/cid/${record.pubchem.cid}/PNG`;
}

const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (process.argv.includes("--images-only")) {
  for (const [id] of names) {
    if (only.length && !only.includes(id)) continue;
    const file = path.join(moleculeDir, `${id}.json`);
    const record = await fs.readFile(file, "utf8").then(JSON.parse).catch(() => null);
    if (!record) continue;
    await localImage(id, record);
    await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`${id}: image ${record.pubchem?.image || "unavailable"}`);
  }
  process.exit(0);
}

for (const [id, name] of names) {
  if (only.length && !only.includes(id)) continue;
  const file = path.join(moleculeDir, `${id}.json`);
  const existing = await fs.readFile(file, "utf8").then(JSON.parse).catch(() => ({}));
  const identity = await pubchem(name);
  const chem = identity === undefined ? existing.pubchem : identity;
  const fetchedTargets = chem?.cid ? await targets(chem.cid) : [];
  const fetchedLiterature = await literature(name);
  const record = {
    ...existing,
    name,
    id,
    formula: chem?.formula || existing.formula || null,
    pubchem: chem ?? null,
    targets: fetchedTargets === undefined ? existing.targets ?? [] : fetchedTargets,
    literature: keep(fetchedLiterature, existing.literature),
    retrieved: new Date().toISOString().slice(0, 10),
  };
  await localImage(id, record);
  await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`${id}: ${chem?.cid ? `CID ${chem.cid}` : "no PubChem match"}, ${record.targets.length} targets, ${record.literature?.papers.length ?? 0}/${record.literature?.total ?? 0} papers`);
}
