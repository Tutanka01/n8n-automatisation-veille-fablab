// Chaque publication réservée part vers le sous-workflow avec la configuration du moment.
const config = $('Lire la configuration').first().json.config;
return $input.all().map(item => ({ json: { id: item.json.id, title: item.json.title, config } }));
