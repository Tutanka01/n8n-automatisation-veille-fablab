#!/usr/bin/env python3
"""Test réel de la stack, avec sources/LLM fictifs, volumes temporaires et aucun e-mail.
Usage : python3 n8n/check-integration.py (Docker requis).
"""
import json
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from email.utils import format_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


def serve():
    state = {'mode': 'initial', 'calls': []}

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

        def do_GET(self):
            url = urlsplit(self.path)
            if url.path == '/control':
                state.update(mode=parse_qs(url.query)['mode'][0], calls=[])
                return self.reply(200, state)
            if url.path == '/calls':
                return self.reply(200, state['calls'])
            now = format_datetime(datetime.now(timezone.utc))
            items = ''.join(f'<item><title>{title}</title><guid>{i}</guid><pubDate>{now}</pubDate>'
                            '<description>Source de test scientifique suffisamment détaillée.</description></item>'
                            for i, title in [(1, 'Terminer'), (2, 'Écarter'), (3, 'Panne')])
            self.reply(200, f'<rss><channel>{items}</channel></rss>', 'application/rss+xml')

        def do_POST(self):
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

    ThreadingHTTPServer(('0.0.0.0', 8080), Handler).serve_forever()


def check():
    repo = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix='veille-integration-') as directory:
        root = Path(directory)
        for name in ['n8n', 'config', 'db']:
            shutil.copytree(repo / name, root / name)
        shutil.copy2(repo / 'docker-compose.yml', root / 'docker-compose.yml')
        (root / 'output').mkdir()
        (root / '.env').write_text('''POSTGRES_PASSWORD=test-postgres
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
''')
        config = json.loads((root / 'config/veille.json').read_text())
        config['llm'].update(base_url='http://fixtures:8080/v1', modele='test-model',
                             delai_max_secondes=30, delai_rapide_secondes=30)
        config['sources']['hal']['actif'] = False
        config['laboratoires'] = [{'code': 'TEST', 'nom': 'Test', 'flux_rss': 'http://fixtures:8080/rss'}]
        config['notifications']['email']['actif'] = False
        config_file = root / 'config/veille.json'
        config_file.write_text(json.dumps(config))
        (root / 'compose.test.yml').write_text('''services:
  fixtures:
    image: python:3.13-slim
    command: ["python", "/test.py", "serve"]
    volumes:
      - ./n8n/check-integration.py:/test.py:ro
''')
        command = ['docker', 'compose', '-p', root.name, '-f', 'docker-compose.yml', '-f', 'compose.test.yml']

        def compose(*args):
            result = subprocess.run(command + list(args), cwd=root, text=True, capture_output=True)
            if result.returncode:
                raise RuntimeError(result.stderr + result.stdout)
            return result.stdout.strip()

        def sql(query, db='veille'):
            return compose('exec', '-T', 'postgres', 'psql', '-At', '-U', 'n8n', '-d', db, '-v', 'ON_ERROR_STOP=1', '-c', query)

        def http(url, method='GET', authenticated=False):
            headers = {'Authorization': 'Basic dGVzdDp0ZXN0LW9ubHk='} if authenticated else {}
            js = f"fetch({json.dumps(url)}, {{method:{json.dumps(method)},headers:{json.dumps(headers)},redirect:'manual'}}).then(async r=>console.log(JSON.stringify({{status:r.status,body:await r.text()}})))"
            return json.loads(compose('exec', '-T', 'n8n', 'node', '-e', js))

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
        finally:
            compose('down', '-v', '--remove-orphans')


if __name__ == '__main__':
    serve() if sys.argv[1:] == ['serve'] else check()
