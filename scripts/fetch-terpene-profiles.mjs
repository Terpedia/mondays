#!/usr/bin/env node
// Scrape the measured terpene profiles MONDAYS publishes on each hemp product page
// into data/terpene-profiles/<handle>.json. Botanical SKUs and bundles carry no
// measured profile and are skipped.
import fs from "node:fs/promises";
import path from "node:path";

const STORE = "https://www.chewmondays.com";
const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "data/terpene-profiles");
const decode = (value) => value
  .replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">")
  .replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&middot;", "·")
  .replaceAll("&nbsp;", " ").replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
const text = (value) => decode(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

const slug = (value) => value.toLowerCase()
  .replaceAll("β", "beta-").replaceAll("α", "alpha-").replaceAll("γ", "gamma-").replaceAll("δ", "delta-")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function profile(handle) {
  const url = `${STORE}/products/${handle}`;
  const html = await fetch(url, { headers: { "user-agent": "terpedia-mondays-ingest" } }).then((r) => r.text());
  const section = html.slice(html.indexOf('<section class="mv mv-sec mv-sec--paper mv-tp"'));
  if (!section.startsWith("<section")) return null;

  const compounds = [];
  for (const [, body] of section.matchAll(/<button[^>]*class="mv-trow[^"]*"[^>]*>([\s\S]*?)<\/button>/g)) {
    const name = text((body.match(/mv-trow__name">([\s\S]*?)<\/span>/) || [])[1] || "");
    const value = text((body.match(/mv-trow__val">([\s\S]*?)<\/span>/) || [])[1] || "");
    const [, percent, mg] = value.match(/([\d.]+)%\s*·\s*([\d.]+)mg/) || [];
    if (!name || percent === undefined) continue;
    compounds.push({
      name,
      id: slug(name),
      percent_of_profile: Number(percent),
      mg_per_chew: Number(mg),
      aggregate: /trace and unidentified/i.test(name),
    });
  }
  if (!compounds.length) return null;

  const heading = text((section.match(/class="mv-tp__h">([\s\S]*?)<\/h2>/) || [])[1] || "");
  const meta = text((section.match(/class="[^"]*mv-tp__meta"[^>]*>([\s\S]*?)<\/p>/) || [])[1] || "");
  const note = text((section.match(/class="[^"]*mv-tp__note[^"]*"[^>]*>([\s\S]*?)<\/p>/) || [])[1] || "");

  return {
    handle,
    product: meta.split("·")[0].trim() || handle,
    source: url,
    identified_compounds: Number((heading.match(/(\d+)\s+terpenes/) || [])[1]) || null,
    listed_compounds: compounds.filter((c) => !c.aggregate).length,
    trace_compounds_not_listed: Number((note.match(/plus\s+(\d+)\s+more identified at trace/) || [])[1]) || 0,
    mg_terpenes_per_chew: Number((meta.match(/(\d+(?:\.\d+)?)mg total terpenes/) || [])[1]) || null,
    lab: /ISO 17025/i.test(meta) ? "ISO 17025-accredited laboratory (unnamed on page)" : null,
    basis: "percent of total volatiles; mg assumes the stated total terpenes per chew",
    note,
    compounds,
  };
}

// The all-caps banner above "The Vibe" on each product page is MONDAYS' own claim
// language. Captured verbatim so the catalog can show it as marketing, clearly
// separated from anything measured.
function claimTiles(product) {
  const copy = text(product.body_html || "");
  const banner = copy.match(/^([A-Z][A-Z \-]{5,40}?)\s+The Vibe/);
  return banner ? banner[1].trim().split(/\s+/) : [];
}

const handles = process.argv.slice(2);
const catalog = await fetch(`${STORE}/products.json?limit=250`).then((r) => r.json());
const retail = catalog.products.filter((p) => p.tags.includes("retail"));
if (!handles.length) handles.push(...retail.map((p) => p.handle));

const claims = {};
for (const product of retail) {
  const tiles = claimTiles(product);
  if (tiles.length) claims[product.handle] = { tiles, source: `${STORE}/products/${product.handle}` };
}
await fs.writeFile(path.join(root, "data/product-claims.json"), `${JSON.stringify({ source: STORE, retrieved: new Date().toISOString().slice(0, 10), note: "MONDAYS marketing language, verbatim. Not a health claim and not evidence.", claims }, null, 2)}\n`);

await fs.mkdir(outDir, { recursive: true });
const index = [];
for (const handle of handles) {
  const result = await profile(handle);
  if (!result) { console.log(`skip ${handle} — no published terpene profile`); continue; }
  await fs.writeFile(path.join(outDir, `${handle}.json`), `${JSON.stringify(result, null, 2)}\n`);
  index.push({ handle, product: result.product, identified_compounds: result.identified_compounds, listed_compounds: result.listed_compounds });
  console.log(`${handle}: ${result.listed_compounds} listed of ${result.identified_compounds} identified`);
}
await fs.writeFile(path.join(outDir, "index.json"), `${JSON.stringify({ source: STORE, retrieved: new Date().toISOString().slice(0, 10), profiles: index }, null, 2)}\n`);
