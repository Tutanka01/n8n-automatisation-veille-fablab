// Étape 3 — contenus : post LinkedIn, carrousel, paragraphe d'e-mail de prospection.
//@include lib/prompts.js
const { config } = $('Entrée').first().json;
const pub = $('Charger la publication').first().json;
const fiche = $('LLM · Fiche').isExecuted ? $('LLM · Fiche').first().json.data : pub.fiche;

return [{
  json: {
    llm: config.llm,
    niveau: 'principal',
    schema_name: 'contenus',
    schema: pSchemaContenus(),
    system: pSystem(config),
    user: pUserContenus(pub, config, fiche),
  },
}];
