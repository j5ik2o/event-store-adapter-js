import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

FAKE_GH = '''#!/bin/sh
# 偽の gh。api は FAKE_GH_FAIL 回だけ失敗し、続く FAKE_GH_EMPTY 回は [] を返し、その後に $FAKE_PULLS を返す。
if [ "$1" = release ]; then
  [ "$2" = view ] && exit 1
  printf '%s\\n' "$@" > "$FAKE_RELEASE_ARGS"
  exit 0
fi
calls=$(cat "$FAKE_GH_CALLS" 2>/dev/null || echo 0)
calls=$((calls + 1))
echo "$calls" > "$FAKE_GH_CALLS"
if [ "$calls" -le "${FAKE_GH_FAIL:-0}" ]; then
  echo "HTTP 502" >&2
  exit 1
fi
if [ "$calls" -le $(( ${FAKE_GH_FAIL:-0} + ${FAKE_GH_EMPTY:-0} )) ]; then
  echo '[]'
  exit 0
fi
cat "$FAKE_PULLS"
'''

from release_test_support import BUMP, GITHUB, PACKAGE, RELEASE, REPOSITORY, outputs, pull, run_body


class ReleaseRehearsalTest(unittest.TestCase):
    """bare のリモートに対して、版の枝 → squash 相当のマージ → 関門 → タグ → 公開の関門までを手元で通す。"""

    def setUp(self):
        self.directory = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.directory)
        self.remote = self.directory / 'remote.git'
        self.work = self.directory / 'work'
        fake_bin = self.directory / 'bin'
        fake_bin.mkdir()
        (fake_bin / 'gh').write_text(FAKE_GH)
        (fake_bin / 'gh').chmod(0o755)
        self.pulls = self.directory / 'pulls.json'
        self.pulls.write_text('[]')
        self.env = {
            **os.environ,
            'PATH': f'{fake_bin}{os.pathsep}{os.environ["PATH"]}',
            'FAKE_PULLS': str(self.pulls),
            'FAKE_GH_CALLS': str(self.directory / 'gh-calls'),
            'FAKE_RELEASE_ARGS': str(self.directory / 'release-args'),
            'PULLS_RETRY_SECONDS': '0',
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

    def trigger(self, sha, **env):
        (self.directory / 'gh-calls').unlink(missing_ok=True)
        return self.step(BUMP, 'trigger', self.clone(sha), RELEASE_SHA=sha, **env)

    def merged_release(self):
        self.open_version_branch()
        return self.squash_merge()

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
        self.assertIn('(https://github.com/o/r/compare/v5.2.0...release/v5.3.0)', body)
        self.assertNotIn('compare/v5.2.0...v5.3.0)', body)
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

    def test_pull_request_lookup_is_retried_while_github_links_it(self):
        after = self.merged_release()
        result, out = self.trigger(after, FAKE_GH_FAIL='1', FAKE_GH_EMPTY='2')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(out['tag'], 'v5.3.0')
        self.assertEqual((self.directory / 'gh-calls').read_text().strip(), '4')

    def test_pull_request_that_never_appears_stops_without_a_tag(self):
        after = self.merged_release()
        result, out = self.trigger(after, FAKE_GH_EMPTY='9')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('no pull request is associated', result.stderr)
        self.assertEqual(out, {})
        self.assertEqual((self.directory / 'gh-calls').read_text().strip(), '5')

    def test_pull_request_lookup_that_keeps_failing_stops_without_a_tag(self):
        after = self.merged_release()
        result, out = self.trigger(after, FAKE_GH_FAIL='9')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('could not read the pull requests', result.stdout)
        self.assertEqual(out, {})

    def test_final_tag_check_refuses_to_overtake_a_newer_tag(self):
        after = self.merged_release()
        self.push_tag('v5.3.0', after)
        runner = self.clone('v5.3.0')
        result, _ = self.step(RELEASE, 'final_tag_check', runner, RELEASE_TAG='v5.3.0')
        self.assertEqual(result.returncode, 0, result.stderr)
        work = self.clone()
        self.git(work, 'tag', '-a', 'v5.4.0', '-m', 'v5.4.0')
        self.git(work, 'push', 'origin', 'v5.4.0')
        result, _ = self.step(RELEASE, 'final_tag_check', runner, RELEASE_TAG='v5.3.0')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('the latest release tag is v5.4.0', result.stdout)

    def github_release_notes(self, tag):
        result, _ = self.step(RELEASE, 'github_release', self.clone(tag), RELEASE_TAG=tag)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--verify-tag', (self.directory / 'release-args').read_text())
        return (self.directory / 'changelog.txt').read_text()

    def test_github_release_notes_start_at_the_previous_release_tag(self):
        after = self.merged_release()
        self.push_tag('v5.3.0', after)
        notes = self.github_release_notes('v5.3.0')
        self.assertIn('compare/v5.2.0...v5.3.0', notes)
        self.assertIn('add a feature', notes)

    def test_github_release_notes_without_a_previous_tag_start_at_the_first_commit(self):
        self.git(self.remote, 'tag', '-d', 'v5.2.0')
        after = self.merged_release()
        self.push_tag('v5.3.0', after)
        root = self.git(self.remote, 'rev-list', '--max-parents=0', 'main')
        notes = self.github_release_notes('v5.3.0')
        self.assertIn(f'compare/{root}...v5.3.0', notes)

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
