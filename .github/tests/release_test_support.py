"""リリースの経路のテストが共有する読み込みと補助関数。"""
import importlib.util
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


GITHUB = Path(__file__).resolve().parents[1]
GATE_SCRIPT = GITHUB / 'release-gate.py'
NPM_REGISTRY_SCRIPT = GITHUB / 'npm-registry.py'
BUMP = (GITHUB / 'workflows/bump-version.yml').read_text()
RELEASE = (GITHUB / 'workflows/release.yml').read_text()
REPOSITORY = 'o/r'
PACKAGE = 'packages/library/package.json'
LOOPBACK = '127.0.0.1,localhost'

spec = importlib.util.spec_from_file_location('release_gate', GATE_SCRIPT)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


def load_npm_registry():
    npm_spec = importlib.util.spec_from_file_location('npm_registry', NPM_REGISTRY_SCRIPT)
    module = importlib.util.module_from_spec(npm_spec)
    npm_spec.loader.exec_module(module)
    return module


def run_body(workflow, step):
    return re.search(
        r'id: ' + step + r'\n.*?        run: \|\n((?:          [^\n]*\n|\n)+)',
        workflow, re.DOTALL,
    ).group(1)


def run_blocks(workflow):
    blocks = re.findall(r'run: \|\n((?:          [^\n]*\n|\n)+)', workflow)
    return blocks + re.findall(r'run: ([^|\n][^\n]*)', workflow)


def job(workflow, name):
    start = workflow.index('\n  ' + name + ':\n')
    end = re.search(r'\n  [a-z-]+:\n', workflow[start + 1:])
    return workflow[start:start + 1 + end.start()] if end else workflow[start:]


def step(workflow, step_id):
    start = workflow.rindex('\n      - ', 0, workflow.index('id: ' + step_id + '\n'))
    end = workflow.find('\n      - ', start + 1)
    return workflow[start:end if end != -1 else len(workflow)]


def outputs(path):
    return dict(line.split('=', 1) for line in path.read_text().splitlines() if line)


def pull(sha, ref='release/v5.3.0', repo=REPOSITORY, merged=True, base='main'):
    return {
        'number': 1, 'merged_at': '2026-11-25T00:00:00Z' if merged else None,
        'merge_commit_sha': sha, 'base': {'ref': base}, 'head': {'ref': ref, 'repo': {'full_name': repo}},
    }


def packument(version=None, latest=None, provenance=True):
    """npm の packument の形（使う鍵だけ）。version が None なら、その版を持たない。"""
    versions = {'5.2.0': {'version': '5.2.0', 'dist': {}}}
    if version is not None:
        dist = {'tarball': f'https://registry.npmjs.org/event-store-adapter-js/-/event-store-adapter-js-{version}.tgz'}
        if provenance:
            dist['attestations'] = {'url': 'https://registry.npmjs.org/-/npm/v1/attestations/x',
                                    'provenance': {'predicateType': 'https://slsa.dev/provenance/v1'}}
        versions[version] = {'version': version, 'dist': dist}
    tags = {'snapshot': '5.2.1-snapshot.5559.1'}
    if latest is not None:
        tags['latest'] = latest
    return json.dumps({'name': 'event-store-adapter-js', 'dist-tags': tags, 'versions': versions}).encode()


class NpmStub:
    """手元の npm レジストリの代わり（127.0.0.1 のスレッド）。照会ごとに replies の先頭を返し、最後の1つは繰り返す。
    replies は (status, body)。受けた照会は requests に (method, path, headers) で残す。GET 以外には 405 を返す。"""

    def __init__(self, replies):
        stub = self
        self.replies = list(replies)
        self.requests = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self):
                stub.requests.append((self.command, self.path, dict(self.headers)))
                if self.command != 'GET':
                    status, body = 405, b''
                else:
                    status, body = stub.replies.pop(0) if len(stub.replies) > 1 else stub.replies[0]
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = reply

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
