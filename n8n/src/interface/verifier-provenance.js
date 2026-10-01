// Le bouton « Lancer la veille » déclenche des appels LLM payants : on refuse les requêtes
// envoyées depuis un autre site (protection CSRF). La page de validation, servie en bac à sable
// par n8n, a une origine « null » ; un autre site aurait sa propre origine.
const h = $input.first().json.headers || {};
const origin = h.origin;
const self = h.host ? [`http://${h.host}`, `https://${h.host}`] : [];
if (origin && origin !== 'null' && !self.includes(origin)) {
  throw new Error(`Requête refusée : origine ${origin}`);
}
return [{ json: { declenche_par: 'interface', a: new Date().toISOString() } }];
