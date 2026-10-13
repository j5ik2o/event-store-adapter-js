import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path


GITHUB = Path(__file__).resolve().parents[1]
BUMP = (GITHUB / 'workflows/bump-version.yml').read_text()
RELEASE = (GITHUB / 'workflows/release.yml').read_text()
GUARDED = "steps.changes.outputs.count > 0 || inputs.level != 'auto' || inputs.version != ''"


def run_body(workflow, step):
    return re.search(
        r'id: ' + step + r'\n.*?        run: \|\n((?:          [^\n]*\n|\n)+)',
        workflow, re.DOTALL,
    ).group(1)



def step_index(workflow, step_id):
    return workflow.index('id: ' + step_id)


def step_if(workflow, step_id):
    start = workflow.index('id: ' + step_id)
    end = workflow.find('\n      - ', start)
    block = workflow[start:end if end != -1 else len(workflow)]
    return re.search(r'\n        if: (.+)', block).group(1)


class ReleaseVersionsTest(unittest.TestCase):
    def run_script(self, script, cwd, env):
        return subprocess.run(
            ['bash', '-e', '-o', 'pipefail', '-c', script], cwd=cwd,
            env={**os.environ, 'GITHUB_WORKSPACE': str(GITHUB.parent), **env},
            capture_output=True, text=True,
        )

    def make_repo(self, directory, tags):
        def git(*args):
            return subprocess.run(['git', *args], cwd=directory, check=True, text=True, capture_output=True)

        git('init')
        git('config', 'user.name', 'Test')
        git('config', 'user.email', 'test@example.com')
        git('commit', '--allow-empty', '-m', 'initial')
        for tag in tags:
            git('tag', tag)

    def validate(self, requested, tags=('v3.1.1', 'v4.0.1')):
        with tempfile.TemporaryDirectory() as directory:
            self.make_repo(directory, tags)
            output = Path(directory) / 'outputs'
            output.write_text('')
            result = self.run_script(
                run_body(BUMP, 'requested_version'), directory,
                {'GITHUB_OUTPUT': str(output), 'REQUESTED_VERSION': requested, 'LC_ALL': 'C'},
            )
            return result, output.read_text().strip()

    def test_empty_version_is_a_no_op(self):
        result, output = self.validate('')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output, 'version=')

    def test_accepted_versions(self):
        for requested in ('5.0.0', '4.0.2', '4.1.0', '10.0.0'):
            with self.subTest(requested=requested):
                result, output = self.validate(requested)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(output, 'version=' + requested)

    def test_accepted_when_no_tag_exists(self):
        result, output = self.validate('5.0.0', tags=())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output, 'version=5.0.0')

    def test_rejected_versions_write_nothing(self):
        for requested in ('v5.0.0', '5.0.0-rc.1', '5.0.0+build', '5.0', '05.0.0', '5.0.0 ',
                          '4.0.1', '4.0.0', '3.1.1', ' 5.0.0'):
            with self.subTest(requested=requested):
                result, output = self.validate(requested)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(output, '')

    def test_rejected_when_not_greater_than_the_highest_tag(self):
        result, output = self.validate('5.0.0', tags=('v4.0.1', 'v6.0.0'))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(output, '')

    def test_versions_step_uses_requested_version(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'outputs'
            output.write_text('')
            result = self.run_script(
                run_body(BUMP, 'versions'), directory,
                {'GITHUB_OUTPUT': str(output), 'REQUESTED_VERSION': '5.0.0'},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(output.read_text().splitlines(), ['next_version=5.0.0', 'next_tag=v5.0.0'])

    def test_versions_step_without_request_keeps_level_calculation(self):
        self.assertIn('next-semver.py', run_body(BUMP, 'versions'))
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'outputs'
            output.write_text('')
            script = run_body(BUMP, 'versions').replace('${{ steps.defines.outputs.prev_tag }}', 'v4.0.1') \
                .replace('${{ steps.semver_level.outputs.semver_level }}', 'minor')
            result = self.run_script(script, directory, {'GITHUB_OUTPUT': str(output), 'REQUESTED_VERSION': ''})
            if result.returncode == 0:
                self.assertEqual(output.read_text().splitlines(), ['next_version=4.1.0', 'next_tag=v4.1.0'])
            else:
                # CI 以外の環境では semver パッケージが無い場合がある
                self.assertIn('semver', result.stderr)

    def test_workflow_conditions(self):
        for step in ('versions', 'git_commit_push', 'tag_version'):
            with self.subTest(step=step):
                self.assertEqual(step_if(BUMP, step), GUARDED)
        self.assertEqual(BUMP.count('if: ' + GUARDED), 5)
        self.assertEqual(
            step_if(BUMP, 'semver_level'),
            "inputs.version == '' && (steps.changes.outputs.count > 0 || inputs.level != 'auto')",
        )

    def test_validation_runs_before_any_rewrite(self):
        self.assertLess(step_index(BUMP, 'requested_version'), step_index(BUMP, 'git_commit_push'))
        self.assertLess(step_index(BUMP, 'requested_version'), step_index(BUMP, 'versions'))
        self.assertIn('version:\n        description:', BUMP)

    def verify_release(self, tag, package_version):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory) / 'packages/library'
            package.mkdir(parents=True)
            (package / 'package.json').write_text('{"version": "%s"}' % package_version)
            return self.run_script(
                run_body(RELEASE, 'package_version'), directory, {'RELEASE_TAG': tag},
            )

    def test_release_accepts_matching_tag(self):
        result = self.verify_release('v5.0.0', '5.0.0')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_release_rejects_mismatched_tag(self):
        for package_version in ('5.0.1', '5.0.0-snapshot.0', '4.0.1'):
            with self.subTest(package_version=package_version):
                self.assertNotEqual(self.verify_release('v5.0.0', package_version).returncode, 0)

    def test_release_check_precedes_publish_for_every_trigger(self):
        self.assertLess(step_index(RELEASE, 'package_version'), RELEASE.index('publish --access public'))
        self.assertNotIn('if:', RELEASE[step_index(RELEASE, 'package_version'):RELEASE.index('run: |', step_index(RELEASE, 'package_version'))])
        self.assertIn("github.event_name == 'workflow_dispatch' && inputs.tag || github.ref_name", RELEASE)


if __name__ == '__main__':
    unittest.main()
