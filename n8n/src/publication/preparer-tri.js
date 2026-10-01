// Étape 1 — tri : la source intéresse-t-elle les entreprises / acteurs publics du territoire ?
//@include lib/prompts.js
const { config } = $('Entrée').first().json;
const pub = $('Charger la publication').first().json;
if (!pub.id) throw new Error(`Publication introuvable (id ${$('Entrée').first().json.id})`);

return [{
  json: {
    llm: config.llm,
    niveau: 'rapide',
    schema_name: 'tri',
    schema: pSchemaTri(config),
    system: pSystem(config),
    user: pUserTri(pub, config),
  },
}];
