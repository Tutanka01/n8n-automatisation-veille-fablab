#!/bin/sh
# Point d'entrée du conteneur n8n : provisionne l'instance (provision.js), puis démarre n8n.
# Exécuté à chaque démarrage du conteneur : volumes neufs, .env modifié ou workflows régénérés,
# un simple `docker compose up -d` remet toujours la stack dans un état opérationnel.
set -eu

# Adresse publique de l'interface de validation : celle du reverse proxy si VEILLE_DOMAIN est défini
# (liens des e-mails, URL des webhooks), sinon celle de n8n (N8N_PUBLIC_URL).
if [ -n "${VEILLE_DOMAIN:-}" ]; then
  if [ "${VEILLE_HTTPS:-false}" = true ]; then
    scheme=https; port="${PROXY_HTTPS_PORT:-443}"; [ "$port" = 443 ] && port=""
  else
    scheme=http; port="${PROXY_HTTP_PORT:-80}"; [ "$port" = 80 ] && port=""
  fi
  export WEBHOOK_URL="$scheme://$VEILLE_DOMAIN${port:+:$port}/"
fi
export VEILLE_PUBLIC_URL="${WEBHOOK_URL%/}"

# Proxy sortant : s'il est défini dans .env, les requêtes HTTP(S) de n8n vers l'extérieur passent par
# lui ; sinon, connexion directe. Restent toujours en direct : les services de la stack, et les hôtes
# de config/veille.json à adresse interne (ex. LLM de l'établissement), qu'un proxy ne sait pas joindre.
# Cette détection a lieu ici, au démarrage : après un changement d'hôte dans la configuration, `make restart`.
if [ -n "${OUTBOUND_PROXY:-}" ]; then
  internes="$(node /opt/veille/provision/no-proxy.js || true)"
  export HTTP_PROXY="$OUTBOUND_PROXY" HTTPS_PROXY="$OUTBOUND_PROXY"
  export NO_PROXY="localhost,127.0.0.1,::1,postgres,gotenberg,n8n,task-runners,host.docker.internal${internes:+,$internes}${OUTBOUND_NO_PROXY:+,$OUTBOUND_NO_PROXY}"
  export http_proxy="$HTTP_PROXY" https_proxy="$HTTPS_PROXY" no_proxy="$NO_PROXY"
  # Affiché sans les identifiants éventuels du proxy
  echo "[veille] Proxy sortant : ${OUTBOUND_PROXY##*@} · en direct (adresse interne) : ${internes:-aucun hôte}${OUTBOUND_NO_PROXY:+ · en direct (.env) : $OUTBOUND_NO_PROXY}"
fi

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
