# Veille scientifique UPPA -> contenus FabLab — commandes courantes (`make help`)
SHELL := /bin/bash
COMPOSE := docker compose
STAMP := $(shell date +%Y%m%d-%H%M%S)

.DEFAULT_GOAL := help

help: ## Affiche cette aide
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: build ## Installation complète / mise à jour (idempotente) : .env, secrets, démarrage
	./scripts/bootstrap.sh

up: ## Démarre la stack ; après une modification de .env, la resynchronise (clé LLM, SMTP…)
	$(COMPOSE) up -d --wait --wait-timeout 300

down: ## Arrête la stack (les données sont conservées)
	$(COMPOSE) down

restart: ## Redémarre n8n (et refait son provisionnement)
	$(COMPOSE) restart n8n
	$(COMPOSE) up -d --wait --wait-timeout 300 n8n

ps: ## État des conteneurs
	$(COMPOSE) ps

logs: ## Journaux de n8n (Ctrl+C pour quitter)
	$(COMPOSE) logs -f --tail 100 n8n

build: ## Génère n8n/workflows/*.json depuis n8n/src/ (vérifie la syntaxe JS)
	python3 n8n/build.py

check: build ## Vérifie les délais, reprises, sorties IA et étapes sauvegardées (Node.js requis)
	node n8n/check.js

check-integration: check ## Teste toute la stack dans des volumes jetables, avec un faux LLM (Docker requis)
	python3 n8n/check-integration.py

workflows: build ## Régénère, réimporte et publie les workflows (écrase les modifs faites dans l'UI)
	@# Oublie l'empreinte mémorisée : le prochain démarrage réimporte même si rien n'a changé.
	$(COMPOSE) exec -T postgres psql -qU n8n -d n8n -c "DELETE FROM settings WHERE key = 'veille.workflowsHash'"
	$(COMPOSE) restart n8n
	$(COMPOSE) up -d --wait --wait-timeout 300 n8n
	@echo "Workflows réimportés et publiés"

run: ## Lance une veille maintenant (collecte + traitement IA)
	@set -a; . ./.env; set +a; \
	curl -fsS --noproxy '*' -o /dev/null -u "$$VEILLE_UI_USER:$$VEILLE_UI_PASSWORD" -X POST "http://127.0.0.1:$${N8N_PORT:-5678}/webhook/veille/lancer" \
	  && echo "Veille lancée : suivez-la dans l'interface ou avec « make logs »"

recap: ## Envoie maintenant l'e-mail récapitulatif (contenus à valider)
	@set -a; . ./.env; set +a; \
	curl -fsS --noproxy '*' -o /dev/null -u "$$VEILLE_UI_USER:$$VEILLE_UI_PASSWORD" -X POST "http://127.0.0.1:$${N8N_PORT:-5678}/webhook/veille/recap" \
	  && echo "Récapitulatif en cours d'envoi (en cas de souci : onglet « Erreurs » de l'interface)"

open: ## Ouvre l'interface de validation
	@set -a; . ./.env; set +a; open "$${N8N_PUBLIC_URL:-http://localhost:5678}/webhook/veille" 2>/dev/null \
	  || xdg-open "$${N8N_PUBLIC_URL:-http://localhost:5678}/webhook/veille"

status: ## Nombre de publications par statut, dernières erreurs, dernière sauvegarde
	@$(COMPOSE) exec -T postgres psql -U n8n -d veille -c \
	  "SELECT status, count(*) FROM publications GROUP BY 1 ORDER BY 1" -c \
	  "SELECT created_at::timestamp(0), workflow_name, left(message, 120) AS message FROM workflow_errors ORDER BY id DESC LIMIT 5"
	@echo "Dernière sauvegarde : $$(ls -t backups/veille-*.sql.gz 2>/dev/null | head -1 || true)"

export: ## Sauvegarde les workflows tels qu'ils sont dans n8n (backups/)
	@mkdir -p backups/workflows-$(STAMP)
	$(COMPOSE) exec -T n8n sh -c 'rm -rf /tmp/export && n8n export:workflow --all --separate --output=/tmp/export >/dev/null'
	$(COMPOSE) cp n8n:/tmp/export/. backups/workflows-$(STAMP)/
	@echo "Workflows exportés dans backups/workflows-$(STAMP)"

backup: ## Sauvegarde maintenant les bases, la config et les PDF (aussi faite chaque nuit) dans backups/
	$(COMPOSE) exec -T backup sh /opt/veille/backup/backup.sh now
	@echo "Sauvegarde dans backups/ (conservez aussi .env : il contient la clé de chiffrement n8n)"

.PHONY: help install up down restart ps logs build check check-integration workflows run recap open status export backup
