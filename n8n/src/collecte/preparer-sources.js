// Un élément par source : les nœuds HTTP gèrent les téléchargements et leurs délais.
const config = $input.first().json.config;
const labs = config.laboratoires || [];
const hal = config.sources?.hal || {};
const rss = config.sources?.rss || {};
const sources = [];
const arr = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
const collections = labs.filter(l => l.collection_hal);
if (hal.actif !== false && collections.length) {
  const fields = ['halId_s', 'title_s', 'authFullName_s', 'abstract_s', 'keyword_s', 'docType_s', 'journalTitle_s',
    'conferenceTitle_s', 'bookTitle_s', 'doiIdStr_s', 'uri_s', 'fileMain_s', 'language_s', 'producedDate_s',
    'publicationDate_tdate', 'submittedDate_tdate', 'collCode_s'];
  const params = [
    ['q', '*:*'], ['wt', 'json'], ['fl', fields.join(',')], ['sort', 'submittedDate_tdate desc'],
    ['rows', String(Number(hal.max_resultats) || 200)],
    ['fq', `collCode_s:(${collections.map(l => l.collection_hal).join(' OR ')})`],
    ['fq', `submittedDate_tdate:[NOW-${Number(hal.jours_de_recul) || 30}DAYS/DAY TO NOW]`],
  ];
  if (arr(hal.types_exclus).length) params.push(['fq', `-docType_s:(${arr(hal.types_exclus).join(' OR ')})`]);
  const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

  sources.push({ kind: 'hal', url: `https://api.archives-ouvertes.fr/search/?${query}` });
}
if (rss.actif !== false) for (const lab of labs.filter(l => l.flux_rss)) {
  sources.push({ kind: 'rss', lab, url: lab.flux_rss });
}
return (sources.length ? sources : [{ skip: true }]).map(json => ({ json }));
