"""npm-registry.py の決まった例（#1161）。手元の HTTP のスタブを叩く。"""
import os
import subprocess
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

from release_test_support import GITHUB, LOOPBACK, NpmStub, load_npm_registry, packument

npm = load_npm_registry()


def read(body, version='5.3.1', provenance=True):
    return npm.read_packument(npm.Response(200, body), version, provenance)


class ReadPackumentTest(unittest.TestCase):
    def test_the_version_as_latest_with_provenance_is_ready(self):
        self.assertEqual(read(packument('5.3.1', '5.3.1')), npm.Reading(npm.READY, '5.3.1'))

    def test_a_newer_latest_passes(self):
        """時間切れのあとに次の版が先に出た場合（latest ≥ 版なら通す）。"""
        self.assertEqual(read(packument('5.3.1', '5.4.0')).state, npm.READY)

    def test_versions_are_compared_as_numbers(self):
        self.assertEqual(read(packument('5.9.0', '5.10.0'), '5.9.0').state, npm.READY)
        self.assertEqual(read(packument('5.10.0', '5.9.0'), '5.10.0').state, npm.STALE_LATEST)

    def test_an_older_prerelease_or_missing_latest_is_stale(self):
        for latest in ('5.3.0', '5.3.1-snapshot.5559.1', '5.4.0-rc.1', None):
            with self.subTest(latest=latest):
                self.assertEqual(read(packument('5.3.1', latest)), npm.Reading(npm.STALE_LATEST, latest))

    def test_provenance_is_required_only_when_asked(self):
        body = packument('5.3.1', '5.3.1', provenance=False)
        self.assertEqual(read(body).state, npm.NO_PROVENANCE)
        self.assertEqual(read(body, provenance=False).state, npm.READY)

    def test_a_missing_version_or_a_failed_query_is_absent(self):
        self.assertEqual(read(packument(None, '5.3.0')).state, npm.ABSENT)
        for response in (npm.Response(None), npm.Response(404, b'{"error":"Not found"}'), npm.Response(503),
                         npm.Response(429), npm.Response(200, b'<html>'), npm.Response(200, b'[]')):
            with self.subTest(response=response):
                self.assertEqual(npm.read_packument(response, '5.3.1', True).state, npm.ABSENT)


class TimeoutMessageTest(unittest.TestCase):
    def test_each_state_has_its_message(self):
        self.assertEqual(
            npm.timeout_message(npm.Reading(npm.ABSENT), '5.3.1', 900.0),
            'npm did not serve event-store-adapter-js@5.3.1 within 900 seconds. The package may have been published: '
            'check with npm view event-store-adapter-js@5.3.1 version dist-tags dist.attestations, then re-run only '
            'the failed jobs of this run (the confirm job). Do not re-run all jobs and do not publish again.')
        self.assertEqual(
            npm.timeout_message(npm.Reading(npm.STALE_LATEST, '5.3.0'), '5.3.1', 900.0),
            'npm serves event-store-adapter-js@5.3.1, but dist-tags.latest is still "5.3.0" after 900 seconds. '
            'Re-run only the failed jobs; if latest stays older, fix it with npm dist-tag add '
            'event-store-adapter-js@5.3.1 latest (see CONTRIBUTING).')
        self.assertEqual(
            npm.timeout_message(npm.Reading(npm.NO_PROVENANCE, '5.3.1'), '5.3.1', 900.0),
            'event-store-adapter-js@5.3.1 has no provenance attestation after 900 seconds. Re-run only the failed '
            'jobs; if it stays missing, see CONTRIBUTING (When a release stops halfway).')

    def test_a_latest_with_a_line_break_stays_on_one_line(self):
        message = npm.timeout_message(npm.Reading(npm.STALE_LATEST, '5.3.0\n::error::x'), '5.3.1', 1.5)
        self.assertNotIn('\n', message)
        self.assertIn('after 1.5 seconds', message)


class HttpTest(unittest.TestCase):
    def setUp(self):
        self.no_proxy = mock.patch.dict(os.environ, {'no_proxy': LOOPBACK, 'NO_PROXY': LOOPBACK})
        self.no_proxy.start()
        self.addCleanup(self.no_proxy.stop)

    def test_no_request_is_sent_after_the_deadline(self):
        stub = NpmStub([(200, b'{}')])
        self.addCleanup(stub.close)
        clock = [0.0]
        deadline = npm.Deadline(10, lambda: clock[0])
        clock[0] = 10
        self.assertEqual(npm.http(stub.url + '/x', deadline), npm.Response(None))
        self.assertEqual(stub.requests, [])

    def test_the_timeout_is_cut_to_the_remaining_time(self):
        seen = []

        def urlopen(request, timeout):
            seen.append(timeout)
            raise TimeoutError()
        clock = [0.0]
        deadline = npm.Deadline(100, lambda: clock[0])
        clock[0] = 97.5
        with mock.patch.object(npm.urllib.request, 'urlopen', urlopen):
            self.assertEqual(npm.http('http://127.0.0.1:9/x', deadline), npm.Response(None))
        self.assertEqual(seen, [2.5])

    def test_an_error_status_keeps_its_code(self):
        stub = NpmStub([(404, b'{"error":"Not found"}')])
        self.addCleanup(stub.close)
        self.assertEqual(npm.http(stub.url + '/x', npm.Deadline(10)), npm.Response(404, b'{"error":"Not found"}'))

    def test_a_trickling_body_is_cut_at_the_deadline(self):
        for mode in ('length', 'error', 'chunked'):
            with self.subTest(mode):
                server = TrickleServer(mode)
                self.addCleanup(server.close)
                started = time.monotonic()
                result = npm.http(server.url, npm.Deadline(1.0))
                elapsed = time.monotonic() - started
                self.assertEqual(result, npm.Response(None))
                self.assertLess(elapsed, 2.5, mode)

    def test_a_body_that_arrives_in_time_is_read(self):
        server = TrickleServer('length', every=0.01, total=0.2)
        self.addCleanup(server.close)
        self.assertEqual(npm.http(server.url, npm.Deadline(10)), npm.Response(200, b'x' * 20))


class TrickleServer:
    """少しずつ送り続ける HTTP サーバー。mode は 'length'（200、Content-Length つきの本文を 1 バイトずつ）、
    'error'（404 で同じ）、'chunked'（200、chunked の長さの行を 1 文字ずつ。1回の read1 の中で何度も受信させる）。"""

    def __init__(self, mode, every=0.05, total=8.0):
        stop = self.stop = threading.Event()

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *args):
                pass

            def do_GET(self):
                count = int(total / every)
                self.send_response(404 if mode == 'error' else 200)
                if mode == 'chunked':
                    self.send_header('Transfer-Encoding', 'chunked')
                else:
                    self.send_header('Content-Length', str(count))
                self.end_headers()
                self.wfile.flush()
                try:
                    if mode == 'chunked':
                        self.wfile.write(b'1;')
                    for _ in range(count):
                        if stop.wait(every):
                            return
                        self.wfile.write(b'x')
                        self.wfile.flush()
                except OSError:
                    pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}/x'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.stop.set()
        self.server.shutdown()
        self.server.server_close()


class WatchdogTest(unittest.TestCase):
    def test_a_socket_that_cannot_be_shut_down_fails_the_query(self):
        class Broken:
            def fileno(self):
                return 3

            def shutdown(self, how):
                raise OSError(107, 'Transport endpoint is not connected')
        watchdog = npm.Watchdog(Broken(), 60)
        watchdog.cancel()
        watchdog.fire()
        with self.assertRaises(TimeoutError):
            watchdog.raise_failure()

    def test_a_closed_socket_is_left_alone(self):
        class Closed:
            def fileno(self):
                return -1

            def shutdown(self, how):
                raise AssertionError('a closed socket must not be shut down')
        watchdog = npm.Watchdog(Closed(), 60)
        watchdog.cancel()
        watchdog.fire()
        watchdog.raise_failure()


class ConfirmTest(unittest.TestCase):
    def run_script(self, stub, *args):
        env = {**os.environ, 'NPM_REGISTRY_URL': stub.url, 'no_proxy': LOOPBACK, 'NO_PROXY': LOOPBACK}
        return subprocess.run([sys.executable, str(GITHUB / 'npm-registry.py'), 'confirm', *args], env=env,
                              capture_output=True, text=True)

    def stub(self, replies):
        stub = NpmStub(replies)
        self.addCleanup(stub.close)
        return stub

    def test_the_version_is_read_with_get_only_from_the_packument(self):
        stub = self.stub([(404, b'{}'), (200, packument('5.3.1', '5.3.1'))])
        result = self.run_script(stub, '--version', '5.3.1', '--provenance', '--deadline', '5', '--interval', '0.05')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('(attempt 2)', result.stdout)
        self.assertEqual([(method, path) for method, path, _ in stub.requests],
                         [('GET', '/event-store-adapter-js')] * 2)
        headers = stub.requests[0][2]
        self.assertEqual(headers.get('Accept'), 'application/json')
        self.assertNotIn('Cache-Control', headers)

    def test_a_version_that_does_not_appear_times_out(self):
        stub = self.stub([(200, packument(None, '5.3.0'))])
        result = self.run_script(stub, '--version', '5.3.1', '--deadline', '0.5', '--interval', '0.1')
        self.assertEqual(result.returncode, 1)
        self.assertTrue(result.stderr.startswith('::error::npm did not serve event-store-adapter-js@5.3.1 within '
                                                 '0.5 seconds.'), result.stderr)

    def test_the_most_advanced_reading_decides_the_message(self):
        """版を一度返したあとに CDN の端が古い応答を返しても、文は「latest が古い」の行になる。"""
        stub = self.stub([(200, packument('5.3.1', '5.3.0')), (503, b''), (200, packument(None, '5.3.0'))])
        result = self.run_script(stub, '--version', '5.3.1', '--deadline', '0.5', '--interval', '0.1')
        self.assertEqual(result.returncode, 1)
        self.assertIn('dist-tags.latest is still "5.3.0" after 0.5 seconds', result.stderr)

    def test_bad_arguments_stop_before_a_query(self):
        stub = self.stub([(200, packument('5.3.1', '5.3.1'))])
        for args in (('--version', 'v5.3.1'), ('--version', '5.3.1-rc.1'), ('--version', '5.3.1', '--interval', '0'),
                     ('--version', '5.3.1', '--deadline', '0')):
            with self.subTest(args=args):
                result = self.run_script(stub, *args)
                self.assertEqual(result.returncode, 1)
                self.assertTrue(result.stderr.startswith('::error::--'), result.stderr)
        self.assertEqual(stub.requests, [])


if __name__ == '__main__':
    unittest.main()
