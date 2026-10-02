-- Schéma de la base "veille". Idempotent : rejoué à chaque démarrage de n8n (n8n/provision/provision.js).

CREATE TABLE IF NOT EXISTS publications (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source         text        NOT NULL,                 -- 'hal' | 'rss'
  external_id    text        NOT NULL,                 -- halId, ou lien / guid pour le RSS
  kind           text        NOT NULL DEFAULT 'publication', -- 'publication' | 'actualite'
  labs           text[]      NOT NULL DEFAULT '{}',
  title          text        NOT NULL,
  authors        text[]      NOT NULL DEFAULT '{}',
  abstract       text,
  keywords       text[]      NOT NULL DEFAULT '{}',
  doc_type       text,
  venue          text,
  doi            text,
  url            text,
  pdf_url        text,
  language       text,
  published_on   date,
  deposited_at   timestamptz,
  raw            jsonb,

  -- Cycle de vie
  status         text        NOT NULL DEFAULT 'new',
  attempts       int         NOT NULL DEFAULT 0,
  last_error     text,

  -- Résultats IA
  score          int,
  sectors        text[]      NOT NULL DEFAULT '{}',
  triage         jsonb,
  fiche          jsonb,
  linkedin       jsonb,
  carousel       jsonb,
  email          jsonb,
  pdf_file       text,
  llm_usage      jsonb       NOT NULL DEFAULT '{}',

  -- Validation humaine
  review_token   uuid        NOT NULL DEFAULT gen_random_uuid(),
  review_note    text,
  reviewed_at    timestamptz,
  published_at   timestamptz,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz,

  CONSTRAINT publications_source_external_uq UNIQUE (source, external_id),
  CONSTRAINT publications_status_ck CHECK (status IN (
    'new',          -- collectée, en attente de traitement IA
    'processing',   -- en cours de traitement
    'triaged_out',  -- écartée par le tri (score < seuil)
    'to_review',    -- contenus générés, à valider
    'approved',     -- validée, prête à publier
    'rejected',     -- refusée par un humain
    'published',    -- publiée
    'error'         -- échec (re-tentée automatiquement jusqu'à max_tentatives)
  ))
);

-- Migrations additives (base déjà créée par une version précédente)
ALTER TABLE publications ADD COLUMN IF NOT EXISTS forced boolean NOT NULL DEFAULT false; -- traiter même sous le seuil
ALTER TABLE publications ADD COLUMN IF NOT EXISTS processing_step text;

CREATE INDEX IF NOT EXISTS publications_status_idx     ON publications (status);
CREATE INDEX IF NOT EXISTS publications_deposited_idx  ON publications (deposited_at DESC);
CREATE INDEX IF NOT EXISTS publications_doi_idx        ON publications (lower(doi)) WHERE doi IS NOT NULL;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS publications_updated_at ON publications;
CREATE TRIGGER publications_updated_at BEFORE UPDATE ON publications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Paramètres d'instance écrits au démarrage depuis .env (ex. public_url : adresse de l'interface)
CREATE TABLE IF NOT EXISTS instance_settings (
  key    text PRIMARY KEY,
  value  text NOT NULL
);

-- Journal des collectes
CREATE TABLE IF NOT EXISTS collect_runs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at   timestamptz NOT NULL DEFAULT now(),
  found        int         NOT NULL DEFAULT 0,
  inserted     int         NOT NULL DEFAULT 0,
  warnings     jsonb       NOT NULL DEFAULT '[]'
);

-- Journal des erreurs de workflows (alimenté par le workflow d'alerte)
CREATE TABLE IF NOT EXISTS workflow_errors (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at     timestamptz NOT NULL DEFAULT now(),
  workflow_name  text,
  execution_id   text,
  execution_url  text,
  node           text,
  message        text,
  details        jsonb
);
