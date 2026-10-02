#!/bin/sh
# Point d'entrée du reverse proxy (Caddy) : écrit sa configuration depuis .env, puis le démarre.
# Seule l'interface de validation (/webhook/veille…) est relayée vers n8n ; tout le reste
# (éditeur, API, autres webhooks) répond 404. HTTP ou HTTPS selon VEILLE_HTTPS.
set -eu

fail() { echo "[veille] ✖ $*" >&2; exit 1; }

DOMAIN="$(printf '%s' "${VEILLE_DOMAIN:-}" | tr 'A-Z' 'a-z')"
[ -n "$DOMAIN" ] || fail "VEILLE_DOMAIN est vide : indiquez dans .env le nom de domaine de l'interface (ex. veille.exemple.fr)."
case "$DOMAIN" in
  *[!a-z0-9.-]*) fail "VEILLE_DOMAIN=« $DOMAIN » : attendu un nom de domaine seul, sans http://, port ni chemin." ;;
esac

CONF=/tmp/Caddyfile
cat >"$CONF" <<EOF
{
	admin off
	auto_https off
	persist_config off
}

(interface) {
	log
	encode zstd gzip
	header {
		X-Content-Type-Options nosniff
		X-Frame-Options DENY
		Referrer-Policy no-referrer
		-Server
	}
	@interface path /webhook/veille /webhook/veille/*
	handle @interface {
		request_body {
			max_size 1MB
		}
		reverse_proxy n8n:5678
	}
	handle {
		respond "Introuvable" 404
	}
}

# Sonde de santé du conteneur (port non publié)
:8081 {
	respond /healthz "ok" 200
}

# Tout autre nom d'hôte que VEILLE_DOMAIN
:80 {
	respond "Introuvable" 404
}
EOF

case "${VEILLE_HTTPS:-false}" in
  true)
    CERT="/certs/${TLS_CERT_FILE:-fullchain.pem}"
    KEY="/certs/${TLS_KEY_FILE:-privkey.pem}"
    [ -r "$CERT" ] || fail "certificat introuvable : ${TLS_CERT_FILE:-fullchain.pem} absent du dossier TLS_CERTS_DIR (voir .env)."
    [ -r "$KEY" ] || fail "clé privée introuvable : ${TLS_KEY_FILE:-privkey.pem} absente du dossier TLS_CERTS_DIR (voir .env)."
    PORT="${PROXY_HTTPS_PORT:-443}"
    [ "$PORT" = 443 ] && PORT="" || PORT=":$PORT"
    cat >>"$CONF" <<EOF

https://$DOMAIN:443 {
	tls $CERT $KEY
	header Strict-Transport-Security "max-age=2592000"
	import interface
}

http://$DOMAIN:80 {
	redir https://$DOMAIN$PORT{uri} 308
}
EOF
    MODE="https://$DOMAIN$PORT/webhook/veille (certificat ${TLS_CERT_FILE:-fullchain.pem})"
    ;;
  false)
    cat >>"$CONF" <<EOF

http://$DOMAIN:80 {
	import interface
}
EOF
    MODE="http://$DOMAIN/webhook/veille (sans HTTPS : mots de passe en clair sur le réseau)"
    ;;
  *) fail "VEILLE_HTTPS=« ${VEILLE_HTTPS} » : attendu true ou false." ;;
esac

# Refuse de démarrer sur un certificat illisible ou une clé qui ne lui correspond pas.
caddy validate --config "$CONF" --adapter caddyfile >/tmp/validation.log 2>&1 \
  || { cat /tmp/validation.log >&2; fail "configuration refusée par Caddy (certificat ou clé invalide ?)."; }

echo "[veille] Reverse proxy : $MODE"
exec caddy run --config "$CONF" --adapter caddyfile
