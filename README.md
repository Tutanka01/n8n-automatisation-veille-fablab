# Veille scientifique UPPA → contenus FabLab

Chaîne automatisée, auto-hébergée sur **n8n**, qui :

1. **surveille** les publications des chercheurs (API HAL : collections LaTEP, LIUPPA…) et les actualités des laboratoires (flux RSS) ;
2. **trie** chaque nouveauté avec un LLM : est-ce utile pour les TPE/PME, l'agroalimentaire, les collectivités du territoire ? (score 0–10) ;
3. **rédige** une fiche de valorisation fidèle à la recherche (problème terrain, apport, projet FabLab possible, points de vigilance) ;
4. **génère** à partir de cette fiche : un **post LinkedIn**, un **carrousel PDF** (1080×1350) et un **article pour e-mail de prospection** ;
5. **soumet le tout à validation humaine** dans une interface web, et envoie un **e-mail récapitulatif** complet (PDF joints) à une liste de destinataires.

Le LLM est **au choix** : toute API compatible OpenAI (OpenAI, Mistral, OpenRouter, Groq, DeepSeek, Ollama, LM Studio, vLLM…).

```
 HAL (API) ─┐                                   ┌─ Post LinkedIn
            ├─► Collecte ─► Tri IA ─► Fiche IA ─┼─ Carrousel PDF (Gotenberg)
 RSS labos ─┘   (dédoublonnée)   (score ≥ seuil) └─ Article e-mail de prospection
                                                         │
                         Interface de validation ◄───────┤
                         E-mail récapitulatif    ◄───────┘
```

## Démarrage rapide

Prérequis : Docker (Desktop) avec Compose v2, `make`, `python3`, `curl`.

```bash
make install            # crée .env (secrets générés) puis démarre la stack
```

C'est tout : **le conteneur n8n se configure lui-même à chaque démarrage** (base de données, identifiants,
compte, workflows importés et publiés). Ensuite, `make up` (ou `docker compose up -d`) suffit toujours,
y compris après un `docker compose down -v` ou sur une nouvelle machine.

Puis :

1. **LLM** — dans `config/veille.json`, section `llm` : `base_url` et `modele` (voir tableau ci-dessous).
   Dans `.env` : `LLM_API_KEY=…`, puis `make up`.
2. **Profil du FabLab** — dans `config/veille.json`, section `fablab` : équipements, offres, contact, couleurs.
   ⚠ Ce profil alimente tous les prompts : l'IA ne doit décrire que ce qui existe vraiment.
3. **Lancer** — `make run`, ou le bouton « Lancer la veille maintenant » de l'interface.

| Adresse | Accès |
|---|---|
| Interface de validation : http://localhost:5678/webhook/veille | `VEILLE_UI_USER` / `VEILLE_UI_PASSWORD` (dans `.env`) |
| Éditeur n8n : http://localhost:5678 | `N8N_OWNER_EMAIL` / `N8N_OWNER_PASSWORD` (dans `.env`) |
| PDF des carrousels | dossier `output/` |

## Choisir le LLM

Tout se règle dans `config/veille.json` → `llm` (relu à chaque exécution, sans redémarrage). Seule la clé est dans `.env`.

| Fournisseur | `base_url` | Remarque |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | |
| Mistral | `https://api.mistral.ai/v1` | hébergé en Europe |
| OpenRouter | `https://openrouter.ai/api/v1` | accès à la plupart des modèles |
| Groq | `https://api.groq.com/openai/v1` | |
| Ollama (local) | `http://host.docker.internal:11434/v1` | `LLM_API_KEY` vide |
| LM Studio (local) | `http://host.docker.internal:1234/v1` | |

| Clé | Rôle |
|---|---|
| `modele` | Modèle principal : fiche et contenus (la qualité rédactionnelle compte). |
| `modele_rapide` | Optionnel : modèle moins cher pour le tri. Vide = `modele`. |
| `format_json` | `json_schema` (sortie garantie, par défaut) · `json_object` · `aucun` (consigne seule). Si votre fournisseur refuse `json_schema`, la chaîne se rabat automatiquement sur un format dégradé ; réglez-le pour éviter les essais inutiles. |
| `temperature`, `max_tokens` | `null` = valeur par défaut du fournisseur. Sortie limitée ici à 4 096 tokens (tri : 1 024 via `parametres_rapide`). Certains modèles « raisonnants » refusent `temperature` ou exigent `"parametre_max_tokens": "max_completion_tokens"`. |
| `delai_max_secondes`, `delai_rapide_secondes` | Budget **total**, reprises et correction comprises : 180 s par tâche, 60 s pour le tri dans la configuration fournie. Timeout n8n par publication : 10 minutes ; l'arrêt prend effet après le nœud en cours, lui-même borné pour les appels réseau. |
| `parametres_supplementaires` | Ajoutés tels quels à la requête (ex. `{"reasoning_effort": "low"}`). |
| `parametres_rapide` | Ajoutés en plus, **pour le tri seulement** : utile pour y couper la réflexion d'un modèle « raisonnant » (ex. Qwen via llama.cpp/vLLM : `{"chat_template_kwargs": {"enable_thinking": false}}`) sans toucher à la fiche ni aux contenus. |

Robustesse : chaque réponse est validée contre un schéma JSON (types, score 0–10, champs non vides, 6 à 8 diapositives) ; si elle est invalide, le modèle reçoit ses erreurs et **une** correction est tentée. Erreurs réseau, 429 et 5xx : au plus 3 essais dans le même budget, avec respect de `Retry-After`. Une erreur 401/403 ou un autre problème permanent arrête immédiatement la tâche. Un format refusé passe de `json_schema` à `json_object`, puis à la consigne seule si nécessaire.

La fiche et les textes sont sauvegardés **avant** la génération du PDF. Une publication en échec passe en « Erreurs » et est re-tentée aux lots suivants (jusqu'à `max_tentatives`) en réutilisant les étapes réussies. « Régénérer » efface ces résultats et recommence avec les réglages actuels.

## Au quotidien

- **Collecte automatique** (par défaut chaque lundi à 7 h) : HAL + RSS sur les `jours_de_recul` derniers jours, puis traitement IA. **Jours, heure et activation se règlent dans l'interface** : panneau « Collecte automatique » en haut de la page, cases des jours + heure + **Enregistrer** (pris en compte dans la minute, pas de redémarrage). L'heure est dans le fuseau `TZ` de `.env`. Si n8n était arrêté à l'heure prévue, la collecte part à son retour, le même jour ; une heure déjà passée aujourd'hui n'est pas rattrapée à l'enregistrement.
- **Chaque jour à 8 h** : traitement de ce qui reste (lots de `taille_lot`) et nouvelles tentatives sur les erreurs.
- **Interface de validation**, onglets :
  - *À valider* : choisir un contenu dans la liste de gauche, relire les points « À vérifier avant publication », **copier** le post et l'article, ouvrir le **PDF**, puis **Valider** / **Refuser** / **Régénérer** ;
  - *Validées* → **Marquer comme publiée** une fois postée ;
  - *Écartées* (score sous `seuil_pertinence`) → **Traiter quand même** ;
  - *Erreurs* → **Remettre en file** ; on y voit l'étape concernée et les erreurs des workflows (SMTP, LLM…). Le prochain lot reprend les étapes manquantes.

Bonnes pratiques : relisez les « points de vigilance » de la fiche, prévenez les chercheurs avant de publier (la fiche propose des questions à leur poser), et ajoutez le lien de la publication en premier commentaire LinkedIn.

## E-mail récapitulatif

Pour chaque contenu à valider, l'e-mail contient la fiche de valorisation, le post LinkedIn, l'article de prospection et la liste des diapositives, avec le **carrousel PDF en pièce jointe**. Il liste ensuite les publications écartées (avec la raison) et celles en erreur. Une version texte brut accompagne la version HTML.

1. `.env` : `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE` (`true` pour le port 465, `false` pour 587/STARTTLS), puis `make up`.
2. `config/veille.json` → `notifications.email` :

```json
"email": {
  "actif": true,
  "destinataires": ["direction@exemple.fr", "communication@exemple.fr"],
  "expediteur": "Veille FabLab <veille@exemple.fr>",
  "joindre_pdf": true,
  "envoyer_si_vide": false
}
```

- `actif` : envoi automatique à la fin de chaque lot qui produit des contenus (ou des erreurs).
- `envoyer_si_vide` : envoyer aussi « rien de nouveau » après une collecte planifiée.
- Envoi à la demande : bouton « Envoyer le récapitulatif par e-mail » de l'interface, ou `make recap` (fonctionne même si `actif` vaut `false`).
- Si `actif` vaut `true`, les mêmes destinataires reçoivent aussi une alerte quand un workflow échoue.

## Personnaliser

| Quoi | Où |
|---|---|
| Laboratoires suivis (collection HAL, flux RSS) | `config/veille.json` → `laboratoires` |
| Profil du FabLab, ton, couleurs du carrousel | `config/veille.json` → `fablab` |
| Secteurs, territoire, public cible | `config/veille.json` → `cibles` |
| Seuil de pertinence, taille des lots | `config/veille.json` → `traitement` |
| Textes des prompts et schémas JSON | `n8n/src/lib/prompts.js` |
| Mise en page du carrousel | `n8n/src/publication/composer-carrousel.js` |
| Interface / e-mail | `n8n/src/interface/page.js` · `n8n/src/recap/rediger.js` |
| Horaires | déclencheurs dans `n8n/build.py` |

Le code des nœuds « Code » vit dans `n8n/src/` ; `n8n/build.py` assemble les workflows (`n8n/workflows/*.json`) et vérifie la syntaxe JavaScript. Après une modification : **`make workflows`** (régénère, réimporte, publie ; ~20 s).

Dans l'éditeur, les blocs colorés indiquent les étapes à lire. Le workflow **1** collecte, le **2** pilote la boucle et isole les erreurs, le **3** produit une publication en quatre lignes : tri, fiche, contenus, PDF. Le **4** centralise les reprises IA. Les lignes du **5** correspondent chacune à une action de l'interface.

Vérification : `make check` exécute les régressions sans dépendance supplémentaire. `make check-integration` démarre une stack Docker jetable avec un faux LLM et un flux RSS fictif : poursuite après erreur, PDF réel, reprise des étapes, refus de formats JSON, correction, 401, dépassement de délai et reprise d'une publication interrompue dans le même lot ; puis le proxy sortant (avec et sans), le reverse proxy (HTTPS puis HTTP) et la sauvegarde. Il utilise uniquement des identifiants de test, désactive les e-mails et supprime ses propres volumes à la fin (`openssl` requis pour son certificat de test).

> ⚠ `make workflows` écrase les modifications faites directement dans l'éditeur n8n. Si vous modifiez un workflow dans l'éditeur, sauvegardez-le d'abord avec `make export`.

Pour trouver le code HAL d'un autre laboratoire : `https://api.archives-ouvertes.fr/search/?q=*:*&fq=collCode_s:CODE&rows=0` doit renvoyer `numFound > 0`.

## Architecture

| Service | Rôle |
|---|---|
| `n8n` (2.40.7, épinglé) | Orchestration, planification, webhooks de l'interface. Écoute sur `127.0.0.1` uniquement. Se provisionne à chaque démarrage (voir ci-dessous). |
| `task-runners` | Exécute le JavaScript des nœuds « Code », isolé du processus n8n. |
| `postgres` 17 | Base interne de n8n + base métier `veille` (utilisateur dédié). |
| `gotenberg` 8 | Conversion HTML → PDF des carrousels (Chromium). |
| `backup` | Sauvegarde chaque nuit les bases, la configuration et les PDF dans `backups/`. |
| `proxy` (Caddy, optionnel) | Reverse proxy : seul `/webhook/veille…` est exposé au réseau, en HTTP ou HTTPS. |

| Workflow n8n | Rôle |
|---|---|
| 0 · Alertes d'erreur | Journalise toute erreur (`workflow_errors`) et alerte par e-mail si activé. |
| 1 · Collecte HAL + RSS | Téléchargements HTTP natifs (30 s par source), normalisation, dédoublonnage → table `publications`. |
| 2 · Traitement par lot | Réserve un lot, traite une publication à la fois, isole les échecs. |
| 3 · Traiter une publication | Tri → fiche → contenus → PDF. |
| 4 · Appel LLM | Appel générique compatible OpenAI + validation JSON + correction. |
| 5 · Interface de validation | Pages web et actions (webhooks protégés par mot de passe). |
| 6 · E-mail récapitulatif | E-mail complet avec PDF joints. |
| 7 · Planificateur | Chaque minute, lit la table `schedule` (réglée dans l'interface) et lance la collecte au jour et à l'heure choisis, une fois par jour. Ses exécutions réussies ne sont pas conservées. |

### Démarrage de n8n (`n8n/provision/`)

À chaque démarrage du conteneur, **avant** que n8n ne se lance, `entrypoint.sh` → `provision.js` :

1. crée si besoin le rôle et la base `veille` (mot de passe de `.env`) et applique `db/schema.sql` (rejouable) ;
2. recopie depuis `.env` les identifiants n8n : base, clé LLM, accès interface, SMTP ;
3. importe et publie les workflows de `n8n/workflows/` **s'ils ont changé ou ne sont plus publiés** (empreinte
   mémorisée dans n8n) : les modifications faites dans l'éditeur survivent donc à un simple redémarrage ;
4. définit le compte propriétaire de l'éditeur depuis `.env` (`N8N_OWNER_*`), puis retire les secrets de
   l'environnement du processus n8n.

Le conteneur n'est déclaré « healthy » que lorsque l'interface de validation répond réellement : `make up`
échoue clairement (avec le journal) au lieu de laisser une interface en 404.

Cycle de vie d'une publication : `new` → `processing` → `to_review` (ou `triaged_out`, `error`) → `approved` → `published` (ou `rejected`).

## Exploitation

```bash
make help        # toutes les commandes
make status      # compteurs par statut + dernières erreurs
make logs        # journaux n8n
make backup      # bases + config + PDF dans backups/
make export      # workflows tels qu'ils sont dans n8n
```

- **Sauvegardez `.env`** : il contient `N8N_ENCRYPTION_KEY`, indispensable pour relire les identifiants stockés dans n8n.
- **Modification de `.env`** (clé LLM, SMTP, mots de passe) : `make up` — Compose recrée le conteneur n8n, qui se resynchronise.
- **Mise à jour de n8n** : changez `N8N_VERSION` dans `.env` (image `n8n` et image `task-runners` ensemble), puis `make up`.

## Mise en production

Sur le serveur : `git clone`, puis `make install` (crée `.env`, les secrets et les dossiers). Tout se règle ensuite dans `.env`, suivi de `make up` (ou `docker compose up -d`).

### Proxy sortant (réseau de l'université)

```bash
OUTBOUND_PROXY=http://proxy.exemple.fr:3128
OUTBOUND_NO_PROXY=            # hôtes à joindre en direct, ex. un LLM interne
```

- **Renseigné** : les requêtes HTTP(S) de n8n vers l'extérieur (HAL, flux RSS, LLM hébergé) passent par le proxy.
- **Vide** : connexion directe.
- Restent toujours en direct : les services de la stack (Gotenberg, base), les hôtes de `OUTBOUND_NO_PROXY`, et les hôtes de `config/veille.json` dont l'adresse est **interne** (10.x, 172.16–31.x, 192.168.x…), par exemple un LLM de l'établissement : un proxy sortant ne sait pas les joindre (Squid répond `503 ERR_CONNECT_FAIL`). Ils sont détectés au démarrage et listés dans le journal (`[veille] Proxy sortant : … · en direct (adresse interne) : …`) ; après un changement d'hôte dans la configuration : `make restart`.
- L'e-mail (SMTP) n'est pas concerné : il part en direct vers `SMTP_HOST`.
- Le téléchargement des images Docker dépend du proxy du **démon Docker**, à régler une fois sur le serveur ([documentation Docker](https://docs.docker.com/engine/daemon/proxy/)).

### Ouvrir l'interface de validation au réseau

n8n n'écoute que sur `127.0.0.1`. Le reverse proxy est le seul service exposé, et il ne relaie que `/webhook/veille…` : l'éditeur n8n, son API et les autres webhooks répondent 404.

```bash
COMPOSE_PROFILES=proxy
VEILLE_DOMAIN=veille.exemple.fr
VEILLE_HTTPS=true             # false = HTTP seul
TLS_CERTS_DIR=./certs         # dossier contenant vos certificats
TLS_CERT_FILE=fullchain.pem   # certificat + chaîne intermédiaire (PEM)
TLS_KEY_FILE=privkey.pem      # clé privée (PEM)
```

- Déposez vos deux fichiers dans `certs/` (jamais versionné), ou pointez `TLS_CERTS_DIR` vers leur dossier. Un dossier Let's Encrypt `live/…` contient des liens symboliques : indiquez plutôt le dossier `archive/…`, ou copiez les fichiers.
- Le proxy ne répond qu'au nom `VEILLE_DOMAIN`, redirige HTTP vers HTTPS, et refuse de démarrer si le certificat manque ou ne correspond pas à la clé (`docker compose logs proxy`).
- Après un renouvellement de certificat : `docker compose restart proxy`.
- Les liens des e-mails suivent automatiquement cette adresse.
- **Éditeur n8n** : il reste sur `127.0.0.1:5678`. Depuis votre poste : `ssh -L 5678:127.0.0.1:5678 serveur`, puis http://localhost:5678.

### Sauvegardes

Le conteneur `backup` écrit chaque nuit (`BACKUP_HOUR`, 3 h par défaut) trois fichiers dans `backups/` — bases `n8n` et `veille`, configuration + PDF — et supprime ceux de plus de `BACKUP_KEEP_DAYS` jours (14). `make backup` en fait une immédiatement ; `docker compose ps` affiche `backup` en *unhealthy* si la dernière a échoué. Copiez ce dossier **et `.env`** hors du serveur.

Restauration (sur un serveur neuf : `make install` d'abord, avec le `.env` d'origine) :

```bash
docker compose stop n8n task-runners
docker compose exec -T postgres psql -U n8n -d postgres -c 'DROP DATABASE IF EXISTS veille' -c 'CREATE DATABASE veille OWNER veille'
gunzip -c backups/veille-AAAAMMJJ-HHMMSS.sql.gz | docker compose exec -T postgres psql -qU n8n -d veille
tar xzf backups/fichiers-AAAAMMJJ-HHMMSS.tar.gz        # config/ et output/
make up
```

La base `n8n` (workflows, identifiants) n'a pas besoin d'être restaurée : elle se reconstruit au démarrage à partir de `.env` et des workflows versionnés. Sa sauvegarde ne sert qu'à retrouver l'historique des exécutions.

## Dépannage

| Symptôme | Piste |
|---|---|
| `The requested webhook "GET veille" is not registered` (404) | Workflows non publiés : `make workflows` (ou `make restart`). Si `make up` échoue : `make logs`, lignes `[veille]`. |
| Bandeau « LLM non configuré » | `llm.base_url` + `llm.modele` dans `config/veille.json`. |
| Erreurs « HTTP 401 » | `LLM_API_KEY` dans `.env`, puis `make up`. |
| Erreurs « le proxy sortant n'a pas pu joindre… » ou « page HTML reçue… » | Le proxy ne sait pas joindre cet hôte : `make restart` s'il est interne (détection au démarrage), sinon l'ajouter à `OUTBOUND_NO_PROXY` dans `.env`, puis `make up`. |
| Erreurs « format refusé » | `"format_json": "json_object"` (ou `"aucun"`). |
| « Réponse LLM tronquée » | Augmenter `llm.max_tokens`. |
| Rien n'est collecté | Onglet « À valider » → ligne « Dernière collecte » : incidents HAL/RSS éventuels ; augmenter `jours_de_recul`. |
| L'e-mail n'arrive pas | Onglet « Erreurs » (section « Erreurs des workflows ») ; vérifier `SMTP_*` puis `make up`. |
| Tout le détail d'une exécution | Éditeur n8n → *Executions*. |
