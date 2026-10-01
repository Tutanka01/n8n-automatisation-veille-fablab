// Met en page le carrousel (HTML 1080×1350, format portrait LinkedIn) ; Gotenberg le convertit ensuite en PDF.
//@include lib/html.js
//@include lib/prompts.js
const { config } = $('Entrée').first().json;
const pub = $('Charger la publication').first().json;
const contenus = $('LLM · Contenus').isExecuted ? $('LLM · Contenus').first().json.data
  : { linkedin: pub.linkedin, carrousel: pub.carousel, email: pub.email };
const fiche = $('LLM · Fiche').isExecuted ? $('LLM · Fiche').first().json.data : pub.fiche;
const f = config.fablab || {};
const col = f.couleurs || {};
const C = {
  primaire: safeColor(col.primaire, '#0B3D5C'),
  accent: safeColor(col.accent, '#F2A900'),
  fond: safeColor(col.fond, '#F7F5F0'),
  texte: safeColor(col.texte, '#14202B'),
};

const slides = (contenus.carrousel?.slides || []).filter(s => s && (s.titre || s.texte));
if (slides.length < 3) throw new Error(`Carrousel incomplet : ${slides.length} diapositive(s) générée(s)`);

const labs = pLabNames(config, pub.labs) || 'laboratoire';
const etab = f.etablissement_court || 'UPPA';
const total = slides.length;
const KICKERS = {
  couverture: 'Recherche × Terrain', probleme: 'Le problème', recherche: 'Ce que montre la recherche',
  application: 'Concrètement', fablab: 'Au FabLab', appel_a_action: 'À vous de jouer',
};
const size = (text, steps) => { const n = String(text || '').length; for (const [max, px] of steps) if (n <= max) return px; return steps[steps.length - 1][1]; };
const pad = n => String(n).padStart(2, '0');

function bullets(list) {
  const items = (list || []).filter(Boolean).slice(0, 4);
  if (!items.length) return '';
  const px = size(items.join(''), [[90, 36], [160, 33], [9999, 30]]);
  return `<ul style="font-size:${px}px">${items.map(b => `<li>${esc(b)}</li>`).join('')}</ul>`;
}

function slide(s, i) {
  const n = i + 1;
  const type = KICKERS[s.type] ? s.type : 'application';
  const top = `<div class="top"><span class="brand">${esc(f.nom_court || f.nom)}</span><span class="num">${pad(n)} / ${pad(total)}</span></div>`;

  if (i === 0) {
    return `<section class="slide cover">
      <div class="orb orb1"></div><div class="orb orb2"></div>
      ${top}
      <div class="body">
        <div class="kicker">D'après les travaux du ${esc(labs)} · ${esc(etab)}</div>
        <h1 style="font-size:${size(s.titre, [[30, 104], [50, 92], [70, 80], [9999, 68]])}px">${esc(s.titre)}</h1>
        <p class="lead" style="font-size:${size(s.texte, [[90, 44], [160, 40], [9999, 36]])}px">${esc(s.texte)}</p>
      </div>
      <div class="foot"><span>${esc(f.nom)}</span><span class="swipe">Faites défiler →</span></div>
    </section>`;
  }

  if (n === total) {
    const contact = [f.contact_nom, f.contact_email, f.site_web].filter(Boolean);
    const authors = (pub.authors || []).slice(0, 3).join(', ') + ((pub.authors || []).length > 3 ? ' et al.' : '');
    return `<section class="slide cta">
      ${top}
      <div class="body">
        <div class="kicker">${esc(KICKERS.appel_a_action)}</div>
        <h2 style="font-size:${size(s.titre, [[30, 84], [50, 72], [9999, 60]])}px">${esc(s.titre)}</h2>
        <p class="text" style="font-size:${size(s.texte, [[120, 44], [200, 40], [9999, 36]])}px">${esc(s.texte)}</p>
        ${bullets(s.puces)}
        ${contact.length ? `<div class="contact">${contact.map(c => `<div>${esc(c)}</div>`).join('')}</div>` : ''}
      </div>
      <div class="foot source">Source : « ${esc(pub.title)} »${authors ? ` — ${esc(authors)}` : ''} — ${esc(labs)}, ${esc(etab)}${pub.url ? ` — ${esc(pub.url)}` : ''}</div>
    </section>`;
  }

  return `<section class="slide content t-${type}">
    <div class="bar"></div>
    <div class="ghost">${pad(n)}</div>
    ${top}
    <div class="body">
      <div class="kicker">${esc(KICKERS[type])}</div>
      <h2 style="font-size:${size(s.titre, [[30, 76], [50, 66], [70, 58], [9999, 50]])}px">${esc(s.titre)}</h2>
      <p class="text" style="font-size:${size(s.texte, [[120, 44], [200, 40], [280, 36], [9999, 32]])}px">${esc(s.texte)}</p>
      ${bullets(s.puces)}
    </div>
    <div class="foot"><span>${esc(labs)} × ${esc(f.nom_court || f.nom)}</span><span class="swipe">→</span></div>
  </section>`;
}

const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>${esc(fiche.titre_accrocheur || pub.title)}</title>
<style>
  @page { size: 1080px 1350px; margin: 0; }
  :root { --primaire: ${C.primaire}; --accent: ${C.accent}; --fond: ${C.fond}; --texte: ${C.texte}; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { font-family: 'Noto Sans', 'DejaVu Sans', sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .slide { width: 1080px; height: 1350px; position: relative; overflow: hidden; display: flex; flex-direction: column;
    padding: 72px 96px 80px; background: var(--fond); color: var(--texte); break-after: page; page-break-after: always; }
  .slide:last-child { break-after: auto; page-break-after: auto; }
  .top { display: flex; justify-content: space-between; align-items: center; font-size: 24px; font-weight: 700;
    letter-spacing: .08em; text-transform: uppercase; opacity: .7; position: relative; z-index: 2; }
  .body { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 36px; position: relative; z-index: 2; }
  .kicker { font-size: 26px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: var(--accent); }
  h1, h2 { font-weight: 800; line-height: 1.08; letter-spacing: -.01em; }
  .text, .lead { line-height: 1.45; }
  ul { list-style: none; display: flex; flex-direction: column; gap: 22px; line-height: 1.35; }
  li { position: relative; padding-left: 52px; }
  li::before { content: ''; position: absolute; left: 0; top: .42em; width: 26px; height: 26px; border-radius: 6px; background: var(--accent); }
  .foot { display: flex; justify-content: space-between; align-items: center; font-size: 24px; padding-top: 28px;
    border-top: 2px solid currentColor; opacity: .75; position: relative; z-index: 2; }
  .swipe { font-weight: 700; }

  .cover { background: var(--primaire); color: #fff; }
  .cover h1 { color: #fff; }
  .cover .lead { opacity: .9; }
  .orb { position: absolute; border-radius: 50%; z-index: 1; }
  .orb1 { width: 640px; height: 640px; right: -260px; top: -380px; background: var(--accent); opacity: .92; }
  .orb2 { width: 420px; height: 420px; left: -180px; bottom: 120px; border: 60px solid rgba(255,255,255,.08); }
  .cover .top { opacity: .85; }

  .content .bar { position: absolute; left: 0; top: 0; bottom: 0; width: 18px; background: var(--primaire); }
  .content .ghost { position: absolute; right: -20px; bottom: 40px; font-size: 520px; font-weight: 800; line-height: 1;
    color: var(--primaire); opacity: .05; z-index: 1; }
  .content h2 { color: var(--primaire); }
  .t-fablab { background: #fff; }
  .t-fablab .bar { background: var(--accent); }

  .cta { background: var(--accent); color: var(--primaire); }
  .cta .kicker { color: var(--primaire); opacity: .8; }
  .cta li::before { background: var(--primaire); }
  .contact { margin-top: 12px; padding: 32px 40px; background: var(--primaire); color: #fff; border-radius: 20px;
    font-size: 32px; font-weight: 700; line-height: 1.5; }
  .cta .source { display: block; font-size: 19px; line-height: 1.4; }
</style></head>
<body>
${slides.map(slide).join('\n')}
</body></html>`;

const slug = String(pub.title || 'publication').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'publication';

return [{
  json: { fileName: `carrousel-${pub.id}-${slug}.pdf`, slides: total },
  binary: { html: { data: Buffer.from(html, 'utf8').toString('base64'), mimeType: 'text/html', fileName: 'index.html' } },
}];
