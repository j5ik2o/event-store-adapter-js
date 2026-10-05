#!/usr/bin/env python3
"""適合データの manifest を標準ライブラリだけで生成・照合する。"""

import argparse
import hashlib
import json
from pathlib import Path
import sys

VERSION = "1.0.0"
DEFAULT_ROOT = Path(__file__).resolve().parents[2] / "conformance"


def read_json(path):
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"{path}: JSON キーが重複: {key}")
            result[key] = value
        return result

    def reject_constant(value):
        raise ValueError(f"{path}: JSON にない数値: {value}")

    return json.loads(path.read_text(encoding="utf-8"),
                      object_pairs_hook=unique_object, parse_constant=reject_constant)


def inventory(root):
    files = []
    for path in sorted(root.rglob("*"), key=lambda path: path.relative_to(root).as_posix()):
        if path.is_symlink():
            raise ValueError(f"シンボリックリンクは配布できない: {path}")
        if path.is_file() and path != root / "manifest.json":
            files.append({"path": path.relative_to(root).as_posix(),
                          "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    return {"format": "manifest", "version": VERSION, "files": files}


def verify(root):
    expected = inventory(root)
    actual = read_json(root / "manifest.json")
    if actual != expected:
        expected_files = {entry["path"]: entry["sha256"] for entry in expected["files"]}
        actual_files = {entry["path"]: entry["sha256"] for entry in actual.get("files", [])}
        for path in sorted(expected_files.keys() | actual_files.keys()):
            if expected_files.get(path) != actual_files.get(path):
                print(f"不一致: {path}", file=sys.stderr)
        raise ValueError("manifest の版・構造・順序・ファイル集合・SHA-256 が実ファイルと一致しない")
    return len(expected["files"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["rebuild", "verify"])
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT,
                        help="照合する conformance ディレクトリ")
    args = parser.parse_args()
    try:
        if not args.root.is_dir():
            raise ValueError(f"データディレクトリがない: {args.root}")
        if args.mode == "rebuild":
            result = inventory(args.root)
            (args.root / "manifest.json").write_text(
                json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            count = len(result["files"])
        else:
            count = verify(args.root)
        print(f"manifest {args.mode}: OK ({count} files, version {VERSION})")
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"manifest {args.mode}: FAILED: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
