// Régressions sans dépendance : node n8n/check.js (ou make check).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, 'src');
const source = file => fs.readFileSync(path.join(root, file), 'utf8')
  .replace(/^\/\/@include (\S+)\s*$/gm, (_, include) => source(include));
async function run(file, items, nodes = {}) {
  const $ = name => {
    const values = nodes[name];
    return { isExecuted: !!values, first: () => ({ json: values[0] }),
      itemMatching: i => ({ json: values[i] }) };
  };
  return vm.runInNewContext(`(async function () {${source(file)}\n})()`, {
    $, $input: { first: () => ({ json: items[0] }), all: () => items.map(json => ({ json })) }, Buffer,
  });
}
const response = (data, tokens = 3) => ({ statusCode: 200, body: JSON.stringify({
  choices: [{ message: { content: JSON.stringify(data) }, finish_reason: 'stop' }],
  usage: { total_tokens: tokens }, model: 'test',
}) });
(async () => {
  const schema = { type: 'object', required: ['score'], properties: {
    score: { type: 'integer', minimum: 0, maximum: 10 },
  } };
  const prepared = (await run('llm/preparer.js', [{ llm: { base_url: 'http://test/v1/', modele: 'test',
    delai_max_secondes: 180, delai_rapide_secondes: 60 }, niveau: 'rapide', schema, user: 'test', system: 'test' }]))[0].json;
  assert.equal(prepared.timeout_ms, 60000);
  assert.equal(prepared.url, 'http://test/v1/chat/completions');
  const read = async (req, resp) => (await run('llm/lire-reponse.js', [resp], { 'Requête en cours': [req] }))[0].json;
  assert.equal((await read(prepared, response({ score: 7 }))).data.score, 7);
  for (const score of ['', 12, 2.5]) {
    const fix = await read(prepared, response({ score }));
    assert.equal(fix.correction, true);
    const ok = await read(fix, response({ score: 7 }, 5));
    assert.equal(ok.usage.total_tokens, 8);
    assert.equal(ok.corrige, true);
    await assert.rejects(() => read(fix, response({ score })), /après correction/);
  }
  for (const statusCode of [400, 401, 403]) {
    await assert.rejects(() => read(prepared, { statusCode, body: { error: { message: 'invalid API key' } } }), /HTTP/);
  }
  const refused = { statusCode: 400, body: { error: { message: 'response_format unsupported' } } };
  const fallback = await read(prepared, refused);
  assert.equal(fallback.body.response_format.type, 'json_object');
  assert.equal((await read(fallback, refused)).body.response_format, undefined);
  const transient = { statusCode: 429, headers: { 'retry-after': '7' }, body: { error: { message: 'slow down' } } };
  const retry = await read(prepared, transient);
  assert.equal(retry.wait_seconds, 7);
  assert.equal(retry.tentative, 2);
  assert.equal((await read(retry, response({ score: 5 }))).ok, true);
  await assert.rejects(() => read({ ...retry, tentative: 3 }, transient), /HTTP 429/);
  await assert.rejects(() => read({ ...prepared, deadline: Date.now() - 1 }, transient), /budget/);
  const broken = { statusCode: 503, body: 'gateway unavailable' };
  assert.equal((await read(prepared, broken)).ok, false);

  const validate = vm.runInNewContext(`${source('lib/llm-json.js')}; llmAnalyse`);
  const prompts = vm.runInNewContext(`${source('lib/prompts.js')}; ({pSchemaContenus, pSchemaTri})`);
  const envelope = data => ({ choices: [{ message: { content: JSON.stringify(data) } }] });
  assert.equal(validate(envelope({ score: 7, secteurs: ['INCONNU'] }), prompts.pSchemaTri({ cibles: { secteurs: [{ id: 'industrie' }] } })).ok, false);
  assert.equal(validate(envelope({ linkedin: { post: '', hashtags: [] }, carrousel: { slides: [] }, email: {} }), prompts.pSchemaContenus()).ok, false);

  const config = { sources: { hal: { actif: false }, rss: { actif: false } } };
  const sources = (await run('collecte/preparer-sources.js', [{ config }])).map(item => item.json);
  assert.equal(sources[0].skip, true);
  const collected = (await run('collecte/collecter.js', [{ skip: true }], {
    'Lire la configuration': [{ config }], 'Préparer les sources': sources,
  }))[0].json;
  assert.equal(collected.rows.length, 0);
  const now = new Date().toUTCString();
  const partial = (await run('collecte/collecter.js', [{ statusCode: 503 }, {
    statusCode: 200, body: `<rss><channel><item><title>Test &#999999999;</title><link>https://example.test</link><pubDate>${now}</pubDate></item></channel></rss>`,
  }], { 'Lire la configuration': [{ config }], 'Préparer les sources': [
    { kind: 'rss', lab: { nom: 'En panne' } }, { kind: 'rss', lab: { nom: 'Test', code: 'TEST' } },
  ] }))[0].json;
  assert.equal(partial.rows.length, 1);
  assert.equal(partial.warnings.length, 1);

  const pub = { id: 1, fiche: { apport_recherche: 'Connu' }, linkedin: { post: 'Sauvegardé' },
    carousel: { slides: [1] }, email: { paragraphe: 'Sauvegardé' }, llm_usage: { fiche: {}, contenus: {} } };
  const saved = (await run('publication/finaliser.js', [{}], {
    'Charger la publication': [pub], 'Composer le carrousel': [{ fileName: 'test.pdf' }],
  }))[0].json;
  assert.equal(saved.fiche.apport_recherche, 'Connu');
  assert.equal(saved.linkedin.post, 'Sauvegardé');
  pub.carousel.slides = ['couverture', 'probleme', 'recherche', 'application', 'fablab', 'appel_a_action']
    .map(type => ({ type, titre: 'Test', texte: 'Test', puces: [] }));
  const carousel = (await run('publication/composer-carrousel.js', [{}], {
    'Entrée': [{ config: {} }], 'Charger la publication': [pub],
  }))[0];
  assert.equal(carousel.json.slides, 6);
  assert(Buffer.from(carousel.binary.html.data, 'base64').toString().includes('<html'));
  const action = async action => (await run('interface/verifier-action.js', [{ body: { action } }]))[0].json;
  assert.equal((await action('regenerer')).regenerate, true);
  assert.equal((await action('relancer')).regenerate, false);

  for (const file of fs.readdirSync(path.join(__dirname, 'workflows'))) {
    const wf = JSON.parse(fs.readFileSync(path.join(__dirname, 'workflows', file)));
    const names = new Set(wf.nodes.map(n => n.name));
    assert.equal(names.size, wf.nodes.length);
    for (const [from, outputs] of Object.entries(wf.connections)) {
      assert(names.has(from));
      for (const group of outputs.main) for (const link of group) assert(names.has(link.node));
    }
  }
  console.log('✔ Délais, reprises HTTP, formats JSON, validation, collecte partielle et réutilisation des étapes.');
})().catch(error => { console.error(error); process.exitCode = 1; });
