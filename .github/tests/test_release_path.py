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
TRIGGER = GITHUB / 'release-trigger.py'
BUMP = (GITHUB / 'workflows/bump-version.yml').read_text()
RELEASE = (GITHUB / 'workflows/release.yml').read_text()


def run_body(workflow, step):
    return re.search(
        r'id: ' + step + r'\n.*?        run: \|\n((?:          [^\n]*\n|\n)+)',
        workflow, re.DOTALL,
    ).group(1)


def job(workflow, name):
    start = workflow.index('\n  ' + name + ':\n')
    end = re.search(r'\n  [a-z-]+:\n', workflow[start + 1:])
    return workflow[start:start + 1 + end.start()] if end else workflow[start:]


def outputs(path):
    return dict(line.split('=', 1) for line in path.read_text().splitlines() if line)


class ReleaseTriggerTest(unittest.TestCase):
    def detect(self, before, after, tags=('v5.1.0', 'v5.2.0')):
        return subprocess.run(
            [sys.executable, str(TRIGGER), before, after], input='\n'.join(tags) + '\n',
            text=True, capture_output=True, check=False,
        )

    def assert_release(self, result, tag):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, tag + '\n')

    def assert_no_release(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '')
        self.assertIn('no release:', result.stderr)

    def test_snapshot_to_release_version(self):
        self.assert_release(self.detect('5.2.1-snapshot.0', '5.3.0'), 'v5.3.0')

    def test_release_to_release_version(self):
        self.assert_release(self.detect('5.2.0', '5.2.1'), 'v5.2.1')

    def test_without_previous_version_or_tags(self):
        self.assert_release(self.detect('', '5.3.0'), 'v5.3.0')
        self.assert_release(self.detect('5.2.1-snapshot.0', '5.3.0', tags=()), 'v5.3.0')

    def test_unchanged_version(self):
        for version in ('5.2.1-snapshot.0', '5.3.0'):
            with self.subTest(version=version):
                self.assert_no_release(self.detect(version, version, tags=('v5.2.0',)))

    def test_not_a_release_version(self):
        for after in ('5.3.1-snapshot.0', '5.4.0-rc.1', 'v5.4.0', '05.4.0', '5.4', '5.4.0+build'):
            with self.subTest(after=after):
                self.assert_no_release(self.detect('5.3.0', after))

    def test_existing_tag(self):
        self.assert_no_release(self.detect('5.2.1-snapshot.0', '5.2.0'))

    def test_version_not_greater_than_the_latest_tag_fails(self):
        for after in ('5.1.9', '4.0.0'):
            with self.subTest(after=after):
                result = self.detect('5.2.1-snapshot.0', after)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, '')
                self.assertIn('must be greater than the latest tag v5.2.0', result.stderr)

    def test_comparison_is_numeric(self):
        self.assert_release(self.detect('5.9.0', '5.10.0', tags=('v5.9.0',)), 'v5.10.0')


class ReleaseWorkflowShapeTest(unittest.TestCase):
    def test_nothing_is_pushed_to_main(self):
        pushes = re.findall(r'git push [^\n]*', BUMP + RELEASE)
        self.assertEqual(pushes, [
            'git push origin "HEAD:refs/heads/${BRANCH}"',
            'git push origin "refs/tags/${RELEASE_TAG}"',
        ])
        self.assertIn('BRANCH="release/${NEXT_TAG}"', BUMP)

    def test_triggers(self):
        self.assertNotIn('pull_request', BUMP)
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

    def test_tag_is_pushed_with_the_pat_only_after_detection(self):
        tag_job = job(BUMP, 'tag-release')
        self.assertIn('token: ${{ secrets.PERSONAL_ACCESS_TOKEN }}', tag_job)
        self.assertLess(tag_job.index('id: trigger'), tag_job.index('id: release_tag'))
        self.assertIn("if: steps.trigger.outputs.tag != ''", tag_job[tag_job.index('id: release_tag'):])

    def test_pull_request_is_opened_with_the_pat(self):
        step = BUMP[BUMP.index('id: version_pr'):]
        self.assertIn('GH_TOKEN: ${{ secrets.PERSONAL_ACCESS_TOKEN }}', step[:step.index('run: |')])

    def test_github_release_follows_publish(self):
        self.assertIn('    needs: release\n', job(RELEASE, 'github-release'))
        self.assertIn('publish --access public', job(RELEASE, 'release'))
        self.assertNotIn('publish', job(RELEASE, 'github-release').replace('github-release', ''))
        self.assertIn(
            "if: github.event_name == 'workflow_dispatch'\n        run: echo 'PNPM_CONFIG_PROVENANCE=false'",
            RELEASE)


class ReleaseRehearsalTest(unittest.TestCase):
    """bare のリモートに対して、版の枝 → squash 相当のマージ → タグまでを手元で通す。"""

    def setUp(self):
        self.directory = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.directory)
        self.remote = self.directory / 'remote.git'
        self.work = self.directory / 'work'
        self.env = {
            **os.environ,
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

    def write_version(self, root, version):
        package = root / 'packages/library'
        package.mkdir(parents=True, exist_ok=True)
        (package / 'package.json').write_text(json.dumps({'name': 'event-store-adapter-js', 'version': version}, indent=2) + '\n')

    def step(self, workflow, step_id, cwd, **env):
        output = self.directory / ('output-' + step_id)
        output.write_text('')
        result = subprocess.run(
            ['bash', '-e', '-o', 'pipefail', '-c', run_body(workflow, step_id)], cwd=cwd,
            env={**self.env, 'GITHUB_WORKSPACE': str(cwd), 'GITHUB_OUTPUT': str(output),
                 'GITHUB_REPOSITORY': 'o/r', **env},
            capture_output=True, text=True,
        )
        return result, outputs(output)

    def remote_ref(self, ref):
        return self.git(self.remote, 'rev-parse', ref)

    def open_version_branch(self):
        result, out = self.step(BUMP, 'version_branch', self.work, NEXT_TAG='v5.3.0')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(out, {'branch': 'release/v5.3.0'})
        result, _ = self.step(BUMP, 'version_commit', self.work, NEXT_VERSION='5.3.0',
                              NEXT_TAG='v5.3.0', BRANCH=out['branch'])
        self.assertEqual(result.returncode, 0, result.stderr)

    def squash_merge(self):
        merged = self.directory / 'merged'
        self.git(self.directory, 'clone', str(self.remote), str(merged))
        self.git(merged, 'merge', '--squash', 'origin/release/v5.3.0')
        self.git(merged, 'commit', '-m', 'version up to v5.3.0 (#1)')
        self.git(merged, 'push', 'origin', 'main')
        return self.git(merged, 'rev-parse', 'HEAD')

    def detect(self, before, after):
        runner = Path(tempfile.mkdtemp(dir=self.directory)) / 'runner'
        self.git(self.directory, 'clone', str(self.remote), str(runner))
        self.git(runner, 'checkout', after)
        shutil.copytree(GITHUB, runner / '.github', dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns('__pycache__', 'tests'))
        result, out = self.step(BUMP, 'trigger', runner, BEFORE_SHA=before, AFTER_SHA=after)
        self.assertEqual(result.returncode, 0, result.stderr)
        return runner, out['tag']

    def test_version_branch_changes_only_the_version_and_leaves_main(self):
        main_before = self.remote_ref('main')
        self.open_version_branch()
        self.assertEqual(self.remote_ref('main'), main_before)
        branch = self.remote_ref('release/v5.3.0')
        self.assertEqual(self.git(self.remote, 'rev-parse', branch + '^'), main_before)
        self.assertEqual(self.git(self.remote, 'diff', '--name-only', main_before, branch),
                         'packages/library/package.json')
        package = json.loads(self.git(self.remote, 'show', branch + ':packages/library/package.json'))
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
                                NEXT_TAG='v5.3.0', SERVER_URL='https://github.com')
        self.assertEqual(result.returncode, 0, result.stderr)
        body = Path(out['path']).read_text()
        self.assertIn('Bump `packages/library/package.json` to `5.3.0`', body)
        self.assertIn('[5.3.0](https://github.com/o/r/compare/v5.2.0...v5.3.0)', body)
        self.assertIn('add a feature', body)

    def test_merged_version_is_tagged_once_on_the_main_commit(self):
        before = self.remote_ref('main')
        self.open_version_branch()
        branch_commit = self.remote_ref('release/v5.3.0')
        after = self.squash_merge()
        self.assertNotEqual(after, branch_commit)

        runner, tag = self.detect(before, after)
        self.assertEqual(tag, 'v5.3.0')
        result, _ = self.step(BUMP, 'release_tag', runner, RELEASE_TAG=tag, AFTER_SHA=after)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.remote_ref('v5.3.0^{commit}'), after)

        _, tag = self.detect(before, after)
        self.assertEqual(tag, '')

    def test_push_without_a_version_change_is_not_tagged(self):
        before = self.remote_ref('main')
        self.write_version(self.work, '5.2.1-snapshot.0')
        (self.work / 'packages/library/package.json').write_text(
            json.dumps({'name': 'event-store-adapter-js', 'version': '5.2.1-snapshot.0',
                        'dependencies': {'x': '1.0.0'}}, indent=2) + '\n')
        self.git(self.work, 'commit', '-am', 'chore(deps): add x')
        self.git(self.work, 'push', 'origin', 'main')
        _, tag = self.detect(before, self.remote_ref('main'))
        self.assertEqual(tag, '')


if __name__ == '__main__':
    unittest.main()
