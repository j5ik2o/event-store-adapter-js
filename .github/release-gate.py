#! /usr/bin/env python3
"""リリースの関門。タグを打つ前と npm へ公開する前に、同じ条件で確かめる。

latest-tag [--below X.Y.Z]   標準入力のタグ名から、最大の正式版のタグ (vX.Y.Z) を書く（無ければ何も書かない）。
greater <A> <B>              A が B より大きい版なら終了コード 0、そうでなければ 1。
check --mode tag|publish ... コミットが、版上げの PR を squash したものかを確かめる。
  tag     : 版が変わっていない、正式版 (X.Y.Z) でない、タグが既に同じコミットにある、のときは何も書かない。
            通るならタグ名を書く。
  publish : --tag のタグが関門を通るなら、タグ名を書く。
  どちらも、通らないときは理由を ::error:: で書いて終了コード 1 を返す。
"""
import argparse
import json
from dataclasses import dataclass
import re
import sys

VERSION = re.compile(
    r'^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?$')
PACKAGE = 'packages/library/package.json'


class GateError(Exception):
    pass


@dataclass(frozen=True)
class Candidate:
    """関門にかけるコミットと、その周りの事実。"""
    repository: str
    sha: str
    parent: dict
    package: dict
    changed_files: tuple
    pulls: tuple
    tags: dict
    on_main: bool


def parse(version, release_only=True):
    match = VERSION.match(version or '')
    if not match or (release_only and match.group(4)):
        return None
    core = tuple(int(part) for part in match.groups()[:3])
    # 同じ core なら、プレリリース（snapshot など）は正式版より小さい
    return core + ((1,) if match.group(4) is None else (0,))


def stable_tags(names):
    return {name: parse(name[1:]) for name in names if name.startswith('v') and parse(name[1:])}


def latest_tag(names, below=None):
    limit = parse(below) if below else None
    candidates = [(key, name) for name, key in stable_tags(names).items() if limit is None or key < limit]
    return max(candidates)[1] if candidates else None


def remote_tags(ls_remote):
    """`git ls-remote --tags` の出力を {タグ名: コミット} にする（注釈つきタグは ^{} の先を使う）。"""
    tags = {}
    for line in ls_remote.splitlines():
        if not line.strip():
            continue
        sha, ref = line.split('\t', 1)
        name = ref.removeprefix('refs/tags/')
        if name.endswith('^{}'):
            tags[name[:-3]] = sha
        else:
            tags.setdefault(name, sha)
    return tags


def merged_from(pull, candidate, branch):
    head = pull['head']
    return (
        bool(pull['merged_at']) and pull['merge_commit_sha'] == candidate.sha
        and pull['base']['ref'] == 'main' and head['ref'] == branch
        and head['repo'] is not None and head['repo']['full_name'] == candidate.repository
    )


def approved_release(candidate):
    before, after = candidate.parent.get('version'), candidate.package.get('version')
    version = parse(after)
    if version is None:
        raise GateError(f'{after} is not a release version (X.Y.Z)')
    if not candidate.on_main:
        raise GateError(f'{candidate.sha} is not reachable from main')
    if list(candidate.changed_files) != [PACKAGE]:
        raise GateError(f'the commit must change only {PACKAGE}, but changes {list(candidate.changed_files)}')
    if {**candidate.parent, 'version': after} != candidate.package:
        raise GateError(f'the commit must change only the version in {PACKAGE}')
    previous = parse(before, release_only=False)
    if previous is None or version <= previous:
        raise GateError(f'{after} must be greater than the previous version {before}')
    branch = f'release/v{after}'
    if not candidate.pulls:
        raise GateError(
            f'no pull request is associated with {candidate.sha} yet; '
            'if it is the merge of a version pull request, re-run the job')
    if len([pull for pull in candidate.pulls if merged_from(pull, candidate, branch)]) != 1:
        raise GateError(
            f'{candidate.sha} is not the squash merge of a pull request from {candidate.repository}:{branch} into main; '
            'restore the version with a pull request')
    tag = f'v{after}'
    newest = latest_tag([name for name in candidate.tags if name != tag])
    if newest and version <= parse(newest[1:]):
        raise GateError(f'{after} must be greater than the latest tag {newest}')
    return tag


def check(args):
    def read(path):
        with open(path, encoding='utf-8') as file:
            return file.read()

    candidate = Candidate(
        repository=args.repository, sha=args.sha,
        parent=json.loads(read(args.parent_package)), package=json.loads(read(args.package)),
        changed_files=tuple(line for line in read(args.changed_files).splitlines() if line),
        pulls=tuple(json.loads(read(args.pulls))), tags=remote_tags(read(args.remote_tags)),
        on_main=args.on_main == 'true',
    )
    return check_candidate(args.mode, candidate, args.tag)


def check_candidate(mode, candidate, requested_tag=None):
    after = candidate.package.get('version')
    if mode == 'tag' and candidate.parent.get('version') == after:
        print(f'no release: version unchanged ({after})', file=sys.stderr)
        return None
    if mode == 'tag' and parse(after) is None:
        print(f'no release: {after} is not a release version (X.Y.Z)', file=sys.stderr)
        return None
    tag = approved_release(candidate)
    remote = candidate.tags.get(tag)
    if mode == 'publish':
        if requested_tag != tag:
            raise GateError(f'tag {requested_tag} does not match the package version {after}')
        if remote != candidate.sha:
            raise GateError(f'tag {tag} does not point at {candidate.sha} on the remote')
        return tag
    if remote is None:
        return tag
    if remote != candidate.sha:
        raise GateError(f'tag {tag} already exists on another commit {remote}')
    print(f'no release: tag {tag} already points at {candidate.sha}', file=sys.stderr)
    return None


def main(argv):
    parser = argparse.ArgumentParser(prog='release-gate.py')
    commands = parser.add_subparsers(dest='command', required=True)
    latest = commands.add_parser('latest-tag')
    latest.add_argument('--below')
    greater = commands.add_parser('greater')
    greater.add_argument('version')
    greater.add_argument('than')
    gate = commands.add_parser('check')
    gate.add_argument('--mode', choices=('tag', 'publish'), required=True)
    gate.add_argument('--tag')
    for name in ('repository', 'sha', 'parent-package', 'package', 'changed-files', 'pulls', 'remote-tags'):
        gate.add_argument('--' + name, required=True)
    gate.add_argument('--on-main', choices=('true', 'false'), required=True)
    args = parser.parse_args(argv[1:])

    if args.command == 'latest-tag':
        tag = latest_tag([line.strip() for line in sys.stdin], args.below)
        if tag:
            print(tag)
        return 0
    if args.command == 'greater':
        version, than = parse(args.version), parse(args.than, release_only=False)
        return 0 if version and than and version > than else 1
    try:
        tag = check(args)
    except GateError as error:
        print(f'::error::{error}', file=sys.stderr)
        return 1
    if tag:
        print(tag)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
