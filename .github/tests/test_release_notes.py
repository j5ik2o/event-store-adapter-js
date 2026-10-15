#!/usr/bin/env python3
"""リリースノートを作る 2 つのスクリプトの試験（標準ライブラリの unittest だけを使う）。"""
import os
import re
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HEADER_NAME = "create-release-note-header.py"
BODY_NAME = "create-release-note-body.py"
BASE = "https://github.com/o/r"


def find_scripts():
    for d in (HERE, os.path.dirname(HERE)):
        header = os.path.join(d, HEADER_NAME)
        body = os.path.join(d, BODY_NAME)
        if os.path.isfile(header) and os.path.isfile(body):
            return header, body
    raise AssertionError(
        f"{HEADER_NAME} と {BODY_NAME} が {HERE} にも 1 つ上のディレクトリにも見つからない"
    )


def run_body(stdin, *args):
    _, body = find_scripts()
    argv = list(args) if args else ["https://github.com", "o/r"]
    return subprocess.run(
        [sys.executable, "-B", body, *argv],
        input=stdin.encode("utf-8"),
        capture_output=True,
    )


def out(stdin):
    p = run_body(stdin)
    assert p.returncode == 0, p.stderr.decode("utf-8")
    return p.stdout.decode("utf-8")


def commit(h, subject, body=""):
    return f"{h}\x1f{subject}\x1f{body}\x1e\n"


def h40(c):
    return c * 40


def link(h):
    return f"([{h[:7]}]({BASE}/commit/{h}))"


class BodyScriptTest(unittest.TestCase):
    def test_1_breaking_mark_in_subject_goes_to_both_sections(self):
        a, b, c = h40("a"), h40("b"), h40("c")
        text = out(
            commit(a, "feat!: x")
            + commit(b, "fix(storage)!: y")
            + commit(c, "refactor!: z")
        )
        expected = (
            "### ⚠ BREAKING CHANGES\n\n"
            f"* x {link(a)}\n"
            f"* **storage:** y {link(b)}\n"
            f"* z {link(c)}\n\n"
            "### Features\n\n"
            f"* x {link(a)}\n\n"
            "### Bug Fixes\n\n"
            f"* **storage:** y {link(b)}\n\n"
            "### Code Refactoring\n\n"
            f"* z {link(c)}\n\n"
        )
        self.assertEqual(expected, text)

    def test_2_breaking_footer_in_body_uses_reason(self):
        a, b = h40("a"), h40("b")
        text = out(
            commit(a, "feat: add x", "details\n\nBREAKING CHANGE: 理由A")
            + commit(b, "fix: y", "BREAKING-CHANGE: 理由B")
        )
        breaking = text.split("### Features")[0]
        self.assertIn(f"* 理由A {link(a)}", breaking)
        self.assertIn(f"* 理由B {link(b)}", breaking)
        self.assertIn(f"* add x {link(a)}", text.split("### Features")[1])
        self.assertIn(f"* y {link(b)}", text.split("### Bug Fixes")[1])

    def test_2c_empty_breaking_footer_falls_back_to_description(self):
        a = h40("a")
        text = out(commit(a, "feat: add x", "BREAKING CHANGE:"))
        breaking = text.split("### Features")[0]
        self.assertIn("### ⚠ BREAKING CHANGES", breaking)
        self.assertIn(f"* add x {link(a)}", breaking)
        self.assertNotIn(f"*  {link(a)}", breaking)

    def test_2b_breaking_footer_continuation_lines_until_blank_line(self):
        a = h40("a")
        text = out(
            commit(a, "feat: x", "BREAKING CHANGE: 一行目\n二行目\n\n別の段落")
        )
        self.assertIn(f"* 一行目 二行目 {link(a)}", text)
        self.assertNotIn("別の段落", text)

    def test_3_non_conventional_subjects(self):
        a, b, c = h40("a"), h40("b"), h40("c")
        self.assertEqual("", out(commit(a, "version up to v5.0.2")))
        text = out(
            commit(b, "version up to v5.0.2", "BREAKING CHANGE: 本文の理由")
            + commit(c, "BREAKING CHANGE: 件名の理由")
        )
        expected = (
            "### ⚠ BREAKING CHANGES\n\n"
            f"* 本文の理由 {link(b)}\n"
            f"* 件名の理由 {link(c)}\n\n"
        )
        self.assertEqual(expected, text)
        text2 = out(commit(a, "BREAKING-CHANGE: ハイフン"))
        self.assertEqual(
            f"### ⚠ BREAKING CHANGES\n\n* ハイフン {link(a)}\n\n", text2
        )

    def test_4_pr_link_and_short_hash(self):
        a = "0123456789abcdef0123456789abcdef01234567"
        text = out(commit(a, "feat(core): add x (#305)"))
        expected = (
            "### Features\n\n"
            f"* **core:** add x ([#305]({BASE}/pull/305)) "
            f"([0123456]({BASE}/commit/{a}))\n\n"
        )
        self.assertEqual(expected, text)

    def test_5_description_and_type_parsing(self):
        a, b = h40("a"), h40("b")
        text = out(commit(a, "fix: a: b") + commit(b, "feature: x"))
        self.assertEqual(
            "### Bug Fixes\n\n"
            f"* a: b {link(a)}\n\n"
            "### Other Changes\n\n"
            f"* x {link(b)}\n\n",
            text,
        )
        self.assertNotIn("### Features", text)

    def test_5b_forms_that_are_not_conventional_are_not_printed(self):
        text = out(
            commit(h40("a"), "Feat: x")
            + commit(h40("b"), "fix:x")
            + commit(h40("c"), "fix: ")
        )
        self.assertEqual("", text)

    def test_5c_breaking_marker_must_be_at_line_start_and_exact(self):
        a, b, c = h40("a"), h40("b"), h40("c")
        text = out(
            commit(a, "fix: p", "see BREAKING CHANGE: x")
            + commit(b, "fix: q", "BREAKING CHANGES: x")
            + commit(c, "fix: r", "breaking change: x")
        )
        self.assertNotIn("BREAKING CHANGES\n", text.replace("### ⚠ BREAKING CHANGES", ""))
        self.assertNotIn("⚠", text)
        self.assertIn("### Bug Fixes", text)

    def test_5d_breaking_text_in_middle_of_subject_is_not_a_mark(self):
        a = h40("a")
        text = out(commit(a, "fix: drop BREAKING CHANGE: x"))
        self.assertNotIn("⚠", text)
        self.assertEqual(
            f"### Bug Fixes\n\n* drop BREAKING CHANGE: x {link(a)}\n\n", text
        )

    def test_5e_only_trailing_pr_number_is_taken(self):
        a, b = h40("a"), h40("b")
        text = out(commit(a, "feat: x (#1) (#2)") + commit(b, "fix: (#3) x"))
        self.assertIn(f"* x (#1) ([#2]({BASE}/pull/2)) {link(a)}", text)
        self.assertIn(f"* (#3) x {link(b)}", text)
        self.assertNotIn("/pull/3)", text)

    def test_5f_breaking_item_also_gets_pr_link(self):
        a = h40("a")
        text = out(commit(a, "feat!: x (#9)"))
        item = f"* x ([#9]({BASE}/pull/9)) {link(a)}"
        self.assertEqual(2, text.count(item))

    def test_6_section_order_and_empty_sections_omitted(self):
        types = [
            "chore", "ci", "build", "test", "refactor", "style", "docs",
            "revert", "perf", "fix", "feat",
        ]
        data = commit(h40("0"), "zzz: other")
        for i, t in enumerate(types):
            data += commit(h40(str(i + 1)) if i < 9 else h40("abcdef"[i - 9]), f"{t}: m{i}")
        data += commit(h40("9"), "feat!: brk")
        text = out(data)
        titles = re.findall(r"^### (.*)$", text, re.MULTILINE)
        self.assertEqual(
            [
                "⚠ BREAKING CHANGES", "Features", "Bug Fixes",
                "Performance Improvements", "Reverts", "Documentation",
                "Styles", "Code Refactoring", "Tests", "Build Systems",
                "Continuous Integration", "Chores", "Other Changes",
            ],
            titles,
        )
        only = out(commit(h40("a"), "docs: d"))
        self.assertEqual(["Documentation"], re.findall(r"^### (.*)$", only, re.MULTILINE))

    def test_6b_order_inside_section_follows_input(self):
        a, b = h40("a"), h40("b")
        text = out(commit(a, "feat: second") + commit(b, "feat: first"))
        self.assertLess(text.index("second"), text.index("first"))

    def test_7_empty_input(self):
        for stdin in ("", "\n"):
            p = run_body(stdin)
            self.assertEqual(0, p.returncode)
            self.assertEqual(b"", p.stdout)

    def test_8_real_git_log(self):
        def git(*args, cwd):
            return subprocess.run(
                ["git", "-c", "commit.gpgsign=false", *args],
                cwd=cwd, check=True, capture_output=True, text=True,
            ).stdout.strip()

        with tempfile.TemporaryDirectory() as d:
            git("-c", "init.defaultBranch=main", "init", "-q", cwd=d)
            git("config", "user.name", "T", cwd=d)
            git("config", "user.email", "t@example.com", cwd=d)
            git("commit", "--allow-empty", "-q", "-m", "chore: root", cwd=d)
            base = git("rev-parse", "HEAD", cwd=d)
            git("checkout", "-q", "-b", "side", cwd=d)
            git("commit", "--allow-empty", "-q", "-m", "fix(core): side fix (#12)", cwd=d)
            side = git("rev-parse", "HEAD", cwd=d)
            git("checkout", "-q", "main", cwd=d)
            git(
                "commit", "--allow-empty", "-q", "-m",
                "feat: first feature\n\nlong body\n\nBREAKING CHANGE: 一行目\n二行目\n\n後ろの段落",
                cwd=d,
            )
            feat = git("rev-parse", "HEAD", cwd=d)
            git("commit", "--allow-empty", "-q", "-m", "version up to v5.0.2", cwd=d)
            git("commit", "--allow-empty", "-q", "-m", "docs: update guide", cwd=d)
            docs = git("rev-parse", "HEAD", cwd=d)
            git("merge", "--no-ff", "-q", "-m", "feat: merge commit", "side", cwd=d)
            log = git(
                "log", f"{base}..HEAD", "--no-merges",
                "--format=%H%x1f%s%x1f%b%x1e", cwd=d,
            )
        text = out(log)
        expected = (
            "### ⚠ BREAKING CHANGES\n\n"
            f"* 一行目 二行目 {link(feat)}\n\n"
            "### Features\n\n"
            f"* first feature {link(feat)}\n\n"
            "### Bug Fixes\n\n"
            f"* **core:** side fix ([#12]({BASE}/pull/12)) {link(side)}\n\n"
            "### Documentation\n\n"
            f"* update guide {link(docs)}\n\n"
        )
        self.assertEqual(expected, text)
        self.assertNotIn("merge commit", text)

    def test_9_no_warnings_when_compiled_with_error_filter(self):
        for path in find_scripts():
            p = subprocess.run(
                [
                    sys.executable, "-B", "-W", "error", "-c",
                    "import sys, pathlib; compile(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'), sys.argv[1], 'exec')",
                    path,
                ],
                capture_output=True,
            )
            self.assertEqual(0, p.returncode, p.stderr.decode("utf-8"))
            self.assertEqual(b"", p.stderr)

    def test_10_header_format(self):
        header, _ = find_scripts()
        p = subprocess.run(
            [sys.executable, "-B", header, "https://github.com", "o/r", "v5.0.1", "v5.0.2"],
            capture_output=True,
        )
        self.assertEqual(0, p.returncode, p.stderr.decode("utf-8"))
        self.assertRegex(
            p.stdout.decode("utf-8"),
            re.compile(
                r"^### \[5\.0\.2\]\(https://github\.com/o/r/compare/v5\.0\.1\.\.\.v5\.0\.2\) \(\d{4}-\d{2}-\d{2}\)$",
                re.MULTILINE,
            ),
        )


if __name__ == "__main__":
    unittest.main()
