# MONDAYS × Terpedia

Static product catalog for the MONDAYS partnership. It can be hosted directly on GitHub Pages or Cloudflare Pages; there is no server, database, or build step. Query routes render shared templates: `/?c=limonene`, `/?p=cb2`, `/?d=anxiety`, `/?claim=relaxation`, and `/?pmid=31446830`.

## Local preview

Because the page loads `data/products.json`, serve the directory over HTTP:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080` from this directory.

## Data policy

`data/products.json` is a dated snapshot of the public MONDAYS product catalog. Molecules are profile candidates based on strain/profile language, not claims about measured product composition. Replace or supplement them with batch CoA results when available.

## Deployment

- GitHub Pages: enable Pages for the repository and select **GitHub Actions**.
- Cloudflare Pages: connect the repository with the root directory set to `mondays` if the monorepo is deployed, or deploy this directory as the project root.
