// Normalise les réponses HTTP HAL + RSS ; un incident reste visible dans le journal de collecte.
// Toujours un seul élément en sortie { rows, warnings, stats } : une source en panne
// n'empêche pas les autres d'être collectées (l'incident est noté dans warnings).
const config = $('Lire la configuration').first().json.config;
const labs = config.laboratoires || [];
const rss = config.sources?.rss || {};
const rows = [];
const warnings = [];
const stats = { hal: 0, rss: 0 };

const arr = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
const first = v => (Array.isArray(v) ? v[0] : v);

function toDate(v) {
  const m = String(v || '').match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  return m ? `${m[1]}-${m[2] || '01'}-${m[3] || '01'}` : null;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', eacute: 'é', egrave: 'è', ecirc: 'ê',
  euml: 'ë', agrave: 'à', acirc: 'â', ccedil: 'ç', icirc: 'î', iuml: 'ï', ocirc: 'ô', ucirc: 'û', ugrave: 'ù',
  oelig: 'œ', Eacute: 'É', Agrave: 'À', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  hellip: '…', ndash: '–', mdash: '—', euro: '€', deg: '°' };
function decode(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  if (!m) return '';
  const cdata = m[1].match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return cdata ? cdata[1] : decode(m[1]);
}
function stripHtml(s) {
  return decode(String(s || '').replace(/<(br|\/p|\/div|\/li)\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

const collections = labs.filter(l => l.collection_hal);
const since = new Date(Date.now() - (Number(rss.jours_de_recul) || 30) * 86400000);
for (const [index, item] of $input.all().entries()) {
  const source = $('Préparer les sources').itemMatching(index).json;
  if (source.skip) continue;
  const response = item.json;
  const label = source.kind === 'hal' ? 'HAL' : `RSS ${source.lab.nom}`;
  try {
    if (response.error || response.statusCode >= 400) {
      throw new Error(response.error || `HTTP ${response.statusCode}`);
    }
    if (source.kind === 'hal') {
      const res = JSON.parse(response.body);
      if (!Array.isArray(res?.response?.docs)) throw new Error('réponse HAL invalide');
      const docs = res?.response?.docs || [];
      if (res?.response?.numFound > docs.length) {
        warnings.push(`HAL : ${res.response.numFound} résultats, ${docs.length} récupérés (augmenter sources.hal.max_resultats)`);
      }
      for (const d of docs) {
        if (!d.halId_s) continue;
        const colls = arr(d.collCode_s);
        rows.push({
          source: 'hal',
          external_id: d.halId_s,
          kind: 'publication',
          labs: collections.filter(l => colls.includes(l.collection_hal)).map(l => l.code),
          title: first(d.title_s) || '(sans titre)',
          authors: arr(d.authFullName_s),
          abstract: arr(d.abstract_s).join('\n\n') || null,
          keywords: arr(d.keyword_s),
          doc_type: d.docType_s || null,
          venue: d.journalTitle_s || d.conferenceTitle_s || d.bookTitle_s || null,
          doi: d.doiIdStr_s || null,
          url: d.uri_s || `https://hal.science/${d.halId_s}`,
          pdf_url: d.fileMain_s || null,
          language: first(d.language_s) || null,
          published_on: toDate(d.publicationDate_tdate || d.producedDate_s),
          deposited_at: d.submittedDate_tdate || null,
          raw: d,
        });
        stats.hal++;
      }
    } else {
      const lab = source.lab;
      const xml = String(response.body || '');
      if (!/<rss[\s>]|<rdf:RDF[\s>]/i.test(xml)) throw new Error('flux RSS invalide');
      const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
      for (const block of items) {
        const title = stripHtml(tag(block, 'title'));
        const link = tag(block, 'link').trim();
        const date = new Date(tag(block, 'pubDate'));
        if (!title || isNaN(date) || date < since) continue;
        const guid = tag(block, 'guid').trim();
        rows.push({
          source: 'rss',
          external_id: guid || link || `${lab.code}:${title}:${date.toISOString()}`,
          kind: 'actualite',
          labs: [lab.code],
          title,
          authors: [],
          abstract: stripHtml(tag(block, 'description')) || null,
          keywords: (block.match(/<category[^>]*>[\s\S]*?<\/category>/gi) || []).map(c => stripHtml(c)).filter(Boolean),
          doc_type: 'ACTU',
          venue: `Site du ${lab.nom}`,
          doi: null,
          url: /^https?:\/\//.test(link) ? link : lab.site || null,
          pdf_url: null,
          language: 'fr',
          published_on: date.toISOString().slice(0, 10),
          deposited_at: date.toISOString(),
          raw: { title, link, guid, pubDate: date.toISOString() },
        });
        stats.rss++;
      }
    }
  } catch (e) {
    warnings.push(`${label} indisponible : ${e.message}`);
  }
}
return [{ json: { rows, warnings, stats } }];
