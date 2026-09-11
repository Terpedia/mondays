const TERPEDIA_PORTAL = 'https://terpedia.com/intelligence-portals/cannabis';
// The knowledge base is where molecule science lives; this catalog carries composition.
const KB_MOLECULE = 'https://kb.terpedia.com/entity/';
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

const LEVEL_LABEL = {human_trials: 'human trials', human_observational: 'human observational', animal: 'animal studies', in_vitro: 'lab studies', review_only: 'reviews', none_found: 'no research yet'};
const claimTiles = (claims) => claims?.length
  ? `<div class="claims"><div class="claims-label">On the pack</div><div class="claim-tiles">${claims.map((t) => `<span class="claim-tile">${esc(t)}</span>`).join('')}</div></div>`
  : '';

// A claim with its receipts: what it means, and which measured compounds carry research in
// that area, graded on Oxford CEBM. The tile is a promise; this is what stands behind it.
const claimSupport = (support) => support?.length
  ? `<h2 class="section-h">What the claims mean, and what backs them</h2>
    <div class="claim-cards">${support.map((c) => `
      <details class="claim-card" ${c.compounds_with_research ? '' : 'data-empty'}>
        <summary>
          <span class="claim-tile">${esc(c.tile)}</span>
          <span class="claim-def">${esc(c.definition || 'No definition yet.')}</span>
          <span class="claim-stat">${c.compounds_with_research ? `${c.compounds_with_research} compounds · ${c.share_of_profile}% of profile · ${c.papers} papers · best evidence <b>${esc(LEVEL_LABEL[c.best_evidence] || c.best_evidence)}</b>${c.best_oxford ? ` (Oxford ${esc(c.best_oxford)})` : ''}` : 'No research on file for this area yet.'}</span>
        </summary>
        ${c.backing.length ? `<div class="ctable-wrap claim-table"><table class="ctable">
          <thead><tr><th>Compound</th><th class="num">Share</th><th class="num">Papers</th><th>Best evidence</th><th>Oxford</th></tr></thead>
          <tbody>${c.backing.map((b) => `<tr>
            <td><a href="?c=${encodeURIComponent(b.id)}">${esc(b.name)}</a><br /><span class="fine">${esc(b.areas.join(' · '))}</span></td>
            <td class="num">${b.percent}%</td>
            <td class="num">${b.pmids?.length ? `<a href="https://pubmed.ncbi.nlm.nih.gov/?term=${b.pmids.join(',')}" target="_blank" rel="noreferrer">${b.papers} ↗</a>` : b.papers}</td>
            <td>${esc(LEVEL_LABEL[b.evidence_level] || b.evidence_level)}${b.eco ? `<br /><span class="fine mono">${esc(b.eco)}</span>` : ''}</td>
            <td class="num">${esc(b.oxford || '—')}</td>
          </tr>`).join('')}</tbody></table></div>
        <p class="fine">Research on each compound in this area, weighted by how much of the chew it is. Evidence type per ECO, strength per Oxford CEBM 2009. Studies test isolated compounds at their own doses.</p>` : ''}
      </details>`).join('')}</div>`
  : '';

const evidenceBadge = (level, oxford) => `<span class="ev-badge ev-${esc(level)}">${esc(LEVEL_LABEL[level] || level)}${oxford?.level ? ` · Oxford ${esc(oxford.level)}` : ''}</span>`;

// The cached consumer summary for a molecule: what it is, why it is interesting, what
// may support what at which evidence level, the open hypotheses and the studies that
// would settle them. Written from the record, graded from the data.
const moleculeSummary = (cs) => cs ? `
  <h2 class="section-h">In plain language</h2>
  <p class="hero-copy">${esc(cs.what_it_is)}</p>
  <p class="hero-copy">${esc(cs.found_in)}</p>
  <h2 class="section-h">Why researchers are interested</h2>
  <p class="hero-copy">${esc(cs.why_researchers_care)}</p>
  <p class="measured-line">${esc(cs.evidence_at_a_glance)}</p>
  ${cs.structure_function?.length ? `<h2 class="section-h">What it may support</h2>
  <ul class="sf-list">${cs.structure_function.map((x) => `<li><p class="sf-statement">${esc(x.statement)}</p><p class="fine">${evidenceBadge(x.evidence_level, x.oxford)} · ${esc(x.basis)}${x.eco?.id ? ` · <span class="mono">${esc(x.eco.id)}</span>` : ''}</p></li>`).join('')}</ul>` : ''}
  ${cs.hypothesized_benefits?.length ? `<h2 class="section-h">Open questions worth answering</h2>
  <ul class="sf-list">${cs.hypothesized_benefits.map((x) => `<li><p class="sf-statement"><b>${esc(x.area)}</b> — ${esc(x.hypothesis)}</p><p class="fine">${evidenceBadge(x.evidence_level, x.oxford)} · ${x.paper_count} papers</p>${x.study_to_test_it ? `<p class="study-idea"><b>The study that would settle it:</b> ${esc(x.study_to_test_it)}</p>` : ''}</li>`).join('')}</ul>` : ''}
  ${cs.associated_conditions?.length ? `<h2 class="section-h">Conditions it has been studied in</h2>
  <ul class="cond-list">${cs.associated_conditions.map((x) => `<li><b>${esc(x.condition)}</b>${x.mondo_id ? ` <span class="mono fine">${esc(x.mondo_id)}</span>` : ''} — <span class="fine">${esc(x.relationship)}</span></li>`).join('')}</ul>` : ''}
  ${cs.cautions ? `<p class="fine"><b>Worth knowing:</b> ${esc(cs.cautions)}</p>` : ''}
  <p class="fine">Summary written from the record by ${esc(cs.model)} on ${esc(cs.generated)}; evidence grades computed from PubMed indexing (ECO · MeSH publication types · Oxford CEBM 2009).</p>` : '';

const productSummary = (cs) => cs ? `
  <h2 class="section-h">This profile, in plain language</h2>
  <p class="hero-copy">${esc(cs.profile_character)}</p>
  <p class="hero-copy">${esc(cs.structure_function_summary)}</p>
  <p class="measured-line">${esc(cs.evidence_at_a_glance)}</p>
  ${cs.dominant_compounds?.length ? `<ul class="sf-list">${cs.dominant_compounds.map((c) => `<li><p class="sf-statement"><b>${esc(c.name)}</b> · ${c.share_percent}% · ${c.mg_per_serving}mg</p><p class="fine">${esc(c.researched_for)}</p></li>`).join('')}</ul>` : ''}
  ${cs.minor_notes ? `<p class="fine">${esc(cs.minor_notes)}</p>` : ''}` : '';

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
      ${claimSupport(product.claim_support)}
      ${profile ? productSummary(profile.consumer_summary) : ''}

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

  const cs = molecule.consumer_summary;
  const lede = cs?.what_it_is || chem?.description || molecule.summary || '';
  main().innerHTML = `
    <section class="entity">
      ${back}
      <p class="eyebrow">Molecule</p>
      <div class="mol-head">
        ${chem?.image ? `<img class="mol-image" src="${esc(chem.image)}" alt="Structure of ${esc(molecule.name)}" width="300" height="300" onerror="this.remove()" />` : ''}
        <div>
          <h1>${esc(molecule.name)}</h1>
          <p class="hero-copy">${esc(lede)}</p>
          ${cs?.found_in ? `<p class="hero-copy">${esc(cs.found_in)}</p>` : ''}
          ${molecule.evidence ? `<p class="measured-line">${esc(molecule.evidence)}</p>` : ''}
        </div>
      </div>

      ${cs ? `
      <h2 class="section-h">Why researchers are interested</h2>
      <p class="hero-copy">${esc(cs.why_researchers_care)}</p>
      <p class="measured-line">${esc(cs.evidence_at_a_glance)}</p>
      ${cs.structure_function?.length ? `<h2 class="section-h">What it may support</h2>
      <ul class="sf-list">${cs.structure_function.map((x) => `<li><p class="sf-statement">${esc(x.statement)}</p><p class="fine">${evidenceBadge(x.evidence_level, x.oxford)} · ${esc(x.basis)}${x.eco?.id ? ` · <span class="mono">${esc(x.eco.id)}</span>` : ''}</p></li>`).join('')}</ul>` : ''}
      ${cs.hypothesized_benefits?.length ? `<h2 class="section-h">Open questions worth answering</h2>
      <ul class="sf-list">${cs.hypothesized_benefits.map((x) => `<li><p class="sf-statement"><b>${esc(x.area)}</b> — ${esc(x.hypothesis)}</p><p class="fine">${evidenceBadge(x.evidence_level, x.oxford)} · ${x.paper_count} papers</p>${x.study_to_test_it ? `<p class="study-idea"><b>The study that would settle it:</b> ${esc(x.study_to_test_it)}</p>` : ''}</li>`).join('')}</ul>` : ''}
      ` : ''}

      ${molecule.trials?.studies?.length ? `
      <h2 class="section-h">Human trials on record</h2>
      <ul class="sf-list">${molecule.trials.studies.slice(0, 5).map((t) => `<li><p class="sf-statement"><a href="${esc(t.url)}" target="_blank" rel="noreferrer">${esc(t.title)}</a></p><p class="fine">${/RECRUITING|ACTIVE/.test(t.status) ? '<span class="ev-badge ev-human_trials">live</span> ' : ''}${esc(String(t.status).toLowerCase().replaceAll('_', ' '))}${t.phases?.filter((p) => p !== 'NA').length ? ` · ${esc(t.phases.filter((p) => p !== 'NA').join(', ').replaceAll('PHASE', 'Phase '))}` : ''} · ${esc(t.conditions.slice(0, 2).join(', '))}${t.enrollment ? ` · ${t.enrollment} people` : ''} · <span class="mono">${esc(t.nct_id)}</span></p></li>`).join('')}</ul>
      <p class="fine">${molecule.trials.total} registered on ClinicalTrials.gov naming this molecule as an intervention.</p>` : ''}

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

      ${cs?.associated_conditions?.length ? `<h2 class="section-h">Conditions it has been studied in</h2>
      <ul class="cond-list">${cs.associated_conditions.map((x) => `<li><b>${esc(x.condition)}</b>${x.mondo_id ? ` <span class="mono fine">${esc(x.mondo_id)}</span>` : ''} — <span class="fine">${esc(x.relationship)}</span></li>`).join('')}</ul>` : ''}
      ${cs?.cautions ? `<p class="fine"><b>Worth knowing:</b> ${esc(cs.cautions)}</p>` : ''}

      ${chem ? `
      <h2 class="section-h">Identity</h2>
      <div class="molecule-panel">
        <span>Formula</span><strong>${esc(chem.formula)}</strong>
        <span>Molecular weight</span><strong>${esc(chem.molecular_weight)} g/mol</strong>
        <span>PubChem</span><strong><a href="${esc(chem.url)}" target="_blank" rel="noreferrer">CID ${esc(chem.cid)} ↗</a></strong>
        ${chem.description_source ? `<span>Description</span><strong><a href="${esc(chem.description_source.url)}" target="_blank" rel="noreferrer">${esc(chem.description_source.name)} ↗</a>, via PubChem</strong>` : ''}
      </div>` : ''}

      <h2 class="section-h">The full record</h2>
      <p class="hero-copy">Organisms it occurs in, protein assay results, literature and the evidence behind each statement live in the Terpedia knowledge base.</p>
      <a class="portal-button" href="${KB_MOLECULE}${encodeURIComponent(molecule.id)}/" target="_blank" rel="noreferrer">Open in the Terpedia knowledge base ↗</a>
      ${cs ? `<p class="fine">Plain-language summary written from the record by ${esc(cs.model)} on ${esc(cs.generated)}. Evidence grades computed from PubMed indexing: ECO · MeSH publication types · Oxford CEBM 2009.</p>` : ''}
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
    // Shoppers search by how something feels and tastes, not only by compound name, so the
    // claim tiles and flavour words on the card have to be in the index too.
    const haystack = [p.name, p.strain, p.description, p.type, p.category, ...(p.claims || []), ...p.molecules].join(' ').toLowerCase();
    return matchesType && (!query || haystack.includes(query));
  });
  const strip = (p) => (stats?.organism_strips?.[p.handle] || []).slice(0, 4);
  const backed = (p) => (p.claim_support || []).reduce((n, c) => n + (c.papers || 0), 0);
  document.querySelector('#catalog').innerHTML = visible.map((p) => `
    <article class="card ${p.image ? 'card--image' : ''}">
      ${p.image ? `<a class="card-image" href="?product=${encodeURIComponent(p.handle)}"><img src="${esc(p.image.src)}" alt="${esc(p.image.alt || p.name)}" loading="lazy" onerror="this.parentElement.remove()" /></a>` : ''}
      <div class="card-body">
        <div class="card-top"><span class="pill ${p.type.toLowerCase()}">${esc(p.type)}</span><span>${esc(p.size)}</span></div>
        <h2><a href="?product=${encodeURIComponent(p.handle)}">${esc(p.name)}</a></h2>
        <div class="strain">${esc(p.strain)}</div>
        ${p.claims?.length ? `<div class="claim-tiles claim-tiles--card">${p.claims.map((t) => `<span class="claim-tile">${esc(t)}</span>`).join('')}</div>` : ''}
        ${p.molecules_basis === 'measured' ? `
        <div class="molecules"><div class="molecules-label">Top of ${p.terpene_profile.identified_compounds} measured compounds</div><div class="molecule-list">${p.terpene_profile.top.slice(0, 4).map((c) => `<a href="?c=${encodeURIComponent(c.id)}">${esc(c.name)} <b>${c.percent}%</b></a>`).join('')}</div></div>
        ${strip(p).length ? `<p class="also-in"><span>Also found in</span> ${strip(p).map((o) => `<a href="https://kb.terpedia.com/organism/${esc(o.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'))}/" target="_blank" rel="noreferrer" title="${esc(o.name)}">${esc(o.common)}</a>`).join(' · ')}</p>` : ''}
        ${backed(p) ? `<p class="backed-line">Claims backed by <b>${backed(p).toLocaleString()}</b> papers across ${p.claim_support.length} claim areas</p>` : ''}` : `
        <p class="description">${esc(p.description)}</p>
        <div class="molecules"><div class="molecules-label">Profile molecule candidates</div><div class="molecule-list">${p.molecules.map((m) => `<a href="${moleculeUrl(m)}">${esc(m)}</a>`).join('')}</div></div>`}
        <div class="card-footer"><a href="?product=${encodeURIComponent(p.handle)}">${p.molecules_basis === 'measured' ? `Full profile and evidence →` : 'Product detail →'}</a><span>${esc(p.category)}</span></div>
      </div>
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
let stats = null;
route.then((isEntity) => { if (isEntity) return null; return Promise.all([getJSON('data/products.json'), getJSON('data/stats.json')]).then(([data, s]) => {
  if (!data) { document.querySelector('#product-count').textContent = 'Catalog unavailable'; return; }
  products = data.products; stats = s;
  document.querySelector('#product-count').textContent = `${products.length} products · ${data.snapshot_date} snapshot`;
  if (stats) {
    const put = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = Number(v).toLocaleString(); };
    put('stat-products', stats.measured_products); put('stat-compounds', stats.compounds); put('stat-organisms', stats.organisms); put('stat-papers', stats.papers); put('stat-trials', stats.trials);
  }
  render();
});
});


// Ask the TerpeneQueen: the Terpedia multiagent chat, with whatever the reader is looking
// at sent along as context so "this chew" and "this molecule" mean the page on screen.
(() => {
  const root = document.getElementById('tq');
  if (!root) return;
  const API = window.TERPENE_QUEEN_URL || 'https://terpene-queen-715567218723.us-central1.run.app/chat';
  const toggle = root.querySelector('.tq-toggle'), panel = root.querySelector('.tq-panel'), log = root.querySelector('.tq-log');
  const form = root.querySelector('.tq-form'), input = root.querySelector('.tq-input');
  const history = [];
  const open = (show) => { panel.hidden = !show; toggle.setAttribute('aria-expanded', String(show)); if (show) input.focus(); };
  toggle.addEventListener('click', () => open(panel.hidden));
  root.querySelector('.tq-close').addEventListener('click', () => open(false));
  const bubble = (role, text) => { const el = document.createElement('div'); el.className = `tq-msg tq-msg--${role}`; el.textContent = text; log.appendChild(el); log.scrollTop = log.scrollHeight; return el; };
  const pageContext = () => {
    const q = new URLSearchParams(location.search);
    const h1 = document.querySelector('main h1')?.innerText?.replace(/\s+/g, ' ').trim();
    if (q.get('product')) return `the MONDAYS product "${h1}" (${location.href}); its measured compounds and claim backing are on this page`;
    if (q.get('c')) return `the molecule ${h1} (${location.href})`;
    return 'the MONDAYS × Terpedia catalog homepage';
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const question = input.value.trim(); if (!question) return;
    input.value = ''; bubble('user', question); history.push({ role: 'user', content: question });
    const answer = bubble('assistant', '…');
    try {
      const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ context: pageContext(), messages: history }) });
      if (!res.ok || !res.body) throw new Error(`API ${res.status}`);
      const reader = res.body.getReader(), dec = new TextDecoder(); let raw = '', buf = '';
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true }); const lines = buf.split('\n'); buf = lines.pop() || '';
        for (const line of lines) { if (!line.startsWith('data:')) continue; const p = line.slice(5).trim(); if (!p || p === '[DONE]') continue; try { const j = JSON.parse(p); if (j.error) throw new Error(j.error); raw += j.delta || ''; } catch (e) { if (e.message && !/JSON/.test(e.message)) throw e; } answer.textContent = raw || '…'; log.scrollTop = log.scrollHeight; }
      }
      const final = raw.trim() || 'I did not get an answer back — try asking another way.';
      answer.textContent = final; history.push({ role: 'assistant', content: final });
    } catch (err) { answer.textContent = 'The TerpeneQueen is away from the throne for a moment. Try again shortly.'; console.error('chat failed', err); }
  });
})();
