# MONDAYS × Terpedia

Static product catalog for the MONDAYS partnership. It can be hosted directly on GitHub Pages or Cloudflare Pages; there is no server, database, or build step. Query routes render shared templates: `/?c=limonene`, `/?p=cb2`, `/?d=anxiety`, `/?claim=relaxation`, and `/?pmid=31446830`.

## Local preview

Because the page loads `data/products.json`, serve the directory over HTTP:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080` from this directory.

## Terpene profiles

`data/terpene-profiles/<handle>.json` holds the measured terpene profile MONDAYS publishes on each hemp product page: every compound listed at 0.05% or more of total volatiles, plus the aggregate trace/unidentified slice, with the milligrams each contributes to a 20mg-terpene chew. Refresh from the live store with:

```bash
node scripts/fetch-terpene-profiles.mjs
node scripts/apply-terpene-profiles.mjs
```

The first writes the profile files, the second folds the top compounds and a pointer into `data/products.json`.

## Data policy

`data/products.json` is a dated snapshot of the public MONDAYS product catalog. Products with `"molecules_basis": "measured"` carry laboratory-quantified compounds from the profile files above. Products with `"molecules_basis": "candidate"` — the botanical SKUs and the bundles, which publish no measurement — keep molecule lists inferred from strain/profile language, not claims about measured composition.

The batch CoAs linked from each product are cannabinoid and safety panels (all cannabinoids ND); they carry no terpene panel, so the measured profile is a separate analytical record from a separate laboratory.

## Deployment

- GitHub Pages: enable Pages for the repository and select **GitHub Actions**.
- Cloudflare Pages: connect the repository with the root directory set to `mondays` if the monorepo is deployed, or deploy this directory as the project root.
