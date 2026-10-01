// Score borné à 0–10 ; la publication est retenue si score ≥ seuil (ou si un humain a forcé le traitement).
const { config } = $('Entrée').first().json;
const pub = $('Charger la publication').first().json;
const res = $input.first().json;
const tri = res.data;
const score = Math.max(0, Math.min(10, Math.round(Number(tri.score) || 0)));
const seuil = Number(config.traitement?.seuil_pertinence ?? 6);

return [{
  json: {
    id: pub.id,
    score,
    secteurs: tri.secteurs || [],
    triage: { ...tri, score, seuil, force: pub.forced === true },
    retenue: score >= seuil || pub.forced === true,
    usage: { tri: { modele: res.model, ...res.usage, corrige: res.corrige } },
  },
}];
