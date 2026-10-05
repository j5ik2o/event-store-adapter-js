#! /usr/bin/env python3
# -*- coding: utf-8 -*-
import re
import sys


def semver_level(commit_log):
    levels = []
    for record in commit_log.split('\x1e'):
        if not record.strip():
            continue
        subject, body = record.lstrip('\n').split('\x1f', 1)
        header = re.match(r'^([a-z]+)(?:\([^\r\n]*\))?(!)?:', subject)
        if (header and header.group(2)) or re.search(
            r'^BREAKING[ -]CHANGE:', body, re.MULTILINE
        ) or subject.startswith('BREAKING CHANGE:'):
            levels.append('major')
        elif header:
            levels.append('minor' if header.group(1) in ('feat', 'revert') else 'patch')
    return next((level for level in ('major', 'minor', 'patch') if level in levels), None)


if __name__ == '__main__':
    level = semver_level(sys.stdin.read())
    if level is None:
        sys.exit(1)
    print(level)
