#!/usr/bin/env python3
"""公開のあとの確認：npm がその版を、latest と（求めるなら）provenance つきで返すまで待つ（#1161）。

標準ライブラリだけを使う（confirm ジョブは pip install をしない）。秘密の値は使わず、npm には GET だけを送る。

confirm --version X.Y.Z [--provenance] [--interval SECONDS] [--deadline SECONDS]
    packument（<registry>/event-store-adapter-js）を読み直し、1回の応答に次の3つがそろえば成功：
    versions に X.Y.Z がある、dist-tags.latest が正式版で X.Y.Z 以上、（--provenance なら）その版に provenance がある。
    照会の失敗（404・5xx・429・接続の失敗・本文の途中の切断・JSON でない）も、そろわない応答も、締め切りまで読み直す。
    締め切りは単調時計で持ち、照会と待ちの時間をすべて数える。時間切れの文は、読めた中でいちばん進んだ状態で決まる。
環境変数：NPM_REGISTRY_URL（テストで差し替える。既定 https://registry.npmjs.org）。
"""
import argparse
import http.client as http_client  # 関数 http と名前がぶつからないように
import json
import os
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

PACKAGE = 'event-store-adapter-js'
USER_AGENT = 'event-store-adapter-js-release (+https://github.com/j5ik2o/event-store-adapter-js)'
BODY_CHUNK = 64 * 1024
RELEASE = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)')

# 読めた状態。数が大きいほど進んでいる
ABSENT = 0          # 版を読めなかった（照会の失敗を含む）
STALE_LATEST = 1    # 版はあるが、latest がこの版より古い（または正式版でない、無い）
NO_PROVENANCE = 2   # 版と latest はあるが、provenance が無い
READY = 3


class Stop(Exception):
    """確認が通らない。理由を ::error:: で書いて終了コード 1。"""


def release_key(version):
    """正式版 X.Y.Z の比べるためのキー。正式版でなければ None。"""
    if not isinstance(version, str):
        return None
    match = RELEASE.fullmatch(version)
    return tuple(int(part) for part in match.groups()) if match else None


# ---------------------------------------------------------------- 判定（純粋な関数。照会と分ける）

@dataclass(frozen=True)
class Response:
    """照会の結果。code が None なら照会の失敗（接続、時間切れ、本文の途中の切断）。"""
    code: object
    body: bytes = b''


@dataclass(frozen=True)
class Reading:
    state: int
    latest: object = None


def has_provenance(entry):
    dist = entry.get('dist')
    attestations = dist.get('attestations') if isinstance(dist, dict) else None
    provenance = attestations.get('provenance') if isinstance(attestations, dict) else None
    predicate = provenance.get('predicateType') if isinstance(provenance, dict) else None
    return isinstance(predicate, str) and predicate != ''


def read_packument(response, version, provenance):
    """packument の応答を Reading にする。版・latest・provenance を同じ1回の応答から読む。"""
    if response.code != 200:
        return Reading(ABSENT)
    try:
        body = json.loads(response.body.decode('utf-8'))
    except (UnicodeDecodeError, ValueError):
        return Reading(ABSENT)
    if not isinstance(body, dict):
        return Reading(ABSENT)
    versions = body.get('versions')
    entry = versions.get(version) if isinstance(versions, dict) else None
    if not isinstance(entry, dict):
        return Reading(ABSENT)
    tags = body.get('dist-tags')
    latest = tags.get('latest') if isinstance(tags, dict) else None
    key = release_key(latest)
    if key is None or key < release_key(version):
        return Reading(STALE_LATEST, latest)
    if provenance and not has_provenance(entry):
        return Reading(NO_PROVENANCE, latest)
    return Reading(READY, latest)


def timeout_message(reading, version, seconds):
    """時間切れの文。reading は読めた中でいちばん進んだ状態。"""
    name = f'{PACKAGE}@{version}'
    limit = f'{seconds:g}'
    if reading.state == ABSENT:
        return (f'npm did not serve {name} within {limit} seconds. The package may have been published: check with '
                f'npm view {name} version dist-tags dist.attestations, then re-run only the failed jobs of this run '
                '(the confirm job). Do not re-run all jobs and do not publish again.')
    if reading.state == STALE_LATEST:
        return (f'npm serves {name}, but dist-tags.latest is still {json.dumps(reading.latest)} after {limit} seconds. '
                f'Re-run only the failed jobs; if latest stays older, fix it with npm dist-tag add {name} latest '
                '(see CONTRIBUTING).')
    return (f'{name} has no provenance attestation after {limit} seconds. Re-run only the failed jobs; '
            'if it stays missing, see CONTRIBUTING (When a release stops halfway).')


# ---------------------------------------------------------------- 照会（j5ik2o/event-store-adapter-rs の crates-io.py と同じ作り）

class Deadline:
    """コマンド全体の締め切り（単調時計）。照会の時間も待ちに数える。"""

    def __init__(self, seconds, clock=time.monotonic):
        self.clock = clock
        self.end = clock() + seconds

    def remaining(self):
        return max(0.0, self.end - self.clock())


def response_socket(response):
    """応答の socket。CPython の http.client では、HTTPResponse.fp は socket.makefile('rb') の BufferedReader で、
    その raw（SocketIO）が socket を持つ。HTTPError は fp に HTTPResponse を持つ。取れなければ None。"""
    fp = getattr(response, 'fp', None)
    raw = getattr(fp, 'raw', None)
    sock = getattr(raw, '_sock', None)
    return sock if isinstance(sock, socket.socket) else None


def read_body(response, deadline, timeout):
    """本文を読み、締め切りで打ち切る（過ぎたら TimeoutError）。

    urlopen の timeout は通信の1回ごとにかかるので、本文が少しずつ届くと締め切りを超えて待つ。そこで、受信の前ごとに
    socket の timeout を締め切りの残りにし、read1（受信は1回）で読み、読むたびに締め切りを確かめる。1回の read1 の中で
    何度も受信する場合（chunked の長さの行）に備え、締め切りに socket を閉じる（shutdown）。"""
    sock = response_socket(response)
    read = getattr(response, 'read1', None) or response.read
    watchdog = Watchdog(sock, deadline.remaining()) if sock is not None else None
    try:
        chunks = []
        while True:
            left = deadline.remaining()
            if left <= 0:
                raise TimeoutError('the deadline passed while reading the body')
            if sock is not None and sock.fileno() >= 0:   # 本文を読み終えると http.client が socket を閉じる
                sock.settimeout(min(timeout, left))
            chunk = read(BODY_CHUNK)
            if not chunk:
                break
            chunks.append(chunk)
        if deadline.remaining() <= 0:
            raise TimeoutError('the deadline passed while reading the body')
        return b''.join(chunks)
    finally:
        if watchdog is not None:
            watchdog.cancel()
            watchdog.raise_failure()


class Watchdog:
    """締め切りに socket を閉じ、受信を止める timer。閉じられなかったときは、その照会を時間切れとして失敗にする
    （raise_failure）。読み終えて閉じた socket には何もしない。"""

    def __init__(self, sock, seconds):
        self.sock = sock
        self.failure = None
        self.timer = threading.Timer(max(seconds, 0), self.fire)
        self.timer.daemon = True
        self.timer.start()

    def fire(self):
        if self.sock.fileno() < 0:
            return
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError as error:
            self.failure = error

    def cancel(self):
        self.timer.cancel()

    def raise_failure(self):
        if self.failure is not None:
            raise TimeoutError(f'could not shut the socket down at the deadline: {self.failure}') from self.failure


def http(url, deadline, timeout=60, headers=None):
    """GET して Response を返す。接続の失敗、時間切れ、本文の途中の切断（IncompleteRead）は code=None。
    締め切りの残りで照会を打ち切り、残りが無ければ照会しない。締め切りのあとに読み終えた応答は使わない。"""
    left = deadline.remaining()
    if left <= 0:
        return Response(None)
    request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, **(headers or {})})
    try:
        try:
            with urllib.request.urlopen(request, timeout=min(timeout, left)) as response:
                return Response(response.status, read_body(response, deadline, timeout))
        except urllib.error.HTTPError as error:
            with error:
                return Response(error.code, read_body(getattr(error, 'fp', None) or error, deadline, timeout))
    except (urllib.error.URLError, http_client.HTTPException, TimeoutError, OSError, ValueError):
        return Response(None)


def packument_url():
    return os.environ.get('NPM_REGISTRY_URL', 'https://registry.npmjs.org').rstrip('/') + '/' + PACKAGE


def describe(reading, version):
    if reading.state == ABSENT:
        return f'npm does not serve {PACKAGE}@{version} yet'
    if reading.state == STALE_LATEST:
        return f'npm serves {PACKAGE}@{version}, but dist-tags.latest is {json.dumps(reading.latest)}'
    return f'npm serves {PACKAGE}@{version} as latest, but without a provenance attestation yet'


def confirm(args, deadline, sleep=time.sleep):
    if not RELEASE.fullmatch(args.version or ''):
        raise Stop(f'--version must be a release version X.Y.Z, but is {args.version!r}')
    if not args.interval > 0:
        raise Stop(f'--interval must be greater than 0, but is {args.interval}')
    if not args.deadline > 0:
        raise Stop(f'--deadline must be greater than 0, but is {args.deadline}')
    best = Reading(ABSENT)
    attempt = 0
    while True:
        attempt += 1
        reading = read_packument(http(packument_url(), deadline, headers={'Accept': 'application/json'}),
                                 args.version, args.provenance)
        if reading.state == READY:
            print(f'npm serves {PACKAGE}@{args.version} with dist-tags.latest {json.dumps(reading.latest)}'
                  f'{" and a provenance attestation" if args.provenance else ""} (attempt {attempt})')
            return 0
        if reading.state >= best.state:
            best = reading
        print(f'{describe(reading, args.version)} (attempt {attempt})')
        if deadline.remaining() <= 0:
            raise Stop(timeout_message(best, args.version, args.deadline))
        sleep(min(args.interval, deadline.remaining()))


def main(argv, sleep=time.sleep, clock=time.monotonic):
    parser = argparse.ArgumentParser(prog='npm-registry.py')
    commands = parser.add_subparsers(dest='command', required=True)
    con = commands.add_parser('confirm')
    con.add_argument('--version', required=True)
    con.add_argument('--provenance', action='store_true')
    con.add_argument('--interval', type=float, default=20)
    con.add_argument('--deadline', type=float, default=900)
    args = parser.parse_args(argv[1:])
    try:
        return confirm(args, Deadline(args.deadline, clock), sleep)
    except Stop as error:
        print(f'::error::{error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
