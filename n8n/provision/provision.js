// Provisionnement de l'instance n8n, lancé par entrypoint.sh AVANT chaque démarrage de n8n.
// Tout est idempotent : un `docker compose up` suffit, que les volumes soient neufs ou non.
//   1. base « veille » : rôle (mot de passe de .env), base, schéma db/schema.sql
//   2. identifiants n8n recopiés depuis .env (base, clé LLM, accès interface, SMTP)
//   3. workflows de n8n/workflows/ importés et publiés s'ils ont changé, manquent ou ne sont plus publiés
'use strict';
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Client } = require(require.resolve('pg', { paths: ['/usr/local/lib/node_modules/n8n'] }));

const WORKFLOWS_DIR = '/opt/veille/workflows';
const SCHEMA_FILE = '/opt/veille/db/schema.sql';
// Empreinte des workflows importés, rangée dans la table `settings` de n8n (même base que les workflows).
const HASH_KEY = 'veille.workflowsHash';
const env = process.env;

const log = (msg) => console.log(`[veille] ${msg}`);

function fail(msg) {
  console.error(`[veille] ✖ ${msg}`);
  process.exit(1);
}

function required(name) {
  const value = (env[name] || '').trim();
  if (!value) fail(`${name} est vide : renseignez-le dans .env puis relancez « make up ».`);
  return value;
}

async function withDb(database, user, password, fn) {
  const db = new Client({
    host: env.DB_POSTGRESDB_HOST, port: Number(env.DB_POSTGRESDB_PORT) || 5432, database, user, password,
  });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

function n8n(...args) {
  const r = spawnSync('n8n', args, { encoding: 'utf8' });
  if (r.status !== 0) fail(`« n8n ${args.join(' ')} » a échoué :\n${`${r.stdout || ''}${r.stderr || ''}`.trim()}`);
}

// ── 1 · Base « veille » ────────────────────────────────────────────────────
async function veilleDatabase() {
  const password = required('VEILLE_DB_PASSWORD');
  const admin = [env.DB_POSTGRESDB_USER, env.DB_POSTGRESDB_PASSWORD];
  await withDb('postgres', ...admin, async (db) => {
    const role = await db.query("SELECT 1 FROM pg_roles WHERE rolname = 'veille'");
    // Réappliqué à chaque démarrage : changer VEILLE_DB_PASSWORD dans .env suffit.
    await db.query(`${role.rowCount ? 'ALTER' : 'CREATE'} ROLE veille WITH LOGIN PASSWORD ${db.escapeLiteral(password)}`);
    const base = await db.query("SELECT 1 FROM pg_database WHERE datname = 'veille'");
    if (!base.rowCount) {
      await db.query("CREATE DATABASE veille OWNER veille ENCODING 'UTF8' TEMPLATE template0");
      log('Base « veille » créée');
    }
  });
  await withDb('veille', 'veille', password, (db) => db.query(fs.readFileSync(SCHEMA_FILE, 'utf8')));
  log('Base « veille » : schéma à jour');
}

// ── 2 · Identifiants ───────────────────────────────────────────────────────
function credentials() {
  const creds = [
    { id: 'VeilleCredPgDb01', name: 'Veille · Base PostgreSQL', type: 'postgres',
      data: { host: env.DB_POSTGRESDB_HOST, port: Number(env.DB_POSTGRESDB_PORT) || 5432, database: 'veille', user: 'veille',
              password: required('VEILLE_DB_PASSWORD'), ssl: 'disable', allowUnauthorizedCerts: false, sshTunnel: false } },
    { id: 'VeilleCredLlmKey', name: 'Veille · Clé API LLM', type: 'httpHeaderAuth',
      data: { name: 'Authorization', value: `Bearer ${(env.LLM_API_KEY || '').trim() || 'sans-cle'}` } },
    { id: 'VeilleCredUiAuth', name: 'Veille · Accès interface', type: 'httpBasicAuth',
      data: { user: required('VEILLE_UI_USER'), password: required('VEILLE_UI_PASSWORD') } },
    // Toujours créé (même vide) pour que les workflows restent valides ; utilisé seulement si l'e-mail est activé.
    { id: 'VeilleCredSmtp01', name: 'Veille · SMTP', type: 'smtp',
      data: { host: env.SMTP_HOST || 'localhost', port: Number(env.SMTP_PORT) || 587, user: env.SMTP_USER || '',
              password: env.SMTP_PASSWORD || '', secure: env.SMTP_SECURE === 'true' } },
  ];
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'veille-')), 'credentials.json');
  fs.writeFileSync(file, JSON.stringify(creds), { mode: 0o600 });
  try {
    n8n('import:credentials', `--input=${file}`); // crée aussi les tables de n8n au tout premier démarrage
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
  log(`Identifiants recopiés depuis .env : base, clé LLM${env.LLM_API_KEY ? '' : ' (vide)'}, accès interface, SMTP`);
}

// ── 3 · Workflows ──────────────────────────────────────────────────────────
async function workflows(db) {
  const files = fs.readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) fail('aucun workflow dans n8n/workflows/ : lancez « make build ».');
  const hash = crypto.createHash('sha256');
  const ids = files.map((f) => {
    const text = fs.readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8');
    hash.update(`${f}\0${text}\0`);
    return JSON.parse(text).id;
  });
  const digest = hash.digest('hex');

  const published = async () => (await db.query(
    `SELECT count(*)::int AS n FROM workflow_entity
     WHERE id = ANY($1) AND "activeVersionId" IS NOT NULL AND NOT "isArchived"`, [ids])).rows[0].n;
  const stored = (await db.query('SELECT value FROM settings WHERE key = $1', [HASH_KEY])).rows[0]?.value;
  const before = await published();
  if (stored === digest && before === ids.length) {
    log(`Workflows à jour (${ids.length} publiés)`);
    return;
  }

  log(stored === digest ? `${ids.length - before} workflow(s) absent(s) ou dépublié(s) : réimport…`
                        : 'Nouvelle version des workflows : import…');
  n8n('import:workflow', '--separate', `--input=${WORKFLOWS_DIR}`);
  for (const id of ids) n8n('publish:workflow', `--id=${id}`);
  const after = await published();
  if (after !== ids.length) fail(`${ids.length - after} workflow(s) non publié(s) après import.`);
  await db.query(
    `INSERT INTO settings (key, value, "loadOnStartup") VALUES ($1, $2, false)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [HASH_KEY, digest]);
  log(`${ids.length} workflows importés et publiés`);
}

(async () => {
  await veilleDatabase();
  credentials();
  await withDb(env.DB_POSTGRESDB_DATABASE, env.DB_POSTGRESDB_USER, env.DB_POSTGRESDB_PASSWORD, workflows);
})().catch((err) => fail(err.stack || String(err)));
