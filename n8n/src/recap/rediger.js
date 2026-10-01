// E-mail récapitulatif complet (HTML + texte brut) : pour chaque contenu à valider, la fiche,
// le post LinkedIn, l'article de prospection, le carrousel (PDF joint) ; puis écartées et erreurs.
//@include lib/html.js
const config = $('Lire la configuration').first().json.config;
const params = $('Paramètres e-mail').first().json;
const data = $('Rassembler les contenus').first().json;
const f = config.fablab || {};
const base = String(config.interface?.url || 'http://localhost:5678').replace(/\/+$/, '');
const dashboard = `${base}/webhook/veille`;
const labsByCode = Object.fromEntries((config.laboratoires || []).map(l => [l.code, l]));
const sectorLabel = Object.fromEntries((config.cibles?.secteurs || []).map(s => [s.id, s.label]));
const MATURITE = { recherche_amont: 'Recherche amont', preuve_de_concept: 'Preuve de concept', prototype: 'Prototype', transfert_possible: 'Transfert possible' };
const primary = safeColor(f.couleurs?.primaire, '#0B3D5C');
const accent = safeColor(f.couleurs?.accent, '#F2A900');

const items = data.a_valider || [];
const ecartees = data.ecartees || [];
const erreurs = data.erreurs || [];
const run = data.derniere_collecte;

// ─── Pièces jointes : on regroupe les PDF lus sur un seul élément ───────────
const binary = {};
const attached = {};
$input.all().forEach((item, k) => {
  if (item.binary && item.binary.data) {
    binary[`pdf_${k + 1}`] = item.binary.data;
    attached[item.binary.data.fileName] = true;
  }
});

// ─── Briques HTML (styles en ligne pour les clients e-mail) ─────────────────
const labNames = codes => (codes || []).map(c => labsByCode[c]?.nom || c).join(', ');
const h3 = t => `<h3 style="margin:18px 0 6px;font-size:14px;color:${primary};text-transform:uppercase;letter-spacing:.04em">${esc(t)}</h3>`;
const p = (t, style = '') => (t ? `<p style="margin:0 0 8px;${style}">${nl2br(t)}</p>` : '');
const ul = list => ((list || []).length ? `<ul style="margin:0 0 8px;padding-left:20px">${list.map(v => `<li style="margin-bottom:3px">${esc(v)}</li>`).join('')}</ul>` : '');
const box = inner => `<div style="background:#f6f5f1;border:1px solid #e3e1da;border-radius:8px;padding:12px 14px;margin:0 0 8px;white-space:normal">${inner}</div>`;
const tag = (t, bg = '#eeece6', color = '#14202B') => `<span style="display:inline-block;background:${bg};color:${color};border-radius:12px;padding:2px 9px;margin:0 4px 4px 0;font-size:12px;font-weight:bold">${esc(t)}</span>`;

function hashtags(li) { return (li.hashtags || []).map(h => '#' + String(h).replace(/^#/, '').replace(/\s+/g, '')).join(' '); }

function section(item, index) {
  const fi = item.fiche || {};
  const li = item.linkedin || {};
  const em = item.email || {};
  const slides = item.carousel?.slides || [];
  const projet = fi.idee_projet_fablab || {};
  const authors = (item.authors || []).slice(0, 4).join(', ') + ((item.authors || []).length > 4 ? ' et al.' : '');
  const url = safeUrl(item.url);
  const scoreBg = item.score >= 8 ? '#1e7a46' : accent;
  return `
  <tr><td style="padding:24px 28px;border-top:6px solid ${index === 0 ? accent : '#e3e1da'}">
    <div>${(item.labs || []).map(c => tag(labsByCode[c]?.nom || c, primary, '#fff')).join('')}${tag(`${item.score}/10`, scoreBg, '#fff')}${(item.sectors || []).map(s => tag(sectorLabel[s] || s)).join('')}</div>
    <h2 style="margin:8px 0 4px;font-size:20px;line-height:1.3;color:#14202B">${esc(fi.titre_accrocheur || item.title)}</h2>
    <p style="margin:0 0 12px;font-size:13px;color:#5d6873">${url ? `<a href="${esc(url)}" style="color:#5d6873">${esc(item.title)}</a>` : esc(item.title)}${authors ? ` — ${esc(authors)}` : ''}${item.venue ? ` · <i>${esc(item.venue)}</i>` : ''}</p>
    ${p(fi.resume_vulgarise, 'font-size:15px')}

    ${h3('Post LinkedIn')}
    ${box(`${nl2br(li.post)}${hashtags(li) ? `<br><br><span style="color:${primary}">${esc(hashtags(li))}</span>` : ''}`)}
    ${url ? p(`Lien à mettre en premier commentaire : ${item.url}`, 'font-size:12px;color:#5d6873') : ''}

    ${h3('Article pour e-mail de prospection')}
    ${box(`<b>Objet :</b> ${esc(em.objet)}<br><b>Aperçu :</b> ${esc(em.preheader)}<br><br>${nl2br(em.paragraphe)}<br><br><i>${esc(em.appel_a_action)}</i>`)}

    ${h3(`Carrousel · ${slides.length} diapositives`)}
    <ol style="margin:0 0 8px;padding-left:20px">${slides.map(s => `<li style="margin-bottom:3px"><b>${esc(s.titre)}</b> — ${esc(s.texte)}</li>`).join('')}</ol>
    ${p(attached[item.pdf_file] ? `PDF en pièce jointe : ${item.pdf_file}` : 'PDF disponible dans l\'interface de validation.', 'font-size:12px;color:#5d6873')}

    ${h3('Fiche de valorisation')}
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-size:14px">
      ${[
        ['Problème terrain', p(fi.probleme_terrain)],
        ['Apport de la recherche', p(fi.apport_recherche)],
        ['Bénéfices', ul(fi.benefices)],
        ['Bénéficiaires', p((fi.exemples_beneficiaires || []).join(' · '))],
        ['Maturité', p(MATURITE[fi.maturite] || fi.maturite)],
        ['Projet FabLab', `${p(`${projet.titre || ''} — ${projet.description || ''}`)}${p(`Livrables : ${(projet.livrables || []).join(', ')} · Partenaire : ${projet.partenaire_ideal || ''} · Durée : ${projet.duree_indicative || ''}`, 'font-size:13px;color:#5d6873')}`],
        ['Chercheurs cités', p((fi.chercheurs_a_citer || []).join(', ') || '—')],
        ['Points de vigilance', ul(fi.points_de_vigilance)],
        ['Questions au laboratoire', ul(fi.questions_au_labo)],
      ].map(([k, v]) => `<tr><td style="vertical-align:top;width:170px;padding:4px 12px 4px 0;font-weight:bold;color:${k === 'Points de vigilance' ? '#b3261e' : '#5d6873'}">${esc(k)}</td><td style="vertical-align:top;padding:4px 0">${v}</td></tr>`).join('')}
    </table>
    <p style="margin:14px 0 0"><a href="${esc(dashboard)}?statut=to_review#pub-${esc(item.id)}" style="display:inline-block;background:${primary};color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;font-weight:bold">Valider ou refuser dans l'interface</a></p>
  </td></tr>`;
}

const intro = items.length
  ? `${items.length} contenu(s) prêt(s) à relire et valider.`
  : 'Aucun nouveau contenu à valider.';
const collecte = run
  ? `Dernière collecte : ${fmtDateTime(run.started_at)} — ${run.found} élément(s) trouvé(s), ${run.inserted} nouveau(x)${(run.warnings || []).length ? ` — incidents : ${run.warnings.join(' ; ')}` : ''}.`
  : '';

const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#eeece6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eeece6"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%;background:#ffffff;border-radius:10px;font-family:Arial,Helvetica,sans-serif;color:#14202B;font-size:14px;line-height:1.5">
  <tr><td style="background:${primary};color:#fff;padding:22px 28px;border-radius:10px 10px 0 0">
    <div style="font-size:12px;font-weight:bold;letter-spacing:.12em;text-transform:uppercase;color:${accent}">Veille scientifique · récapitulatif</div>
    <div style="font-size:22px;font-weight:bold;margin-top:4px">${esc(f.nom)}</div>
    <div style="margin-top:8px">${esc(intro)}${ecartees.length ? ` ${ecartees.length} écartée(s) par le tri.` : ''}${erreurs.length ? ` <b style="color:#ffb4ab">${erreurs.length} en erreur.</b>` : ''}</div>
    ${collecte ? `<div style="margin-top:6px;font-size:12px;opacity:.85">${esc(collecte)}</div>` : ''}
    ${data.validees_en_attente ? `<div style="margin-top:6px;font-size:12px;opacity:.85">${esc(data.validees_en_attente)} contenu(s) validé(s) attendent encore d'être publiés.</div>` : ''}
    <p style="margin:14px 0 0"><a href="${esc(dashboard)}" style="display:inline-block;background:${accent};color:#14202B;padding:9px 16px;border-radius:6px;text-decoration:none;font-weight:bold">Ouvrir l'interface de validation</a></p>
  </td></tr>
  ${items.map(section).join('')}
  ${ecartees.length ? `<tr><td style="padding:20px 28px;border-top:6px solid #e3e1da">${h3('Écartées par le tri')}
    <ul style="margin:0;padding-left:20px">${ecartees.map(e => `<li style="margin-bottom:6px"><b>${esc(e.title)}</b> <span style="color:#5d6873">(${esc(labNames(e.labs))}, ${esc(e.score)}/10)</span><br><span style="color:#5d6873;font-size:13px">${esc(e.raison)}</span></li>`).join('')}</ul>
    ${p('Pour en traiter une malgré tout : onglet « Écartées » → « Traiter quand même ».', 'font-size:12px;color:#5d6873;margin-top:8px')}</td></tr>` : ''}
  ${erreurs.length ? `<tr><td style="padding:20px 28px;border-top:6px solid #e3e1da">${h3('En erreur')}
    <ul style="margin:0;padding-left:20px">${erreurs.map(e => `<li style="margin-bottom:6px"><b>${esc(e.title)}</b><br><span style="color:#b3261e;font-size:13px">${esc(e.erreur)}</span> <span style="color:#5d6873;font-size:12px">(${esc(e.tentatives)} tentative(s))</span></li>`).join('')}</ul></td></tr>` : ''}
  <tr><td style="padding:16px 28px;border-top:1px solid #e3e1da;font-size:12px;color:#5d6873">Contenus générés par IA à partir des publications HAL et des actualités des laboratoires : à relire avant toute publication. Réglages : config/veille.json.</td></tr>
</table></td></tr></table></body></html>`;

// ─── Version texte brut ─────────────────────────────────────────────────────
const line = '─'.repeat(60);
const text = [
  `${f.nom} — veille scientifique`,
  intro,
  collecte,
  `Interface de validation : ${dashboard}`,
  '',
  ...items.flatMap((item, i) => {
    const fi = item.fiche || {};
    const li = item.linkedin || {};
    const em = item.email || {};
    return [
      line,
      `${i + 1}. ${fi.titre_accrocheur || item.title}`,
      `Source : ${item.title} — ${labNames(item.labs)} — ${item.url || ''}`,
      `Score : ${item.score}/10 · Secteurs : ${(item.sectors || []).map(s => sectorLabel[s] || s).join(', ')}`,
      '',
      fi.resume_vulgarise || '',
      '',
      '▸ POST LINKEDIN',
      li.post || '',
      hashtags(li),
      '',
      '▸ ARTICLE POUR E-MAIL DE PROSPECTION',
      `Objet : ${em.objet || ''}`,
      `Aperçu : ${em.preheader || ''}`,
      em.paragraphe || '',
      em.appel_a_action || '',
      '',
      '▸ CARROUSEL',
      ...(item.carousel?.slides || []).map((s, k) => `${k + 1}. ${s.titre} — ${s.texte}`),
      attached[item.pdf_file] ? `(PDF joint : ${item.pdf_file})` : '',
      '',
      '▸ POINTS DE VIGILANCE',
      ...(fi.points_de_vigilance || []).map(v => `- ${v}`),
      '',
    ];
  }),
  ...(ecartees.length ? [line, 'ÉCARTÉES PAR LE TRI', ...ecartees.map(e => `- ${e.title} (${e.score}/10) : ${e.raison}`), ''] : []),
  ...(erreurs.length ? [line, 'EN ERREUR', ...erreurs.map(e => `- ${e.title} : ${e.erreur}`), ''] : []),
].join('\n');

const date = fmtDate(new Date());
return [{
  json: {
    to: params.to,
    from: params.from,
    subject: `[Veille ${f.nom_court || 'FabLab'}] ${items.length ? `${items.length} contenu(s) à valider` : 'rien de nouveau à valider'} — ${date}`,
    html,
    text,
    attachments: Object.keys(binary).join(','),
  },
  binary,
}];
