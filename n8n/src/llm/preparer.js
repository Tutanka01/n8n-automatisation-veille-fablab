// Construit la requête /chat/completions pour n'importe quelle API compatible OpenAI.
// Entrée : { llm (section de config), niveau: 'rapide'|'principal', system, user, schema_name, schema }
const input = $input.first().json;
const llm = input.llm || {};
const baseUrl = String(llm.base_url || '').trim().replace(/\/+$/, '');
const model = input.niveau === 'rapide' && llm.modele_rapide ? llm.modele_rapide : llm.modele;
if (!baseUrl || !model) {
  throw new Error('LLM non configuré : renseignez « llm.base_url » et « llm.modele » dans config/veille.json.');
}
const mode = ['json_schema', 'json_object', 'aucun'].includes(llm.format_json) ? llm.format_json : 'json_schema';

const system = `${input.system}

## Format de sortie
Réponds UNIQUEMENT avec un objet JSON valide, sans texte avant ou après et sans bloc de code. Il doit respecter ce schéma JSON (les champs « description » précisent le contenu attendu) :
${JSON.stringify(input.schema)}`;

const body = {
  model,
  messages: [
    { role: 'system', content: system },
    { role: 'user', content: input.user },
  ],
};
if (llm.temperature !== null && llm.temperature !== undefined && llm.temperature !== '') body.temperature = Number(llm.temperature);
if (llm.max_tokens) body[llm.parametre_max_tokens || 'max_tokens'] = Number(llm.max_tokens);
if (mode === 'json_schema') {
  body.response_format = { type: 'json_schema', json_schema: { name: input.schema_name || 'reponse', strict: true, schema: input.schema } };
} else if (mode === 'json_object') {
  body.response_format = { type: 'json_object' };
}
Object.assign(body, llm.parametres_supplementaires || {}, input.niveau === 'rapide' ? llm.parametres_rapide || {} : {});

const budget = Math.max(1, Number(input.niveau === 'rapide' ? llm.delai_rapide_secondes ?? llm.delai_max_secondes : llm.delai_max_secondes) || 180) * 1000;
return [{
  json: {
    url: `${baseUrl}/chat/completions`,
    body,
    timeout_ms: budget,
    deadline: Date.now() + budget,
    tentative: 1,
    correction: false,
    usage: {},
    schema: input.schema,
    tache: input.schema_name || 'reponse',
    mode,
  },
}];
