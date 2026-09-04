const TERPEDIA_PORTAL = 'https://terpedia.com/intelligence-portals/cannabis';
let products = [];
let activeFilter = 'all';

const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const moleculeUrl = (name) => `?c=${encodeURIComponent(name.toLowerCase().replaceAll('β-', 'beta-').replaceAll('α-', 'alpha-'))}`;

async function renderMolecule() {
  const slug = new URLSearchParams(location.search).get('c');
  if (!slug) return false;
  return renderEntity('molecule', slug);
}

async function renderEntity(type, slug) {
  const labels = {molecule:'Molecule', protein:'Protein', disease:'Disease / condition', claim:'Claim', pmid:'Literature'};
  const fallback = {name: slug.replaceAll('-', ' '), summary: `Terpedia ${labels[type]} profile`, evidence: 'Profile data will be hydrated from Terpedia when the public record is connected.'};
  let molecule = fallback;
  try { const response = await fetch(`data/${type}s/${encodeURIComponent(slug)}.json`); if (response.ok) molecule = await response.json(); } catch (_) {}
  const source = type === 'pmid' ? `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(slug)}/` : `${TERPEDIA_PORTAL}?${type}=${encodeURIComponent(molecule.name)}`;
  document.querySelector('main').innerHTML = `<section class="molecule-hero"><a class="back" href="./">← Back to MONDAYS catalog</a><p class="eyebrow">Terpedia ${labels[type]} profile</p><h1>${esc(molecule.name)}</h1><p class="hero-copy">${esc(molecule.summary)}</p><div class="molecule-panel"><span>Type</span><strong>${labels[type]}</strong>${molecule.formula ? `<span>Identity</span><strong>${esc(molecule.formula)}</strong>` : ''}${type === 'pmid' ? `<span>PMID</span><strong>${esc(slug)}</strong>` : ''}<span>Evidence</span><strong>${esc(molecule.evidence)}</strong></div><a class="portal-button" href="${source}" target="_blank" rel="noreferrer">${type === 'pmid' ? 'Open PubMed record' : 'Open Terpedia intelligence'} ↗</a></section>`;
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
      <h2>${esc(p.name)}</h2>
      <div class="strain">${esc(p.strain)}</div>
      <p class="description">${esc(p.description)}</p>
      <div class="molecules"><div class="molecules-label">Profile molecule candidates</div><div class="molecule-list">${p.molecules.map((m) => `<a href="${moleculeUrl(m)}" target="_blank" rel="noreferrer">${esc(m)} ↗</a>`).join('')}</div></div>
      <div class="traceability"><div><b>Ingredient</b><span>${esc(p.ingredient || 'Cannabis sativa L. terpene oil · SKU-specific')}</span></div><div><b>CoA</b><span>${p.coa ? `<a href="${esc(p.coa)}" target="_blank" rel="noreferrer">View batch report ↗</a>` : 'Pending partner document'}</span></div></div>
      <div class="card-footer"><a href="${esc(p.source)}" target="_blank" rel="noreferrer">MONDAYS source ↗</a><span>${esc(p.category)}</span></div>
    </article>`).join('');
  document.querySelector('#empty').hidden = visible.length !== 0;
}

document.querySelectorAll('.filter').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.filter').forEach((b) => b.classList.remove('active'));
  button.classList.add('active'); activeFilter = button.dataset.filter; render();
}));
document.querySelector('#search').addEventListener('input', render);
const params = new URLSearchParams(location.search);
const entityType = params.has('p') ? 'protein' : params.has('d') ? 'disease' : params.has('claim') ? 'claim' : params.has('pmid') ? 'pmid' : null;
const entitySlug = entityType && params.get(entityType === 'protein' ? 'p' : entityType === 'disease' ? 'd' : entityType);
const route = entityType && entitySlug ? renderEntity(entityType, entitySlug) : renderMolecule();
route.then((isEntity) => { if (isEntity) return null; return fetch('data/products.json').then((r) => r.json()).then((data) => {
  products = data.products;
  document.querySelector('#product-count').textContent = `${products.length} products indexed`;
  render();
}).catch(() => { document.querySelector('#product-count').textContent = 'Catalog unavailable'; });
});
