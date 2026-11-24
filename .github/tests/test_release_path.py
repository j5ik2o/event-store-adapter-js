import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


GITHUB = Path(__file__).resolve().parents[1]
GATE_SCRIPT = GITHUB / 'release-gate.py'
BUMP = (GITHUB / 'workflows/bump-version.yml').read_text()
RELEASE = (GITHUB / 'workflows/release.yml').read_text()
REPOSITORY = 'o/r'
PACKAGE = 'packages/library/package.json'

spec = importlib.util.spec_from_file_location('release_gate', GATE_SCRIPT)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


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


class ReleaseWorkflowShapeTest(unittest.TestCase):
    def test_nothing_is_pushed_to_main(self):
        pushes = re.findall(r'git push [^\n]*', BUMP + RELEASE)
        self.assertEqual(pushes, [
            'git push origin "HEAD:refs/heads/${BRANCH}"',
            'git push origin "refs/tags/${RELEASE_TAG}"; then',
        ])
        self.assertIn('BRANCH="release/${NEXT_TAG}"', BUMP)

    def test_triggers(self):
        self.assertNotIn('pull_request:', BUMP)
        self.assertNotIn('pull_request_target', BUMP + RELEASE)
        self.assertTrue(BUMP.startswith(
            'name: Bump-Version\non:\n  push:\n    branches:\n      - main\n'
            '    paths:\n      - packages/library/package.json\n  workflow_dispatch:\n'))
        self.assertIn(
            "if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'",
            job(BUMP, 'bump-version'))
        self.assertIn(
            "if: github.event_name == 'push' && github.ref == 'refs/heads/main'"
            " && github.repository == 'j5ik2o/event-store-adapter-js'",
            job(BUMP, 'tag-release'))

    def test_pat_is_given_only_to_the_steps_that_push_or_open_the_pull_request(self):
        pat = '${{ secrets.PERSONAL_ACCESS_TOKEN }}'
        self.assertEqual(BUMP.count(pat), 3)
        for step_id in ('version_commit', 'version_pr', 'release_tag'):
            with self.subTest(step=step_id):
                self.assertIn(pat, step(BUMP, step_id))
        self.assertNotIn(pat, RELEASE)
        self.assertNotIn('persist-credentials: true', BUMP + RELEASE)

    def test_no_expression_is_expanded_inside_scripts(self):
        for block in run_blocks(BUMP) + run_blocks(RELEASE):
            self.assertNotIn('${{', block)

    def test_tag_and_publish_are_serialized(self):
        self.assertIn('    concurrency:\n      group: release-tag\n      cancel-in-progress: false\n',
                      job(BUMP, 'tag-release'))
        self.assertIn('concurrency:\n  group: release-publish\n  cancel-in-progress: false\n', RELEASE)

    def test_tag_is_pushed_only_after_the_gate(self):
        tag_job = job(BUMP, 'tag-release')
        self.assertLess(tag_job.index('id: trigger'), tag_job.index('id: release_tag'))
        self.assertIn("if: steps.trigger.outputs.tag != ''", step(BUMP, 'release_tag'))
        self.assertIn('--mode tag', run_body(BUMP, 'trigger'))

    def test_publish_is_guarded_on_both_sides(self):
        release = job(RELEASE, 'release')
        publish = release.index('publish --access public')
        for step_id in ('package_version', 'release_gate', 'npm_before'):
            with self.subTest(step=step_id):
                self.assertLess(release.index('id: ' + step_id), publish)
                self.assertNotIn('        if:', step(RELEASE, step_id))
        self.assertLess(publish, release.index('id: npm_after'))
        self.assertIn('--mode publish', run_body(RELEASE, 'release_gate'))
        self.assertIn('    needs: release\n', job(RELEASE, 'github-release'))
        self.assertIn(
            "if: github.event_name == 'workflow_dispatch'\n        run: echo 'PNPM_CONFIG_PROVENANCE=false'",
            RELEASE)


class ReleaseRehearsalTest(unittest.TestCase):
    """bare のリモートに対して、版の枝 → squash 相当のマージ → 関門 → タグ → 公開の関門までを手元で通す。"""

    def setUp(self):
        self.directory = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.directory)
        self.remote = self.directory / 'remote.git'
        self.work = self.directory / 'work'
        fake_bin = self.directory / 'bin'
        fake_bin.mkdir()
        (fake_bin / 'gh').write_text('#!/bin/sh\ncat "$FAKE_PULLS"\n')
        (fake_bin / 'gh').chmod(0o755)
        self.pulls = self.directory / 'pulls.json'
        self.pulls.write_text('[]')
        self.env = {
            **os.environ,
            'PATH': f'{fake_bin}{os.pathsep}{os.environ["PATH"]}',
            'FAKE_PULLS': str(self.pulls),
            'GIT_CONFIG_GLOBAL': str(self.directory / 'gitconfig'),
            'GIT_CONFIG_NOSYSTEM': '1',
            'RUNNER_TEMP': str(self.directory),
        }
        (self.directory / 'gitconfig').write_text(
            '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n')
        self.git(self.directory, 'init', '--bare', str(self.remote))
        self.git(self.directory, 'init', str(self.work))
        shutil.copytree(GITHUB, self.work / '.github', ignore=shutil.ignore_patterns('__pycache__', 'tests'))
        (self.work / 'pnpm-lock.yaml').write_text('lockfileVersion: 9.0\n')
        self.write_version(self.work, '5.2.0')
        self.git(self.work, 'add', '.')
        self.git(self.work, 'commit', '-m', 'version up to v5.2.0')
        self.git(self.work, 'tag', '-a', 'v5.2.0', '-m', 'v5.2.0')
        self.write_version(self.work, '5.2.1-snapshot.0')
        self.git(self.work, 'commit', '-am', '[skip ci] version up to 5.2.1-snapshot.0')
        (self.work / 'feature.txt').write_text('x\n')
        self.git(self.work, 'add', 'feature.txt')
        self.git(self.work, 'commit', '-m', 'feat: add a feature')
        self.git(self.work, 'remote', 'add', 'origin', str(self.remote))
        self.git(self.work, 'push', 'origin', 'main', '--tags')

    def git(self, cwd, *args):
        return subprocess.run(['git', *args], cwd=cwd, env=self.env, check=True, text=True,
                              capture_output=True).stdout.strip()

    def write_version(self, root, version, **extra):
        package = root / 'packages/library'
        package.mkdir(parents=True, exist_ok=True)
        (package / 'package.json').write_text(
            json.dumps({'name': 'event-store-adapter-js', 'version': version, **extra}, indent=2) + '\n')

    def step(self, workflow, step_id, cwd, **env):
        output = self.directory / ('output-' + step_id)
        output.write_text('')
        result = subprocess.run(
            ['bash', '-e', '-o', 'pipefail', '-c', run_body(workflow, step_id)], cwd=cwd,
            env={**self.env, 'GITHUB_WORKSPACE': str(cwd), 'GITHUB_OUTPUT': str(output),
                 'GITHUB_REPOSITORY': REPOSITORY, 'SERVER_URL': 'https://github.com',
                 'PUSH_TOKEN': 'dummy', **env},
            capture_output=True, text=True,
        )
        return result, outputs(output)

    def remote_ref(self, ref):
        return self.git(self.remote, 'rev-parse', ref)

    def clone(self, ref='main'):
        target = Path(tempfile.mkdtemp(dir=self.directory)) / 'clone'
        self.git(self.directory, 'clone', str(self.remote), str(target))
        self.git(target, 'checkout', ref)
        return target

    def open_version_branch(self):
        result, out = self.step(BUMP, 'version_branch', self.work, NEXT_TAG='v5.3.0')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(out, {'branch': 'release/v5.3.0'})
        result, _ = self.step(BUMP, 'version_commit', self.work, NEXT_VERSION='5.3.0',
                              NEXT_TAG='v5.3.0', BRANCH=out['branch'])
        self.assertEqual(result.returncode, 0, result.stderr)

    def squash_merge(self, ref='release/v5.3.0'):
        merged = self.clone()
        self.git(merged, 'merge', '--squash', 'origin/' + ref)
        self.git(merged, 'commit', '-m', 'version up to v5.3.0 (#1)')
        self.git(merged, 'push', 'origin', 'main')
        sha = self.git(merged, 'rev-parse', 'HEAD')
        self.pulls.write_text(json.dumps([pull(sha, ref=ref)]))
        return sha

    def trigger(self, sha):
        return self.step(BUMP, 'trigger', self.clone(sha), RELEASE_SHA=sha)

    def push_tag(self, tag, sha, cwd=None):
        return self.step(BUMP, 'release_tag', cwd or self.clone(sha), RELEASE_TAG=tag, RELEASE_SHA=sha)

    def publish_gate(self, tag):
        return self.step(RELEASE, 'release_gate', self.clone(tag), RELEASE_TAG=tag)[0]

    def test_version_branch_changes_only_the_version_and_leaves_main(self):
        main_before = self.remote_ref('main')
        self.open_version_branch()
        self.assertEqual(self.remote_ref('main'), main_before)
        branch = self.remote_ref('release/v5.3.0')
        self.assertEqual(self.git(self.remote, 'rev-parse', branch + '^'), main_before)
        self.assertEqual(self.git(self.remote, 'diff', '--name-only', main_before, branch), PACKAGE)
        package = json.loads(self.git(self.remote, 'show', branch + ':' + PACKAGE))
        self.assertEqual(package['version'], '5.3.0')
        self.assertEqual(self.git(self.remote, 'log', '-1', '--format=%s', branch), 'version up to v5.3.0')

    def test_existing_version_branch_stops_a_second_run(self):
        self.open_version_branch()
        result, out = self.step(BUMP, 'version_branch', self.work, NEXT_TAG='v5.3.0')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('already exists', result.stdout)
        self.assertEqual(out, {})

    def test_pull_request_body_previews_the_release_notes(self):
        result, out = self.step(BUMP, 'pr_body', self.work, PREV_TAG='v5.2.0', NEXT_VERSION='5.3.0',
                                NEXT_TAG='v5.3.0')
        self.assertEqual(result.returncode, 0, result.stderr)
        body = Path(out['path']).read_text()
        self.assertIn('Bump `packages/library/package.json` to `5.3.0`', body)
        self.assertIn('[5.3.0](https://github.com/o/r/compare/v5.2.0...v5.3.0)', body)
        self.assertIn('add a feature', body)

    def test_previous_tag_is_the_latest_stable_tag(self):
        self.git(self.work, 'tag', 'v9.0.0-rc.1')
        self.git(self.work, 'tag', 'not-a-version')
        result, out = self.step(BUMP, 'defines', self.work)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(out, {'prev_tag': 'v5.2.0'})

    def test_merged_version_pull_request_is_tagged_once_and_passes_the_publish_gate(self):
        self.open_version_branch()
        branch_commit = self.remote_ref('release/v5.3.0')
        after = self.squash_merge()
        self.assertNotEqual(after, branch_commit)

        result, out = self.trigger(after)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(out['tag'], 'v5.3.0')
        result, _ = self.push_tag('v5.3.0', after)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.remote_ref('v5.3.0^{commit}'), after)

        result, out = self.trigger(after)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(out['tag'], '')

        result = self.publish_gate('v5.3.0')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_tag_pushed_by_a_concurrent_run_on_the_same_commit_is_accepted(self):
        self.open_version_branch()
        after = self.squash_merge()
        runner = self.clone(after)
        other = self.clone(after)
        self.git(other, 'tag', '-a', 'v5.3.0', '-m', 'v5.3.0 from another run')
        self.git(other, 'push', 'origin', 'v5.3.0')
        result, _ = self.push_tag('v5.3.0', after, cwd=runner)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('pushed by another run', result.stdout)

    def test_tag_on_another_commit_fails(self):
        self.open_version_branch()
        before = self.remote_ref('main')
        after = self.squash_merge()
        other = self.clone(before)
        self.git(other, 'tag', '-a', 'v5.3.0', '-m', 'v5.3.0')
        self.git(other, 'push', 'origin', 'v5.3.0')
        result, _ = self.trigger(after)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('already exists on another commit', result.stderr)
        result, _ = self.push_tag('v5.3.0', after)
        self.assertNotEqual(result.returncode, 0)

    def test_version_changed_by_another_pull_request_is_not_tagged(self):
        work = self.clone()
        self.git(work, 'switch', '-c', 'feature/x')
        self.write_version(work, '5.3.0')
        self.git(work, 'commit', '-am', 'feat: bump by hand')
        self.git(work, 'push', 'origin', 'feature/x')
        after = self.squash_merge('feature/x')
        result, out = self.trigger(after)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('is not the squash merge', result.stderr)
        self.assertEqual(out, {})

    def test_push_without_a_version_change_is_not_tagged(self):
        self.write_version(self.work, '5.2.1-snapshot.0', dependencies={'x': '1.0.0'})
        self.git(self.work, 'commit', '-am', 'chore(deps): add x')
        self.git(self.work, 'push', 'origin', 'main')
        result, out = self.trigger(self.remote_ref('main'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(out['tag'], '')

    def test_hand_made_tag_on_an_unapproved_commit_is_not_published(self):
        work = self.clone()
        self.write_version(work, '5.3.0')
        self.git(work, 'commit', '-am', 'version up to v5.3.0')
        self.git(work, 'tag', '-a', 'v5.3.0', '-m', 'v5.3.0')
        self.git(work, 'push', 'origin', 'v5.3.0')
        result = self.publish_gate('v5.3.0')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('is not reachable from main', result.stderr)

    def test_older_tag_is_not_published_again(self):
        self.open_version_branch()
        after = self.squash_merge()
        self.push_tag('v5.3.0', after)
        work = self.clone()
        self.git(work, 'tag', '-a', 'v5.4.0', '-m', 'v5.4.0')
        self.git(work, 'push', 'origin', 'v5.4.0')
        result = self.publish_gate('v5.3.0')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('must be greater than the latest tag v5.4.0', result.stderr)


if __name__ == '__main__':
    unittest.main()
