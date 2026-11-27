"""npm-registry.py の性質を Hypothesis で確かめる（#1161 の設計 3.2 の P1〜P6。除外は付けない）。"""
import argparse
import contextlib
import io
import json
import unittest
from unittest import mock

import semver
from hypothesis import given, settings
from hypothesis import strategies as st

from release_test_support import load_npm_registry

npm = load_npm_registry()
SETTINGS = settings(max_examples=300, deadline=None, database=None)
URL = 'https://registry.npmjs.org/event-store-adapter-js'
MISSING = object()   # dist-tags に latest の鍵が無い

release_versions = st.builds(lambda *parts: '.'.join(map(str, parts)),
                             st.integers(0, 12), st.integers(0, 12), st.integers(0, 12))
prereleases = st.builds(lambda v, p: f'{v}-{p}', release_versions,
                        st.sampled_from(['rc.1', 'snapshot.5559.1', '0', 'alpha']))
broken = st.sampled_from(['', 'v5.3.0', '5.3', '05.3.0', '5.3.0 ', 'latest', '5.3.0+build.1', '5.3.0.1'])
latests = st.one_of(release_versions, prereleases, broken, st.just(None), st.just(MISSING), st.integers(0, 9))
bodies = st.fixed_dictionaries({
    'has_version': st.booleans(), 'latest': latests, 'provenance': st.booleans(), 'dist_tags': st.booleans()})
failures = st.sampled_from([('status', 404), ('status', 500), ('status', 503), ('status', 429), ('status', 403),
                            ('cut', None), ('not_json', None)])
replies = st.one_of(st.tuples(st.just('body'), bodies), failures)
json_values = st.recursive(
    st.one_of(st.none(), st.booleans(), st.integers(), st.text(max_size=8)),
    lambda inner: st.one_of(st.lists(inner, max_size=3), st.dictionaries(
        st.sampled_from(['versions', 'dist-tags', 'latest', 'dist', 'attestations', 'provenance', 'predicateType',
                         '5.3.1']), inner, max_size=3)),
    max_leaves=12)


def packument(spec, version):
    entry = {'version': version, 'dist': {'tarball': 'https://example.invalid/x.tgz'}}
    if spec['provenance']:
        entry['dist']['attestations'] = {'provenance': {'predicateType': 'https://slsa.dev/provenance/v1'}}
    body = {'name': npm.PACKAGE, 'versions': {version: entry} if spec['has_version'] else {'0.0.0-placeholder': {}}}
    if spec['dist_tags']:
        body['dist-tags'] = {} if spec['latest'] is MISSING else {'latest': spec['latest']}
    return json.dumps(body).encode()


def expected_state(spec, version, provenance):
    """npm-registry.py とは別に、semver で決める期待の状態。"""
    if not spec['has_version']:
        return npm.ABSENT
    latest = spec['latest'] if spec['dist_tags'] else MISSING
    try:
        parsed = semver.Version.parse(latest) if isinstance(latest, str) else None
    except ValueError:
        parsed = None
    if parsed is None or parsed.prerelease or parsed.build or parsed < semver.Version.parse(version):
        return npm.STALE_LATEST
    if provenance and not spec['provenance']:
        return npm.NO_PROVENANCE
    return npm.READY


class FakeNetwork:
    """照会のたびに時計を進める偽の http。script は (応答, 所要時間) の列。packument の URL だけを受け付ける。"""

    def __init__(self, script, version, provenance):
        self.script, self.version, self.provenance = list(script), version, provenance
        self.now = 0.0
        self.calls = 0
        self.seen = []   # 締め切りの中で返った応答の (期待の状態, latest)

    def clock(self):
        return self.now

    def sleep(self, seconds):
        assert seconds >= 0
        self.now += seconds

    def http(self, url, deadline, timeout=60, headers=None):
        assert url == URL, url
        left = deadline.remaining()
        if left <= 0:
            return npm.Response(None)
        reply, duration = self.script[self.calls % len(self.script)] if self.script else (('status', 404), 1.0)
        self.calls += 1
        self.now += min(duration, timeout, left)
        if duration > min(timeout, left):
            return npm.Response(None)   # 時間切れ
        kind, value = reply
        if kind == 'body':
            latest = value['latest'] if value['dist_tags'] and value['latest'] is not MISSING else None
            self.seen.append((expected_state(value, self.version, self.provenance), latest))
            return npm.Response(200, packument(value, self.version))
        self.seen.append((npm.ABSENT, None))
        if kind == 'status':
            return npm.Response(value, b'{"error":"not found"}')
        if kind == 'not_json':
            return npm.Response(200, b'{"versions": {')
        return npm.Response(None)   # 本文の途中の切断


def run_confirm(script, version, limit, interval, provenance):
    network = FakeNetwork(script, version, provenance)
    args = argparse.Namespace(version=version, provenance=provenance, interval=interval, deadline=limit)
    with mock.patch.object(npm, 'http', network.http), contextlib.redirect_stdout(io.StringIO()):
        try:
            npm.confirm(args, npm.Deadline(limit, network.clock), network.sleep)
            return network, None
        except npm.Stop as error:
            return network, str(error)


class ConfirmProperties(unittest.TestCase):
    @SETTINGS
    @given(st.lists(st.tuples(replies, st.floats(0, 200, allow_nan=False)), max_size=12), release_versions,
           st.floats(1, 900, allow_nan=False), st.floats(0.1, 120, allow_nan=False), st.booleans())
    def test_p1_to_p5_confirm_stays_within_the_deadline_and_succeeds_exactly_when_it_read_a_ready_reply(
            self, script, version, limit, interval, provenance):
        network, error = run_confirm(script, version, limit, interval, provenance)
        # P1：締め切りを越えない
        self.assertLessEqual(network.now, limit + 1e-6)
        states = [state for state, _ in network.seen]
        # P2・P3・P5：成功は、締め切りの中で通る条件の応答を読んだときだけ。読んだなら成功（そこで止まる）
        if error is None:
            self.assertEqual(states[-1], npm.READY)
            self.assertEqual(states.count(npm.READY), 1)
            return
        self.assertNotIn(npm.READY, states)
        # P4：時間切れの文は、読めた中でいちばん進んだ状態で決まる。秒数は --deadline から
        best = max(states, default=npm.ABSENT)
        self.assertIn(f'{limit:g} seconds', error)
        self.assertNotIn('\n', error)
        if best == npm.ABSENT:
            self.assertIn(f'npm did not serve event-store-adapter-js@{version} within', error)
            self.assertIn('may have been published', error)
            self.assertIn('re-run only the failed jobs', error)
        elif best == npm.STALE_LATEST:
            latest = [latest for state, latest in network.seen if state == best][-1]
            self.assertIn(f'dist-tags.latest is still {json.dumps(latest)} after', error)
        else:
            self.assertIn('has no provenance attestation', error)

    @SETTINGS
    @given(st.one_of(
        st.tuples(release_versions, st.floats(-100, 0, allow_nan=False), st.floats(1, 900, allow_nan=False)),
        st.tuples(release_versions, st.just(float('nan')), st.floats(1, 900, allow_nan=False)),
        st.tuples(st.one_of(prereleases, broken, release_versions.map(lambda v: 'v' + v), st.text(max_size=12)),
                  st.floats(0.1, 120, allow_nan=False), st.floats(1, 900, allow_nan=False)),
        st.tuples(release_versions, st.floats(0.1, 120, allow_nan=False), st.floats(-100, 0, allow_nan=False))))
    def test_p6_bad_arguments_stop_without_a_query(self, arguments):
        version, interval, limit = arguments
        if npm.RELEASE.fullmatch(version) and interval > 0 and limit > 0:
            return   # st.text が正式版を作った場合
        network, error = run_confirm([], version, limit, interval, False)
        self.assertIsNotNone(error)
        self.assertEqual(network.calls, 0)


class ReadPackumentProperties(unittest.TestCase):
    @SETTINGS
    @given(bodies, release_versions, st.booleans())
    def test_the_state_matches_semver(self, spec, version, provenance):
        """latest は semver の優先順位で比べ（5.10.0 > 5.9.0）、正式版でない latest は通さない。"""
        reading = npm.read_packument(npm.Response(200, packument(spec, version)), version, provenance)
        self.assertEqual(reading.state, expected_state(spec, version, provenance))

    @SETTINGS
    @given(json_values, st.booleans())
    def test_any_json_body_reads_without_an_exception(self, value, provenance):
        """壊れた本文（型の違う値、欠けた鍵）では例外で落ちず、読み直す状態を返す。"""
        reading = npm.read_packument(npm.Response(200, json.dumps(value).encode()), '5.3.1', provenance)
        self.assertIn(reading.state, (npm.ABSENT, npm.STALE_LATEST, npm.NO_PROVENANCE, npm.READY))

    @SETTINGS
    @given(st.binary(max_size=40), st.one_of(st.none(), st.integers(100, 599)))
    def test_a_reply_other_than_a_json_200_reads_as_absent(self, body, code):
        if code == 200:
            return
        self.assertEqual(npm.read_packument(npm.Response(code, body), '5.3.1', False).state, npm.ABSENT)


if __name__ == '__main__':
    unittest.main()
