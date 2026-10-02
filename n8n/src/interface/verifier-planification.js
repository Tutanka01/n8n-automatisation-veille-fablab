// Contrôle strict du formulaire de planification : jours 1-7 (cases j1…j7), heure HH:MM, au moins un jour si activée.
//@include lib/origine.js
const body = $input.first().json.body || {};
const TABS = ['to_review', 'approved', 'published', 'new', 'triaged_out', 'rejected', 'error'];
const actif = Boolean(body.actif);
const jours = [1, 2, 3, 4, 5, 6, 7].filter(d => body[`j${d}`]);
const heure = String(body.heure || '').trim().slice(0, 5);
const valide = /^([01]\d|2[0-3]):[0-5]\d$/.test(heure) && (!actif || jours.length > 0);

return [{
  json: {
    valide,
    actif,
    jours: `{${jours.join(',')}}`,
    heure: valide ? heure : '07:00',
    retour: TABS.includes(body.retour) ? body.retour : 'to_review',
  },
}];
