#! /usr/bin/env python3
"""main への push が公開のきっかけになるかを決める。

使い方: release-trigger.py <push 前の版> <push 後の版>  （標準入力にタグの一覧）
公開するときはタグ名 (vX.Y.Z) を標準出力に書く。しないときは何も書かず、理由を標準エラーに書く。
押し下げ（既存の最大のタグ以下の版）は誤りとして終了コード 1 を返す。
"""
import re
import sys

RELEASE_VERSION = re.compile(r'^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')


def parse(version):
    match = RELEASE_VERSION.match(version)
    return tuple(int(part) for part in match.groups()) if match else None


def release_tag(before, after, tags):
    if before == after:
        return None, f'version unchanged ({after})'
    version = parse(after)
    if version is None:
        return None, f'{after} is not a release version (X.Y.Z)'
    tag = f'v{after}'
    if tag in tags:
        return None, f'tag {tag} already exists'
    released = [parse(t[1:]) for t in tags if t.startswith('v') and parse(t[1:])]
    if released and version <= max(released):
        highest = '.'.join(str(part) for part in max(released))
        raise ValueError(f'{after} must be greater than the latest tag v{highest}')
    return tag, None


def main(argv):
    if len(argv) != 3:
        print('usage: release-trigger.py <before-version> <after-version> < tags', file=sys.stderr)
        return 2
    tags = {line.strip() for line in sys.stdin if line.strip()}
    try:
        tag, reason = release_tag(argv[1], argv[2], tags)
    except ValueError as error:
        print(f'::error::{error}', file=sys.stderr)
        return 1
    if tag is None:
        print(f'no release: {reason}', file=sys.stderr)
        return 0
    print(tag)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
