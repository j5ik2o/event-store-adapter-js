import re
import sys
import unittest

from release_test_support import BUMP, GITHUB, RELEASE, job, run_blocks, run_body, step


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

    def test_both_gates_collect_the_same_inputs(self):
        for workflow, step_id in ((BUMP, 'trigger'), (RELEASE, 'release_gate')):
            with self.subTest(step=step_id):
                self.assertIn('.github/release-gate-inputs.sh "$RELEASE_SHA" "$GATE"', run_body(workflow, step_id))

    def test_publish_is_guarded_on_both_sides(self):
        release = job(RELEASE, 'release')
        publish = release.index('publish --access public')
        for step_id in ('package_version', 'release_gate', 'npm_before', 'final_tag_check'):
            with self.subTest(step=step_id):
                self.assertLess(release.index('id: ' + step_id), publish)
                self.assertNotIn('        if:', step(RELEASE, step_id))
        self.assertIn('--mode publish', run_body(RELEASE, 'release_gate'))
        self.assertIn(
            "if: github.event_name == 'workflow_dispatch'\n        run: echo 'PNPM_CONFIG_PROVENANCE=false'",
            RELEASE)

    def test_confirm_is_a_job_of_its_own_after_the_publish(self):
        """確認を公開と別のジョブにし、「失敗したジョブを再実行」で公開をやり直さない（#1161）。"""
        release, confirm = job(RELEASE, 'release'), job(RELEASE, 'confirm')
        self.assertNotIn('npm view', release[release.index('publish --access public'):])
        self.assertNotIn('sleep', release)
        self.assertIn('    needs: release\n', confirm)
        self.assertNotIn('    if:', confirm)
        self.assertIn('    timeout-minutes: 20\n', confirm)
        self.assertIn('    permissions:\n      contents: read\n    steps:\n', confirm)
        for word in ('secrets.', 'NODE_AUTH_TOKEN', 'id-token', 'setup-node', 'pnpm'):
            with self.subTest(word=word):
                self.assertNotIn(word, confirm)
        scripts = ''.join(run_blocks(confirm))
        for word in ('npm ', 'pip ', 'publish', 'dist-tag', 'curl'):
            with self.subTest(word=word):
                self.assertNotIn(word, scripts)
        body = run_body(RELEASE, 'confirm')
        self.assertIn('npm-registry.py confirm --version "${RELEASE_TAG#v}"', body)
        self.assertIn('--interval "$CONFIRM_INTERVAL_SECONDS" --deadline "$CONFIRM_DEADLINE_SECONDS"', body)
        self.assertIn("EXPECT_PROVENANCE: ${{ github.event_name == 'push' }}", step(RELEASE, 'confirm'))

    def test_confirm_runs_the_script_of_the_workflow_revision(self):
        """confirm は npm-registry.py をワークフローの版から読む。手で古いタグを公開すると、タグの版にはこのスクリプトが無い
        （#1163 の Cursor Bugbot と CodeRabbit の指摘）。確かめる版は RELEASE_TAG から渡す。"""
        checkout = job(RELEASE, 'confirm').split('      - uses: actions/checkout@v7\n', 1)[1].split('\n      - ', 1)[0]
        self.assertEqual(checkout, '        with:\n          persist-credentials: false')
        self.assertIn("RELEASE_TAG: ${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.ref_name }}",
                      step(RELEASE, 'confirm'))

    def test_the_wait_is_set_in_one_place(self):
        for name, value in (('CONFIRM_DEADLINE_SECONDS', '900'), ('CONFIRM_INTERVAL_SECONDS', '20')):
            with self.subTest(name=name):
                self.assertEqual(RELEASE.count(name + ':'), 1)
                self.assertIn(f'          {name}: {value}\n', step(RELEASE, 'confirm'))

    def test_only_the_release_job_can_publish(self):
        """npm の trusted publishing はワークフローのファイル単位で信じるので、id-token は公開のジョブだけに渡す。"""
        self.assertEqual(RELEASE.count('id-token: write'), 1)
        self.assertIn('id-token: write', job(RELEASE, 'release'))
        self.assertEqual(RELEASE.count(' publish --access public'), 1)

    def test_the_npm_registry_script_uses_only_the_standard_library(self):
        script = (GITHUB / 'npm-registry.py').read_text()
        imported = set(re.findall(r'^(?:import|from) ([a-z_.]+)', script, re.MULTILINE))
        self.assertLessEqual({name.split('.')[0] for name in imported}, set(sys.stdlib_module_names))
        self.assertNotIn('method=', script)
        self.assertNotIn('data=', script)

    def test_github_release_follows_a_successful_confirm_and_marks_the_greatest_release_latest(self):
        github_release = job(RELEASE, 'github-release')
        self.assertIn("    needs: confirm\n    if: always() && needs.confirm.result == 'success'\n", github_release)
        self.assertIn('--notes-file "${RUNNER_TEMP}/changelog.txt" --latest=false', run_body(RELEASE, 'github_release'))
        self.assertLess(github_release.index('id: github_release'), github_release.index('id: latest_release'))
        latest = run_body(RELEASE, 'latest_release')
        self.assertIn('release-gate.py latest-tag', latest)
        self.assertIn('gh release edit "$LATEST_TAG" --repo "$GITHUB_REPOSITORY" --latest', latest)


if __name__ == '__main__':
    unittest.main()
