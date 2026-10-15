#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""git log の出力（--format='%H%x1f%s%x1f%b%x1e'）からリリースノートの本体を作る。

使い方:
  git log "$PREV..$NEXT" --no-merges --format='%H%x1f%s%x1f%b%x1e' \
    | python3 create-release-note-body.py "$SERVER_URL" "$REPOSITORY"
"""
import re
import sys

SUBJECT_RE = re.compile(
    r"^(?P<type>[a-z]+)(?:\((?P<scope>[^()\r\n]*)\))?(?P<bang>!)?: (?P<desc>.+)$"
)
BREAKING_RE = re.compile(r"^(?:BREAKING CHANGE|BREAKING-CHANGE):[ \t]*(?P<text>.*)$")
PR_RE = re.compile(r" \(#(?P<pr>\d+)\)$")

SECTIONS = [
    ("feat", "Features"),
    ("fix", "Bug Fixes"),
    ("perf", "Performance Improvements"),
    ("revert", "Reverts"),
    ("docs", "Documentation"),
    ("style", "Styles"),
    ("refactor", "Code Refactoring"),
    ("test", "Tests"),
    ("build", "Build Systems"),
    ("ci", "Continuous Integration"),
    ("chore", "Chores"),
]
BREAKING_TITLE = "⚠ BREAKING CHANGES"
OTHER_TITLE = "Other Changes"


def parse_records(data):
    records = []
    for chunk in data.split("\x1e"):
        chunk = chunk.strip("\r\n")
        if not chunk:
            continue
        parts = chunk.split("\x1f", 2)
        while len(parts) < 3:
            parts.append("")
        records.append((parts[0].strip(), parts[1], parts[2]))
    return records


def body_breaking_text(body):
    lines = body.splitlines()
    for i, line in enumerate(lines):
        m = BREAKING_RE.match(line)
        if m is None:
            continue
        pieces = [m.group("text").strip()]
        for follow in lines[i + 1:]:
            if not follow.strip():
                break
            pieces.append(follow.strip())
        return " ".join(p for p in pieces if p)
    return None


def split_pr(text):
    m = PR_RE.search(text)
    if m is None:
        return text, None
    return text[: m.start()], m.group("pr")


def format_item(text, scope, pr, commit_hash, base):
    item = "* "
    if scope:
        item += f"**{scope}:** "
    item += text
    if pr is not None:
        item += f" ([#{pr}]({base}/pull/{pr}))"
    item += f" ([{commit_hash[:7]}]({base}/commit/{commit_hash}))"
    return item


def render(records, base):
    breaking = []
    by_type = {title: [] for _, title in SECTIONS}
    other = []
    type_to_title = dict(SECTIONS)

    for commit_hash, subject, body in records:
        subject_text, pr = split_pr(subject)
        m = SUBJECT_RE.match(subject_text)
        body_text = body_breaking_text(body)
        subject_mark = BREAKING_RE.match(subject_text)
        is_breaking = bool((m and m.group("bang")) or body_text is not None or subject_mark)
        scope = m.group("scope") if m else None

        if is_breaking:
            mark_text = subject_mark.group("text").strip() if subject_mark else ""
            if body_text:
                text = body_text
            elif mark_text:
                text = mark_text
            elif m is not None:
                text = m.group("desc")
            else:
                text = subject_text
            breaking.append(format_item(text, scope, pr, commit_hash, base))

        if m is not None:
            item = format_item(m.group("desc"), scope, pr, commit_hash, base)
            title = type_to_title.get(m.group("type"))
            if title is None:
                other.append(item)
            else:
                by_type[title].append(item)

    ordered = [(BREAKING_TITLE, breaking)]
    ordered += [(title, by_type[title]) for _, title in SECTIONS]
    ordered.append((OTHER_TITLE, other))

    out = ""
    for title, items in ordered:
        if items:
            out += f"### {title}\n\n" + "\n".join(items) + "\n\n"
    return out


def main(argv):
    if len(argv) != 3:
        sys.stderr.write("usage: create-release-note-body.py SERVER_URL OWNER/NAME\n")
        return 2
    base = f"{argv[1]}/{argv[2]}"
    data = sys.stdin.buffer.read().decode("utf-8")
    out = render(parse_records(data), base)
    if out:
        sys.stdout.buffer.write(out.encode("utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
