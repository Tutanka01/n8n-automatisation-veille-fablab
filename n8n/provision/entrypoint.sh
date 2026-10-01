#!/bin/sh
# Point d'entrée du conteneur n8n : provisionne l'instance (provision.js), puis démarre n8n.
# Exécuté à chaque démarrage du conteneur : volumes neufs, .env modifié ou workflows régénérés,
# un simple `docker compose up -d` remet toujours la stack dans un état opérationnel.
set -eu

node /opt/veille/provision/provision.js

# Compte propriétaire de l'éditeur : appliqué par n8n lui-même au démarrage, depuis .env.
N8N_INSTANCE_OWNER_PASSWORD_HASH="$(cd /usr/local/lib/node_modules/n8n \
  && node -e 'process.stdout.write(require("bcryptjs").hashSync(process.env.N8N_OWNER_PASSWORD, 10))')"
export N8N_INSTANCE_OWNER_MANAGED_BY_ENV=true
export N8N_INSTANCE_OWNER_EMAIL="$N8N_OWNER_EMAIL"
export N8N_INSTANCE_OWNER_FIRST_NAME="${N8N_OWNER_FIRSTNAME:-}"
export N8N_INSTANCE_OWNER_LAST_NAME="${N8N_OWNER_LASTNAME:-}"
export N8N_INSTANCE_OWNER_PASSWORD_HASH

# Les secrets sont désormais stockés (chiffrés) dans n8n : inutile de les laisser au processus.
unset N8N_OWNER_PASSWORD LLM_API_KEY VEILLE_DB_PASSWORD VEILLE_UI_PASSWORD SMTP_PASSWORD

exec /docker-entrypoint.sh "$@"
