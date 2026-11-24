import subprocess
import sys
import unittest

from release_test_support import GATE_SCRIPT, PACKAGE, REPOSITORY, gate, pull


class ReleaseGateTest(unittest.TestCase):
    SHA = 'a' * 40
    PARENT = {'name': 'event-store-adapter-js', 'version': '5.2.1-snapshot.0'}
    TARGET = {'name': 'event-store-adapter-js', 'version': '5.3.0'}

    def check(self, mode='tag', parent=None, package=None, changed=(PACKAGE,), pulls=None,
              tags=None, on_main=True, tag=None):
        candidate = gate.Candidate(
            repository=REPOSITORY, sha=self.SHA, parent=parent or self.PARENT, package=package or self.TARGET,
            changed_files=tuple(changed), pulls=tuple([pull(self.SHA)] if pulls is None else pulls),
            tags={'v5.1.0': 'b' * 40, 'v5.2.0': 'c' * 40} if tags is None else tags, on_main=on_main,
        )
        return gate.check_candidate(mode, candidate, tag)

    def assert_rejected(self, message, **kwargs):
        with self.assertRaises(gate.GateError) as raised:
            self.check(**kwargs)
        self.assertIn(message, str(raised.exception))

    def test_squash_of_the_version_pull_request_is_tagged(self):
        self.assertEqual(self.check(), 'v5.3.0')
        self.assertEqual(self.check(parent={**self.PARENT, 'version': '5.2.0'}), 'v5.3.0')

    def test_unchanged_version_is_skipped(self):
        same = {**self.PARENT, 'dependencies': {'x': '1.0.0'}}
        self.assertIsNone(self.check(parent=self.PARENT, package=same, changed=(PACKAGE,), pulls=[]))

    def test_version_changed_by_another_pull_request_fails(self):
        self.assert_rejected('is not the squash merge', pulls=[pull(self.SHA, ref='feature/x')])
        self.assert_rejected('is not the squash merge', pulls=[])

    def test_fork_pull_request_fails(self):
        self.assert_rejected('is not the squash merge', pulls=[pull(self.SHA, repo='someone/r')])
        self.assert_rejected('is not the squash merge', pulls=[{**pull(self.SHA), 'head': {'ref': 'release/v5.3.0', 'repo': None}}])

    def test_unmerged_or_other_commit_fails(self):
        self.assert_rejected('is not the squash merge', pulls=[pull(self.SHA, merged=False)])
        self.assert_rejected('is not the squash merge', pulls=[pull('d' * 40)])
        self.assert_rejected('is not the squash merge', pulls=[pull(self.SHA, base='develop')])

    def test_other_changes_fail(self):
        self.assert_rejected('must change only packages/library/package.json',
                             changed=(PACKAGE, 'packages/library/src/index.ts'))
        self.assert_rejected('must change only the version',
                             package={**self.TARGET, 'dependencies': {'x': '1.0.0'}})

    def test_downgrade_fails(self):
        self.assert_rejected('must be greater than the previous version 5.3.1',
                             parent={**self.PARENT, 'version': '5.3.1'})
        self.assert_rejected('must be greater than the previous version',
                             parent={**self.PARENT, 'version': '5.3.0-snapshot.0'},
                             package={**self.TARGET, 'version': '5.2.9'}, pulls=[pull(self.SHA, ref='release/v5.2.9')])

    def test_unknown_previous_version_fails(self):
        self.assert_rejected('must be greater than the previous version None',
                             parent={'name': 'event-store-adapter-js'})

    def test_version_not_above_the_latest_tag_fails(self):
        self.assert_rejected('must be greater than the latest tag v5.4.0',
                             tags={'v5.4.0': 'b' * 40})

    def test_non_release_target_is_not_tagged(self):
        for version in ('5.3.1-snapshot.0', '5.4.0-rc.1', '05.4.0'):
            with self.subTest(version=version):
                self.assertIsNone(self.check(parent={**self.PARENT, 'version': '5.3.0'},
                                             package={**self.TARGET, 'version': version}, pulls=[]))
        self.assert_rejected('is not a release version', mode='publish',
                             package={**self.TARGET, 'version': '5.4.0-rc.1'}, tag='v5.4.0-rc.1')

    def test_commit_off_main_fails(self):
        self.assert_rejected('is not reachable from main', on_main=False)

    def test_existing_tag(self):
        self.assertIsNone(self.check(tags={'v5.2.0': 'c' * 40, 'v5.3.0': self.SHA}))
        self.assert_rejected('already exists on another commit', tags={'v5.3.0': 'e' * 40})

    def test_publish_mode(self):
        tags = {'v5.2.0': 'c' * 40, 'v5.3.0': self.SHA}
        self.assertEqual(self.check(mode='publish', tags=tags, tag='v5.3.0'), 'v5.3.0')
        self.assert_rejected('does not point at', mode='publish', tags={'v5.3.0': 'e' * 40}, tag='v5.3.0')
        self.assert_rejected('does not match the package version', mode='publish', tags=tags, tag='v5.3.1')
        self.assert_rejected('must be greater than the latest tag v5.4.0', mode='publish',
                             tags={**tags, 'v5.4.0': 'f' * 40}, tag='v5.3.0')
        self.assert_rejected('is not the squash merge', mode='publish', tags=tags, tag='v5.3.0',
                             pulls=[pull(self.SHA, ref='feature/x')])

    def test_latest_tag(self):
        names = ['v5.2.0', 'v5.10.0', 'v5.9.1', 'v6.0.0-rc.1', 'v$(id)', 'release', '5.11.0', 'v05.0.0']
        self.assertEqual(gate.latest_tag(names), 'v5.10.0')
        self.assertEqual(gate.latest_tag(names, below='5.10.0'), 'v5.9.1')
        self.assertIsNone(gate.latest_tag(names, below='5.2.0'))

    def test_remote_tags_use_the_peeled_commit(self):
        self.assertEqual(
            gate.remote_tags('1' * 40 + '\trefs/tags/v5.3.0\n' + '2' * 40 + '\trefs/tags/v5.3.0^{}\n'
                             + '3' * 40 + '\trefs/tags/v5.2.0\n'),
            {'v5.3.0': '2' * 40, 'v5.2.0': '3' * 40})

    def cli(self, *args, stdin=''):
        return subprocess.run([sys.executable, str(GATE_SCRIPT), *args], input=stdin,
                              text=True, capture_output=True, check=False)

    def test_cli(self):
        self.assertEqual(self.cli('latest-tag', stdin='v5.1.0\nv5.2.0\n').stdout, 'v5.2.0\n')
        self.assertEqual(self.cli('latest-tag', stdin='').stdout, '')
        self.assertEqual(self.cli('greater', '5.3.0', '5.2.0').returncode, 0)
        self.assertEqual(self.cli('greater', '5.2.0', '5.2.0').returncode, 1)
        self.assertEqual(self.cli('greater', '5.2.0', '5.10.0').returncode, 1)

if __name__ == '__main__':
    unittest.main()
