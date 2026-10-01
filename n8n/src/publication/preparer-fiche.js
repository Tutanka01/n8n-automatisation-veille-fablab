// Étape 2 — fiche de valorisation : base unique et vérifiable de tous les contenus.
//@include lib/prompts.js
const { config } = $('Entrée').first().json;
const pub = $('Charger la publication').first().json;
const tri = $('Appliquer le tri').first().json.triage;

return [{
  json: {
    llm: config.llm,
    niveau: 'principal',
    schema_name: 'fiche_valorisation',
    schema: pSchemaFiche(config),
    system: pSystem(config),
    user: pUserFiche(pub, config, tri),
  },
}];
