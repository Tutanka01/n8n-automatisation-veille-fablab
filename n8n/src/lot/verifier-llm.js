// Sans LLM configuré, on s'arrête AVANT de réserver le lot : les publications gardent leurs tentatives.
const { config } = $input.first().json;
if (!String(config.llm?.base_url || '').trim() || !String(config.llm?.modele || '').trim()) {
  throw new Error('LLM non configuré : renseignez « llm.base_url » et « llm.modele » dans config/veille.json, puis relancez la veille.');
}
return $input.all();
