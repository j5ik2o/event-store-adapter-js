import os
import re
import subprocess
import tempfile
import sys
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / 'semver-level.py'


class SemverLevelTest(unittest.TestCase):
    def detect(self, commits):
        commit_log = '\n'.join(subject + '\x1f' + body + '\x1e' for subject, body in commits)
        return subprocess.run(
            [sys.executable, str(SCRIPT)], input=commit_log,
            text=True, capture_output=True, check=False,
        )

    def test_breaking_headers(self):
        for subject in ('feat!: new API', 'fix(scope)!: new API', 'perf!: new API'):
            with self.subTest(subject=subject):
                result = self.detect([(subject, '')])
                self.assertEqual(result.returncode, 0)
                self.assertEqual(result.stdout, 'major\n')

    def test_breaking_body(self):
        for marker in ('BREAKING CHANGE:', 'BREAKING-CHANGE:'):
            with self.subTest(marker=marker):
                result = self.detect([('fix: adjust API', 'Details\n\twith tabs\n\n' + marker + ' API changed\n')])
                self.assertEqual(result.returncode, 0)
                self.assertEqual(result.stdout, 'major\n')

    def test_minor(self):
        for subject in ('feat: add API', 'feat(scope): add API', 'revert: undo API'):
            with self.subTest(subject=subject):
                self.assertEqual(self.detect([(subject, '')]).stdout, 'minor\n')

    def test_patch(self):
        for kind in ('perf', 'fix', 'build', 'ci', 'docs', 'style', 'refactor', 'test', 'chore', 'custom'):
            with self.subTest(kind=kind):
                result = self.detect([(kind + ': adjust behavior', '')])
                self.assertEqual(result.returncode, 0)
                self.assertEqual(result.stdout, 'patch\n')

    def test_mixed_commits(self):
        patch = ('perf: improve speed', 'multiple\nlines\tand tabs\n')
        minor = ('feat: add API', '')
        major = ('fix: adjust API', 'BREAKING CHANGE: API changed\n')
        for commits, expected in (
            ([patch, minor], 'minor'), ([minor, patch], 'minor'),
            ([patch, major, minor], 'major'), ([major, minor, patch], 'major'),
        ):
            with self.subTest(commits=commits):
                self.assertEqual(self.detect(commits).stdout, expected + '\n')

    def test_inline_breaking_text_is_not_a_footer(self):
        result = self.detect([('fix: adjust API', 'Mention BREAKING CHANGE: as an example\n')])
        self.assertEqual(result.stdout, 'patch\n')

    def test_legacy_breaking_subject(self):
        self.assertEqual(self.detect([('BREAKING CHANGE: change API', '')]).stdout, 'major\n')

    def test_git_log_workflow_steps(self):
        workflow = (SCRIPT.parent / 'workflows/bump-version.yml').read_text()
        steps = {
            step: re.search(
                r'id: ' + step + r'\n.*?        run: \|\n((?:          [^\n]*\n|\n)+)',
                workflow, re.DOTALL,
            ).group(1)
            for step in ('changes', 'semver_level')
        }
        with tempfile.TemporaryDirectory() as directory:
            def git(*args):
                return subprocess.run(
                    ['git', *args], cwd=directory, check=True,
                    text=True, capture_output=True,
                )

            git('init')
            git('config', 'user.name', 'Test')
            git('config', 'user.email', 'test@example.com')
            git('commit', '--allow-empty', '-m', 'initial')
            base = git('rev-parse', 'HEAD').stdout.strip()
            output = Path(directory) / 'outputs'

            def run_step(step, level='auto'):
                output.write_text('')
                script = steps[step].replace('${{ steps.defines.outputs.prev_tag }}', base)
                result = subprocess.run(
                    ['bash', '-e', '-o', 'pipefail', '-c', script], cwd=directory,
                    env={**os.environ, 'GITHUB_OUTPUT': str(output),
                         'GITHUB_WORKSPACE': str(SCRIPT.parent.parent), 'REQUESTED_LEVEL': level},
                    capture_output=True, text=True,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                return output.read_text().strip()

            self.assertEqual(run_step('changes'), 'count=0')
            for level in ('patch', 'minor', 'major'):
                self.assertEqual(run_step('semver_level', level), 'semver_level=' + level)
            git('commit', '--allow-empty', '-m', 'perf: optimize', '-m', 'lines\nand\ttabs')
            self.assertEqual(run_step('semver_level'), 'semver_level=patch')
            git('commit', '--allow-empty', '-m', 'fix(scope)!: change API')
            self.assertEqual(run_step('changes'), 'count=2')
            self.assertEqual(run_step('semver_level'), 'semver_level=major')
            git('reset', '--hard', base)
            git('commit', '--allow-empty', '-m', 'change API', '-m', 'Details\n\twith tabs\nBREAKING-CHANGE: new API')
            self.assertEqual(run_step('changes'), 'count=1')
            self.assertEqual(run_step('semver_level'), 'semver_level=major')

    def test_empty_or_unrecognized(self):
        for commits in ([], [('Merge branch main', '')]):
            with self.subTest(commits=commits):
                result = self.detect(commits)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, '')
                self.assertEqual(result.stderr, '')


if __name__ == '__main__':
    unittest.main()
