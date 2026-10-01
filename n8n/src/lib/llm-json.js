// ── Lecture robuste des réponses d'une API compatible OpenAI (/chat/completions) ──

function llmHttpError(err) {
  // Élément produit par le nœud HTTP en mode « continuer en cas d'erreur »
  const e = err && typeof err === 'object' ? err : { message: String(err) };
  const code = Number(e.httpCode || e.status || e.statusCode || (e.context && e.context.httpCode)) || null;
  const detail = [e.message, e.description].filter(Boolean).join(' — ');
  return { code, detail: detail.slice(0, 800) || 'erreur inconnue' };
}

function llmContent(resp) {
  if (typeof resp === 'string') {
    try { resp = JSON.parse(resp); } catch (e) { throw new Error('Réponse LLM illisible : ' + resp.slice(0, 300)); }
  }
  const choice = resp && Array.isArray(resp.choices) ? resp.choices[0] : null;
  if (!choice) throw new Error('Réponse LLM sans « choices » : ' + JSON.stringify(resp).slice(0, 500));
  const msg = choice.message || {};
  if (msg.refusal) throw new Error('Le modèle a refusé de répondre : ' + msg.refusal);
  let content = msg.content;
  if (Array.isArray(content)) content = content.map(p => (typeof p === 'string' ? p : p.text || '')).join('');
  return { content: String(content ?? ''), finish: choice.finish_reason || null, usage: resp.usage || {}, model: resp.model || null };
}

function llmParseJson(text) {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch (e) { /* on tente d'isoler l'objet ci-dessous */ }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('aucun objet JSON dans la réponse');
  return JSON.parse(t.slice(start, end + 1));
}

// Valide un sous-ensemble de JSON Schema et corrige les écarts de type bénins
// ("7" -> 7, "true" -> true, valeur d'énumération mal cassée, chaîne seule -> liste).
function llmValidate(schema, value, path, errors) {
  const type = schema.type;
  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) { errors.push(`${path} doit être un objet`); return value; }
    for (const key of schema.required || []) if (!(key in value)) errors.push(`${path}.${key} est manquant`);
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (key in value) value[key] = llmValidate(sub, value[key], `${path}.${key}`, errors);
    }
    return value;
  }
  if (type === 'array') {
    const items = schema.items || {};
    if (typeof value === 'string' && items.type === 'string') value = value.trim() ? [value] : [];
    if (!Array.isArray(value)) { errors.push(`${path} doit être une liste`); return value; }
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} : au moins ${schema.minItems} éléments`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path} : au plus ${schema.maxItems} éléments`);
    return value.map((v, i) => llmValidate(items, v, `${path}[${i}]`, errors));
  }
  if (type === 'integer' || type === 'number') {
    const n = typeof value === 'string' && value.trim() ? Number(value.trim()) : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) { errors.push(`${path} doit être un nombre`); return value; }
    if (type === 'integer' && !Number.isInteger(n)) errors.push(`${path} doit être un entier`);
    if (schema.minimum !== undefined && n < schema.minimum) errors.push(`${path} doit être ≥ ${schema.minimum}`);
    if (schema.maximum !== undefined && n > schema.maximum) errors.push(`${path} doit être ≤ ${schema.maximum}`);
    return n;
  }
  if (type === 'boolean') {
    if (value === 'true' || value === 'false') return value === 'true';
    if (typeof value !== 'boolean') errors.push(`${path} doit être un booléen`);
    return value;
  }
  if (type === 'string') {
    if (typeof value === 'number') value = String(value);
    if (typeof value !== 'string') { errors.push(`${path} doit être une chaîne`); return value; }
    if (schema.minLength && value.trim().length < schema.minLength) errors.push(`${path} est vide ou trop court`);
    if (schema.enum && !schema.enum.includes(value)) {
      const hit = schema.enum.find(e => e.toLowerCase() === value.trim().toLowerCase());
      if (hit) return hit;
      errors.push(`${path} doit valoir l'une de : ${schema.enum.join(', ')}`);
    }
    return value;
  }
  return value;
}

function llmAnalyse(resp, schema) {
  const { content, finish, usage, model } = llmContent(resp);
  const errors = [];
  let data;
  try { data = llmParseJson(content); } catch (e) { errors.push('JSON invalide : ' + e.message); }
  if (!errors.length) data = llmValidate(schema, data, '$', errors);
  if (errors.length && finish === 'length') {
    throw new Error('Réponse LLM tronquée (limite de tokens atteinte) : augmentez « llm.max_tokens » dans config/veille.json.');
  }
  return { ok: errors.length === 0, data, errors, content, usage, model };
}

function llmSumUsage(...all) {
  const out = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  for (const u of all) for (const k of Object.keys(out)) out[k] += Number(u && u[k]) || 0;
  return out;
}
