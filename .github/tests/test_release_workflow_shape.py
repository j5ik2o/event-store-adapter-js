import re
import unittest

from release_test_support import BUMP, RELEASE, job, run_blocks, run_body, step


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

if __name__ == '__main__':
    unittest.main()
