#!/usr/bin/env python3
"""Test réel de la stack, avec sources/LLM fictifs, volumes temporaires et aucun e-mail.
Couvre aussi le proxy sortant, le reverse proxy (HTTPS puis HTTP) et la sauvegarde.
Usage : python3 n8n/check-integration.py (Docker et openssl requis).
"""
import gzip
import http.client
import json
import select
import shutil
import socket
import ssl
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from datetime import datetime, timezone
from email.utils import format_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


def serve():
    # proxied : requêtes reçues par le faux proxy sortant ; direct : requêtes arrivées sans passer par lui.
    state = {'mode': 'initial', 'calls': [], 'proxied': [], 'direct': []}

    def value(schema):
        if 'enum' in schema:
            return schema['enum'][0]
        kind = schema['type']
        if kind == 'object':
            return {k: value(v) for k, v in schema['properties'].items()}
        if kind == 'array':
            return [value(schema['items']) for _ in range(schema.get('minItems', 1))]
        if kind in ('integer', 'number'):
            return 8
        if kind == 'boolean':
            return True
        return 'Contenu fictif vérifiable.'

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, status, data, content_type='application/json'):
            body = (data if isinstance(data, str) else json.dumps(data)).encode()
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except BrokenPipeError:
                pass

        def track(self):
            # Le faux proxy joint ce serveur par 127.0.0.1 : toute autre provenance est un accès direct.
            if self.client_address[0] != '127.0.0.1':
                state['direct'].append(self.path)

        def do_GET(self):
            url = urlsplit(self.path)
            if url.path == '/control':
                state.update(mode=parse_qs(url.query)['mode'][0], calls=[], proxied=[], direct=[])
                return self.reply(200, state)
            if url.path == '/calls':
                return self.reply(200, state['calls'])
            if url.path == '/routes':
                return self.reply(200, {'proxied': state['proxied'], 'direct': state['direct']})
            self.track()
            now = format_datetime(datetime.now(timezone.utc))
            items = ''.join(f'<item><title>{title}</title><guid>{i}</guid><pubDate>{now}</pubDate>'
                            '<description>Source de test scientifique suffisamment détaillée.</description></item>'
                            for i, title in [(1, 'Terminer'), (2, 'Écarter'), (3, 'Panne')])
            self.reply(200, f'<rss><channel>{items}</channel></rss>', 'application/rss+xml')

        def do_POST(self):
            self.track()
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            schema = json.loads(body['messages'][0]['content'].rsplit('\n', 1)[1])
            task = 'tri' if 'score' in schema['properties'] else 'contenus' if 'linkedin' in schema['properties'] else 'fiche'
            state['calls'].append(task)
            mode = state['mode']
            if mode == 'timeout':
                time.sleep(2)
            if mode == 'auth':
                return self.reply(401, {'error': {'message': 'invalid API key'}})
            if mode == 'format' and body.get('response_format'):
                return self.reply(400, {'error': {'message': 'response_format unsupported'}})
            if (mode == 'initial' and 'Titre : Panne' in body['messages'][1]['content']) or (mode == 'checkpoint' and task == 'contenus'):
                return self.reply(503, {'error': {'message': 'panne fictive'}})
            data = value(schema)
            if task == 'tri' and 'Titre : Écarter' in body['messages'][1]['content']:
                data['score'] = 2
            if task == 'fiche':
                data['chercheurs_a_citer'] = []
            if task == 'contenus':
                data['carrousel']['slides'] = [{'type': t, 'titre': 'Test', 'texte': 'Contenu de test.', 'puces': []}
                    for t in ['couverture', 'probleme', 'recherche', 'application', 'fablab', 'appel_a_action']]
            if mode == 'correction' and len(body['messages']) == 2:
                data = {}
            self.reply(200, {'choices': [{'message': {'content': json.dumps(data)}, 'finish_reason': 'stop'}],
                            'usage': {'total_tokens': 50}, 'model': 'test-model'})

    class Proxy(BaseHTTPRequestHandler):
        """Faux proxy d'établissement : tunnels CONNECT (HTTPS) et relais des requêtes HTTP."""

        def log_message(self, *args):
            pass

        @staticmethod
        def address(host, port):
            return ('127.0.0.1' if host == 'externe.test' else host, int(port))

        def do_CONNECT(self):
            state['proxied'].append(f'CONNECT {self.path}')
            upstream = socket.create_connection(self.address(*self.path.rsplit(':', 1)), timeout=30)
            self.send_response(200, 'Connection established')
            self.end_headers()
            pair = {self.connection: upstream, upstream: self.connection}
            try:
                while True:
                    ready, _, _ = select.select(list(pair), [], [], 60)
                    if not ready:
                        break
                    for sock in ready:
                        data = sock.recv(65536)
                        if not data:
                            return
                        pair[sock].sendall(data)
            except OSError:
                pass
            finally:
                upstream.close()

        def relay(self):
            url = urlsplit(self.path)
            state['proxied'].append(f'{self.command} {url.hostname}:{url.port or 80}')
            body = self.rfile.read(int(self.headers.get('Content-Length') or 0))
            headers = {k: v for k, v in self.headers.items() if k.lower() not in ('connection', 'proxy-connection', 'keep-alive')}
            upstream = http.client.HTTPConnection(*self.address(url.hostname, url.port or 80), timeout=60)
            upstream.request(self.command, url.path + (f'?{url.query}' if url.query else ''), body, headers)
            response = upstream.getresponse()
            data = response.read()
            self.send_response(response.status)
            for key, value in response.getheaders():
                if key.lower() not in ('connection', 'transfer-encoding', 'content-length'):
                    self.send_header(key, value)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        do_GET = do_POST = relay

    secure = ThreadingHTTPServer(('0.0.0.0', 8443), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain('/certs/fullchain.pem', '/certs/privkey.pem')
    secure.socket = context.wrap_socket(secure.socket, server_side=True)
    for server in (secure, ThreadingHTTPServer(('0.0.0.0', 8888), Proxy)):
        threading.Thread(target=server.serve_forever, daemon=True).start()
    ThreadingHTTPServer(('0.0.0.0', 8080), Handler).serve_forever()


def check():
    repo = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix='veille-integration-') as directory:
        root = Path(directory)
        for name in ['n8n', 'config', 'db', 'proxy', 'backup']:
            shutil.copytree(repo / name, root / name)
        shutil.copy2(repo / 'docker-compose.yml', root / 'docker-compose.yml')
        for name in ['output', 'backups', 'certs']:
            (root / name).mkdir()
        # Certificat autosigné : sert au reverse proxy (veille.test) et au flux RSS en HTTPS (externe.test).
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=veille.test',
                        '-addext', 'subjectAltName=DNS:veille.test,DNS:externe.test',
                        '-keyout', str(root / 'certs/privkey.pem'), '-out', str(root / 'certs/fullchain.pem')],
                       check=True, capture_output=True)

        def env(https, outbound_proxy):
            (root / '.env').write_text(f'''POSTGRES_PASSWORD=test-postgres
VEILLE_DB_PASSWORD=test-veille
N8N_ENCRYPTION_KEY=test-only-encryption-key
N8N_RUNNERS_AUTH_TOKEN=test-only-runner-token
N8N_OWNER_EMAIL=test@example.local
N8N_OWNER_PASSWORD=TestOnlyPassword7
VEILLE_UI_USER=test
VEILLE_UI_PASSWORD=test-only
N8N_PORT=0
N8N_PUBLIC_URL=http://localhost:5678
N8N_SECURE_COOKIE=false
N8N_VERSION=2.40.7
COMPOSE_PROFILES=proxy
VEILLE_DOMAIN=veille.test
VEILLE_HTTPS={https}
OUTBOUND_PROXY={outbound_proxy}
''')

        env('true', 'http://fixtures:8888')
        config = json.loads((root / 'config/veille.json').read_text())
        # Le LLM est joint par une adresse interne, les flux RSS par des adresses publiques (voir compose.test.yml).
        config['llm'].update(base_url='http://interne.test:8080/v1', modele='test-model',
                             delai_max_secondes=30, delai_rapide_secondes=30)
        config['sources']['hal']['actif'] = False
        config['laboratoires'] = [{'code': 'TEST', 'nom': 'Test', 'flux_rss': 'https://externe.test:8443/rss'},
                                  {'code': 'TEST2', 'nom': 'Test 2', 'flux_rss': 'http://externe.test:8080/rss'}]
        config['notifications']['email']['actif'] = False
        config_file = root / 'config/veille.json'
        config_file.write_text(json.dumps(config))
        (root / 'compose.test.yml').write_text('''services:
  fixtures:
    image: python:3.13-slim
    command: ["python", "/test.py", "serve"]
    volumes:
      - ./n8n/check-integration.py:/test.py:ro
      - ./certs:/certs:ro
    networks:
      default:
        aliases: [externe.test]
      interne:
        aliases: [interne.test]
  n8n:
    environment:
      NODE_EXTRA_CA_CERTS: /certs-test/fullchain.pem
    volumes:
      - ./certs/fullchain.pem:/certs-test/fullchain.pem:ro
    networks: [default, interne]
  proxy:
    ports: !reset []
    networks:
      default:
        aliases: [veille.test]
# externe.test a une adresse publique (plage de documentation), interne.test une adresse privée.
networks:
  default:
    ipam:
      config:
        - subnet: 203.0.113.0/24
  interne: {}
''')
        command = ['docker', 'compose', '-p', root.name, '-f', 'docker-compose.yml', '-f', 'compose.test.yml']

        def compose(*args, stdin=None):
            result = subprocess.run(command + list(args), cwd=root, text=True, capture_output=True, input=stdin)
            if result.returncode:
                raise RuntimeError(result.stderr + result.stdout)
            return result.stdout.strip()

        def sql(query, db='veille'):
            return compose('exec', '-T', 'postgres', 'psql', '-At', '-U', 'n8n', '-d', db, '-v', 'ON_ERROR_STOP=1', '-c', query)

        def http(url, method='GET', authenticated=False):
            headers = {'Authorization': 'Basic dGVzdDp0ZXN0LW9ubHk='} if authenticated else {}
            js = f"fetch({json.dumps(url)}, {{method:{json.dumps(method)},headers:{json.dumps(headers)},redirect:'manual'}}).then(async r=>console.log(JSON.stringify({{status:r.status,location:r.headers.get('location'),body:await r.text()}})))"
            return json.loads(compose('exec', '-T', 'n8n', 'node', '-e', js))

        def routes():
            return json.loads(http('http://fixtures:8080/routes')['body'])

        def reverse_proxy(scheme):
            base = f'{scheme}://veille.test'
            assert http(f'{base}/webhook/veille')['status'] == 401
            page = http(f'{base}/webhook/veille', authenticated=True)
            assert page['status'] == 200 and 'Veille scientifique' in page['body']
            assert '/home/workflows' not in page['body'], "lien vers l'éditeur n8n exposé derrière le proxy"
            assert '/home/workflows' in http('http://localhost:5678/webhook/veille', authenticated=True)['body']
            for path in ['/', '/healthz', '/rest/settings', '/webhook/autre', '/webhook/veilleX', '/webhook-test/veille']:
                assert http(base + path, authenticated=True)['status'] == 404, path
            # Chemin envoyé tel quel (fetch le normaliserait) : pas d'échappée vers le reste de n8n.
            raw = (f"require({json.dumps(scheme)}).get({{host:'veille.test',path:'/webhook/veille/../../healthz'}},"
                   "r=>{console.log(r.statusCode);r.resume()})")
            assert compose('exec', '-T', 'n8n', 'node', '-e', raw) == '404'
            assert http('http://proxy/webhook/veille', authenticated=True)['status'] == 404  # autre nom d'hôte
            assert sql("SELECT value FROM instance_settings WHERE key='public_url'") == base

        def execute(mode, preserve=False, prepare=True):
            http(f'http://fixtures:8080/control?mode={mode}')
            if mode != 'initial' and prepare:
                sql("UPDATE publications SET status='published' WHERE id<>1")
                clear = '' if preserve else ',fiche=NULL,linkedin=NULL,carousel=NULL,email=NULL,pdf_file=NULL,llm_usage=\'{}\''
                sql("UPDATE publications SET status='new',attempts=0,last_error=NULL" + clear + " WHERE id=1")
            before = int(sql('SELECT coalesce(max(id),0) FROM execution_entity', 'n8n'))
            start = time.monotonic()
            assert http('http://localhost:5678/webhook/veille/lancer', 'POST', True)['status'] == 303
            deadline = start + 60
            while time.monotonic() < deadline:
                status = sql(f'SELECT status FROM execution_entity WHERE "workflowId"=\'VeilleTraitemt01\' AND id>{before} ORDER BY id DESC LIMIT 1', 'n8n')
                if status == 'success':
                    return json.loads(http('http://fixtures:8080/calls')['body']), time.monotonic() - start
                if status in ('error', 'canceled', 'crashed'):
                    raise AssertionError(f'Lot terminé avec statut {status}')
                time.sleep(1)
            raise AssertionError('Le lot ne termine pas en 60 s')

        try:
            compose('up', '-d', '--wait', '--wait-timeout', '180')
            execute('initial')
            assert sql("SELECT string_agg(status,',' ORDER BY id) FROM publications") == 'to_review,triaged_out,error'
            assert sql('SELECT count(*) FROM publications WHERE status=\'processing\'') == '0'
            pdf = sql('SELECT pdf_file FROM publications WHERE id=1')
            assert (root / 'output' / pdf).read_bytes().startswith(b'%PDF')
            print('✔ Échec puis exclusion puis succès : le lot continue, termine et produit un PDF.', flush=True)

            seen = routes()
            assert 'CONNECT externe.test:8443' in seen['proxied'] and 'GET externe.test:8080' in seen['proxied'], seen
            assert set(seen['direct']) == {'/v1/chat/completions'}, seen
            assert not any('gotenberg' in target or 'interne' in target for target in seen['proxied']), seen
            assert 'en direct (adresse interne) : interne.test' in compose('logs', 'n8n')
            print('✔ Proxy sortant défini : flux RSS (HTTPS et HTTP) par le proxy ; LLM interne et Gotenberg en direct.', flush=True)

            reverse_proxy('https')
            redirect = http('http://veille.test/webhook/veille?statut=new')
            assert (redirect['status'], redirect['location']) == (308, 'https://veille.test/webhook/veille?statut=new'), redirect
            print("✔ Reverse proxy HTTPS : seule l'interface de validation est relayée, HTTP redirigé.", flush=True)

            def saved(pattern):
                return sorted((root / 'backups').glob(pattern))
            deadline = time.monotonic() + 90
            while not saved('veille-*.sql.gz') and time.monotonic() < deadline:  # dernier fichier déposé
                time.sleep(2)
            assert len(saved('n8n-*.sql.gz')) == len(saved('veille-*.sql.gz')) == len(saved('fichiers-*.tar.gz')) == 1
            time.sleep(1)
            compose('exec', '-T', 'backup', 'sh', '/opt/veille/backup/backup.sh', 'now')
            dump = saved('veille-*.sql.gz')[-1]
            assert len(saved('veille-*.sql.gz')) == 2 and dump.stat().st_mode & 0o077 == 0
            assert b'CREATE TABLE public.publications' in gzip.decompress(dump.read_bytes())
            assert b'CREATE TABLE public.workflow_entity' in gzip.decompress(saved('n8n-*.sql.gz')[-1].read_bytes())
            with tarfile.open(saved('fichiers-*.tar.gz')[-1]) as archive:
                assert {'config/veille.json', f'output/{pdf}'} <= set(archive.getnames())
            print('✔ Sauvegarde : faite au démarrage puis à la demande (bases, configuration, PDF).', flush=True)

            execute('checkpoint')
            assert sql("SELECT status || ':' || processing_step || ':' || (fiche IS NOT NULL)::text FROM publications WHERE id=1") == 'error:contenus:true'
            calls, _ = execute('normal', preserve=True)
            assert calls == ['contenus'], calls
            calls, _ = execute('normal', preserve=True)
            assert calls == [], calls
            print('✔ Reprise après échec : fiche réutilisée ; PDF seul sans nouvel appel IA.', flush=True)

            calls, _ = execute('format')
            assert len(calls) == 9, calls
            assert sql('SELECT status FROM publications WHERE id=1') == 'to_review'
            calls, _ = execute('correction')
            assert len(calls) == 6, calls
            assert sql('SELECT status FROM publications WHERE id=1') == 'to_review'
            print('✔ Format JSON refusé et correction JSON : les boucles réelles aboutissent.', flush=True)

            calls, _ = execute('auth')
            assert calls == ['tri'], calls
            assert sql('SELECT status FROM publications WHERE id=1') == 'error'
            config['llm'].update(delai_max_secondes=1, delai_rapide_secondes=1)
            config_file.write_text(json.dumps(config))
            calls, elapsed = execute('timeout')
            assert calls == ['tri'] and elapsed < 10, (calls, elapsed)
            assert 'budget' in sql('SELECT last_error FROM publications WHERE id=1')
            print('✔ 401 sans répétition ; fournisseur bloqué arrêté dans le budget.', flush=True)

            config['llm'].update(delai_max_secondes=30, delai_rapide_secondes=30)
            config_file.write_text(json.dumps(config))
            sql("ALTER TABLE publications DISABLE TRIGGER publications_updated_at; "
                "UPDATE publications SET status='processing',attempts=1,updated_at=now()-interval '3 hours' WHERE id=1; "
                "ALTER TABLE publications ENABLE TRIGGER publications_updated_at")
            execute('normal', prepare=False)
            assert sql('SELECT status FROM publications WHERE id=1') == 'to_review'
            print('✔ Publication interrompue : libérée et reprise dans le même lot.', flush=True)

            # Restauration de la sauvegarde (procédure du README), puis redémarrage sur l'autre configuration.
            count = sql('SELECT count(*) FROM publications')
            compose('stop', 'n8n', 'task-runners')
            compose('exec', '-T', 'postgres', 'psql', '-qU', 'n8n', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
                    '-c', 'DROP DATABASE veille', '-c', 'CREATE DATABASE veille OWNER veille')
            compose('exec', '-T', 'postgres', 'psql', '-qU', 'n8n', '-d', 'veille', '-v', 'ON_ERROR_STOP=1',
                    stdin=gzip.decompress(dump.read_bytes()).decode())
            assert sql('SELECT count(*) FROM publications') == count == '3'
            env('false', '')
            compose('up', '-d', '--wait', '--wait-timeout', '180')
            calls, _ = execute('normal')
            seen = routes()
            assert len(calls) == 3 and sql('SELECT status FROM publications WHERE id=1') == 'to_review', calls
            assert not seen['proxied'] and {'/rss', '/v1/chat/completions'} <= set(seen['direct']), seen
            reverse_proxy('http')
            print('✔ Sauvegarde restaurée. Sans proxy sortant : connexion directe. Reverse proxy en HTTP seul : mêmes règles.', flush=True)
        finally:
            compose('down', '-v', '--remove-orphans')


if __name__ == '__main__':
    serve() if sys.argv[1:] == ['serve'] else check()
