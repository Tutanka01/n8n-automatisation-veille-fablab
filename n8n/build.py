#!/usr/bin/env python3
"""Génère les workflows n8n (n8n/workflows/*.json) à partir du code des nœuds (n8n/src/).

Le code JavaScript des nœuds « Code » vit dans des fichiers .js lisibles ; les lignes
`//@include lib/xxx.js` y insèrent les bibliothèques partagées (prompts, validation JSON…).

    python3 n8n/build.py        (ou : make build)
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
OUT = ROOT / "workflows"
NS = uuid.UUID("5b0f6a3e-7c2d-4f7a-9d61-0fab1ab00001")

CONFIG_FILE = "/home/node/.n8n-files/config/veille.json"
OUTPUT_DIR = "/home/node/.n8n-files/output"

CRED = {
    "postgres": {"postgres": {"id": "VeilleCredPgDb01", "name": "Veille · Base PostgreSQL"}},
    "llm": {"httpHeaderAuth": {"id": "VeilleCredLlmKey", "name": "Veille · Clé API LLM"}},
    "ui": {"httpBasicAuth": {"id": "VeilleCredUiAuth", "name": "Veille · Accès interface"}},
    "smtp": {"smtp": {"id": "VeilleCredSmtp01", "name": "Veille · SMTP"}},
}

WF_ERREURS = ("VeilleErreurs001", "Veille · 0 · Alertes d'erreur")
WF_COLLECTE = ("VeilleCollecte01", "Veille · 1 · Collecte HAL + RSS")
WF_LOT = ("VeilleTraitemt01", "Veille · 2 · Traitement par lot")
WF_PUB = ("VeilleTraiterPub", "Veille · 3 · Traiter une publication")
WF_LLM = ("VeilleAppelLLM01", "Veille · 4 · Appel LLM (compatible OpenAI)")
WF_UI = ("VeilleInterface1", "Veille · 5 · Interface de validation")
WF_RECAP = ("VeilleRecapMail1", "Veille · 6 · E-mail récapitulatif")
WF_PLANNING = ("VeillePlanifie01", "Veille · 7 · Planificateur")


def code(path: str) -> str:
    text = (SRC / path).read_text(encoding="utf-8")
    return re.sub(
        r"^//@include (\S+)\s*$",
        lambda m: (SRC / m.group(1)).read_text(encoding="utf-8").strip() + "\n",
        text,
        flags=re.M,
    )


class Workflow:
    def __init__(self, ident, description, error_workflow=True):
        self.id, self.name = ident
        self.description = description
        self.nodes = []
        self.connections = {}
        self.settings = {
            "executionOrder": "v1",
            "timezone": "Europe/Paris",
            "callerPolicy": "workflowsFromSameOwner",
            "saveDataErrorExecution": "all",
            "saveDataSuccessExecution": "all",
            "saveManualExecutions": True,
            "saveExecutionProgress": False,
        }
        if error_workflow:
            self.settings["errorWorkflow"] = WF_ERREURS[0]

    def add(self, name, type_, version, params, pos, **extra):
        node = {
            "parameters": params,
            "id": str(uuid.uuid5(NS, f"{self.id}/{name}")),
            "name": name,
            "type": type_,
            "typeVersion": version,
            "position": list(pos),
        }
        node.update(extra)
        self.nodes.append(node)
        return name

    def link(self, src, dst, out=0):
        main = self.connections.setdefault(src, {"main": []})["main"]
        while len(main) <= out:
            main.append([])
        main[out].append({"node": dst, "type": "main", "index": 0})

    def chain(self, *names):
        for a, b in zip(names, names[1:]):
            self.link(a, b)

    def note(self, text, pos, width=440, height=260, color=7):
        self.add(f"Note {len(self.nodes)}", "n8n-nodes-base.stickyNote", 1,
                 {"content": text, "width": width, "height": height, "color": color}, pos)

    # ── Fabriques de nœuds ────────────────────────────────────────────────
    def code(self, name, path, pos, **extra):
        return self.add(name, "n8n-nodes-base.code", 2,
                        {"mode": "runOnceForAllItems", "jsCode": code(path)}, pos, **extra)

    def sql(self, name, query, params, pos, **extra):
        options = {"queryReplacement": params} if params else {}
        return self.add(name, "n8n-nodes-base.postgres", 2.6,
                        {"operation": "executeQuery", "query": query.strip(), "options": options},
                        pos, credentials=CRED["postgres"], **extra)

    def config(self, pos):
        x, y = pos
        self.add("Fichier de configuration", "n8n-nodes-base.readWriteFile", 1,
                 {"operation": "read", "fileSelector": CONFIG_FILE, "options": {}}, (x, y))
        self.add("Lire la configuration", "n8n-nodes-base.extractFromFile", 1,
                 {"operation": "fromJson", "destinationKey": "config", "options": {}}, (x + 220, y))
        self.link("Fichier de configuration", "Lire la configuration")
        return "Fichier de configuration", "Lire la configuration"

    def call(self, name, target, pos, wait=True, **extra):
        return self.add(name, "n8n-nodes-base.executeWorkflow", 1.3, {
            "workflowId": {"__rl": True, "value": target[0], "mode": "list", "cachedResultName": target[1]},
            "options": {"waitForSubWorkflow": wait},
        }, pos, **extra)

    def sub_trigger(self, name, pos):
        return self.add(name, "n8n-nodes-base.executeWorkflowTrigger", 1.1, {"inputSource": "passthrough"}, pos)

    def condition(self, name, expression, pos):
        return self.add(name, "n8n-nodes-base.if", 2.2, {
            "conditions": {
                "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
                "conditions": [{
                    "id": str(uuid.uuid5(NS, f"{self.id}/{name}/cond")),
                    "leftValue": expression,
                    "rightValue": "",
                    "operator": {"type": "boolean", "operation": "true", "singleValue": True},
                }],
                "combinator": "and",
            },
            "options": {},
        }, pos)

    def llm_http(self, name, pos):
        # Le nœud suivant décide quels échecs méritent un nouvel essai.
        return self.add(name, "n8n-nodes-base.httpRequest", 4.2, {
            "method": "POST",
            "url": "={{ $json.url }}",
            "authentication": "genericCredentialType",
            "genericAuthType": "httpHeaderAuth",
            "sendBody": True,
            "specifyBody": "json",
            "jsonBody": "={{ JSON.stringify($json.body) }}",
            "options": {
                "timeout": "={{ Math.max(1, $json.deadline - Date.now()) }}",
                "response": {"response": {"fullResponse": True, "neverError": True,
                                             "responseFormat": "text", "outputPropertyName": "body"}},
            },
        }, pos, credentials=CRED["llm"],
            onError="continueRegularOutput")

    def save(self):
        data = {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "active": False,
            "isArchived": False,
            "nodes": self.nodes,
            "connections": self.connections,
            "settings": self.settings,
            "pinData": {},
            "meta": {"templateCredsSetupCompleted": True},
            "tags": [],
        }
        OUT.mkdir(parents=True, exist_ok=True)
        path = OUT / f"{self.id}.json"
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return path


# ═════════════════════════════════════════════════════════════════════════════
# 0 · Alertes d'erreur
# ═════════════════════════════════════════════════════════════════════════════
def wf_erreurs():
    wf = Workflow(WF_ERREURS, "Journalise toute erreur d'un workflow de veille et alerte par e-mail si activé.",
                  error_workflow=False)
    wf.note("## Alertes d'erreur\nDéclenché automatiquement quand un workflow de veille échoue.\n"
            "Chaque erreur est enregistrée dans la table `workflow_errors`, puis envoyée par e-mail si "
            "`notifications.email.actif` vaut `true` dans `config/veille.json`.", (-40, -260), 520, 200)
    wf.add("Erreur détectée", "n8n-nodes-base.errorTrigger", 1, {}, (0, 0))
    wf.sql("Journaliser l'erreur", """
INSERT INTO workflow_errors (workflow_name, execution_id, execution_url, node, message, details)
VALUES ($1, $2, $3, $4, $5, $6::jsonb)
RETURNING id
""", "={{ [ $json.workflow?.name ?? null, $json.execution?.id ?? null, $json.execution?.url ?? null, "
         "$json.execution?.lastNodeExecuted ?? null, $json.execution?.error?.message ?? 'Erreur inconnue', JSON.stringify($json) ] }}",
           (220, 0))
    read, cfg = wf.config((440, 0))
    wf.condition("Alerte e-mail activée ?",
                 "={{ $json.config.notifications?.email?.actif === true }}", (880, 0))
    wf.add("Envoyer l'alerte", "n8n-nodes-base.emailSend", 2.1, {
        "fromEmail": "={{ $json.config.notifications.email.expediteur }}",
        "toEmail": "={{ [].concat($json.config.notifications.email.destinataires || []).join(', ') }}",
        "subject": "=Veille FabLab : échec de « {{ $('Erreur détectée').first().json.workflow.name }} »",
        "emailFormat": "text",
        "text": "=Le workflow « {{ $('Erreur détectée').first().json.workflow.name }} » a échoué.\n\n"
                "Nœud : {{ $('Erreur détectée').first().json.execution.lastNodeExecuted }}\n"
                "Erreur : {{ $('Erreur détectée').first().json.execution.error.message }}\n\n"
                "Exécution : {{ $('Erreur détectée').first().json.execution.url }}",
        "options": {"appendAttribution": False},
    }, (1100, -20), credentials=CRED["smtp"])
    wf.chain("Erreur détectée", "Journaliser l'erreur", read)
    wf.link(cfg, "Alerte e-mail activée ?")
    wf.link("Alerte e-mail activée ?", "Envoyer l'alerte", 0)
    return wf


# ═════════════════════════════════════════════════════════════════════════════
# 1 · Collecte
# ═════════════════════════════════════════════════════════════════════════════
def wf_collecte():
    wf = Workflow(WF_COLLECTE, "Collecte les publications HAL et les actualités RSS des laboratoires, "
                               "les déduplique en base puis lance le traitement IA.")
    wf.note("## 1 · Collecte\n**Quand ?** aux jours et à l'heure réglés dans l'interface (workflow 7 · Planificateur), "
            "via le bouton « Lancer la veille » de l'interface, ou à la main.\n\n**Sources** (réglages : `config/veille.json`)\n- API HAL : collections des laboratoires\n"
            "- Flux RSS des actualités des laboratoires\n\nLes doublons sont ignorés (clé : source + identifiant). "
            "Une source indisponible n'empêche pas les autres d'être collectées : l'incident est affiché dans l'interface.",
            (-60, -380), 560, 300)
    wf.add("Lancement manuel", "n8n-nodes-base.manualTrigger", 1, {}, (0, 60))
    wf.sub_trigger("Depuis l'interface ou le planificateur", (0, 240))
    read, cfg = wf.config((260, 60))
    wf.code("Préparer les sources", "collecte/preparer-sources.js", (700, 60))
    wf.condition("Sources actives ?", "={{ !$json.skip }}", (920, 60))
    wf.add("Télécharger les sources", "n8n-nodes-base.httpRequest", 4.2, {
        "url": "={{ $json.url }}",
        "options": {"timeout": 30000,
                    "response": {"response": {"fullResponse": True, "neverError": True,
                                                 "responseFormat": "text", "outputPropertyName": "body"}}},
    }, (1140, -40), onError="continueRegularOutput")
    wf.code("Collecter HAL + RSS", "collecte/collecter.js", (1360, 60))
    wf.sql("Enregistrer les nouveautés", """
WITH incoming AS (
  SELECT DISTINCT ON (source, external_id) *
  FROM jsonb_to_recordset($1::jsonb) AS r(
    source text, external_id text, kind text, labs text[], title text, authors text[], abstract text,
    keywords text[], doc_type text, venue text, doi text, url text, pdf_url text, language text,
    published_on date, deposited_at timestamptz, raw jsonb)
  WHERE external_id IS NOT NULL
),
saved AS (
  INSERT INTO publications AS p (source, external_id, kind, labs, title, authors, abstract, keywords,
    doc_type, venue, doi, url, pdf_url, language, published_on, deposited_at, raw)
  SELECT source, external_id, coalesce(kind, 'publication'), coalesce(labs, '{}'), title,
    coalesce(authors, '{}'), abstract, coalesce(keywords, '{}'), doc_type, venue, doi, url, pdf_url,
    language, published_on, deposited_at, raw
  FROM incoming
  ON CONFLICT (source, external_id) DO UPDATE
    SET labs = ARRAY(SELECT DISTINCT unnest(p.labs || EXCLUDED.labs))
    WHERE NOT (p.labs @> EXCLUDED.labs)
  RETURNING (xmax = 0) AS inserted
)
INSERT INTO collect_runs (found, inserted, warnings)
SELECT (SELECT count(*) FROM incoming), (SELECT count(*) FROM saved WHERE inserted), $2::jsonb
RETURNING id, found, inserted, warnings
""", "={{ [ JSON.stringify($json.rows), JSON.stringify($json.warnings) ] }}", (1580, 60))
    wf.call("Lancer le traitement IA", WF_LOT, (1800, 60), wait=False)
    for trigger in ("Lancement manuel", "Depuis l'interface ou le planificateur"):
        wf.link(trigger, read)
    wf.chain(cfg, "Préparer les sources", "Sources actives ?")
    wf.link("Sources actives ?", "Télécharger les sources", 0)
    wf.link("Sources actives ?", "Collecter HAL + RSS", 1)
    wf.chain("Télécharger les sources", "Collecter HAL + RSS", "Enregistrer les nouveautés", "Lancer le traitement IA")
    wf.note("## 1 · Sources\nConfiguration → requêtes HAL / RSS", (200, -100), 690, 380, 4)
    wf.note("## 2 · Télécharger et normaliser\n30 s maximum par source. Les incidents restent visibles.", (900, -200), 670, 480, 5)
    wf.note("## 3 · Enregistrer et traiter\nDédoublonnage en base, puis démarrage du lot IA.", (1570, -100), 450, 380, 6)
    return wf


# ═════════════════════════════════════════════════════════════════════════════
# 2 · Traitement par lot
# ═════════════════════════════════════════════════════════════════════════════
def wf_lot():
    wf = Workflow(WF_LOT, "Réserve un lot de publications à traiter et les passe une à une dans la chaîne IA, "
                          "en isolant les échecs ; déclenche l'e-mail récapitulatif en fin de lot.")
    wf.note("## 2 · Traitement par lot\nRéserve jusqu'à `traitement.taille_lot` publications (nouvelles, ou en "
            "erreur avec moins de `max_tentatives` essais) et les traite **une par une**.\n\n"
            "Un échec n'arrête pas le lot : la publication passe en « erreur » avec le message, et sera "
            "re-tentée au lot suivant. Une publication bloquée « en cours » depuis 2 h est libérée.\n\n"
            "Se lance après chaque collecte, et chaque jour à 8 h pour reprendre ce qui reste. "
            "En fin de lot : e-mail récapitulatif (workflow 6).",
            (-60, -420), 600, 320)
    wf.sub_trigger("Après la collecte", (0, -120))
    wf.add("Chaque jour à 8 h", "n8n-nodes-base.scheduleTrigger", 1.2, {
        "rule": {"interval": [{"field": "days", "daysInterval": 1, "triggerAtHour": 8, "triggerAtMinute": 0}]},
    }, (0, 60))
    wf.add("Lancement manuel", "n8n-nodes-base.manualTrigger", 1, {}, (0, 240))
    read, cfg = wf.config((260, 60))
    wf.code("Vérifier le LLM", "lot/verifier-llm.js", (700, 60))
    # Deux requêtes : une CTE de modification n'est pas visible au SELECT du même statement.
    wf.sql("Libérer les traitements interrompus", """
WITH liberees AS (
  UPDATE publications SET status = 'error', last_error = 'Traitement interrompu (délai dépassé)'
  WHERE status = 'processing' AND updated_at < now() - interval '2 hours'
  RETURNING id
)
SELECT count(*)::int AS liberees FROM liberees
""", None, (920, 60))
    wf.sql("Réserver un lot", """
WITH lot AS (
  SELECT id FROM publications
  WHERE status = 'new' OR (status = 'error' AND attempts < $1)
  ORDER BY (status = 'new') DESC, deposited_at DESC NULLS LAST, id DESC
  LIMIT $2
  FOR UPDATE SKIP LOCKED
)
UPDATE publications p
SET status = 'processing', attempts = p.attempts + 1, last_error = NULL,
    processing_step = CASE WHEN p.linkedin IS NOT NULL THEN 'pdf' WHEN p.fiche IS NOT NULL THEN 'contenus' ELSE 'tri' END
FROM lot WHERE p.id = lot.id
RETURNING p.id, p.title
""", "={{ [ Number($('Lire la configuration').first().json.config.traitement?.max_tentatives) || 3, "
         "Number($('Lire la configuration').first().json.config.traitement?.taille_lot) || 10 ] }}",
           (1140, 60), alwaysOutputData=True)
    wf.condition("Quelque chose à traiter ?", "={{ !!$json.id }}", (1140, 240))
    wf.code("Préparer les éléments", "lot/preparer-elements.js", (1360, 0))
    wf.add("Une par une", "n8n-nodes-base.splitInBatches", 3, {"batchSize": 1, "options": {}}, (1580, 0))
    wf.call("Traiter la publication", WF_PUB, (1840, 120), onError="continueErrorOutput")
    wf.sql("Marquer en échec", """
UPDATE publications SET status = 'error', last_error = left($2, 2000)
WHERE id = $1 RETURNING id, status
""", "={{ [ $('Une par une').item.json.id, $json.error || 'Erreur inconnue' ] }}", (2080, 240))
    wf.code("Préparer le récapitulatif", "lot/recap.js", (1840, -180))
    wf.call("Envoyer le récapitulatif", WF_RECAP, (2080, -180), wait=False)

    for trigger in ("Après la collecte", "Chaque jour à 8 h", "Lancement manuel"):
        wf.link(trigger, read)
    wf.chain(cfg, "Vérifier le LLM", "Libérer les traitements interrompus", "Réserver un lot", "Quelque chose à traiter ?")
    wf.link("Quelque chose à traiter ?", "Préparer les éléments", 0)
    wf.link("Quelque chose à traiter ?", "Préparer le récapitulatif", 1)   # lot vide
    wf.link("Préparer les éléments", "Une par une")
    wf.link("Une par une", "Préparer le récapitulatif", 0)  # sortie « terminé »
    wf.link("Une par une", "Traiter la publication", 1)     # sortie « boucle »
    wf.link("Traiter la publication", "Une par une", 0)
    wf.link("Traiter la publication", "Marquer en échec", 1)
    wf.link("Marquer en échec", "Une par une")
    wf.link("Préparer le récapitulatif", "Envoyer le récapitulatif")
    wf.note("## 1 · Libérer puis réserver\nLes lots simultanés prennent des publications distinctes.", (200, -70), 1090, 460, 4)
    wf.note("## 2 · Traiter\nSuccès et échec reviennent tous les deux à la boucle.", (1320, -70), 1030, 460, 5)
    wf.note("## 3 · Terminer le lot\nLe récapitulatif se lance après la dernière publication.", (1760, -320), 580, 240, 6)
    return wf


# ═════════════════════════════════════════════════════════════════════════════
# 3 · Traiter une publication
# ═════════════════════════════════════════════════════════════════════════════
def wf_publication():
    wf = Workflow(WF_PUB, "Chaîne IA pour une publication : tri, fiche de valorisation, post LinkedIn, "
                          "carrousel PDF et article d'e-mail.", error_workflow=False)
    wf.settings["executionTimeout"] = 600
    wf.note("## 3 · Une publication, quatre étapes\nLire de gauche à droite, puis descendre : "
            "**tri → fiche → contenus → PDF**.\nLes étapes réussies sont sauvegardées : une reprise les réutilise. "
            "« Régénérer » les efface. Timeout du workflow : 10 minutes ; appels réseau également bornés.", (-60, -320), 900, 200)
    wf.sub_trigger("Entrée", (0, 0))
    wf.sql("Charger la publication", "SELECT * FROM publications WHERE id = $1",
           "={{ [ $json.id ] }}", (220, 0), alwaysOutputData=True)
    wf.condition("Fiche déjà disponible ?", "={{ !!$json.fiche?.apport_recherche }}", (440, 0))
    wf.code("Préparer le tri", "publication/preparer-tri.js", (440, 0))
    wf.call("LLM · Tri", WF_LLM, (660, 0))
    wf.code("Appliquer le tri", "publication/appliquer-tri.js", (880, 0))
    wf.sql("Enregistrer le tri", """
UPDATE publications SET
  score = $2,
  sectors = ARRAY(SELECT jsonb_array_elements_text($3::jsonb)),
  triage = $4::jsonb,
  llm_usage = llm_usage || $5::jsonb,
  status = CASE WHEN $6::boolean THEN status ELSE 'triaged_out' END,
  processing_step = CASE WHEN $6::boolean THEN 'fiche' ELSE NULL END,
  processed_at = CASE WHEN $6::boolean THEN processed_at ELSE now() END
WHERE id = $1
RETURNING id, status, score
""", "={{ [ $json.id, $json.score, JSON.stringify($json.secteurs), JSON.stringify($json.triage), JSON.stringify($json.usage), $json.retenue ] }}", (1100, 0))
    wf.condition("Pertinente ?", "={{ $('Appliquer le tri').first().json.retenue }}", (1320, 0))
    # Sans nœud sur la branche « non », le sous-workflow ne renvoie aucun élément et la boucle du lot s'arrête.
    wf.add("Écartée", "n8n-nodes-base.noOp", 1, {}, (1560, 160))
    wf.code("Préparer la fiche", "publication/preparer-fiche.js", (1560, -120))
    wf.call("LLM · Fiche", WF_LLM, (1780, -120))
    wf.sql("Sauvegarder la fiche", """
UPDATE publications SET fiche = $2::jsonb, processing_step = 'contenus',
  llm_usage = llm_usage || jsonb_build_object('fiche', $3::jsonb || jsonb_build_object('modele', $4::text, 'corrige', $5::boolean))
WHERE id = $1 RETURNING id
""", "={{ [ $('Charger la publication').first().json.id, JSON.stringify($json.data), "
         "JSON.stringify($json.usage), $json.model, $json.corrige ] }}", (660, 400))
    wf.condition("Contenus déjà disponibles ?",
                 "={{ !!$('Charger la publication').first().json.linkedin?.post "
                 "&& !!$('Charger la publication').first().json.carousel?.slides?.length "
                 "&& !!$('Charger la publication').first().json.email?.paragraphe }}", (220, 800))
    wf.code("Préparer les contenus", "publication/preparer-contenus.js", (2000, -120))
    wf.call("LLM · Contenus", WF_LLM, (2220, -120))
    wf.sql("Sauvegarder les textes", """
UPDATE publications SET linkedin = $2::jsonb, carousel = $3::jsonb, email = $4::jsonb,
  processing_step = 'pdf',
  llm_usage = llm_usage || jsonb_build_object('contenus', $5::jsonb || jsonb_build_object('modele', $6::text, 'corrige', $7::boolean))
WHERE id = $1 RETURNING id
""", "={{ [ $('Charger la publication').first().json.id, JSON.stringify($json.data.linkedin), "
         "JSON.stringify($json.data.carrousel), JSON.stringify($json.data.email), "
         "JSON.stringify($json.usage), $json.model, $json.corrige ] }}", (880, 800))
    wf.code("Composer le carrousel", "publication/composer-carrousel.js", (2440, -120))
    wf.add("Générer le PDF", "n8n-nodes-base.httpRequest", 4.2, {
        "method": "POST",
        "url": "http://gotenberg:3000/forms/chromium/convert/html",
        "sendBody": True,
        "contentType": "multipart-form-data",
        "bodyParameters": {"parameters": [
            {"parameterType": "formBinaryData", "name": "files", "inputDataFieldName": "html"},
            {"name": "preferCssPageSize", "value": "true"},
            {"name": "printBackground", "value": "true"},
            {"name": "marginTop", "value": "0"},
            {"name": "marginBottom", "value": "0"},
            {"name": "marginLeft", "value": "0"},
            {"name": "marginRight", "value": "0"},
        ]},
        "options": {"timeout": 120000, "response": {"response": {"responseFormat": "file", "outputPropertyName": "pdf"}}},
    }, (2660, -120), retryOnFail=True, maxTries=2, waitBetweenTries=3000)
    wf.add("Enregistrer le PDF", "n8n-nodes-base.readWriteFile", 1, {
        "operation": "write",
        "fileName": f"={OUTPUT_DIR}/{{{{ $('Composer le carrousel').first().json.fileName }}}}",
        "dataPropertyName": "pdf",
        "options": {},
    }, (2880, -120))
    wf.code("Assembler les contenus", "publication/finaliser.js", (3100, -120))
    wf.sql("Enregistrer les contenus", """
UPDATE publications SET
  fiche = $2::jsonb, linkedin = $3::jsonb, carousel = $4::jsonb, email = $5::jsonb, pdf_file = $6,
  llm_usage = llm_usage || $7::jsonb,
  status = 'to_review', processed_at = now(), last_error = NULL, processing_step = NULL
WHERE id = $1
RETURNING id, status, score
""", "={{ [ $json.id, JSON.stringify($json.fiche), JSON.stringify($json.linkedin), JSON.stringify($json.carousel), JSON.stringify($json.email), $json.pdf_file, JSON.stringify($json.usage) ] }}",
           (3320, -120))

    wf.chain("Entrée", "Charger la publication", "Fiche déjà disponible ?")
    wf.link("Fiche déjà disponible ?", "Contenus déjà disponibles ?", 0)
    wf.link("Fiche déjà disponible ?", "Préparer le tri", 1)
    wf.chain("Préparer le tri", "LLM · Tri", "Appliquer le tri",
             "Enregistrer le tri", "Pertinente ?")
    wf.link("Pertinente ?", "Préparer la fiche", 0)
    wf.link("Pertinente ?", "Écartée", 1)
    wf.chain("Préparer la fiche", "LLM · Fiche", "Sauvegarder la fiche", "Contenus déjà disponibles ?")
    wf.link("Contenus déjà disponibles ?", "Composer le carrousel", 0)
    wf.link("Contenus déjà disponibles ?", "Préparer les contenus", 1)
    wf.chain("Préparer les contenus", "LLM · Contenus", "Sauvegarder les textes", "Composer le carrousel",
             "Générer le PDF", "Enregistrer le PDF", "Assembler les contenus", "Enregistrer les contenus")
    positions = {
        "Entrée": (0, 0), "Charger la publication": (220, 0), "Fiche déjà disponible ?": (440, 0),
        "Préparer le tri": (660, 0), "LLM · Tri": (880, 0), "Appliquer le tri": (1100, 0),
        "Enregistrer le tri": (1320, 0), "Pertinente ?": (1540, 0), "Écartée": (1760, 100),
        "Préparer la fiche": (220, 400), "LLM · Fiche": (440, 400), "Sauvegarder la fiche": (660, 400),
        "Contenus déjà disponibles ?": (220, 800), "Préparer les contenus": (440, 800),
        "LLM · Contenus": (660, 800), "Sauvegarder les textes": (880, 800),
        "Composer le carrousel": (220, 1200), "Générer le PDF": (440, 1200),
        "Enregistrer le PDF": (660, 1200), "Assembler les contenus": (880, 1200),
        "Enregistrer les contenus": (1100, 1200),
    }
    for node in wf.nodes:
        if node["name"] in positions:
            node["position"] = list(positions[node["name"]])
    wf.note("## 1 · Trier\nLa branche « non » termine proprement cette publication.", (-60, -130), 2040, 400, 4)
    wf.note("## 2 · Fiche de référence\nSauvegardée avant de rédiger les contenus.", (160, 280), 1100, 290, 5)
    wf.note("## 3 · Rédiger les textes\nLinkedIn, diapositives, e-mail. Sauvegarde avant le PDF.", (160, 680), 1100, 290, 6)
    wf.note("## 4 · Produire le PDF et terminer\nLa publication passe ensuite en « À valider ».", (160, 1080), 1200, 290, 3)
    return wf


# ═════════════════════════════════════════════════════════════════════════════
# 4 · Appel LLM (compatible OpenAI)
# ═════════════════════════════════════════════════════════════════════════════
def wf_llm():
    wf = Workflow(WF_LLM, "Appelle n'importe quelle API compatible OpenAI (/chat/completions) et renvoie un "
                          "objet JSON validé contre un schéma ; une tentative de correction automatique.",
                  error_workflow=False)
    wf.note("## 4 · Appel LLM (toute API compatible OpenAI)\n"
            "OpenAI, Mistral, Groq, OpenRouter, DeepSeek, Ollama, LM Studio, vLLM… : `llm.base_url` + `llm.modele` "
            "dans `config/veille.json`, clé `LLM_API_KEY` dans `.env`.\n\n"
            "- `format_json` : `json_schema` (sortie garantie), `json_object` ou `aucun` (consigne seule).\n"
            "- Réponse validée contre le schéma ; si invalide, **une** correction est demandée au modèle.\n"
            "- Si le fournisseur refuse `response_format` (HTTP 400/422), la requête est rejouée avec un format dégradé.\n"
            "- Réseau / 429 / 5xx : au plus 3 essais, avec attente. 401/403 : arrêt immédiat.\n"
            "- Tous les essais partagent `delai_max_secondes` (tri : `delai_rapide_secondes`).",
            (-60, -400), 700, 300)
    wf.sub_trigger("Entrée", (0, 0))
    wf.code("Préparer la requête", "llm/preparer.js", (220, 0))
    wf.add("Requête en cours", "n8n-nodes-base.noOp", 1, {}, (440, 0))
    wf.llm_http("Appeler le LLM", (660, 0))
    wf.code("Lire la réponse", "llm/lire-reponse.js", (880, 0))
    wf.condition("Réponse exploitable ?", "={{ $json.ok }}", (1100, 0))
    wf.add("Attendre avant reprise", "n8n-nodes-base.wait", 1.1,
           {"resume": "timeInterval", "amount": "={{ $json.wait_seconds }}", "unit": "seconds"}, (1100, 260))
    wf.add("Résultat", "n8n-nodes-base.noOp", 1, {}, (1340, -100))
    wf.chain("Entrée", "Préparer la requête", "Requête en cours", "Appeler le LLM", "Lire la réponse", "Réponse exploitable ?")
    wf.link("Réponse exploitable ?", "Résultat", 0)
    wf.link("Réponse exploitable ?", "Attendre avant reprise", 1)
    wf.link("Attendre avant reprise", "Requête en cours")
    wf.note("## Appel et validation\nLa réponse doit respecter le schéma de la tâche.", (390, -150), 1000, 350, 4)
    wf.note("## Reprise limitée\nErreur temporaire : attendre. Format refusé : dégrader. JSON invalide : corriger une fois.", (850, 150), 530, 300, 3)
    return wf


# ═════════════════════════════════════════════════════════════════════════════
# 5 · Interface de validation
# ═════════════════════════════════════════════════════════════════════════════
def wf_interface():
    wf = Workflow(WF_UI, "Interface web de validation des contenus générés (webhook protégé par mot de passe).")
    wf.note("## 5 · Interface de validation\n**http://localhost:5678/webhook/veille** (identifiants : `.env`)\n\n"
            "- Relire, copier le post LinkedIn et l'article d'e-mail, ouvrir le carrousel PDF\n"
            "- Valider / refuser / marquer publié / régénérer\n"
            "- Écartées : « Traiter quand même » ; Erreurs : « Relancer »\n"
            "- Boutons « Lancer la veille maintenant » et « Envoyer le récapitulatif par e-mail »\n"
            "- « Collecte automatique » : jours, heure et activation de la collecte planifiée",
            (-60, -420), 560, 280)
    hook = {"authentication": "basicAuth", "responseMode": "responseNode", "options": {}}
    html_headers = {"entries": [
        {"name": "Content-Type", "value": "text/html; charset=utf-8"},
        {"name": "Cache-Control", "value": "no-store"},
    ]}

    def redirect(name, location, pos):
        return wf.add(name, "n8n-nodes-base.respondToWebhook", 1.1, {
            "respondWith": "noData",
            "options": {"responseCode": 303, "responseHeaders": {"entries": [{"name": "Location", "value": location}]}},
        }, pos)

    # Page principale
    wf.add("Tableau de bord", "n8n-nodes-base.webhook", 2, {"httpMethod": "GET", "path": "veille", **hook},
           (0, 0), webhookId="3f5d2d0e-1c4b-4c55-9d3e-7a1f0b7e0001", credentials=CRED["ui"])
    read, cfg = wf.config((220, 0))
    wf.sql("Charger les publications", """
SELECT
  $1::text AS statut,
  (SELECT coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
     FROM (SELECT status, count(*)::int AS n FROM publications GROUP BY status) c) AS counts,
  (SELECT coalesce(jsonb_agg(to_jsonb(p) - 'raw' - 'abstract' ORDER BY p.sort_at DESC), '[]'::jsonb)
     FROM (SELECT *, coalesce(processed_at, deposited_at, created_at) AS sort_at
           FROM publications
           WHERE status = ANY (CASE WHEN $1 = 'new' THEN ARRAY['new', 'processing'] ELSE ARRAY[$1::text] END)
           ORDER BY sort_at DESC
           LIMIT 150) p) AS items,
  (SELECT to_jsonb(r) FROM collect_runs r ORDER BY id DESC LIMIT 1) AS last_run,
  (SELECT jsonb_build_object(
      'actif', s.enabled, 'jours', s.days, 'heure', to_char(s.at_time, 'HH24:MI'), 'fuseau', z.name,
      'prochain', (SELECT to_char(g.d, 'YYYY-MM-DD')
                   FROM generate_series(date_trunc('day', now() AT TIME ZONE z.name),
                                        date_trunc('day', now() AT TIME ZONE z.name) + interval '7 days',
                                        interval '1 day') AS g(d)
                   WHERE extract(isodow FROM g.d)::int = ANY (s.days) AND g.d + s.at_time > now() AT TIME ZONE z.name
                   ORDER BY g.d LIMIT 1))
     FROM schedule s,
          (SELECT coalesce((SELECT value FROM instance_settings WHERE key = 'timezone'), 'Europe/Paris') AS name) z
     WHERE s.id = 1) AS planning,
  (SELECT coalesce(jsonb_agg(e ORDER BY e.created_at DESC), '[]'::jsonb)
     FROM (SELECT id, created_at, workflow_name, node, message, execution_url FROM workflow_errors
           WHERE created_at > now() - interval '14 days' ORDER BY created_at DESC LIMIT 10) e) AS wf_errors
""", "={{ [ ['to_review','approved','published','new','triaged_out','rejected','error']"
         ".includes($('Tableau de bord').first().json.query.statut) ? $('Tableau de bord').first().json.query.statut : 'to_review' ] }}",
           (660, 0))
    wf.code("Page de validation", "interface/page.js", (880, 0))
    wf.add("Afficher la page", "n8n-nodes-base.respondToWebhook", 1.1, {
        "respondWith": "text", "responseBody": "={{ $json.html }}",
        "options": {"responseCode": 200, "responseHeaders": html_headers},
    }, (1100, 0))
    wf.chain("Tableau de bord", read)
    wf.chain(cfg, "Charger les publications", "Page de validation", "Afficher la page")

    # Actions (formulaires)
    wf.add("Action", "n8n-nodes-base.webhook", 2, {"httpMethod": "POST", "path": "veille/action", **hook},
           (0, 300), webhookId="3f5d2d0e-1c4b-4c55-9d3e-7a1f0b7e0002", credentials=CRED["ui"])
    wf.code("Vérifier la demande", "interface/verifier-action.js", (220, 300))
    wf.sql("Appliquer l'action", """
UPDATE publications SET
  status = $3,
  review_note = NULLIF($4, ''),
  reviewed_at = CASE WHEN $3 IN ('approved', 'rejected') THEN now() ELSE reviewed_at END,
  published_at = CASE WHEN $3 = 'published' THEN now() ELSE published_at END,
  attempts = CASE WHEN $5::boolean THEN 0 ELSE attempts END,
  last_error = CASE WHEN $5::boolean THEN NULL ELSE last_error END,
  forced = forced OR $6::boolean,
  review_token = CASE WHEN $5::boolean THEN gen_random_uuid() ELSE review_token END,
  fiche = CASE WHEN $8::boolean THEN NULL ELSE fiche END,
  linkedin = CASE WHEN $8::boolean THEN NULL ELSE linkedin END,
  carousel = CASE WHEN $8::boolean THEN NULL ELSE carousel END,
  email = CASE WHEN $8::boolean THEN NULL ELSE email END,
  pdf_file = CASE WHEN $8::boolean THEN NULL ELSE pdf_file END,
  triage = CASE WHEN $8::boolean THEN NULL ELSE triage END,
  score = CASE WHEN $8::boolean THEN NULL ELSE score END,
  sectors = CASE WHEN $8::boolean THEN '{}'::text[] ELSE sectors END,
  llm_usage = CASE WHEN $8::boolean THEN '{}'::jsonb ELSE llm_usage END,
  processing_step = CASE WHEN $5::boolean THEN NULL ELSE processing_step END
WHERE id = $1 AND review_token = $2::uuid AND status = ANY($7::text[])
RETURNING id, status
""", "={{ [ $json.id, $json.token, $json.status, $json.note, $json.reset, $json.force, $json.from, $json.regenerate ] }}",
           (440, 300), alwaysOutputData=True)
    redirect("Revenir à la liste",
             "=/webhook/veille?statut={{ $('Vérifier la demande').first().json.retour }}&msg={{ $json.id ? 'ok' : 'echec' }}",
             (660, 300))
    wf.chain("Action", "Vérifier la demande", "Appliquer l'action", "Revenir à la liste")

    # Lancer la veille
    wf.add("Lancer la veille", "n8n-nodes-base.webhook", 2, {"httpMethod": "POST", "path": "veille/lancer", **hook},
           (0, 520), webhookId="3f5d2d0e-1c4b-4c55-9d3e-7a1f0b7e0003", credentials=CRED["ui"])
    wf.code("Vérifier la provenance", "interface/verifier-provenance.js", (220, 520))
    wf.call("Démarrer la collecte", WF_COLLECTE, (440, 520), wait=False)
    redirect("Confirmer le lancement", "=/webhook/veille?statut=to_review&msg=lancee", (660, 520))
    wf.chain("Lancer la veille", "Vérifier la provenance", "Démarrer la collecte", "Confirmer le lancement")

    # Enregistrer la planification de la collecte
    wf.add("Planification", "n8n-nodes-base.webhook", 2, {"httpMethod": "POST", "path": "veille/planification", **hook},
           (0, 1240), webhookId="3f5d2d0e-1c4b-4c55-9d3e-7a1f0b7e0006", credentials=CRED["ui"])
    wf.code("Vérifier la planification", "interface/verifier-planification.js", (220, 1240))
    # Une demande invalide ne met rien à jour : sans id renvoyé, la redirection annonce l'échec.
    wf.sql("Enregistrer la planification", """
WITH local AS (
  SELECT now() AT TIME ZONE coalesce((SELECT value FROM instance_settings WHERE key = 'timezone'), 'Europe/Paris') AS t
)
UPDATE schedule s SET
  enabled = $1::boolean,
  days = $2::int[],
  at_time = $3::time,
  -- Un créneau déjà passé aujourd'hui n'est pas rattrapé : on n'enregistre pas une collecte immédiate par surprise.
  last_fired_on = CASE WHEN local.t::time >= $3::time THEN local.t::date ELSE NULL END,
  updated_at = now()
FROM local
WHERE s.id = 1 AND $4::boolean
RETURNING s.id
""", "={{ [ $json.actif, $json.jours, $json.heure, $json.valide ] }}", (440, 1240), alwaysOutputData=True)
    redirect("Revenir à la page",
             "=/webhook/veille?statut={{ $('Vérifier la planification').first().json.retour }}"
             "&msg={{ $json.id ? 'planning_ok' : 'planning_invalide' }}#planification",
             (660, 1240))
    wf.chain("Planification", "Vérifier la planification", "Enregistrer la planification", "Revenir à la page")

    # Envoyer le récapitulatif par e-mail
    wf.add("Envoyer le récap", "n8n-nodes-base.webhook", 2, {"httpMethod": "POST", "path": "veille/recap", **hook},
           (0, 960), webhookId="3f5d2d0e-1c4b-4c55-9d3e-7a1f0b7e0005", credentials=CRED["ui"])
    wf.code("Vérifier la provenance du récap", "interface/verifier-provenance.js", (220, 960))
    wf.add("Demande manuelle", "n8n-nodes-base.set", 3.4, {
        "mode": "raw", "jsonOutput": '={ "mode": "manuel" }', "options": {},
    }, (440, 960))
    wf.call("Envoyer le récapitulatif", WF_RECAP, (660, 960), wait=False)
    redirect("Confirmer l'envoi", "=/webhook/veille?statut=to_review&msg=recap", (880, 960))
    wf.chain("Envoyer le récap", "Vérifier la provenance du récap", "Demande manuelle", "Envoyer le récapitulatif",
             "Confirmer l'envoi")

    # PDF du carrousel
    wf.add("Carrousel PDF", "n8n-nodes-base.webhook", 2, {"httpMethod": "GET", "path": "veille/pdf", **hook},
           (0, 740), webhookId="3f5d2d0e-1c4b-4c55-9d3e-7a1f0b7e0004", credentials=CRED["ui"])
    wf.sql("Trouver le PDF", "SELECT id, pdf_file FROM publications WHERE id = $1 AND pdf_file IS NOT NULL",
           "={{ [ /^\\d{1,12}$/.test($json.query.id ?? '') ? Number($json.query.id) : 0 ] }}",
           (220, 740), alwaysOutputData=True)
    wf.condition("PDF disponible ?", "={{ !!$json.pdf_file }}", (440, 740))
    wf.add("Lire le PDF", "n8n-nodes-base.readWriteFile", 1, {
        "operation": "read", "fileSelector": f"={OUTPUT_DIR}/{{{{ $json.pdf_file }}}}", "options": {},
    }, (660, 680))
    wf.add("Envoyer le PDF", "n8n-nodes-base.respondToWebhook", 1.1, {
        "respondWith": "binary", "responseDataSource": "automatically",
        "options": {"responseHeaders": {"entries": [
            {"name": "Content-Type", "value": "application/pdf"},
            {"name": "Content-Disposition", "value": "=inline; filename=\"{{ $('Trouver le PDF').first().json.pdf_file }}\""},
        ]}},
    }, (880, 680))
    wf.add("PDF introuvable", "n8n-nodes-base.respondToWebhook", 1.1, {
        "respondWith": "text", "responseBody": "PDF introuvable (contenu régénéré ou supprimé).",
        "options": {"responseCode": 404, "responseHeaders": {"entries": [{"name": "Content-Type", "value": "text/plain; charset=utf-8"}]}},
    }, (660, 840))
    wf.chain("Carrousel PDF", "Trouver le PDF", "PDF disponible ?")
    wf.link("PDF disponible ?", "Lire le PDF", 0)
    wf.link("PDF disponible ?", "PDF introuvable", 1)
    wf.link("Lire le PDF", "Envoyer le PDF")
    for title, y, height, color in (
        ("Afficher la page", -140, 340, 4), ("Valider ou remettre en file", 210, 270, 5),
        ("Lancer une collecte", 440, 200, 6), ("Ouvrir un PDF", 650, 290, 3),
        ("Demander un e-mail", 880, 280, 4), ("Régler la collecte automatique", 1180, 200, 5),
    ):
        wf.note(f"## {title}", (-60, y), 1380, height, color)
    return wf


# ═════════════════════════════════════════════════════════════════════════════
# 6 · E-mail récapitulatif
# ═════════════════════════════════════════════════════════════════════════════
def wf_recap():
    wf = Workflow(WF_RECAP, "Envoie à une liste de destinataires un e-mail complet : fiches, posts LinkedIn, "
                            "articles de prospection, carrousels PDF en pièces jointes, écartées et erreurs.")
    wf.note("## 6 · E-mail récapitulatif\n**Quand ?** en fin de lot (si `notifications.email.actif` = `true`), "
            "via le bouton « Envoyer le récapitulatif » de l'interface, ou à la main.\n\n"
            "**Contenu** : pour chaque contenu à valider → fiche de valorisation, post LinkedIn, article d'e-mail, "
            "diapositives + **PDF en pièce jointe** ; puis les publications écartées et les erreurs.\n\n"
            "**Réglages** : destinataires / expéditeur dans `config/veille.json` (section `notifications.email`), "
            "serveur SMTP dans `.env` puis `make up`.",
            (-60, -440), 640, 330)
    wf.sub_trigger("Entrée", (0, -60))
    wf.add("Lancement manuel", "n8n-nodes-base.manualTrigger", 1, {}, (0, 120))
    read, cfg = wf.config((220, 30))
    wf.code("Paramètres e-mail", "recap/parametres.js", (660, 30))
    wf.condition("Envoi activé ?", "={{ $json.envoyer }}", (880, 30))
    wf.sql("Rassembler les contenus", """
WITH cible AS (
  SELECT * FROM publications
  WHERE CASE WHEN $1::bigint[] IS NULL THEN status = 'to_review' ELSE id = ANY($1::bigint[]) END
)
SELECT
  (SELECT coalesce(jsonb_agg(to_jsonb(c) - 'raw' - 'abstract' ORDER BY c.score DESC NULLS LAST, c.id), '[]'::jsonb)
     FROM cible c WHERE c.status = 'to_review') AS a_valider,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'title', title, 'labs', labs, 'score', score,
       'raison', triage->>'raison', 'url', url) ORDER BY score DESC NULLS LAST), '[]'::jsonb)
     FROM cible WHERE status = 'triaged_out') AS ecartees,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'title', title, 'erreur', last_error, 'tentatives', attempts)), '[]'::jsonb)
     FROM cible WHERE status = 'error') AS erreurs,
  (SELECT to_jsonb(r) FROM collect_runs r ORDER BY id DESC LIMIT 1) AS derniere_collecte,
  (SELECT count(*)::int FROM publications WHERE status = 'approved') AS validees_en_attente,
  (SELECT value FROM instance_settings WHERE key = 'public_url') AS url_publique
""", "={{ [ $json.ids ] }}", (1100, 30))
    wf.condition("Quelque chose à envoyer ?",
                 "={{ $json.a_valider.length > 0 || $json.erreurs.length > 0 "
                 "|| !$('Paramètres e-mail').first().json.automatique || $('Paramètres e-mail').first().json.envoyer_si_vide }}",
                 (1320, 30))
    wf.code("Pièces jointes", "recap/pieces-jointes.js", (1540, 30))
    wf.condition("PDF à joindre ?", "={{ !!$json.path }}", (1760, 30))
    wf.add("Lire les PDF", "n8n-nodes-base.readWriteFile", 1,
           {"operation": "read", "fileSelector": "={{ $json.path }}", "options": {}}, (1980, -60),
           onError="continueRegularOutput")
    wf.code("Rédiger le récapitulatif", "recap/rediger.js", (2200, 30))
    wf.add("Envoyer l'e-mail", "n8n-nodes-base.emailSend", 2.1, {
        "fromEmail": "={{ $json.from }}",
        "toEmail": "={{ $json.to }}",
        "subject": "={{ $json.subject }}",
        "emailFormat": "both",
        "text": "={{ $json.text }}",
        "html": "={{ $json.html }}",
        "options": {"attachments": "={{ $json.attachments }}", "appendAttribution": False},
    }, (2420, 30), credentials=CRED["smtp"], retryOnFail=True, maxTries=3, waitBetweenTries=5000)

    wf.link("Entrée", read)
    wf.link("Lancement manuel", read)
    wf.chain(cfg, "Paramètres e-mail", "Envoi activé ?")
    wf.link("Envoi activé ?", "Rassembler les contenus", 0)
    wf.chain("Rassembler les contenus", "Quelque chose à envoyer ?")
    wf.link("Quelque chose à envoyer ?", "Pièces jointes", 0)
    wf.link("Pièces jointes", "PDF à joindre ?")
    wf.link("PDF à joindre ?", "Lire les PDF", 0)
    wf.link("PDF à joindre ?", "Rédiger le récapitulatif", 1)
    wf.link("Lire les PDF", "Rédiger le récapitulatif")
    wf.link("Rédiger le récapitulatif", "Envoyer l'e-mail")
    return wf


# ═════════════════════════════════════════════════════════════════════════════
# 7 · Planificateur
# ═════════════════════════════════════════════════════════════════════════════
def wf_planning():
    # Sans workflow d'erreur : s'il se déclenchait chaque minute (base arrêtée…), il inonderait les e-mails d'alerte.
    wf = Workflow(WF_PLANNING, "Lance la collecte aux jours et à l'heure enregistrés dans l'interface (table schedule).",
                  error_workflow=False)
    wf.settings["saveDataSuccessExecution"] = "none"  # une exécution par minute : on ne garde que les échecs
    wf.note("## 7 · Planificateur\nLe déclencheur de n8n ne peut pas lire l'heure choisie dans l'interface : ce workflow "
            "se réveille **chaque minute**, lit la table `schedule` et lance la collecte quand le jour et l'heure sont "
            "atteints, au plus **une fois par jour** (`last_fired_on`).\n\n"
            "Jours, heure et activation se règlent dans l'interface (« Collecte automatique »). Les heures sont dans le "
            "fuseau `TZ` de `.env`. Si n8n était arrêté à l'heure prévue, la collecte part dès son retour, le même jour.",
            (-60, -300), 620, 250)
    wf.add("Chaque minute", "n8n-nodes-base.scheduleTrigger", 1.2, {
        "rule": {"interval": [{"field": "minutes", "minutesInterval": 1}]},
    }, (0, 0))
    # La mise à jour est le verrou : elle ne touche une ligne que si le jour et l'heure sont atteints et pas encore
    # lancés aujourd'hui. Sans ligne, le nœud Postgres renvoie quand même {success: true} : on teste donc l'id.
    wf.sql("Réserver l'échéance", """
WITH local AS (
  SELECT now() AT TIME ZONE coalesce((SELECT value FROM instance_settings WHERE key = 'timezone'), 'Europe/Paris') AS t
)
UPDATE schedule s SET last_fired_on = local.t::date
FROM local
WHERE s.enabled
  AND extract(isodow FROM local.t)::int = ANY (s.days)
  AND local.t::time >= s.at_time
  AND s.last_fired_on IS DISTINCT FROM local.t::date
RETURNING s.id
""", None, (220, 0))
    wf.condition("Échéance réservée ?", "={{ !!$json.id }}", (440, 0))
    wf.call("Lancer la collecte", WF_COLLECTE, (660, 0), wait=False)
    wf.chain("Chaque minute", "Réserver l'échéance", "Échéance réservée ?")
    wf.link("Échéance réservée ?", "Lancer la collecte", 0)
    return wf


def check_syntax(workflows):
    """Vérifie la syntaxe JavaScript de chaque nœud Code (si Node.js est installé)."""
    if not shutil.which("node"):
        print("ℹ Node.js absent : vérification de syntaxe des nœuds Code ignorée")
        return True
    ok = True
    for wf in workflows:
        for node in wf.nodes:
            if node["type"] != "n8n-nodes-base.code":
                continue
            src = "(async function () {\n" + node["parameters"]["jsCode"] + "\n});\n"
            with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as tmp:
                tmp.write(src)
            result = subprocess.run(["node", "--check", tmp.name], capture_output=True, text=True)
            os.unlink(tmp.name)
            if result.returncode != 0:
                ok = False
                print(f"✖ {wf.name} › {node['name']}\n{result.stderr.strip()}", file=sys.stderr)
    return ok


if __name__ == "__main__":
    built = [build() for build in (wf_erreurs, wf_collecte, wf_lot, wf_publication, wf_llm, wf_interface, wf_recap, wf_planning)]
    if not check_syntax(built):
        sys.exit(1)
    for wf in built:
        print("✔", wf.save().relative_to(ROOT.parent))
