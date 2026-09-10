const TERPEDIA_PORTAL = 'https://terpedia.com/intelligence-portals/cannabis';
// Terproduct's Cloud Run URL. terproduct.terpedia.com still points at GitHub Pages
// (a stale static export), so it 404s on this route until DNS moves to Cloud Run.
const TERPRODUCT = 'https://terproduct-715567218723.us-central1.run.app/molecule/';
let products = [];
let activeFilter = 'all';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const slugOf = (name) => name.toLowerCase().replaceAll('β', 'beta-').replaceAll('α', 'alpha-').replaceAll('γ', 'gamma-').replaceAll('δ', 'delta-').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const moleculeUrl = (name) => `?c=${encodeURIComponent(slugOf(name))}`;
const main = () => document.querySelector('main');
const getJSON = async (url) => { try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch { return null; } };
const back = '<a class="back" href="./">← Back to MONDAYS catalog</a>';

// Measured-profile compound ids that name the same molecule as an existing profile file.
const MOLECULE_ALIASES = {'myrcene': 'beta-myrcene', 'alpha-humulene': 'humulene', 'caryophyllene': 'beta-caryophyllene', 'pinene': 'alpha-pinene'};

// Every compound at or above 0.05% of the profile, scrollable, with the aggregate
// trace slice pinned at the bottom where the lab reports it.
const compoundTable = (compounds) => `
  <div class="ctable-wrap">
    <table class="ctable">
      <thead><tr><th>#</th><th>Compound</th><th class="num">% of profile</th><th class="num">mg per chew</th></tr></thead>
      <tbody>${compounds.map((c, i) => `
        <tr class="${c.aggregate ? 'aggregate' : ''}">
          <td class="num rank">${c.aggregate ? '' : i + 1}</td>
          <td>${c.aggregate ? esc(c.name) : `<a href="?c=${encodeURIComponent(c.id)}">${esc(c.name)}</a>`}</td>
          <td class="num">${c.percent_of_profile}%</td>
          <td class="num">${c.mg_per_chew}mg</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>`;

const claimTiles = (claims) => claims?.length
  ? `<div class="claims"><div class="claims-label">MONDAYS claim language</div><div class="claim-tiles">${claims.map((t) => `<span class="claim-tile">${esc(t)}</span>`).join('')}</div><p class="fine">Verbatim marketing copy from the product page. Not a health claim, and not evidence about this product or these compounds.</p></div>`
  : '';

async function renderProduct(handle) {
  const catalog = await getJSON('data/products.json');
  const product = catalog?.products.find((p) => p.handle === handle);
  if (!product) return renderMissing('Product', handle);
  const profile = product.terpene_profile ? await getJSON(product.terpene_profile.path) : null;

  main().innerHTML = `
    <section class="entity">
      ${back}
      <p class="eyebrow">${esc(product.type)} · ${esc(product.category)}</p>
      <h1>${esc(product.name)}</h1>
      <div class="strain">${esc(product.strain)}</div>
      <p class="hero-copy">${esc(product.description)}</p>
      ${claimTiles(product.claims)}

      ${profile ? `
      <h2 class="section-h">Measured terpene profile</h2>
      <div class="stat-row">
        <div class="stat"><b>${profile.identified_compounds}</b><span>compounds identified</span></div>
        <div class="stat"><b>${profile.listed_compounds}</b><span>listed at ≥0.05%</span></div>
        <div class="stat"><b>${profile.trace_compounds_not_listed}</b><span>further traces</span></div>
        <div class="stat"><b>${profile.mg_terpenes_per_chew}mg</b><span>terpenes per chew</span></div>
      </div>
      ${compoundTable(profile.compounds)}
      <p class="fine">${esc(profile.note)}</p>
      ` : `<p class="fine">MONDAYS publishes no measured terpene profile for this product. The molecules below are candidates inferred from strain and flavour language, not measurements.</p>
      <div class="molecule-list">${(product.molecules || []).map((m) => `<a href="${moleculeUrl(m)}">${esc(m)}</a>`).join('')}</div>`}

      <h2 class="section-h">Traceability</h2>
      <div class="molecule-panel">
        <span>Ingredient</span><strong>${esc(product.ingredient)}</strong>
        <span>Batch</span><strong>${esc(product.coa_batch || 'Not published')}</strong>
        <span>Batch panel</span><strong>Cannabinoid and safety panel, all cannabinoids not detected. Carries no terpene panel.</strong>
      </div>
      <a class="portal-button" href="${esc(product.source)}" target="_blank" rel="noreferrer">View on MONDAYS ↗</a>
    </section>`;
  return true;
}

function renderMissing(kind, slug) {
  main().innerHTML = `<section class="entity">${back}<p class="eyebrow">${esc(kind)}</p><h1>${esc(slug.replaceAll('-', ' '))}</h1><p class="hero-copy">No record on file for this ${kind.toLowerCase()} in the catalog snapshot.</p></section>`;
  return true;
}

async function renderMolecule(slug) {
  const id = MOLECULE_ALIASES[slug] || slug;
  const [molecule, index] = await Promise.all([getJSON(`data/molecules/${encodeURIComponent(id)}.json`), getJSON('data/molecule-products.json')]);
  if (!molecule) return renderMissing('Molecule', id);
  const inProducts = index?.molecules[slug] || index?.molecules[id] || [];
  const chem = molecule.pubchem;
  const lit = molecule.literature;

  main().innerHTML = `
    <section class="entity">
      ${back}
      <p class="eyebrow">Terpedia molecule profile</p>
      <div class="mol-head">
        ${chem?.image ? `<img class="mol-image" src="${esc(chem.image)}" alt="Structure of ${esc(molecule.name)}" width="300" height="300" onerror="this.remove()" />` : ''}
        <div>
          <h1>${esc(molecule.name)}</h1>
          ${molecule.summary ? `<p class="hero-copy">${esc(molecule.summary)}</p>` : ''}
          ${molecule.evidence ? `<p class="measured-line">${esc(molecule.evidence)}</p>` : ''}
        </div>
      </div>

      ${chem ? `
      <h2 class="section-h">What it is</h2>
      <div class="molecule-panel">
        <span>Formula</span><strong>${esc(chem.formula)}</strong>
        <span>Molecular weight</span><strong>${esc(chem.molecular_weight)} g/mol</strong>
        <span>PubChem</span><strong><a href="${esc(chem.url)}" target="_blank" rel="noreferrer">CID ${esc(chem.cid)} ↗</a></strong>
      </div>
      ${chem.description ? `<p class="hero-copy">${esc(chem.description)}</p>${chem.description_source ? `<p class="fine">Source: <a href="${esc(chem.description_source.url)}" target="_blank" rel="noreferrer">${esc(chem.description_source.name)} ↗</a>, via PubChem.</p>` : ''}` : ''}
      ` : '<p class="fine">No PubChem record matched this compound name.</p>'}

      <h2 class="section-h">Measured in these products</h2>
      ${inProducts.length ? `
      <div class="ctable-wrap">
        <table class="ctable">
          <thead><tr><th>Product</th><th class="num">% of profile</th><th class="num">mg per chew</th><th class="num">Rank</th></tr></thead>
          <tbody>${inProducts.map((p) => `
            <tr>
              <td><a href="?product=${encodeURIComponent(p.handle)}">${esc(p.product)}</a><br /><span class="fine">${esc(p.strain)}</span></td>
              <td class="num">${p.percent}%</td>
              <td class="num">${p.mg}mg</td>
              <td class="num">${p.rank} of ${p.of}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${claimTiles([...new Set(inProducts.flatMap((p) => p.claims || []))])}
      ` : '<p class="fine">Not quantified in any published MONDAYS profile.</p>'}

      <h2 class="section-h">The research record</h2>
      <p class="hero-copy">Protein assay results, reported disease associations and the literature for ${esc(molecule.name)} live on Terproduct, where each record is shown with the kind of evidence behind it. Those describe the compound at laboratory doses. They do not describe a chew.</p>
      <a class="portal-button" href="${TERPRODUCT}${encodeURIComponent(molecule.id)}/" target="_blank" rel="noreferrer">Open the Terproduct record ↗</a>
      ${molecule.retrieved ? `<p class="fine">Chemistry retrieved ${esc(molecule.retrieved)} from PubChem.</p>` : ''}
    </section>`;
  return true;
}

async function renderEntity(type, slug) {
  if (type === 'molecule') return renderMolecule(slug);
  if (type === 'product') return renderProduct(slug);
  return renderEntityStub(type, slug);
}

async function renderEntityStub(type, slug) {
  const labels = {protein:'Protein', disease:'Disease / condition', claim:'Claim', pmid:'Literature'};
  const fallback = {name: slug.replaceAll('-', ' '), summary: `Terpedia ${labels[type]} profile`, evidence: 'Profile data will be hydrated from Terpedia when the public record is connected.'};
  const record = await getJSON(`data/${type}s/${encodeURIComponent(slug)}.json`) || fallback;
  const source = type === 'pmid' ? `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(slug)}/` : `${TERPEDIA_PORTAL}?${type}=${encodeURIComponent(record.name)}`;
  main().innerHTML = `<section class="entity">${back}<p class="eyebrow">Terpedia ${labels[type]} profile</p><h1>${esc(record.name)}</h1><p class="hero-copy">${esc(record.summary)}</p><div class="molecule-panel"><span>Type</span><strong>${labels[type]}</strong>${type === 'pmid' ? `<span>PMID</span><strong>${esc(slug)}</strong>` : ''}<span>Evidence</span><strong>${esc(record.evidence)}</strong></div><a class="portal-button" href="${source}" target="_blank" rel="noreferrer">${type === 'pmid' ? 'Open PubMed record' : 'Open Terpedia intelligence'} ↗</a></section>`;
  return true;
}

function render() {
  const query = document.querySelector('#search').value.trim().toLowerCase();
  const visible = products.filter((p) => {
    const matchesType = activeFilter === 'all' || p.type === activeFilter;
    const haystack = [p.name, p.strain, p.description, ...p.molecules].join(' ').toLowerCase();
    return matchesType && (!query || haystack.includes(query));
  });
  document.querySelector('#catalog').innerHTML = visible.map((p) => `
    <article class="card">
      <div class="card-top"><span class="pill ${p.type.toLowerCase()}">${esc(p.type)}</span><span>${esc(p.size)}</span></div>
      <h2><a href="?product=${encodeURIComponent(p.handle)}">${esc(p.name)}</a></h2>
      <div class="strain">${esc(p.strain)}</div>
      <p class="description">${esc(p.description)}</p>
      <div class="molecules"><div class="molecules-label">${p.molecules_basis === 'measured' ? `Measured terpene profile · top ${p.terpene_profile.top.length} of ${p.terpene_profile.identified_compounds}` : 'Profile molecule candidates'}</div><div class="molecule-list">${p.molecules_basis === 'measured' ? p.terpene_profile.top.map((c) => `<a href="?c=${encodeURIComponent(c.id)}">${esc(c.name)} <b>${c.percent}%</b> · ${c.mg}mg</a>`).join('') : p.molecules.map((m) => `<a href="${moleculeUrl(m)}">${esc(m)}</a>`).join('')}</div></div>
      <div class="card-footer"><a href="?product=${encodeURIComponent(p.handle)}">${p.molecules_basis === 'measured' ? `All ${p.terpene_profile.listed_compounds} compounds →` : 'Product detail →'}</a><span>${esc(p.category)}</span></div>
    </article>`).join('');
  document.querySelector('#empty').hidden = visible.length !== 0;
}

document.querySelectorAll('.filter').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.filter').forEach((b) => b.classList.remove('active'));
  button.classList.add('active'); activeFilter = button.dataset.filter; render();
}));
document.querySelector('#search').addEventListener('input', render);

const params = new URLSearchParams(location.search);
const ROUTES = {c: 'molecule', product: 'product', p: 'protein', d: 'disease', claim: 'claim', pmid: 'pmid'};
const key = Object.keys(ROUTES).find((k) => params.get(k));
const route = key ? renderEntity(ROUTES[key], params.get(key)) : Promise.resolve(false);
route.then((isEntity) => { if (isEntity) return null; return getJSON('data/products.json').then((data) => {
  if (!data) { document.querySelector('#product-count').textContent = 'Catalog unavailable'; return; }
  products = data.products;
  document.querySelector('#product-count').textContent = `${products.length} products indexed`;
  render();
});
});
