// Une seule boucle : erreurs temporaires, format refusé, puis au plus une correction JSON.
// Tous les essais partagent le même budget de temps.
//@include lib/llm-json.js
const req = $('Requête en cours').first().json;
const resp = $input.first().json;
const status = Number(resp.statusCode) || 0;
let body = resp.body;
try { if (typeof body === 'string') body = JSON.parse(body); } catch (e) { /* llmAnalyse signalera la réponse illisible */ }
const fail = detail => { throw new Error(`Appel LLM en échec (${req.tache}) : ${detail}`); };
function retry(changes, motif, wait = 0) {
  const remaining = req.deadline - Date.now() - wait * 1000;
  if (remaining < 1000) fail(`budget de temps épuisé — ${motif}`);
  return [{ json: { ...req, ...changes, ok: false, motif, wait_seconds: wait, tentative: req.tentative + 1 } }];
}

if (resp.error || status >= 400) {
  const { detail } = llmHttpError(resp.error || body?.error || { message: String(body ?? '') });
  const motif = `HTTP ${status || '?'} — ${detail}`;
  if ((!status || status === 429 || status >= 500) && req.tentative < 3) {
    const header = resp.headers?.['retry-after'];
    const seconds = Number(header);
    const wait = header && !Number.isFinite(seconds) ? (Date.parse(header) - Date.now()) / 1000 : seconds;
    return retry({}, motif, Math.max(5, Math.ceil(wait) || 0));
  }
  const formatIssue = [400, 422].includes(status) && req.body.response_format
    && /response_format|json_schema|json_object|grammar|structured output/i.test(detail);
  if (!formatIssue) fail(motif);
  const next = { ...req.body };
  if (next.response_format.type === 'json_schema') next.response_format = { type: 'json_object' };
  else delete next.response_format;
  return retry({ body: next }, `Format JSON refusé : ${detail}`);
}

const r = llmAnalyse(body, req.schema);
const usage = llmSumUsage(req.usage, r.usage);
if (r.ok) return [{ json: { ok: true, data: r.data, usage, model: r.model, corrige: req.correction, tentatives: req.tentative } }];
if (req.correction) fail(`JSON invalide après correction : ${r.errors.slice(0, 5).join(' ; ')}`);
return retry({
  correction: true,
  usage,
  body: { ...req.body, messages: [
    ...req.body.messages,
    { role: 'assistant', content: r.content.slice(0, 20000) },
    { role: 'user', content: `Corrige ces erreurs :\n- ${r.errors.slice(0, 15).join('\n- ')}\nRenvoie UNIQUEMENT l'objet JSON complet conforme au schéma.` },
  ] },
}, r.errors.slice(0, 5).join(' ; '));
