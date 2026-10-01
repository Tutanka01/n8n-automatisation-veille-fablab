// Qui reçoit le récapitulatif, et faut-il l'envoyer ?
//  - fin de lot (mode « lot ») : seulement si notifications.email.actif = true ;
//  - bouton de l'interface ou lancement manuel : toujours (s'il y a des destinataires).
const config = $('Lire la configuration').first().json.config;
const mail = config.notifications?.email || {};
let input = {};
try { if ($('Entrée').isExecuted) input = $('Entrée').first().json; } catch (e) { /* lancement manuel */ }

const to = [].concat(mail.destinataires || [])
  .flatMap(v => String(v).split(/[,;\s]+/))
  .map(v => v.trim())
  .filter(v => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v));
const automatique = input.mode === 'lot';

if (!automatique || mail.actif === true) {
  if (!to.length) throw new Error('Récapitulatif e-mail : aucun destinataire valide dans « notifications.email.destinataires » (config/veille.json).');
  if (!mail.expediteur) throw new Error('Récapitulatif e-mail : renseignez « notifications.email.expediteur » (config/veille.json).');
}

const ids = Array.isArray(input.ids) ? input.ids.map(Number).filter(Number.isInteger) : null;
return [{
  json: {
    envoyer: to.length > 0 && (!automatique || mail.actif === true),
    automatique,
    to: to.join(', '),
    from: mail.expediteur || '',
    ids: ids ? `{${ids.join(',')}}` : null,
    joindre_pdf: mail.joindre_pdf !== false,
    // « rien de nouveau » : seulement après la collecte hebdomadaire ou sur demande (pas au lot quotidien)
    envoyer_si_vide: mail.envoyer_si_vide === true && (!automatique || input.apres_collecte === true),
  },
}];
