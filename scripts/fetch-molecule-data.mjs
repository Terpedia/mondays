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

  // PubChem returns several descriptions in no useful order, and for some compounds the
  // first is a regulatory hazard statement — beta-myrcene leads with OEHHA's Proposition 65
  // cancer listing. Taking [0] puts that at the top of the page, directly above "measured in
  // 6 of 6 MONDAYS SKUs", which reads as a claim about the product. Use a chemistry source
  // for the summary; regulatory and hazard statements are not carried at all.
  const HAZARD_SOURCE = /OEHHA|Haz-?Map|CAMEO|Toxicology|NIOSH|ILO|Hazardous|Safety/i;
  const CHEMISTRY_SOURCE = /ChEBI|DrugBank|NCIt|LOTUS|Wikipedia|EPA DSSTox/i;
  const described = info.filter((entry) => entry.Description);
  const chemistry = described.find((entry) => CHEMISTRY_SOURCE.test(entry.DescriptionSourceName || ""))
    || described.find((entry) => !HAZARD_SOURCE.test(entry.DescriptionSourceName || ""));

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
    description: chemistry?.Description || null,
    description_source: chemistry ? { name: chemistry.DescriptionSourceName, url: chemistry.DescriptionURL } : null,
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

// PubChem's disease section mixes very different kinds of association: metabolomics
// records (the compound was detected or studied in a condition), occupational exposure
// hazards, and therapeutic-target entries. Each is kept with its source so the page can
// say which is which — none of them is a treatment claim.
async function diseases(cid) {
  const view = await json(`${PUBCHEM}/pug_view/data/compound/${cid}/JSON?heading=Associated+Disorders+and+Diseases`
    .replace("/rest/pug/pug_view", "/rest/pug_view"));
  if (view === undefined) return undefined;
  const record = view?.Record;
  if (!record) return [];
  const sources = new Map((record.Reference || []).map((r) => [r.ReferenceNumber, { name: r.SourceName, url: r.URL }]));

  const found = [];
  const walk = (sections, heading) => {
    for (const section of sections || []) {
      for (const entry of section.Information || []) {
        const source = sources.get(entry.ReferenceNumber);
        const text = entry.Value?.StringWithMarkup?.[0]?.String;
        if (!source || !text) continue;
        // "PubMed: 123, 456" means the entry Name is the disease and the value lists the
        // evidence. Anything else puts the disease in the value and a heading in Name.
        if (/^PubMed:/i.test(text)) {
          found.push({ disease: entry.Name, kind: "reported_association", pmids: (text.match(/\d{6,8}/g) || []).slice(0, 40), source: source.name, source_url: source.url });
        } else if (/disorder|disease/i.test(`${section.TOCHeading || heading || ""} ${entry.Name || ""}`)) {
          found.push({ disease: text.replace(/\s*\[Category:[^\]]*\]\s*/, "").trim(), category: (text.match(/\[Category:\s*([^\]]+)\]/) || [])[1] || null, kind: "occupational_exposure", pmids: [], source: source.name, source_url: source.url });
        }
      }
      walk(section.Section, section.TOCHeading || heading);
    }
  };
  walk(record.Section);

  const merged = new Map();
  for (const item of found) {
    const key = `${item.kind}:${item.disease.toLowerCase()}`;
    if (!item.disease) continue;
    if (!merged.has(key)) merged.set(key, { ...item, id: item.disease.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") });
  }
  return [...merged.values()].sort((a, b) => (b.pmids.length - a.pmids.length) || a.disease.localeCompare(b.disease));
}

// Which plants a molecule actually occurs in. Wikidata's "found in taxon" (P703) is
// keyed off the InChIKey, so the match is exact rather than name-guessed. Kingdom comes
// back annotated because P703 also records animals — terpenes turn up in scent-marking
// studies — and the naive `wdt:P171* wd:Q756` plant filter times out the endpoint.
// Which organisms a molecule occurs in, from LOTUS (lotus.naturalproducts.net) — a
// curated natural-products occurrence database where every compound/organism pair carries
// a literature reference and a real taxonomic backbone (GBIF, NCBI, ITIS, Open Tree of
// Life). Wikidata mirrors much of LOTUS but drops the citations and its kingdom paths are
// unreliable: it filed the plant genus Heterotropa under Animalia and left red algae with
// no kingdom at all.
const LOTUS = "https://lotus.naturalproducts.net/api/search/simple";
const TAXONOMY_PRIORITY = ["NCBI", "GBIF Backbone Taxonomy", "Open Tree of Life", "ITIS", "iNaturalist", "VASCAN"];
// LOTUS encodes "." as "$x$x$" in the DOI keys of taxonomyReferenceObjects.
const decodeDoi = (key) => key.replaceAll("$x$x$", ".");

async function organisms(inchikey, cap = 120) {
  if (!inchikey) return { organisms: [], organism_count: 0, reference_count: 0 };
  const payload = await json(`${LOTUS}?query=${encodeURIComponent(inchikey)}`);
  if (payload === undefined) return undefined;
  const record = payload?.naturalProducts?.[0];
  if (!record?.taxonomyReferenceObjects) return { organisms: [], organism_count: 0, reference_count: 0 };

  const byOrganism = new Map();
  const references = Object.keys(record.taxonomyReferenceObjects);
  for (const [referenceKey, byDatabase] of Object.entries(record.taxonomyReferenceObjects)) {
    const doi = decodeDoi(referenceKey);
    for (const [database, entries] of Object.entries(byDatabase)) {
      for (const entry of entries || []) {
        const name = entry.organism_value;
        if (!name) continue;
        // GBIF writes hybrids as "Citrus × limon" and NCBI as "Citrus limon"; without this
        // the same plant lands twice, competing with itself for the top of the list.
        const key = name.replace(/\s*×\s*/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
        const existing = byOrganism.get(key) || {
          name: name.replace(/\s*×\s*/g, " ").replace(/\s+/g, " ").trim(),
          id: key.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
          kingdom: null, phylum: null, family: null, genus: null,
          databases: new Set(), references: new Set(),
        };
        existing.references.add(doi);
        existing.databases.add(database);
        // Take taxonomy from the most authoritative database that supplied it.
        const rank = TAXONOMY_PRIORITY.indexOf(database);
        if (entry.kingdom && (existing.kingdom === null || rank <= TAXONOMY_PRIORITY.indexOf(existing.source || ""))) {
          // NCBI says Viridiplantae where GBIF says Plantae; one word for one concept.
          existing.kingdom = entry.kingdom === "Viridiplantae" ? "Plantae" : entry.kingdom;
          existing.phylum = entry.phylum || existing.phylum;
          existing.family = entry.family || existing.family;
          existing.genus = entry.genus || existing.genus;
          existing.source = database;
        }
        byOrganism.set(key, existing);
      }
    }
  }

  const all = [...byOrganism.values()]
    .map((organism) => ({
      name: organism.name,
      id: organism.id,
      kingdom: organism.kingdom,
      phylum: organism.phylum,
      family: organism.family,
      genus: organism.genus,
      taxonomy_source: organism.source || [...organism.databases][0] || null,
      reference_count: organism.references.size,
      references: [...organism.references].slice(0, 2),
    }))
    // Best-attested first: an organism reported by many papers is the one worth showing.
    .sort((a, b) => b.reference_count - a.reference_count || a.name.localeCompare(b.name));

  return {
    organisms: all.slice(0, cap),
    organism_count: all.length,
    reference_count: references.length,
    source: "LOTUS · lotus.naturalproducts.net",
    lotus_id: record.lotus_id || null,
  };
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

// Every compound a lab actually measured in a MONDAYS chew gets a record, down to the
// 0.05% floor the profiles publish — a trace compound is still a compound someone can
// look up. Anything already on file is refreshed too.
const profileDir = path.join(root, "data/terpene-profiles");
const names = new Map();
for (const file of await fs.readdir(profileDir)) {
  if (file === "index.json") continue;
  const profile = JSON.parse(await fs.readFile(path.join(profileDir, file), "utf8"));
  const listed = profile.compounds.filter((c) => !c.aggregate);
  for (const compound of listed) names.set(compound.id, compound.name);
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
  const fetchedDiseases = chem?.cid ? await diseases(chem.cid) : [];
  const fetchedOccurrence = chem?.inchikey ? await organisms(chem.inchikey) : null;
  const record = {
    ...existing,
    name,
    id,
    formula: chem?.formula || existing.formula || null,
    pubchem: chem ?? null,
    targets: fetchedTargets === undefined ? existing.targets ?? [] : fetchedTargets,
    diseases: fetchedDiseases === undefined ? existing.diseases ?? [] : fetchedDiseases,
    occurrence: fetchedOccurrence === undefined ? existing.occurrence ?? null : fetchedOccurrence,
    organisms: undefined, // superseded by `occurrence`; drop the old Wikidata list
    literature: keep(fetchedLiterature, existing.literature),
    retrieved: new Date().toISOString().slice(0, 10),
  };
  await localImage(id, record);
  await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`${id}: ${chem?.cid ? `CID ${chem.cid}` : "no PubChem match"}, ${record.targets.length} targets, ${record.diseases.length} diseases, ${record.occurrence?.organism_count ?? 0} organisms, ${record.literature?.papers.length ?? 0}/${record.literature?.total ?? 0} papers`);
}
