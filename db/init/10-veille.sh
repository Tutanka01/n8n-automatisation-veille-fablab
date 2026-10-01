#!/bin/sh
# Exécuté une seule fois, à la création du volume PostgreSQL.
# Crée la base "veille" (données métier) séparée de la base interne de n8n.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -v pw="$VEILLE_DB_PASSWORD" <<'SQL'
CREATE ROLE veille LOGIN PASSWORD :'pw';
CREATE DATABASE veille OWNER veille ENCODING 'UTF8' TEMPLATE template0;
SQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname veille <<'SQL'
ALTER SCHEMA public OWNER TO veille;
SQL

PGPASSWORD="$VEILLE_DB_PASSWORD" psql -v ON_ERROR_STOP=1 --username veille --dbname veille -f /opt/veille/db/schema.sql
