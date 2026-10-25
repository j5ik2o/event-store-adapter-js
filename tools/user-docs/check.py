#!/usr/bin/env python3
"""利用者向けの文書が、型の正本（user-docs/template.json）に従っているかを標準ライブラリだけで照合する。"""

import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import posixpath
import re
import sys
from urllib.parse import unquote

TEMPLATE_VERSION = "1.0.0"
TEMPLATE_PATH = "user-docs/template.json"
CONFIG_PATH = "user-docs/repo.json"
CONFIG_KEYS = ("package", "docs_root", "storages", "extra_documents", "moved")

FENCE_OPEN = re.compile(r"^(`{3,}|~{3,})(.*)$")
CONTAINER_PREFIX = re.compile(r"^(?:[ \t]*(?:>|[-+*][ \t]|\d{1,9}[.)][ \t]))*[ \t]*")
HEADING = re.compile(r"^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$")
INLINE_CODE = re.compile(r"(`+).+?\1")
INLINE_LINK = re.compile(r"\]\(\s*(<[^>]*>|[^)\s]*)[^)]*\)")
REFERENCE_LINK = re.compile(r"^ {0,3}\[[^\]]+\]:[ \t]*(\S+)")
EXTERNAL_PREFIXES = ("http:", "https:", "mailto:", "#")


@dataclass(frozen=True)
class Problem:
    path: str
    line: int | None
    message: str

    def render(self) -> str:
        if self.line is None:
            return f"{self.path}: {self.message}"
        return f"{self.path}:{self.line}: {self.message}"


def relative(path: Path, root: Path) -> str:
    return os.path.relpath(path, root).replace(os.sep, "/")


def read_json(path: Path, problems: list[Problem], root: Path) -> object | None:
    shown = relative(path, root)

    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"JSON キーが重複: {key}")
            result[key] = value
        return result

    def reject_constant(value):
        raise ValueError(f"JSON にない数値: {value}")

    if not path.is_file():
        problems.append(Problem(shown, None, "ファイルがない"))
        return None
    try:
        return json.loads(
            path.read_text(encoding="utf-8"),
            object_pairs_hook=unique_object,
            parse_constant=reject_constant,
        )
    except json.JSONDecodeError as error:
        problems.append(Problem(shown, error.lineno, f"JSON として読めない: {error.msg}"))
    except (OSError, UnicodeDecodeError, ValueError) as error:
        problems.append(Problem(shown, None, f"読めない: {error}"))
    return None


def load_template(path: Path, root: Path, problems: list[Problem]) -> dict | None:
    shown = relative(path, root)
    value = read_json(path, problems, root)
    if value is None:
        return None
    if not isinstance(value, dict):
        problems.append(Problem(shown, None, "型の正本が JSON のオブジェクトでない"))
        return None
    if value.get("version") != TEMPLATE_VERSION:
        problems.append(
            Problem(shown, None, f"型の版が {TEMPLATE_VERSION} でない: {value.get('version')!r}")
        )
        return None
    documents = value.get("documents")
    required = {
        "japanese_first_line": str,
        "storages": list,
        "documents": dict,
        "moved": dict,
    }
    for key, kind in required.items():
        if not isinstance(value.get(key), kind):
            problems.append(Problem(shown, None, f"型の正本のキー {key} がない、または型が違う"))
            return None
    for key in ("readme", "schema", "migration_guide"):
        if not isinstance(documents.get(key), dict):
            problems.append(Problem(shown, None, f"型の正本の documents.{key} がない"))
            return None
    for key in ("en", "ja"):
        if not isinstance(value["moved"].get(key), str):
            problems.append(Problem(shown, None, f"型の正本の moved.{key} がない"))
            return None
    return value


def japanese_path(english: str) -> str:
    return english[: -len(".md")] + ".ja.md"


def expected_first_line(template: dict, english_name: str) -> str:
    return template["japanese_first_line"].replace("{english}", english_name)


def selected_storages(template: dict, storage_ids) -> list[dict]:
    wanted = set(storage_ids)
    return [storage for storage in template["storages"] if storage["id"] in wanted]


def required_documents(template: dict, config: dict) -> list[dict]:
    """型が求める文書（英語のパスと、見出しの期待値）を並べる。パスは文書の起点からの相対。"""
    documents = template["documents"]
    storages = selected_storages(template, config["storages"])
    readme = documents["readme"]
    result = [
        {
            "kind": "readme",
            "en": readme["path"],
            "h1": {"en": config["package"], "ja": config["package"]},
            "h2": readme["h2"],
            "storages_h2": readme["storages_h2"],
            "storages": storages,
        }
    ]
    schema = documents["schema"]
    for storage in storages:
        if storage["schema_prefix"] is None:
            continue
        result.append(
            {
                "kind": "schema",
                "en": schema["path"].replace("{prefix}", storage["schema_prefix"]),
                "h1": {
                    lang: schema["h1"][lang].replace("{en}", storage["en"]).replace("{ja}", storage["ja"])
                    for lang in ("en", "ja")
                },
                "h2": schema["h2"],
                "storages_h2": None,
                "storages": None,
            }
        )
    guide = documents["migration_guide"]
    result.append(
        {
            "kind": "migration_guide",
            "en": guide["path"],
            "h1": guide["h1"],
            "h2": guide["h2"],
            "storages_h2": None,
            "storages": None,
        }
    )
    return result


def path_shape_error(value: str) -> str | None:
    if posixpath.isabs(value) or re.match(r"^[A-Za-z]:", value):
        return "絶対パスは使えない"
    if ".." in value.split("/"):
        return "'..' を含むパスは使えない"
    if not value.endswith(".md"):
        return ".md で終わらない"
    if value.endswith(".ja.md"):
        return "英語の文書のパスで書く（.ja.md で終わらない）"
    return None


def load_config(path: Path, root: Path, template: dict, problems: list[Problem]) -> dict | None:
    shown = relative(path, root)

    def report(message: str) -> None:
        problems.append(Problem(shown, None, message))

    value = read_json(path, problems, root)
    if value is None:
        return None
    if not isinstance(value, dict):
        report("設定が JSON のオブジェクトでない")
        return None
    for key in CONFIG_KEYS:
        if key not in value:
            report(f"必須のキー {key} がない")
    for key in value:
        if key not in CONFIG_KEYS:
            report(f"知らないキー {key} がある")
    if any(key not in value for key in CONFIG_KEYS):
        return None

    usable = True
    package = value["package"]
    if not isinstance(package, str) or not package:
        report("package は空でない文字列にする")
        usable = False
    docs_root = value["docs_root"]
    if not isinstance(docs_root, str) or not docs_root:
        report("docs_root は空でない文字列にする")
        return None
    if posixpath.isabs(docs_root) or ".." in docs_root.split("/"):
        report("docs_root は '..' を含まない相対パスにする")
        return None
    if not (root / docs_root).is_dir():
        report(f"docs_root のディレクトリがない: {docs_root}")
        return None

    storage_ids = value["storages"]
    known = {storage["id"] for storage in template["storages"]}
    kept_ids: list[str] = []
    if not isinstance(storage_ids, list) or not all(isinstance(item, str) for item in storage_ids):
        report("storages は文字列の並びにする")
        return None
    if not storage_ids:
        report("storages が空")
    for storage_id in storage_ids:
        if storage_id not in known:
            report(f"知らない保存先の id: {storage_id}")
        elif storage_id in kept_ids:
            report(f"保存先の id が重複: {storage_id}")
        else:
            kept_ids.append(storage_id)

    extra = value["extra_documents"]
    if not isinstance(extra, list) or not all(isinstance(item, str) for item in extra):
        report("extra_documents は文字列の並びにする")
        return None
    kept_extra: list[str] = []
    for raw in extra:
        error = path_shape_error(raw)
        item = posixpath.normpath(raw)
        if error is not None:
            report(f"extra_documents のパスが正しくない ({raw}): {error}")
        elif item in kept_extra:
            report(f"extra_documents のパスが重複: {item}")
        else:
            kept_extra.append(item)

    moved = value["moved"]
    if not isinstance(moved, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in moved.items()):
        report("moved は文字列から文字列への対応にする")
        return None

    draft = {"package": package if isinstance(package, str) else "", "storages": kept_ids}
    required_paths = [doc["en"] for doc in required_documents(template, draft)]
    taken = set(required_paths)
    for item in kept_extra:
        if item in taken:
            report(f"extra_documents のパスが型の文書と重なる: {item}")
        taken.add(item)
    destinations = set(required_paths) | set(kept_extra)
    kept_moved: dict[str, str] = {}
    for old_raw, new_raw in moved.items():
        old_error = path_shape_error(old_raw)
        new_error = path_shape_error(new_raw)
        old = posixpath.normpath(old_raw)
        new = posixpath.normpath(new_raw)
        if old_error is not None:
            report(f"moved の古いパスが正しくない ({old_raw}): {old_error}")
        elif new_error is not None:
            report(f"moved の新しいパスが正しくない ({new_raw}): {new_error}")
        elif old in taken:
            report(f"moved の古いパスが、型の文書または型の外の文書と重なる: {old}")
        elif new not in destinations:
            report(f"moved の新しいパスが、型の文書にも型の外の文書にもない: {new}")
        else:
            kept_moved[old] = new
            taken.add(old)

    if not usable:
        return None
    return {
        "package": package,
        "docs_root": docs_root,
        "storages": kept_ids,
        "extra_documents": kept_extra,
        "moved": kept_moved,
    }


def read_text(file: Path) -> str:
    return file.read_text(encoding="utf-8").replace("\r\n", "\n")


def read_document(file: Path, root: Path, problems: list[Problem]) -> str | None:
    """文書を読む。読めなければ、そのファイルの誤りを problems に足して None を返す。"""
    try:
        return read_text(file)
    except OSError as error:
        problems.append(Problem(relative(file, root), None, f"文書を読めない: {error.strerror or error}"))
    except UnicodeDecodeError as error:
        problems.append(Problem(relative(file, root), None, f"UTF-8 として読めない: {error.reason}"))
    return None


def check_first_line(file: Path, english_name: str, template: dict, root: Path) -> list[Problem]:
    if not file.is_file():
        return []
    problems: list[Problem] = []
    text = read_document(file, root, problems)
    if text is None:
        return problems
    first = text.split("\n")[0]
    expected = expected_first_line(template, english_name)
    if first != expected:
        return [Problem(relative(file, root), 1, f"1 行目が決まった先頭の一行でない（期待: {expected}）")]
    return []


def parse_markdown(text: str) -> tuple[list[tuple[int, int, str]], list[tuple[int, str]]]:
    """コードブロックの外の見出し [(行, レベル, 文字列)] とリンク [(行, 行き先)] を返す。"""
    headings: list[tuple[int, int, str]] = []
    links: list[tuple[int, str]] = []
    fence_char = ""
    fence_length = 0
    for number, line in enumerate(text.replace("\r\n", "\n").split("\n"), start=1):
        if fence_char:
            unwrapped = line[CONTAINER_PREFIX.match(line).end() :]
            closing = re.match(r"^(" + re.escape(fence_char) + r"{" + str(fence_length) + r",})[ \t]*$", unwrapped)
            if closing:
                fence_char = ""
            continue
        opening = FENCE_OPEN.match(line[CONTAINER_PREFIX.match(line).end() :])
        if opening and not (opening.group(1)[0] == "`" and "`" in opening.group(2)):
            fence_char = opening.group(1)[0]
            fence_length = len(opening.group(1))
            continue
        heading = HEADING.match(line)
        if heading:
            title = re.sub(r"(^|[ \t]+)#+$", "", heading.group(2) or "").strip()
            headings.append((number, len(heading.group(1)), title))
        reference = REFERENCE_LINK.match(line)
        if reference:
            links.append((number, reference.group(1)))
        for target in INLINE_LINK.findall(INLINE_CODE.sub("", line)):
            links.append((number, target))
    return headings, links


def heading_lists(headings: list[tuple[int, int, str]]) -> dict:
    """見出しを、H1・H2・H2 ごとの H3 に整理する。"""
    h1s = [item for item in headings if item[1] == 1]
    h2s: list[tuple[int, str]] = []
    h3s: list[list[tuple[int, str]]] = []
    for number, level, title in headings:
        if level == 2:
            h2s.append((number, title))
            h3s.append([])
        elif level == 3 and h3s:
            h3s[-1].append((number, title))
    return {"all": headings, "h1": h1s, "h2": h2s, "h3": h3s}


def first_mismatch_line(actual: list[tuple[int, str]], expected: list[str], fallback: int | None) -> int | None:
    for index, expected_title in enumerate(expected):
        if index >= len(actual):
            return actual[-1][0] if actual else fallback
        if actual[index][1] != expected_title:
            return actual[index][0]
    if len(actual) > len(expected):
        return actual[len(expected)][0]
    return fallback


def check_one_language(
    shown: str, parsed: dict, h1: str, h2: list[str], storages_h2: str | None, storage_names: list[str] | None
) -> tuple[list[Problem], bool]:
    """1 つの言語の文書の見出しを照合する。H2 が型と一致したかも返す。"""
    problems: list[Problem] = []
    headings = parsed["all"]
    h1s = parsed["h1"]
    first_line = headings[0][0] if headings else None
    if not h1s:
        problems.append(Problem(shown, first_line, f"H1 がない（期待: {h1}）"))
    elif len(h1s) > 1:
        problems.append(Problem(shown, h1s[1][0], "H1 が 2 つ以上ある"))
    elif headings[0] is not h1s[0]:
        problems.append(Problem(shown, headings[0][0], "H1 が最初の見出しでない"))
    elif h1s[0][2] != h1:
        problems.append(Problem(shown, h1s[0][0], f"H1 が型と違う（期待: {h1}、実際: {h1s[0][2]}）"))

    actual = parsed["h2"]
    h2_matches = [title for _, title in actual] == h2
    if not h2_matches:
        line = first_mismatch_line(actual, h2, first_line)
        problems.append(
            Problem(shown, line, f"H2 が型と一致しない（期待: {', '.join(h2)}、実際: {', '.join(t for _, t in actual)}）")
        )
    elif storages_h2 is not None and storage_names is not None:
        index = h2.index(storages_h2)
        actual_h3 = parsed["h3"][index]
        if [title for _, title in actual_h3] != storage_names:
            line = first_mismatch_line(actual_h3, storage_names, actual[index][0])
            problems.append(
                Problem(
                    shown,
                    line,
                    f"{storages_h2} の下の H3 が提供する保存先と一致しない（期待: {', '.join(storage_names)}）",
                )
            )
    return problems, h2_matches


def check_headings(doc: dict, docs_root: Path, root: Path) -> list[Problem]:
    problems: list[Problem] = []
    parsed = {}
    shown = {}
    for lang in ("en", "ja"):
        path = docs_root / (doc["en"] if lang == "en" else japanese_path(doc["en"]))
        shown[lang] = relative(path, root)
        if not path.is_file():
            problems.append(Problem(shown[lang], None, "型が求める文書がない"))
            continue
        text = read_document(path, root, problems)
        if text is None:
            continue
        parsed[lang] = heading_lists(parse_markdown(text)[0])
    matched = {}
    for lang, lists in parsed.items():
        h2 = [entry[lang] for entry in doc["h2"]]
        storages_h2 = None
        storage_names = None
        if doc["storages_h2"] is not None:
            storages_h2 = next(entry[lang] for entry in doc["h2"] if entry["en"] == doc["storages_h2"])
            storage_names = [storage[lang] for storage in doc["storages"]]
        found, matched[lang] = check_one_language(
            shown[lang], lists, doc["h1"][lang], h2, storages_h2, storage_names
        )
        problems.extend(found)
    if len(parsed) == 2 and matched["en"] and matched["ja"]:
        for index, entry in enumerate(doc["h2"]):
            if entry["en"] == doc["storages_h2"]:
                continue
            en_count = len(parsed["en"]["h3"][index])
            ja_count = len(parsed["ja"]["h3"][index])
            if en_count != ja_count:
                problems.append(
                    Problem(
                        shown["en"],
                        parsed["en"]["h2"][index][0],
                        f"H2 {entry['en']} の下の H3 の数が英語と日本語で違う（英語 {en_count}、日本語 {ja_count}）",
                    )
                )
    return problems


def check_links(file: Path, root: Path) -> list[Problem]:
    problems: list[Problem] = []
    shown = relative(file, root)
    text = read_document(file, root, problems)
    if text is None:
        return problems
    for number, target in parse_markdown(text)[1]:
        target = target.strip()
        if target.startswith("<") and target.endswith(">"):
            target = target[1:-1]
        if target.lower().startswith(EXTERNAL_PREFIXES):
            continue
        target = unquote(re.split(r"[#?]", target, maxsplit=1)[0])
        if not target:
            continue
        base = root if target.startswith("/") else file.parent
        resolved = Path(os.path.normpath(base / target.lstrip("/")))
        if relative(resolved, root).split("/")[0] == "..":
            problems.append(Problem(shown, number, f"リンクがリポジトリの外を指している: {target}"))
        elif not resolved.exists():
            problems.append(Problem(shown, number, f"リンクの行き先がない: {target}"))
    return problems


def check_moved(old: str, new: str, docs_root: Path, template: dict, root: Path) -> list[Problem]:
    problems: list[Problem] = []
    directory = posixpath.dirname(old) or "."
    expected = {
        old: template["moved"]["en"].replace("{link}", posixpath.relpath(new, directory)),
        japanese_path(old): template["moved"]["ja"]
        .replace("{first_line}", expected_first_line(template, posixpath.basename(old)))
        .replace("{link}", posixpath.relpath(japanese_path(new), directory)),
    }
    for path_text, content in expected.items():
        file = docs_root / path_text
        shown = relative(file, root)
        if not file.is_file():
            problems.append(Problem(shown, None, "移ったことを示すファイルがない"))
            continue
        text = read_document(file, root, problems)
        if text is None:
            continue
        actual_lines = text.split("\n")
        expected_lines = content.split("\n")
        if actual_lines != expected_lines:
            line = 1
            for index, expected_line in enumerate(expected_lines):
                if index >= len(actual_lines) or actual_lines[index] != expected_line:
                    line = index + 1
                    break
            else:
                line = len(expected_lines)
            problems.append(Problem(shown, line, "移ったことを示すファイルが決まった形でない、または新しいパスを指していない"))
    return problems


def check_docs_directory(docs_root: Path, allowed: set[str], root: Path) -> list[Problem]:
    directory = docs_root / "docs"
    if not directory.is_dir():
        return []
    problems = []
    for file in sorted(p for p in directory.iterdir() if p.is_file() and p.suffix == ".md"):
        if relative(file, docs_root) not in allowed:
            problems.append(
                Problem(
                    relative(file, root),
                    None,
                    "docs/ の直下の .md が、型の文書・型の外の文書・移ったことを示すファイルのどれでもない",
                )
            )
    return problems


def check(root: Path) -> tuple[list[Problem], int]:
    root = Path(os.path.abspath(root))
    problems: list[Problem] = []
    template = load_template(root / TEMPLATE_PATH, root, problems)
    if template is None:
        return problems, 0
    config = load_config(root / CONFIG_PATH, root, template, problems)
    if config is None:
        return problems, 0
    docs_root = root / config["docs_root"]

    documents = required_documents(template, config)
    for doc in documents:
        problems.extend(check_headings(doc, docs_root, root))

    extra = config["extra_documents"]
    for english in extra:
        for path_text in (english, japanese_path(english)):
            if not (docs_root / path_text).is_file():
                problems.append(Problem(relative(docs_root / path_text, root), None, "型の外の文書がない"))

    moved = config["moved"]
    for old, new in moved.items():
        problems.extend(check_moved(old, new, docs_root, template, root))

    english_paths = [doc["en"] for doc in documents] + extra + list(moved)
    all_paths = [path_text for english in english_paths for path_text in (english, japanese_path(english))]
    for english in english_paths:
        problems.extend(check_first_line(docs_root / japanese_path(english), posixpath.basename(english), template, root))

    existing = [docs_root / path_text for path_text in all_paths if (docs_root / path_text).is_file()]
    for file in existing:
        problems.extend(check_links(file, root))

    problems.extend(check_docs_directory(docs_root, set(all_paths), root))
    return problems, len(existing)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="利用者向けの文書を型の正本と照合する")
    parser.add_argument("--root", type=Path, default=Path("."), help="照合するリポジトリのルート（既定: カレントディレクトリ）")
    args = parser.parse_args(argv)
    problems, count = check(args.root)
    if problems:
        for problem in problems:
            print(problem.render(), file=sys.stderr)
        print(f"user-docs check: FAILED ({len(problems)} errors)", file=sys.stderr)
        return 1
    print(f"user-docs check: OK ({count} documents, template {TEMPLATE_VERSION})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
