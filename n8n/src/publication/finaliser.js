// Rassemble les contenus générés pour l'enregistrement final (statut « à valider »).
const pub = $('Charger la publication').first().json;
const fiche = $('LLM · Fiche').isExecuted ? $('LLM · Fiche').first().json : null;
const contenus = $('LLM · Contenus').isExecuted ? $('LLM · Contenus').first().json : null;
const carrousel = $('Composer le carrousel').first().json;
const usage = r => ({ modele: r.model, ...r.usage, corrige: r.corrige });

return [{
  json: {
    id: pub.id,
    fiche: fiche ? fiche.data : pub.fiche,
    linkedin: contenus ? contenus.data.linkedin : pub.linkedin,
    carousel: contenus ? contenus.data.carrousel : pub.carousel,
    email: contenus ? contenus.data.email : pub.email,
    pdf_file: carrousel.fileName,
    usage: { fiche: fiche ? usage(fiche) : pub.llm_usage.fiche, contenus: contenus ? usage(contenus) : pub.llm_usage.contenus },
  },
}];
