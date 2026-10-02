// Page de validation : relire, copier, valider / refuser / régénérer les contenus.
// Toute donnée affichée (HAL, RSS, LLM) est échappée.
//@include lib/html.js
const config = $('Lire la configuration').first().json.config;
const request = $('Tableau de bord').first().json;
const query = request.query || {};
// Derrière le reverse proxy, l'éditeur n8n n'est pas exposé : ses liens ne sont pas proposés.
const editeur = !(request.headers || {})['x-forwarded-host'];
const data = $input.first().json;
const statut = data.statut;
const counts = data.counts || {};
const items = data.items || [];
const run = data.last_run;
const wfErrors = data.wf_errors || [];
const recentErrors = wfErrors.filter(e => Date.now() - new Date(e.created_at).getTime() < 86400000);
const f = config.fablab || {};
const col = f.couleurs || {};
const labsByCode = Object.fromEntries((config.laboratoires || []).map(l => [l.code, l]));
const sectorLabel = Object.fromEntries((config.cibles?.secteurs || []).map(s => [s.id, s.label]));

// Le circuit d'un contenu, dans l'ordre, puis les états qui en sortent.
const CIRCUIT = [['new', 'En file'], ['to_review', 'À valider'], ['approved', 'Validées'], ['published', 'Publiées']];
const SORTIES = [['triaged_out', 'Écartées'], ['rejected', 'Refusées'], ['error', 'Erreurs']];
const count = s => (s === 'new' ? (counts.new || 0) + (counts.processing || 0) : counts[s] || 0);
const VIDE = {
  to_review: 'Rien à valider. Les contenus arrivent ici après chaque veille : lancez-en une, ou attendez la prochaine collecte automatique.',
  approved: 'Aucun contenu validé en attente de publication.',
  published: 'Aucun contenu publié. Une fois un contenu validé posté, marquez-le comme publié pour le retrouver ici.',
  new: 'Aucune publication en file. La prochaine veille en collectera de nouvelles.',
  triaged_out: 'Aucune publication écartée par le tri.',
  rejected: 'Aucun contenu refusé.',
  error: 'Aucune erreur.',
};
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
// Types de documents HAL les plus courants (les autres codes s'affichent tels quels).
const TYPES = {
  ART: 'Article', COMM: 'Communication', POSTER: 'Poster', THESE: 'Thèse', OUV: 'Ouvrage', COUV: "Chapitre d'ouvrage",
  PROCEEDINGS: 'Actes', REPORT: 'Rapport', PATENT: 'Brevet', SOFTWARE: 'Logiciel', UNDEFINED: 'Prépublication', OTHER: 'Autre',
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
    ${withNote ? `<input type="text" name="note" maxlength="500" aria-label="Note interne" placeholder="Note interne (optionnelle)" value="${esc(p.review_note || '')}">` : ''}
    <div class="btns">${buttons.join('')}</div>
  </form>`;
}
// Le bouton porte le texte exact à copier ; `cible` est le bloc sélectionné si la copie est refusée.
function copyButton(label, text, cible) {
  return `<button type="button" class="btn small" data-copie="${esc(text)}" data-cible="${cible}" onclick="copier(this)">${label}</button>`;
}
function list(values) { return (values || []).length ? `<ul>${values.map(v => `<li>${esc(v)}</li>`).join('')}</ul>` : '—'; }
function labNames(p) { return (p.labs || []).map(c => labsByCode[c]?.nom || c); }
function score(p) {
  if (p.score == null) return '';
  return `<span class="score ${p.score >= 8 ? 'hi' : p.score >= 6 ? 'mid' : 'lo'}" title="Pertinence estimée par l'IA">${esc(p.score)}<small>/10</small></span>`;
}
function meta(p) {
  const labs = labNames(p).map(n => `<span class="labo">${esc(n)}</span>`).join('');
  const kind = p.kind === 'actualite' ? '<span>Actualité</span>' : p.doc_type ? `<span>${esc(TYPES[p.doc_type] || p.doc_type)}</span>` : '';
  const sectors = (p.sectors || []).map(s => `<span>${esc(sectorLabel[s] || s)}</span>`).join('');
  const date = p.deposited_at ? `<span>Mis en ligne le ${esc(fmtDate(p.deposited_at))}</span>` : '';
  return `<p class="meta">${labs}${kind}${sectors}${date}</p>`;
}
function titleLink(p) {
  const url = safeUrl(p.url);
  return url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(p.title)}</a>` : esc(p.title);
}
// Référence de la publication ; `title` = false quand le titre est déjà affiché au-dessus.
function source(p, title = true) {
  const authors = p.authors || [];
  const who = authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' et al.' : '');
  const parts = [title && titleLink(p), who && esc(who), p.venue && `<i>${esc(p.venue)}</i>`].filter(Boolean);
  return parts.length ? `<p class="src">${parts.join(', ')}</p>` : '';
}

// Ce qu'un relecteur doit contrôler, sorti de la fiche et placé en marge du contenu.
function marge(fi) {
  const blocs = [
    ['Points de vigilance', fi.points_de_vigilance],
    ['Questions à poser au laboratoire', fi.questions_au_labo],
    ['Chercheurs à citer', fi.chercheurs_a_citer],
  ].filter(([, values]) => (values || []).length);
  if (!blocs.length) return '';
  return `<aside class="marge"><h3>À vérifier avant publication</h3>${blocs.map(([t, values]) => `<h4>${t}</h4>${list(values)}`).join('')}</aside>`;
}

// Aperçu du carrousel aux couleurs du PDF (le PDF reste la référence).
function planche(slides) {
  return `<ol class="planche">${slides.map((s, i) => `<li class="diapo">
      <span class="num">${i + 1} / ${slides.length}</span><b>${esc(s.titre)}</b><span>${esc(s.texte)}</span>
      ${(s.puces || []).filter(Boolean).length ? `<ul>${s.puces.filter(Boolean).slice(0, 4).map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
    </li>`).join('')}</ol>`;
}

function dossier(p) {
  const fi = p.fiche || {};
  const li = p.linkedin || {};
  const em = p.email || {};
  const slides = p.carousel?.slides || [];
  const projet = fi.idee_projet_fablab || {};
  const tags = (li.hashtags || []).map(h => '#' + String(h).replace(/^#/, '').replace(/\s+/g, '')).join(' ');
  const post = [li.post, tags].filter(Boolean).join('\n\n');
  const corps = [em.paragraphe, em.appel_a_action].filter(Boolean).join('\n\n');
  const article = [em.objet && `Objet : ${em.objet}`, em.preheader && `Aperçu : ${em.preheader}`, corps].filter(Boolean).join('\n\n');
  const notes = marge(fi);
  const buttons = {
    to_review: [button('approuver', 'Valider', 'primary'), button('refuser', 'Refuser', 'danger'), button('regenerer', 'Régénérer')],
    approved: [button('publier', 'Marquer comme publiée', 'primary'), button('a_valider', 'Remettre à valider')],
    published: [button('a_valider', 'Remettre à valider')],
  }[p.status] || [];

  return `<article class="dossier" id="pub-${esc(p.id)}">
    <div class="feuille${notes ? '' : ' sans-marge'}">
      <header class="entete">
        <div class="ligne-meta">${meta(p)}${score(p)}</div>
        <h2>${esc(fi.titre_accrocheur || p.title)}</h2>
        ${source(p)}
        ${fi.resume_vulgarise ? `<p class="chapo">${esc(fi.resume_vulgarise)}</p>` : ''}
        ${p.status === 'published' && p.published_at ? `<p class="muted">Publiée le ${esc(fmtDate(p.published_at))}</p>` : ''}
      </header>
      ${notes}
      <div class="corps">
        <section class="piece">
          <header><h3>Post LinkedIn</h3><span class="muted">${post.length.toLocaleString('fr-FR')} caractères</span>${copyButton('Copier le post', post, `li-${esc(p.id)}`)}</header>
          <div class="texte" id="li-${esc(p.id)}">${esc(li.post)}${tags ? `\n\n<span class="tags">${esc(tags)}</span>` : ''}</div>
          ${safeUrl(p.url) ? `<p class="muted">Lien à ajouter en premier commentaire : ${esc(p.url)}</p>` : ''}
        </section>
        <section class="piece">
          <header><h3>Carrousel</h3><span class="muted">${slides.length} diapositives</span><a class="btn small" href="/webhook/veille/pdf?id=${esc(p.id)}" target="_blank" rel="noopener">Ouvrir le PDF</a></header>
          ${planche(slides)}
        </section>
        <section class="piece">
          <header><h3>Article pour e-mail de prospection</h3><span class="muted">${article.length.toLocaleString('fr-FR')} caractères</span>${copyButton("Copier l'article", article, `em-${esc(p.id)}`)}</header>
          <div id="em-${esc(p.id)}">
            <dl class="objet"><dt>Objet</dt><dd>${esc(em.objet)}</dd><dt>Aperçu</dt><dd>${esc(em.preheader)}</dd></dl>
            <div class="texte">${esc(corps)}</div>
          </div>
        </section>
        <details class="piece">
          <summary>Fiche de valorisation</summary>
          <dl class="fiche">
            <dt>Problème terrain</dt><dd>${esc(fi.probleme_terrain)}</dd>
            <dt>Apport de la recherche</dt><dd>${esc(fi.apport_recherche)}</dd>
            <dt>Bénéfices</dt><dd>${list(fi.benefices)}</dd>
            <dt>Bénéficiaires</dt><dd>${esc((fi.exemples_beneficiaires || []).join(', '))}</dd>
            <dt>Maturité</dt><dd>${esc(MATURITE[fi.maturite] || fi.maturite || '')}</dd>
            <dt>Projet FabLab</dt><dd><b>${esc(projet.titre)}</b><br>${esc(projet.description)}
              <br><span class="muted">Livrables : ${esc((projet.livrables || []).join(', '))}. Partenaire : ${esc(projet.partenaire_ideal)}. Durée : ${esc(projet.duree_indicative)}.</span></dd>
          </dl>
        </details>
      </div>
    </div>
    ${actionForm(p, buttons)}
  </article>`;
}

// Entrée de la liste de gauche : ouvre le dossier correspondant.
function entree(p) {
  return `<a href="#pub-${esc(p.id)}"><span class="titre">${esc(p.fiche?.titre_accrocheur || p.title)}</span>
    <span class="detail"><span>${esc(labNames(p).join(', '))}</span>${score(p)}</span></a>`;
}

function ligne(p) {
  const t = p.triage || {};
  let body = '';
  let buttons = [];
  if (p.status === 'triaged_out') {
    body = `<p>${esc(t.raison)}${t.limites ? ` <span class="muted">${esc(t.limites)}</span>` : ''}</p>`;
    buttons = [button('forcer', 'Traiter quand même')];
  } else if (p.status === 'rejected') {
    body = p.review_note ? `<p class="muted">Note : ${esc(p.review_note)}</p>` : '';
    buttons = [button('a_valider', 'Remettre à valider'), button('regenerer', 'Régénérer')];
  } else if (p.status === 'error') {
    body = `<p class="error">${esc(p.last_error)}</p><p class="muted">Étape : ${esc(STEPS[p.processing_step] || 'Traitement')}. ${esc(p.attempts)} tentative(s), re-tentée automatiquement jusqu'à ${esc(config.traitement?.max_tentatives ?? 3)}. ${p.fiche ? 'La fiche est sauvegardée ; la reprise la réutilisera.' : ''}</p>`;
    buttons = [button('relancer', 'Remettre en file', 'primary')];
  } else {
    body = `<p class="muted">${p.status === 'processing' ? `${esc(STEPS[p.processing_step] || 'Traitement')} : lot en cours` : 'En attente du prochain lot de traitement'}</p>`;
  }
  return `<li class="ligne" id="pub-${esc(p.id)}"><div><div class="ligne-meta">${meta(p)}${score(p)}</div><h3>${titleLink(p)}</h3>${source(p, false)}${body}</div>${actionForm(p, buttons, false)}</li>`;
}

function etape([key, label]) {
  return `<li><a href="/webhook/veille?statut=${key}"${key === statut ? ' aria-current="page"' : ''}${key === 'error' && count(key) ? ' class="alerte"' : ''}>${label}<span class="n">${count(key)}</span></a></li>`;
}

const full = ['to_review', 'approved', 'published'].includes(statut);
const message = MESSAGES[query.msg];
const warnings = run?.warnings?.length ? ` <span class="error">${run.warnings.map(esc).join(' ; ')}</span>` : '';
const vue = items.length
  ? full
    ? `<div class="bureau"><nav class="pile" aria-label="Contenus">${items.map(entree).join('')}</nav><div class="dossiers">${items.map(dossier).join('')}</div></div>`
    : `<ul class="feuille liste">${items.map(ligne).join('')}</ul>`
  : statut === 'error' && wfErrors.length ? '' : `<p class="vide">${VIDE[statut]}</p>`;

const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Veille · ${esc(f.nom_court || f.nom)}</title>
<style>
  :root {
    --primaire:${safeColor(col.primaire, '#0B3D5C')}; --accent:${safeColor(col.accent, '#F2A900')};
    --diapo-fond:${safeColor(col.fond, '#F7F5F0')}; --diapo-texte:${safeColor(col.texte, '#14202B')};
    --atelier:#E8EDF0; --feuille:#fff; --creux:#F2F5F7; --encre:#10212C; --sourdine:#52626D; --trait:#CBD5DC;
    --action:var(--primaire); --sur-action:#fff; --alerte:#B3261E; --ok:#1E7A46;
    --ui:"Avenir Next",Avenir,"Segoe UI Variable Text","Segoe UI","Noto Sans","Helvetica Neue",Arial,sans-serif;
    /* Empattements = texte généré, tel qu'il sera publié ; sans empattement = l'outil. */
    --copie:Charter,"Bitstream Charter","Sitka Text",Cambria,"Noto Serif",Georgia,serif;
  }
  @media (prefers-color-scheme: dark) { :root {
    --atelier:#0E151A; --feuille:#172029; --creux:#111A21; --encre:#E7EDF1; --sourdine:#9AA9B4; --trait:#2D3A45;
    --action:#8CC3E6; --sur-action:#0B1D29; --alerte:#FF8A80; --ok:#6FCF97;
  } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--atelier); color:var(--encre); font:15px/1.5 var(--ui); }
  a { color:var(--action); }
  :focus-visible { outline:3px solid var(--accent); outline-offset:2px; }
  .page { max-width:1320px; margin:0 auto; padding:28px 24px 72px; }
  .muted { color:var(--sourdine); font-size:13px; }
  .error { color:var(--alerte); }

  .tete { display:flex; justify-content:space-between; align-items:flex-end; gap:16px 24px; flex-wrap:wrap; }
  .tete h1 { margin:0; font-size:30px; line-height:1.1; letter-spacing:-.015em; }
  .tete p { margin:4px 0 0; color:var(--sourdine); }
  .tete form { margin:0; }
  .btns { display:flex; gap:8px; flex-wrap:wrap; }
  .btn { display:inline-block; padding:8px 14px; border:1.5px solid var(--trait); border-radius:6px; background:var(--feuille); color:var(--encre);
    font:600 14px/1.2 var(--ui); cursor:pointer; text-decoration:none; white-space:nowrap; }
  .btn:hover { border-color:var(--action); }
  .btn.primary { background:var(--action); border-color:var(--action); color:var(--sur-action); }
  .btn.danger { color:var(--alerte); }
  .btn.small { padding:5px 10px; font-size:13px; }

  /* Circuit : les quatre étapes reliées se suivent ; les sorties (pointillés) le quittent. */
  .circuit { display:flex; flex-wrap:wrap; gap:10px 36px; margin:26px 0 12px; }
  .circuit ol, .circuit ul { display:flex; flex-wrap:wrap; gap:8px 0; list-style:none; margin:0; padding:0; }
  .circuit ul { gap:8px; }
  .circuit li { display:flex; align-items:center; }
  .circuit ol li + li::before { content:''; width:26px; height:2px; background:var(--trait); }
  .circuit a { display:flex; align-items:center; gap:10px; padding:7px 14px; border:1.5px solid var(--trait); border-radius:999px;
    background:var(--feuille); color:var(--encre); font-weight:600; text-decoration:none; }
  .circuit ul a { border-style:dashed; background:none; font-weight:500; }
  .circuit a:hover { border-color:var(--action); }
  .circuit a[aria-current] { border-style:solid; border-color:var(--action); background:var(--action); color:var(--sur-action); }
  .circuit .n { font-variant-numeric:tabular-nums; opacity:.7; }
  .circuit a.alerte .n { opacity:1; color:var(--alerte); font-weight:700; }
  .circuit a.alerte[aria-current] .n { color:inherit; }
  .etat { margin:0 0 20px; color:var(--sourdine); font-size:13px; }

  .avis { margin:0 0 14px; padding:10px 14px; border-left:4px solid var(--ok); border-radius:2px; background:var(--feuille); }
  .avis.err { border-left-color:var(--alerte); }
  .vide { margin:0; padding:56px 24px; border:1.5px dashed var(--trait); border-radius:4px; color:var(--sourdine); text-align:center; }
  .feuille { background:var(--feuille); border:1px solid var(--trait); border-radius:4px; }

  /* Bureau : la pile des contenus à gauche, le dossier ouvert à droite. */
  .bureau { display:grid; grid-template-columns:288px minmax(0,1fr); gap:20px; align-items:start; }
  .pile { position:sticky; top:16px; max-height:calc(100vh - 32px); overflow-y:auto; border-top:1px solid var(--trait); }
  .pile a { display:block; padding:12px 12px 12px 14px; border-left:4px solid transparent; border-bottom:1px solid var(--trait); color:inherit; text-decoration:none; }
  .pile a:hover { background:var(--creux); }
  .pile a[aria-current] { border-left-color:var(--accent); background:var(--feuille); }
  .pile .titre { display:block; font-weight:600; line-height:1.3; }
  .pile .detail { display:flex; justify-content:space-between; gap:8px; margin-top:4px; color:var(--sourdine); font-size:13px; }
  .dossier { display:none; scroll-margin-top:16px; }
  .dossier:target, .dossiers:not(:has(.dossier:target)) > .dossier:first-child { display:block; }

  .dossier .feuille { display:grid; grid-template-columns:minmax(0,1fr) 272px; grid-template-areas:"entete marge" "corps marge"; border-radius:4px 4px 0 0; }
  .dossier .feuille.sans-marge { grid-template-columns:minmax(0,1fr); grid-template-areas:"entete" "corps"; }
  .entete { grid-area:entete; padding:26px 32px 20px; }
  .entete h2 { margin:10px 0 6px; font-size:24px; line-height:1.2; letter-spacing:-.01em; }
  .corps { grid-area:corps; padding:0 32px 12px; min-width:0; }
  .ligne-meta { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; }
  .meta { display:flex; flex-wrap:wrap; align-items:center; gap:4px 14px; margin:0; color:var(--sourdine); font-size:13px; }
  .meta .labo { padding:1px 8px; border-radius:3px; background:var(--action); color:var(--sur-action); font-weight:600; }
  .score { flex:none; font-weight:700; font-variant-numeric:tabular-nums; color:var(--sourdine); }
  .score small { font-weight:500; font-size:.8em; }
  .score.hi { color:var(--ok); }
  .entete .score { font-size:22px; line-height:1; }
  .src { margin:0; color:var(--sourdine); font-size:13px; }
  .src a { color:inherit; }
  .chapo { margin:14px 0 0; max-width:68ch; font:17px/1.6 var(--copie); }

  .marge { grid-area:marge; padding:26px 22px; border-left:1px solid var(--trait); border-radius:0 4px 0 0;
    background:color-mix(in srgb, var(--accent) 10%, var(--feuille)); font-size:14px; line-height:1.45; }
  .marge h3 { margin:0; font-size:15px; }
  .marge h4 { margin:18px 0 6px; font-size:13px; font-weight:600; color:var(--sourdine); }
  .marge ul { margin:0; padding:0; list-style:none; }
  .marge li { position:relative; margin-bottom:8px; padding-left:18px; }
  .marge li::before { content:''; position:absolute; left:0; top:.42em; width:8px; height:8px; border-radius:2px; background:var(--accent); }

  .piece { padding:18px 0 20px; border-top:1px solid var(--trait); }
  .piece > header { display:flex; align-items:baseline; gap:12px; margin-bottom:12px; }
  .piece > header .muted { margin-right:auto; }
  .piece h3, .piece summary { margin:0; font-size:15px; font-weight:700; }
  .piece summary { cursor:pointer; }
  .piece > .muted { margin:10px 0 0; overflow-wrap:anywhere; }
  .texte { max-width:68ch; font:17px/1.6 var(--copie); white-space:pre-wrap; overflow-wrap:anywhere; }
  .texte .tags { color:var(--action); }
  .objet { display:grid; grid-template-columns:auto minmax(0,1fr); gap:2px 12px; margin:0 0 14px; max-width:68ch; font:17px/1.5 var(--copie); }
  .objet dt { color:var(--sourdine); font:13px/2 var(--ui); }
  .objet dd { margin:0; }
  .objet dd:first-of-type { font-weight:700; }

  .planche { display:grid; grid-template-columns:repeat(auto-fill, minmax(168px, 1fr)); gap:10px; margin:0; padding:0; list-style:none; }
  .diapo { min-height:210px; display:flex; flex-direction:column; gap:8px; padding:14px; border-radius:3px;
    background:var(--diapo-fond); color:var(--diapo-texte); font-size:12px; line-height:1.4; }
  .diapo .num { font-size:11px; font-weight:700; opacity:.6; font-variant-numeric:tabular-nums; }
  .diapo b { font-size:15px; line-height:1.2; }
  .diapo ul { margin:0; padding-left:14px; }
  .diapo:first-child { background:var(--primaire); color:#fff; }
  .diapo:last-child { background:var(--accent); color:var(--primaire); }

  dl.fiche { display:grid; grid-template-columns:168px minmax(0,1fr); gap:10px 16px; margin:14px 0 0; }
  dl.fiche dt { color:var(--sourdine); font-size:13px; line-height:1.75; }
  dl.fiche dd { margin:0; }
  dl.fiche ul { margin:0; padding-left:18px; }

  .actions { display:flex; flex-wrap:wrap; align-items:center; gap:10px; }
  .actions input[type=text] { flex:1; min-width:200px; padding:8px 10px; border:1.5px solid var(--trait); border-radius:6px;
    background:var(--creux); color:var(--encre); font:inherit; }
  .dossier > .actions { position:sticky; bottom:0; padding:12px 16px; border:1px solid var(--trait); border-top:0; border-radius:0 0 4px 4px;
    background:var(--feuille); box-shadow:0 -1px 0 var(--trait), 0 -10px 18px -14px rgba(16,33,44,.5); }

  .liste { margin:0; padding:0; list-style:none; }
  .ligne { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:10px 24px; padding:16px 22px; border-bottom:1px solid var(--trait); }
  .ligne:last-child { border-bottom:0; }
  .ligne .ligne-meta { flex-direction:row-reverse; justify-content:flex-end; gap:14px; }
  .ligne .meta { max-width:none; }
  .ligne h3 { margin:6px 0 2px; font-size:16px; line-height:1.3; }
  .ligne h3 a { color:inherit; text-decoration-color:var(--trait); text-underline-offset:3px; }
  .ligne p { margin:6px 0 0; max-width:80ch; }
  .ligne .src { margin:0; }
  h2.section { margin:28px 0 12px; font-size:17px; }

  footer { margin-top:32px; color:var(--sourdine); font-size:13px; }
  footer a { color:inherit; }
  @media (max-width:1100px) {
    .dossier .feuille { grid-template-columns:minmax(0,1fr); grid-template-areas:"entete" "marge" "corps"; }
    .marge { border-left:0; border-top:1px solid var(--trait); border-bottom:1px solid var(--trait); border-radius:0; }
    .marge + .corps > .piece:first-child { border-top:0; }
  }
  @media (max-width:860px) {
    .page { padding:20px 14px 56px; }
    .bureau { display:block; }
    .pile { display:none; }
    .dossier, .dossier:target { display:block; margin-bottom:24px; }
    .entete, .corps { padding-left:18px; padding-right:18px; }
    .marge { padding:20px 18px; }
    .piece > header { flex-wrap:wrap; }
    .ligne { grid-template-columns:minmax(0,1fr); padding:14px 16px; }
    dl.fiche { grid-template-columns:minmax(0,1fr); gap:2px; }
    dl.fiche dd { margin-bottom:10px; }
  }
</style></head>
<body><div class="page">
  <header class="tete">
    <div><h1>Veille scientifique</h1><p>${esc(f.nom)}${f.etablissement ? `, ${esc(f.etablissement)}` : ''}</p></div>
    <div class="btns">
      <form method="post" action="/webhook/veille/recap"><button class="btn" type="submit" title="Envoie les contenus à valider (fiches, posts, articles, PDF) aux destinataires configurés">Envoyer le récapitulatif par e-mail</button></form>
      <form method="post" action="/webhook/veille/lancer"><button class="btn primary" type="submit">Lancer la veille maintenant</button></form>
    </div>
  </header>
  <nav class="circuit" aria-label="États des contenus">
    <ol>${CIRCUIT.map(etape).join('')}</ol>
    <ul>${SORTIES.map(etape).join('')}</ul>
  </nav>
  <p class="etat">${run ? `Dernière collecte le ${esc(fmtDateTime(run.started_at))} : ${esc(run.found)} trouvée(s), ${esc(run.inserted)} nouvelle(s).` : 'Aucune collecte pour le moment.'}${warnings}
    ${counts.processing ? ` ${esc(counts.processing)} publication(s) en cours de traitement : rechargez la page pour suivre.` : ''}
    ${editeur ? ' <a href="/workflow/VeilleTraitemt01" target="_blank" rel="noopener">Suivre le traitement dans n8n</a>' : ''}</p>
  ${!String(config.llm?.modele || '').trim() ? '<p class="avis err"><b>LLM non configuré.</b> Renseignez « llm.base_url » et « llm.modele » dans config/veille.json (et LLM_API_KEY dans .env), puis lancez la veille.</p>' : ''}
  ${message ? `<p class="avis ${message[0]}">${esc(message[1])}</p>` : ''}
  ${recentErrors.length && statut !== 'error' ? `<p class="avis err">${recentErrors.length} erreur(s) de workflow ces dernières 24 h : voir l'onglet « Erreurs ».</p>` : ''}
  <main>${vue}
  ${statut === 'error' && wfErrors.length ? `<h2 class="section">Erreurs des workflows (14 derniers jours)</h2>
    <ul class="feuille liste">${wfErrors.map(e => `<li class="ligne"><div><p class="meta"><span class="labo">${esc(e.workflow_name)}</span><span>${esc(fmtDateTime(e.created_at))}</span><span>Nœud « ${esc(e.node)} »</span></p>
      <p class="error">${esc(e.message)}</p></div>${editeur && safeUrl(e.execution_url) ? `<a class="btn small" href="${esc(e.execution_url)}" target="_blank" rel="noopener">Voir l'exécution dans n8n</a>` : ''}</li>`).join('')}</ul>` : ''}
  </main>
  <footer>Réglages : <code>config/veille.json</code>. E-mail récapitulatif automatique ${config.notifications?.email?.actif ? 'activé' : 'désactivé'}.${editeur ? ' <a href="/home/workflows" target="_blank" rel="noopener">Éditeur n8n</a>' : ''}</footer>
</div>
<script>
  function copier(btn) {
    var label = btn.textContent, ok = false;
    var done = function (t) { btn.textContent = t; setTimeout(function () { btn.textContent = label; }, 1800); };
    var zone = document.createElement('textarea');
    zone.value = btn.getAttribute('data-copie');
    zone.setAttribute('readonly', '');
    zone.style.cssText = 'position:fixed;top:0;left:-9999px';
    document.body.appendChild(zone);
    zone.select();
    try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(zone);
    if (ok) return done('Copié');
    var select = function () {
      window.getSelection().selectAllChildren(document.getElementById(btn.getAttribute('data-cible')));
      done('Texte sélectionné : Ctrl/Cmd + C');
    };
    if (navigator.clipboard) navigator.clipboard.writeText(zone.value).then(function () { done('Copié'); }, select);
    else select();
  }
  // Marque dans la pile le dossier affiché (celui de l'ancre, sinon le premier).
  (function () {
    var liens = document.querySelectorAll('.pile a');
    if (!liens.length) return;
    var marquer = function () {
      var ouvert = document.getElementById(location.hash.slice(1));
      if (!ouvert || ouvert.className !== 'dossier') ouvert = document.querySelector('.dossier');
      for (var i = 0; i < liens.length; i++) {
        if (liens[i].getAttribute('href') === '#' + ouvert.id) liens[i].setAttribute('aria-current', 'true');
        else liens[i].removeAttribute('aria-current');
      }
    };
    marquer();
    window.addEventListener('hashchange', marquer);
  })();
</script>
</body></html>`;

return [{ json: { html } }];
