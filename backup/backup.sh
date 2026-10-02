#!/bin/sh
# Sauvegarde des bases (n8n + veille), de la configuration et des PDF dans ./backups.
#   backup.sh       : une sauvegarde chaque nuit à BACKUP_HOUR h, purge après BACKUP_KEEP_DAYS jours
#   backup.sh now   : une sauvegarde immédiate (`make backup`)
set -u

DIR=/backups
KEEP="${BACKUP_KEEP_DAYS:-14}"
HOUR="${BACKUP_HOUR:-3}"
HOUR=$((${HOUR#0} + 0))  # « 08 » serait lu comme de l'octal
ECHEC=/tmp/echec  # lu par le healthcheck du conteneur

log() { echo "[veille] $*"; }

dump() {
  pg_dump -h postgres -U n8n -d "$1" --compress=gzip:6 -f "$2/$1-$3.sql.gz"
}

backup() {
  stamp="$(date +%Y%m%d-%H%M%S)"
  tmp="$DIR/.en-cours-$stamp"
  umask 077
  # Tout est écrit à part puis déplacé : un fichier présent dans backups/ est toujours complet.
  if mkdir -p "$tmp" \
    && dump n8n "$tmp" "$stamp" \
    && dump veille "$tmp" "$stamp" \
    && tar czf "$tmp/fichiers-$stamp.tar.gz" -C /data config output \
    && mv "$tmp"/* "$DIR"/
  then
    # Fichiers rendus au propriétaire du dossier backups/ de l'hôte (le conteneur écrit en root).
    chown "$(stat -c '%u:%g' "$DIR")" "$DIR"/*-"$stamp".* 2>/dev/null || true
    rmdir "$tmp"
    rm -f "$ECHEC"
    # Purge seulement après une sauvegarde réussie : les anciennes restent tant que rien ne les remplace.
    find "$DIR" -maxdepth 1 -type f \( -name 'n8n-*.sql.gz' -o -name 'veille-*.sql.gz' -o -name 'fichiers-*.tar.gz' \) \
      -mtime "+$KEEP" -delete
    log "Sauvegarde $stamp terminée (conservation : $KEEP jours)"
  else
    rm -rf "$tmp"
    touch "$ECHEC"
    log "✖ Sauvegarde $stamp échouée"
    return 1
  fi
}

if [ "${1:-}" = now ]; then
  backup
  exit
fi

# Premier démarrage : la base « veille » est créée par le conteneur n8n, on l'attend (10 min au plus).
i=0
until psql -h postgres -U n8n -d veille -Atc 'SELECT 1' >/dev/null 2>&1 || [ "$i" -ge 40 ]; do
  i=$((i + 1))
  sleep 15
done
[ -n "$(find "$DIR" -maxdepth 1 -name 'veille-*.sql.gz' -mmin -1440)" ] || backup

while :; do
  now="$(date +%s)"
  next="$(date -d "$(date +%Y-%m-%d) $(printf '%02d' "$HOUR"):00:00" +%s)"
  [ "$next" -gt "$now" ] || next=$((next + 86400))
  sleep $((next - now))
  backup
done
