// Paramètres transmis au workflow « E-mail récapitulatif » en fin de lot.
let ids = [];
try { ids = $('Préparer les éléments').all().map(i => i.json.id).filter(Boolean); } catch (e) { /* lot vide */ }
let apresCollecte = false;
try { apresCollecte = $('Après la collecte').isExecuted; } catch (e) { /* autre déclencheur */ }
return [{ json: { mode: 'lot', ids, apres_collecte: apresCollecte } }];
