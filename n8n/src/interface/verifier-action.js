// Contrôle strict du formulaire : action connue, identifiant numérique, jeton de la publication.
const body = $input.first().json.body || {};
const TABS = ['to_review', 'approved', 'published', 'new', 'triaged_out', 'rejected', 'error'];
const ACTIONS = {
  approuver: { status: 'approved', from: ['to_review'] },
  refuser: { status: 'rejected', from: ['to_review', 'approved'] },
  publier: { status: 'published', from: ['approved', 'to_review'] },
  a_valider: { status: 'to_review', from: ['approved', 'published', 'rejected'] },
  regenerer: { status: 'new', from: ['to_review', 'approved', 'rejected'], reset: true },
  forcer: { status: 'new', from: ['triaged_out'], reset: true, force: true },
  relancer: { status: 'new', from: ['error'], reset: true },
};
const action = ACTIONS[body.action];
const id = /^\d{1,12}$/.test(String(body.id || '')) ? Number(body.id) : 0;
const token = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(body.token || ''))
  ? body.token : '00000000-0000-0000-0000-000000000000';

return [{
  json: {
    id: action ? id : 0,
    token,
    status: action ? action.status : 'new',
    note: String(body.note || '').slice(0, 500),
    reset: Boolean(action && action.reset),
    regenerate: body.action === 'regenerer',
    force: Boolean(action && action.force),
    from: `{${(action ? action.from : []).join(',')}}`,
    retour: TABS.includes(body.retour) ? body.retour : 'to_review',
  },
}];
