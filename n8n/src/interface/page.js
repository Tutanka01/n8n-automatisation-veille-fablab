// Page de validation : relire, copier, valider / refuser / régénérer les contenus.
// Toute donnée affichée (HAL, RSS, LLM) est échappée.
//@include lib/html.js
const config = $('Lire la configuration').first().json.config;
const query = $('Tableau de bord').first().json.query || {};
const data = $input.first().json;
const statut = data.statut;
const counts = data.counts || {};
const items = data.items || [];
const run = data.last_run;
const wfErrors = data.wf_errors || [];
const recentErrors = wfErrors.filter(e => Date.now() - new Date(e.created_at).getTime() < 86400000);
const f = config.fablab || {};
const labsByCode = Object.fromEntries((config.laboratoires || []).map(l => [l.code, l]));
const sectorLabel = Object.fromEntries((config.cibles?.secteurs || []).map(s => [s.id, s.label]));

const TABS = [
  ['to_review', 'À valider'], ['approved', 'Validées'], ['published', 'Publiées'], ['new', 'En file'],
  ['triaged_out', 'Écartées'], ['rejected', 'Refusées'], ['error', 'Erreurs'],
];
const count = s => (s === 'new' ? (counts.new || 0) + (counts.processing || 0) : counts[s] || 0);
const MESSAGES = {
  ok: ['ok', 'Action enregistrée.'],
  echec: ['err', "Action impossible : l'élément a déjà changé d'état. La page est à jour."],
  lancee: ['ok', 'Veille lancée : collecte puis génération des contenus. Rechargez la page dans quelques minutes.'],
  recap: ['ok', "Récapitulatif en cours d'envoi aux destinataires de config/veille.json. S'il n'arrive pas, voir l'onglet « Erreurs » (réglages SMTP dans .env)."],
};
const MATURITE = {
  recherche_amont: 'Recherche amont', preuve_de_concept: 'Preuve de concept',
  prototype: 'Prototype', transfert_possible: 'Transfert possible',
};
const STEPS = { tri: 'Tri de pertinence', fiche: 'Fiche de valorisation', contenus: 'Rédaction des contenus', pdf: 'Génération du PDF' };
const CONFIRM = {
  regenerer: 'Régénérer relance les appels IA pour cette publication. Continuer ?',
  refuser: 'Refuser ce contenu ?',
};

function button(value, label, style = '') {
  const confirm = CONFIRM[value] ? ` onclick="return confirm('${esc(CONFIRM[value])}')"` : '';
  return `<button type="submit" name="action" value="${value}" class="btn ${style}"${confirm}>${label}</button>`;
}
function actionForm(p, buttons, withNote = true) {
  if (!buttons.length) return '';
  return `<form method="post" action="/webhook/veille/action" class="actions">
    <input type="hidden" name="id" value="${esc(p.id)}">
    <input type="hidden" name="token" value="${esc(p.review_token)}">
    <input type="hidden" name="retour" value="${esc(statut)}">
    ${withNote ? `<input type="text" name="note" maxlength="500" placeholder="Note interne (optionnelle)" value="${esc(p.review_note || '')}">` : ''}
    <div class="btns">${buttons.join('')}</div>
  </form>`;
}
function copyBlock(id, label, text, rows) {
  return `<div class="copy"><textarea id="${id}" aria-label="${esc(label)}" rows="${rows}" readonly>${esc(text)}</textarea>
    <div class="row"><button type="button" class="btn small" onclick="copier('${id}', this)">Copier ${label}</button>
    <span class="muted">${String(text).length} caractères</span></div></div>`;
}
function list(values) { return (values || []).length ? `<ul>${values.map(v => `<li>${esc(v)}</li>`).join('')}</ul>` : '—'; }
function meta(p) {
  const labs = (p.labs || []).map(c => `<span class="tag lab">${esc(labsByCode[c]?.nom || c)}</span>`).join('');
  const kind = p.kind === 'actualite' ? '<span class="tag">Actualité</span>' : p.doc_type ? `<span class="tag">${esc(p.doc_type)}</span>` : '';
  const score = p.score != null
    ? `<span class="tag score ${p.score >= 8 ? 'hi' : p.score >= 6 ? 'mid' : 'lo'}" title="Pertinence estimée par l'IA">${esc(p.score)}/10</span>` : '';
  const sectors = (p.sectors || []).map(s => `<span class="tag sector">${esc(sectorLabel[s] || s)}</span>`).join('');
  const date = p.deposited_at ? `<span class="muted">mis en ligne le ${esc(fmtDate(p.deposited_at))}</span>` : '';
  return `<div class="meta">${labs}${kind}${score}${sectors}${date}</div>`;
}
function source(p) {
  const authors = p.authors || [];
  const who = authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' et al.' : '');
  const url = safeUrl(p.url);
  const title = url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(p.title)}</a>` : esc(p.title);
  return `<p class="src">${title}${who ? ` — ${esc(who)}` : ''}${p.venue ? ` · <i>${esc(p.venue)}</i>` : ''}</p>`;
}

function fullCard(p) {
  const fi = p.fiche || {};
  const li = p.linkedin || {};
  const em = p.email || {};
  const slides = p.carousel?.slides || [];
  const projet = fi.idee_projet_fablab || {};
  const tags = (li.hashtags || []).map(h => '#' + String(h).replace(/^#/, '').replace(/\s+/g, '')).join(' ');
  const post = [li.post, tags].filter(Boolean).join('\n\n');
  const article = [em.objet && `Objet : ${em.objet}`, em.preheader && `Aperçu : ${em.preheader}`, em.paragraphe, em.appel_a_action]
    .filter(Boolean).join('\n\n');
  const buttons = {
    to_review: [button('approuver', 'Valider', 'primary'), button('refuser', 'Refuser', 'danger'), button('regenerer', 'Régénérer')],
    approved: [button('publier', 'Marquer comme publiée', 'primary'), button('a_valider', 'Remettre à valider')],
    published: [button('a_valider', 'Remettre à valider')],
  }[p.status] || [];

  return `<article class="card" id="pub-${esc(p.id)}">
    ${meta(p)}
    <h2>${esc(fi.titre_accrocheur || p.title)}</h2>
    ${source(p)}
    ${fi.resume_vulgarise ? `<p class="resume">${esc(fi.resume_vulgarise)}</p>` : ''}
    ${p.status === 'published' && p.published_at ? `<p class="muted">Publiée le ${esc(fmtDate(p.published_at))}</p>` : ''}
    <details open><summary>Post LinkedIn</summary>${copyBlock(`li-${p.id}`, 'le post', post, 14)}
      ${safeUrl(p.url) ? `<p class="muted">Astuce : ajoutez le lien de la publication en premier commentaire — ${esc(p.url)}</p>` : ''}</details>
    <details><summary>Carrousel PDF · ${slides.length} diapositives</summary>
      <p><a class="btn small primary" href="/webhook/veille/pdf?id=${esc(p.id)}" target="_blank" rel="noopener">Ouvrir le PDF</a></p>
      <ol class="slides">${slides.map(s => `<li><b>${esc(s.titre)}</b> — ${esc(s.texte)}</li>`).join('')}</ol></details>
    <details><summary>Article pour e-mail de prospection</summary>${copyBlock(`em-${p.id}`, "l'article", article, 10)}</details>
    <details><summary>Fiche de valorisation</summary>
      <dl class="fiche">
        <dt>Problème terrain</dt><dd>${esc(fi.probleme_terrain)}</dd>
        <dt>Apport de la recherche</dt><dd>${esc(fi.apport_recherche)}</dd>
        <dt>Bénéfices</dt><dd>${list(fi.benefices)}</dd>
        <dt>Bénéficiaires</dt><dd>${esc((fi.exemples_beneficiaires || []).join(' · '))}</dd>
        <dt>Maturité</dt><dd>${esc(MATURITE[fi.maturite] || fi.maturite || '')}</dd>
        <dt>Projet FabLab</dt><dd><b>${esc(projet.titre)}</b> — ${esc(projet.description)}
          <br><span class="muted">Livrables : ${esc((projet.livrables || []).join(', '))} · Partenaire : ${esc(projet.partenaire_ideal)} · Durée : ${esc(projet.duree_indicative)}</span></dd>
        <dt>Chercheurs cités</dt><dd>${esc((fi.chercheurs_a_citer || []).join(', ')) || '—'}</dd>
        <dt class="warn">Points de vigilance</dt><dd>${list(fi.points_de_vigilance)}</dd>
        <dt>Questions au laboratoire</dt><dd>${list(fi.questions_au_labo)}</dd>
      </dl></details>
    ${actionForm(p, buttons)}
  </article>`;
}

function compactCard(p) {
  const t = p.triage || {};
  let body = '';
  let buttons = [];
  if (p.status === 'triaged_out') {
    body = `<p>${esc(t.raison)}${t.limites ? ` <span class="muted">— ${esc(t.limites)}</span>` : ''}</p>`;
    buttons = [button('forcer', 'Traiter quand même')];
  } else if (p.status === 'rejected') {
    body = p.review_note ? `<p class="muted">Note : ${esc(p.review_note)}</p>` : '';
    buttons = [button('a_valider', 'Remettre à valider'), button('regenerer', 'Régénérer')];
  } else if (p.status === 'error') {
    body = `<p class="error">${esc(p.last_error)}</p><p class="muted">Étape : ${esc(STEPS[p.processing_step] || 'Traitement')} · ${esc(p.attempts)} tentative(s) — re-tentée automatiquement jusqu'à ${esc(config.traitement?.max_tentatives ?? 3)}. ${p.fiche ? 'La fiche est sauvegardée ; la reprise la réutilisera.' : ''}</p>`;
    buttons = [button('relancer', 'Remettre en file', 'primary')];
  } else {
    body = `<p class="muted">${p.status === 'processing' ? `${esc(STEPS[p.processing_step] || 'Traitement')} — lot en cours` : 'En attente du prochain lot de traitement'}</p>`;
  }
  return `<article class="card compact" id="pub-${esc(p.id)}">${meta(p)}<h3>${esc(p.title)}</h3>${source(p)}${body}${actionForm(p, buttons, false)}</article>`;
}

const full = ['to_review', 'approved', 'published'].includes(statut);
const message = MESSAGES[query.msg];
const warnings = run?.warnings?.length ? `<span class="error"> · ${run.warnings.map(esc).join(' · ')}</span>` : '';

const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Veille · ${esc(f.nom_court || f.nom)}</title>
<style>
  :root { --bg:#f6f5f1; --card:#fff; --ink:#14202b; --muted:#5d6873; --line:#e3e1da; --primary:${safeColor(f.couleurs?.primaire, '#0B3D5C')};
    --accent:${safeColor(f.couleurs?.accent, '#F2A900')}; --danger:#b3261e; --ok:#1e7a46; }
  @media (prefers-color-scheme: dark) { :root { --bg:#12171c; --card:#1b2229; --ink:#e8ecef; --muted:#9aa6b1; --line:#2b343d; --primary:#7fb8de; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width:980px; margin:0 auto; padding:24px 16px 64px; }
  header.top { display:flex; justify-content:space-between; align-items:flex-end; gap:16px; flex-wrap:wrap; }
  .eyebrow { font-size:12px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:var(--accent); }
  h1 { margin:2px 0 0; font-size:26px; }
  .run { margin:8px 0 18px; font-size:13px; }
  nav.tabs { display:flex; gap:6px; flex-wrap:wrap; border-bottom:1px solid var(--line); margin-bottom:18px; }
  nav.tabs a { padding:8px 12px; border-radius:8px 8px 0 0; color:var(--muted); text-decoration:none; font-weight:600; }
  nav.tabs a.on { color:var(--ink); background:var(--card); border:1px solid var(--line); border-bottom-color:var(--card); margin-bottom:-1px; }
  nav.tabs .n { display:inline-block; min-width:20px; padding:0 6px; margin-left:4px; border-radius:10px; background:var(--line); color:var(--ink); font-size:12px; text-align:center; }
  .flash { padding:10px 14px; border-radius:8px; margin-bottom:16px; }
  .flash.ok { background:color-mix(in srgb, var(--ok) 14%, transparent); }
  .flash.err { background:color-mix(in srgb, var(--danger) 14%, transparent); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px 20px; margin-bottom:16px; }
  .card h2 { margin:6px 0 4px; font-size:20px; line-height:1.3; }
  .card h3 { margin:6px 0 2px; font-size:16px; }
  .meta { display:flex; gap:6px; flex-wrap:wrap; align-items:center; font-size:12px; }
  .tag { padding:2px 8px; border-radius:999px; background:var(--bg); border:1px solid var(--line); font-weight:600; }
  .tag.lab { background:var(--primary); color:#fff; border-color:transparent; }
  .tag.score.hi { background:var(--ok); color:#fff; border-color:transparent; }
  .tag.score.mid { background:var(--accent); color:#1b1b1b; border-color:transparent; }
  .src { margin:0 0 10px; font-size:13px; color:var(--muted); }
  .src a { color:inherit; }
  .resume { margin:8px 0 12px; }
  details { border-top:1px solid var(--line); padding:8px 0; }
  summary { cursor:pointer; font-weight:700; }
  textarea { width:100%; margin-top:8px; padding:10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--ink); font:inherit; font-size:14px; line-height:1.5; resize:vertical; }
  .row { display:flex; gap:10px; align-items:center; margin-top:6px; }
  .slides li { margin-bottom:4px; }
  dl.fiche { display:grid; grid-template-columns:180px 1fr; gap:6px 14px; margin:10px 0 0; }
  dl.fiche dt { font-weight:700; color:var(--muted); }
  dl.fiche dd { margin:0; }
  dl.fiche ul { margin:0; padding-left:18px; }
  dt.warn { color:var(--danger); }
  .actions { display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-top:12px; padding-top:12px; border-top:1px solid var(--line); }
  .actions input[type=text] { flex:1; min-width:200px; padding:8px 10px; font:inherit; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--ink); }
  .btns { display:flex; gap:8px; flex-wrap:wrap; }
  .btn { display:inline-block; padding:8px 14px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--ink); font:inherit; font-size:14px; font-weight:600; line-height:1.2; cursor:pointer; text-decoration:none; }
  .btn:hover { border-color:var(--primary); }
  .btn.primary { background:var(--primary); border-color:var(--primary); color:#fff; }
  .btn.danger { color:var(--danger); }
  .btn.small { padding:6px 10px; font-size:13px; }
  .muted { color:var(--muted); font-size:13px; }
  .error { color:var(--danger); }
  .empty { text-align:center; color:var(--muted); padding:48px 0; }
  h2.section { font-size:16px; margin:24px 0 12px; }
  header.top form { margin:0; }
  footer { margin-top:32px; font-size:12px; color:var(--muted); }
  footer a { color:inherit; }
  @media (max-width:640px) { dl.fiche { grid-template-columns:1fr; } }
</style></head>
<body><div class="wrap">
  <header class="top">
    <div><div class="eyebrow">Veille scientifique → contenus</div><h1>${esc(f.nom)}</h1></div>
    <div class="btns">
      <form method="post" action="/webhook/veille/recap"><button class="btn" type="submit" title="Envoie les contenus à valider (fiches, posts, articles, PDF) aux destinataires configurés">Envoyer le récapitulatif par e-mail</button></form>
      <form method="post" action="/webhook/veille/lancer"><button class="btn primary" type="submit">Lancer la veille maintenant</button></form>
    </div>
  </header>
  <p class="run muted">Dernière collecte : ${run ? `${esc(fmtDateTime(run.started_at))} — ${esc(run.found)} trouvée(s), ${esc(run.inserted)} nouvelle(s)` : 'aucune pour le moment'}${warnings}</p>
  <p class="run">${counts.new || 0} en attente → ${counts.processing || 0} dans les lots en cours → ${counts.to_review || 0} à valider · ${counts.error || 0} en erreur. <a href="/workflow/VeilleTraitemt01" target="_blank" rel="noopener">Suivre le traitement dans n8n</a></p>
  <nav class="tabs">${TABS.map(([key, label]) => `<a href="/webhook/veille?statut=${key}" class="${key === statut ? 'on' : ''}">${label}<span class="n">${count(key)}</span></a>`).join('')}</nav>
  ${!String(config.llm?.modele || '').trim() ? '<div class="flash err"><b>LLM non configuré.</b> Renseignez « llm.base_url » et « llm.modele » dans config/veille.json (et LLM_API_KEY dans .env), puis lancez la veille.</div>' : ''}
  ${message ? `<div class="flash ${message[0]}">${esc(message[1])}</div>` : ''}
  ${recentErrors.length && statut !== 'error' ? `<div class="flash err">${recentErrors.length} erreur(s) de workflow ces dernières 24 h — voir l'onglet « Erreurs ».</div>` : ''}
  <main>${items.length ? items.map(full ? fullCard : compactCard).join('') : statut === 'error' && wfErrors.length ? '' : '<p class="empty">Rien ici pour le moment.</p>'}
  ${statut === 'error' && wfErrors.length ? `<h2 class="section">Erreurs des workflows (14 derniers jours)</h2>
    ${wfErrors.map(e => `<article class="card compact"><div class="meta"><span class="tag">${esc(e.workflow_name)}</span><span class="muted">${esc(fmtDateTime(e.created_at))} · nœud « ${esc(e.node)} »</span></div>
      <p class="error">${esc(e.message)}</p>${safeUrl(e.execution_url) ? `<p class="muted"><a href="${esc(e.execution_url)}" target="_blank" rel="noopener">Voir l'exécution dans n8n</a></p>` : ''}</article>`).join('')}` : ''}
  </main>
  <footer>Réglages : <code>config/veille.json</code> · E-mail récapitulatif automatique : ${config.notifications?.email?.actif ? 'activé' : 'désactivé'} · <a href="/home/workflows" target="_blank" rel="noopener">Éditeur n8n</a></footer>
</div>
<script>
  function copier(id, btn) {
    var el = document.getElementById(id), label = btn.textContent, ok = false;
    var done = function (t) { btn.textContent = t; setTimeout(function () { btn.textContent = label; }, 1800); };
    el.focus(); el.select();
    try { ok = document.execCommand('copy'); } catch (e) {}
    if (ok) return done('Copié ✓');
    if (navigator.clipboard) navigator.clipboard.writeText(el.value).then(function () { done('Copié ✓'); }, function () { done('Texte sélectionné : Ctrl/Cmd + C'); });
    else done('Texte sélectionné : Ctrl/Cmd + C');
  }
</script>
</body></html>`;

return [{ json: { html } }];
