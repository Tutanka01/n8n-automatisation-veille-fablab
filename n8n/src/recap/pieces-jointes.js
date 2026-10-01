// Un élément par PDF de carrousel à joindre (15 au maximum pour garder un e-mail raisonnable).
const params = $('Paramètres e-mail').first().json;
const items = $('Rassembler les contenus').first().json.a_valider || [];
const pdfs = params.joindre_pdf ? items.filter(p => p.pdf_file).slice(0, 15) : [];
if (!pdfs.length) return [{ json: { path: null } }];
return pdfs.map(p => ({ json: { path: `/home/node/.n8n-files/output/${p.pdf_file}` } }));
