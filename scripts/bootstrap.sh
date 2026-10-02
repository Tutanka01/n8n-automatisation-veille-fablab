#!/usr/bin/env bash
# Installation / mise à jour idempotente de la stack de veille (`make install`).
#
# Crée .env et ses secrets s'ils manquent, puis démarre la stack. Le reste (base « veille »,
# identifiants, compte propriétaire, import et publication des workflows) est fait par le
# conteneur n8n lui-même à chaque démarrage : voir n8n/provision/.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

log()  { printf '\033[1;34m▶\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✔\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m⚠\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✖\033[0m %s\n' "$*" >&2; exit 1; }

rand() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "${1:-32}" || true; }

# Remplace "CLE=" (valeur vide) par "CLE=valeur" dans .env, sans toucher aux valeurs existantes.
set_if_empty() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k && $2=="" {print k "=" v; next} {print}' .env >"$tmp"
  cat "$tmp" >.env && rm -f "$tmp"
}

load_env() {
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
}

check_prereqs() {
  command -v docker >/dev/null || die "Docker est requis."
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 est requis."
  docker info >/dev/null 2>&1 || die "Le démon Docker ne répond pas (Docker Desktop est-il lancé ?)."
}

prepare_env() {
  if [ ! -f .env ]; then
    cp .env.example .env
    chmod 600 .env
    ok "Fichier .env créé à partir de .env.example"
  fi
  set_if_empty N8N_ENCRYPTION_KEY "$(rand 48)"
  set_if_empty POSTGRES_PASSWORD "$(rand 32)"
  set_if_empty VEILLE_DB_PASSWORD "$(rand 32)"
  set_if_empty N8N_RUNNERS_AUTH_TOKEN "$(rand 40)"
  # Politique n8n : 8+ caractères, au moins une majuscule et un chiffre
  set_if_empty N8N_OWNER_PASSWORD "Fab$(rand 18)7"
  set_if_empty VEILLE_UI_PASSWORD "$(rand 20)"
  load_env

  mkdir -p output backups certs
  # Sous Linux, le conteneur n8n (uid 1000) doit pouvoir écrire les PDF
  if [ "$(uname -s)" = "Linux" ]; then chmod 0777 output; fi
}

# Le reverse proxy refuse de démarrer sans domaine ni certificats : autant le dire avant.
check_proxy() {
  case ",${COMPOSE_PROFILES:-}," in *,proxy,*) ;; *)
    [ -z "${VEILLE_DOMAIN:-}" ] || warn "VEILLE_DOMAIN est défini mais le reverse proxy est éteint : ajoutez COMPOSE_PROFILES=proxy dans .env"
    return ;;
  esac
  [ -n "${VEILLE_DOMAIN:-}" ] || die "COMPOSE_PROFILES=proxy : renseignez VEILLE_DOMAIN dans .env."
  if [ "${VEILLE_HTTPS:-false}" = true ]; then
    local dir="${TLS_CERTS_DIR:-./certs}" file
    for file in "${TLS_CERT_FILE:-fullchain.pem}" "${TLS_KEY_FILE:-privkey.pem}"; do
      [ -f "$dir/$file" ] || die "VEILLE_HTTPS=true : $dir/$file est introuvable (certificat et clé privée au format PEM)."
    done
  else
    warn "Reverse proxy en HTTP : les mots de passe circulent en clair. Passez VEILLE_HTTPS=true dès que les certificats sont en place."
  fi
}

start_stack() {
  log "Démarrage des conteneurs (premier lancement : ~1 min)…"
  if ! docker compose up -d --wait --wait-timeout 300; then
    docker compose ps >&2 || true
    docker compose logs --tail 40 n8n >&2 || true
    docker compose logs --tail 15 proxy backup >&2 2>/dev/null || true
    die "La stack n'a pas démarré correctement (journal ci-dessus ; complet : docker compose logs)."
  fi
  ok "Stack opérationnelle : base, identifiants et workflows provisionnés, interface en ligne"
}

check_config() {
  if grep -q '"modele": ""' config/veille.json; then
    warn "Aucun modèle LLM défini : renseignez « llm.base_url » et « llm.modele » dans config/veille.json"
  fi
  [ -n "${LLM_API_KEY:-}" ] || warn "LLM_API_KEY est vide (normal pour un LLM local sans clé ; sinon renseignez-la puis : make up)"
}

summary() {
  local url="${N8N_PUBLIC_URL:-http://localhost:5678}" public
  # Adresse inscrite au démarrage par le conteneur n8n (reverse proxy si VEILLE_DOMAIN, sinon n8n)
  public="$(docker compose exec -T postgres psql -AtU n8n -d veille -c \
    "SELECT value FROM instance_settings WHERE key = 'public_url'" 2>/dev/null || true)"
  cat <<EOF

────────────────────────────────────────────────────────────────────
  Veille FabLab prête

  n8n (éditeur)            $url
     identifiant           $N8N_OWNER_EMAIL
     mot de passe          dans .env (N8N_OWNER_PASSWORD)

  Interface de validation  ${public:-$url}/webhook/veille
     identifiant           $VEILLE_UI_USER
     mot de passe          dans .env (VEILLE_UI_PASSWORD)

  PDF des carrousels       ./output/
  Sauvegardes (chaque nuit) ./backups/

  Prochaines étapes
    1. config/veille.json : LLM (base_url, modele) + profil du FabLab
    2. .env : LLM_API_KEY, puis  make up
    3. Lancer une première veille : bouton « Lancer la veille » de
       l'interface, ou  make run
────────────────────────────────────────────────────────────────────
EOF
}

main() {
  check_prereqs
  prepare_env
  check_proxy
  start_stack
  check_config
  summary
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
