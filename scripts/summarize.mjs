#!/usr/bin/env node
// Consumer-readable summaries of what the literature holds for each molecule, and for
// each product's full measured profile. Written by Gemini (Vertex AI) from the counted research
// profile, the sourced description, the occurrence data and the paper titles already on
// file — nothing the model is not handed. Cached into the records; rerun with --force to
// regenerate, or name ids to do a subset.
//
// Framing rules live in the system prompt and are the point of this script: structure/
// function language only, every benefit graded by the kind of evidence behind it, and
// disease hypotheses labelled as hypotheses. A summary that reads as a treatment claim is
// a bug, not a style choice.
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { grade } from "./lib/evidence.mjs";

const root = path.resolve(import.meta.dirname, "..");
// Vertex AI, same project as the rest of Terpedia. Auth is the active gcloud credential
// (or GOOGLE_OAUTH_TOKEN when set), so no separate key travels with this script.
const PROJECT = process.env.GCP_PROJECT || "terpedia-489015";
// Gemini 3.x is served from the global location on the v1beta1 surface; regional v1
// endpoints only know 2.5.
const LOCATION = process.env.VERTEX_LOCATION || "global";
const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-pro-preview";
const API_VERSION = process.env.VERTEX_API_VERSION || "v1beta1";
const HOST = LOCATION === "global" ? "aiplatform.googleapis.com" : `${LOCATION}-aiplatform.googleapis.com`;
const ENDPOINT = `https://${HOST}/${API_VERSION}/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;
let cachedToken = null;
function accessToken() {
  if (process.env.GOOGLE_OAUTH_TOKEN) return process.env.GOOGLE_OAUTH_TOKEN;
  cachedToken ||= execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" }).trim();
  return cachedToken;
}

// Gemini's responseSchema is OpenAPI-shaped, not full JSON Schema: no $schema, no
// additionalProperties, and a null-able field is `nullable: true` rather than a
// ["string","null"] type union. Walk zod's JSON Schema and translate.
function toGeminiSchema(schema) {
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$schema" || key === "additionalProperties" || key === "default") continue;
      if (key === "type" && Array.isArray(value)) {
        const types = value.filter((t) => t !== "null");
        out.type = types[0];
        if (types.length !== value.length) out.nullable = true;
        continue;
      }
      if (key === "anyOf" && Array.isArray(value)) {
        // zod emits anyOf [X, {type: null}] for .nullable(); collapse to X + nullable.
        const nonNull = value.filter((v) => v?.type !== "null");
        if (nonNull.length === 1 && nonNull.length !== value.length) {
          Object.assign(out, walk(nonNull[0]), { nullable: true });
          continue;
        }
      }
      out[key] = walk(value);
    }
    return out;
  };
  return walk(z.toJSONSchema(schema));
}

async function generate(system, user, schema, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: toGeminiSchema(schema),
          temperature: 0.3,
          maxOutputTokens: 8192,
        },
      }),
    });
    if (response.status === 401 && attempt < attempts) { cachedToken = null; continue; }
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) { await new Promise((r) => setTimeout(r, attempt * 4000)); continue; }
      throw new Error(`${response.status}: ${data.error?.message || JSON.stringify(data).slice(0, 200)}`);
    }
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
    try { return schema.parse(JSON.parse(text)); }
    catch (error) { if (attempt === attempts) throw new Error(`invalid output: ${error.message}`); }
  }
  throw new Error("exhausted retries");
}
const force = process.argv.includes("--force");
const productsOnly = process.argv.includes("--products");
const moleculesOnly = process.argv.includes("--molecules");
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
// --shard i/n: this worker takes every n-th molecule starting at i, so several can run at once.
const shardArg = (process.argv.find((a) => a.startsWith("--shard=")) || "").split("=")[1];
const [shardIndex, shardCount] = shardArg ? shardArg.split("/").map(Number) : [0, 1];
const mine = (index) => index % shardCount === shardIndex;

const EvidenceLevel = z.enum(["human_trials", "human_observational", "animal", "in_vitro", "review_only", "none_found"]);

const MoleculeSummary = z.object({
  what_it_is: z.string().describe("2-3 vivid plain-language sentences: what kind of molecule, what it smells or tastes like, where a person meets it in daily life."),
  found_in: z.string().describe("1-2 sentences naming familiar plants or foods it has been reported in, from the organism list provided."),
  why_researchers_care: z.string().describe("2-4 sentences on what draws researchers to this molecule and what they are exploring, naming the strongest kind of evidence once (Oxford level and design). Interested, not hedged."),
  structure_function: z.array(z.object({
    claim_id: z.string().describe("The id of the claim area from claims_with_counts this statement rests on. Must be one of those ids."),
    statement: z.string().describe("An affirmative structure/function statement in 'may support' / 'early work points toward' form, true at the given evidence level. Never treat, cure, prevent, or diagnose."),
    evidence_level: EvidenceLevel.describe("Use the max_evidence_level given for that claim. It will be enforced."),
    basis: z.string().describe("One sentence: which counts or papers this rests on."),
  })).describe("Up to 5. Only claim areas present in claims_with_counts."),
  hypothesized_benefits: z.array(z.object({
    claim_id: z.string().describe("The id of the claim area from claims_with_counts. Must be one of those ids."),
    area: z.string(),
    hypothesis: z.string().describe("What researchers are exploring and what it would mean if it bears out. Framed as an open question, with interest."),
    evidence_level: EvidenceLevel.describe("Use the max_evidence_level given for that claim. It will be enforced."),
    paper_count: z.number().int(),
    study_to_test_it: z.string().describe("The study that would move this hypothesis up one Oxford level: design, population or model, what it would measure, roughly how long. Concrete enough that a lab could pick it up. If current evidence is animal-only, propose the first human study; if observational, propose the randomised trial."),
  })).describe("Up to 4 disease or health areas where the literature is exploring a role, each with the study that would test it."),
  associated_conditions: z.array(z.object({
    condition: z.string().describe("The MONDO label where one is given, else the recorded name."),
    mondo_id: z.string().nullable(),
    relationship: z.string().describe("What the association actually is, in a few words: detected in metabolomic studies of, occupational exposure hazard, studied as an intervention for."),
  })),
  cautions: z.string().nullable().describe("One sentence, only if a caution is genuinely warranted (a real hazard, or study doses far from dietary ones). Null otherwise."),
  evidence_at_a_glance: z.string().describe("One sentence: the strongest evidence available and its Oxford level, in plain words. E.g. 'Best evidence so far is human observational work (Oxford 2b); most of the rest is animal and lab research.'"),
});

const ProductSummary = z.object({
  profile_character: z.string().describe("2-3 sentences on what dominates this profile and what that means for aroma and flavour."),
  dominant_compounds: z.array(z.object({
    name: z.string(), share_percent: z.number(), mg_per_serving: z.number(),
    researched_for: z.string().describe("The areas its literature covers, hedged, with evidence level named."),
  })).describe("The largest 4-6 compounds."),
  structure_function_summary: z.string().describe("3-5 sentences: what the combined profile is being studied for and what makes it interesting, in structure/function terms, weighted by how much of each compound is present. Name the best evidence level once."),
  evidence_at_a_glance: z.string().describe("1-2 sentences: the strongest evidence behind the main compounds in Oxford terms, and that study doses differ from milligrams per serving. Stated once, plainly."),
  minor_notes: z.string().nullable().describe("Anything notable in the long tail of the profile. Null if nothing."),
});

const SYSTEM = `You write for a reference site about natural-product chemistry, for curious readers who want to understand the molecules in what they eat, drink and smell. Terpedia is enthusiastic about what these molecules might do. Its job is to make the potential legible, with the evidence grade stated cleanly so readers can weigh it themselves.

Voice:
- Lead with what is interesting. Why researchers are drawn to this molecule, what they are testing, what it would mean if it holds up. Be specific and warm.
- State the evidence level once, as a plain label, and move on. Do not repeat caveats, do not stack hedges, do not end every sentence with a disclaimer. One clear cautions line is enough if a caution is genuinely warranted; otherwise null.
- A hypothesis is exciting because it is open. Frame it that way: "researchers are exploring whether…", "early animal work points toward…", "if this bears out…". Never dismissive.

Lines that hold regardless of tone:
- Structure/function language for benefits: "may support", "is being studied for", "early work points toward". Never "treats", "cures", "prevents", "reduces the risk of".
- Every graded statement carries the evidence level you are given for its claim area (max_evidence_level, oxford_level). Write it so it is true at that level: an animal finding is described as an animal finding. The grade is the honesty; the sentence can still be hopeful.
- Use the standard vocabulary when you name evidence: Oxford CEBM level (e.g. "Oxford level 2b, human observational") and, where a condition is named, its MONDO label.
- Only what you are given: the description, counts, paper titles, organisms, recorded conditions. No invented studies, mechanisms or doses.
- An occupational-exposure record is an industrial hazard, not a property of eating the compound; a metabolomics association means the compound was detected in studies of a condition. Say what the association is, briefly, without alarm.
- No medical advice and no dosing for readers. Proposing the design of a study — including what a trial would measure — is not dosing advice; be concrete there.
- For each hypothesis, say what would settle it. Terpedia wants these questions answered, and the fastest way to get there is to say plainly which study is missing. If a registered clinical trial already exists for that question, name it (NCT id, status) instead of proposing a duplicate — a recruiting trial is the most exciting thing you can report.`;

// The evidence grade is a function of what kinds of study exist, nothing else. "other"
// (unclassified) never counts. The model is told the ceiling per claim and the result is
// overwritten with it regardless, so a summary cannot promote animal data to human data.
const gradeFor = (claim) => claim.evidence_level || grade(claim.evidence_lines || []).evidence_level;
function enforceGrades(summary, claims) {
  const byId = new Map(claims.map((c) => [c.id, c]));
  const fix = (item) => {
    const claim = byId.get(item.claim_id);
    if (!claim) return null; // a statement that cites no known claim area is dropped
    // Stamped from the research profile: consumer level, ECO type, Oxford level, and the
    // evidence lines behind it. The model's own grade is discarded.
    return {
      ...item,
      evidence_level: gradeFor(claim),
      eco: claim.eco || null,
      oxford: claim.oxford || null,
      evidence_lines: (claim.evidence_lines || []).map(({ design, eco, papers }) => ({ design, eco: eco?.id, papers })),
      paper_count: claim.papers,
    };
  };
  return {
    ...summary,
    structure_function: summary.structure_function.map(fix).filter(Boolean),
    hypothesized_benefits: summary.hypothesized_benefits.map(fix).filter(Boolean),
  };
}

const moleculeDir = path.join(root, "data/molecules");
const profileDir = path.join(root, "data/terpene-profiles");
const stamp = () => ({ model: MODEL, generated: new Date().toISOString().slice(0, 10) });

async function summarizeMolecule(record) {
  const research = record.research || {};
  const occurrence = record.occurrence || {};
  const input = {
    name: record.name,
    description: record.pubchem?.description || record.summary || null,
    description_source: record.pubchem?.description_source?.name || null,
    formula: record.pubchem?.formula || record.formula || null,
    literature: {
      total_papers: research.total ?? null,
      sampled: research.sampled ?? null,
      study_designs: research.designs || {},
      years: research.years || null,
      top_topics: (research.topics || []).slice(0, 12),
      claims_with_counts: (research.claims || []).map((c) => ({ id: c.id, label: c.label, papers: c.papers, designs: c.designs, max_evidence_level: gradeFor(c), oxford_level: c.oxford?.level || null, oxford_label: c.oxford?.label || null, eco: c.eco?.id || null })),
      sample_titles: (record.literature?.papers || []).map((p) => `${p.title} (${p.journal || ""} ${p.year || ""}, PMID ${p.pmid})`),
    },
    organisms: (occurrence.organisms || []).slice(0, 15).map((o) => ({ name: o.name, family: o.family, references: o.reference_count })),
    organism_total: occurrence.organism_count || 0,
    protein_targets: (record.targets || []).map((t) => ({ protein: t.protein, activity: t.activity, value_um: t.value_um })),
    registered_clinical_trials: (record.trials?.studies || []).slice(0, 8).map((t) => ({ nct_id: t.nct_id, title: t.title, status: t.status, phases: t.phases, conditions: t.conditions, enrollment: t.enrollment })),
    recorded_conditions: (record.diseases || []).map((d) => ({ condition: d.disease, mondo_id: d.mondo?.id || null, mondo_label: d.mondo?.label || null, kind: d.kind, source: d.source, papers: d.pmids?.length || 0 })),
  };
  const output = await generate(SYSTEM, `Summarise this molecule for a consumer reader.\n\n${JSON.stringify(input, null, 2)}`, MoleculeSummary);
  return { ...stamp(), ...enforceGrades(output, research.claims || []) };
}

async function summarizeProduct(product, profile, molecules) {
  const listed = profile.compounds.filter((c) => !c.aggregate);
  const input = {
    product: product.name,
    strain: product.strain,
    description: product.description,
    mg_terpenes_per_serving: profile.mg_terpenes_per_chew,
    compounds_identified: profile.identified_compounds,
    full_profile: listed.map((c) => ({ name: c.name, percent: c.percent_of_profile, mg: c.mg_per_chew })),
    molecule_summaries: listed.slice(0, 12).map((c) => {
      const m = molecules.get(c.id);
      return m?.consumer_summary ? { name: c.name, percent: c.percent_of_profile, mg: c.mg_per_chew, structure_function: m.consumer_summary.structure_function, why_researchers_care: m.consumer_summary.why_researchers_care, evidence_at_a_glance: m.consumer_summary.evidence_at_a_glance } : { name: c.name, percent: c.percent_of_profile, mg: c.mg_per_chew, note: "no molecule summary on file" };
    }),
  };
  const output = await generate(SYSTEM, `Summarise this product's full measured terpene profile for a consumer reader. Weight each compound's research by its share of the profile.\n\n${JSON.stringify(input, null, 2)}`, ProductSummary);
  return { ...stamp(), ...output };
}

const molecules = new Map();
for (const file of await fs.readdir(moleculeDir)) {
  if (!file.endsWith(".json")) continue;
  const record = JSON.parse(await fs.readFile(path.join(moleculeDir, file), "utf8"));
  molecules.set(record.id, record);
}

if (!productsOnly) {
  let index = -1;
  for (const [id, record] of molecules) {
    index += 1;
    if (!mine(index)) continue;
    if (only.length && !only.includes(id)) continue;
    if (record.consumer_summary && !force) continue;
    if (!record.research && !record.pubchem) { console.log(`${id}: no data to summarise`); continue; }
    try {
      record.consumer_summary = await summarizeMolecule(record);
      await fs.writeFile(path.join(moleculeDir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
      console.log(`${id}: ${record.consumer_summary.structure_function.length} statements, ${record.consumer_summary.hypothesized_benefits.length} hypotheses`);
    } catch (error) { console.warn(`  ! ${id}: ${error.message}`); }
  }
}

if (!moleculesOnly) {
  const catalog = JSON.parse(await fs.readFile(path.join(root, "data/products.json"), "utf8"));
  for (const product of catalog.products) {
    if (!product.terpene_profile) continue;
    if (only.length && !only.includes(product.handle)) continue;
    const profilePath = path.join(root, product.terpene_profile.path);
    const profile = JSON.parse(await fs.readFile(profilePath, "utf8"));
    if (profile.consumer_summary && !force) continue;
    try {
      profile.consumer_summary = await summarizeProduct(product, profile, molecules);
      await fs.writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
      console.log(`${product.handle}: profile summary written`);
    } catch (error) { console.warn(`  ! ${product.handle}: ${error.message}`); }
  }
}
