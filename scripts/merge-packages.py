"""Merge workspace packages into one, mechanically.

    python merge_packages.py <new-name> <member> [<member> ...]      (run from the repo root)

packages/<member>/ becomes packages/<new>/<member>/ (its src/ and test/ keep their shape), the
group gets one package.json whose exports are "./<member>", imports of "@miyoria/<member>" become
"@miyoria/<new>/<member>" outside the group and relative paths inside it, and relative paths that
cross a moved folder's edge are recomputed. Nothing is committed.
"""

from __future__ import annotations

import io
import json
import os
import posixpath
import re
import subprocess
import sys

NEW = sys.argv[1]
MEMBERS = sys.argv[2:]
SCOPE = "@miyoria/"
CODE_EXT = (".ts", ".tsx", ".mts", ".mjs", ".js", ".cjs")
DEFAULT_TSCONFIG = '{ "extends": "../../tsconfig.base.json" }'
DEFAULT_BUILD = '{ "extends": "../../tsconfig.build.base.json" }'
DEFAULT_VITEST = 'import { nodeProject } from "../../vitest.shared.ts";\n\nexport default nodeProject();'


def git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True, encoding="utf-8").stdout


def read(path: str) -> str:
    return io.open(path, encoding="utf-8", newline="").read()


def write(path: str, text: str) -> None:
    io.open(path, "w", encoding="utf-8", newline="").write(text)


def squash(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


tracked_before = [f for f in git("ls-files").split("\n") if f]
dirs_before = set()
for f in tracked_before:
    d = posixpath.dirname(f)
    while d:
        dirs_before.add(d)
        d = posixpath.dirname(d)
exists_before = set(tracked_before) | dirs_before | {"", "."}

old_dir = {m: f"packages/{m}" for m in MEMBERS}
new_dir = {m: f"packages/{NEW}/{m}" for m in MEMBERS}
for m in MEMBERS:
    if not os.path.isdir(old_dir[m]):
        sys.exit(f"no such package: {old_dir[m]}")


def moved(path: str) -> str:
    """Where a repo-relative path is after the move."""
    for m in MEMBERS:
        if path == old_dir[m] or path.startswith(old_dir[m] + "/"):
            return new_dir[m] + path[len(old_dir[m]):]
    return path


def member_of(path: str) -> str | None:
    for m in MEMBERS:
        if path == old_dir[m] or path.startswith(old_dir[m] + "/"):
            return m
    return None


# ---- 1. read the members' manifests, then move ------------------------------------------------

manifests = {m: json.loads(read(f"{old_dir[m]}/package.json")) for m in MEMBERS}
notes: list[str] = []
for m in MEMBERS:
    for name, default in (("tsconfig.json", DEFAULT_TSCONFIG), ("tsconfig.build.json", DEFAULT_BUILD),
                          ("vitest.config.ts", DEFAULT_VITEST)):
        p = f"{old_dir[m]}/{name}"
        if os.path.exists(p) and squash(read(p)) != squash(default):
            notes.append(f"NOT DEFAULT, merge by hand: {p}\n{read(p)}")
    exports = manifests[m].get("exports") or {}
    extra = [k for k in exports if k != "."]
    if extra:
        notes.append(f"{m} has subpath exports {extra}: add them by hand")
    for k in ("bin", "main", "imports"):
        if k in manifests[m]:
            notes.append(f"{m} has '{k}': {manifests[m][k]}")

for m in MEMBERS:
    for name in ("package.json", "tsconfig.json", "tsconfig.build.json", "vitest.config.ts"):
        p = f"{old_dir[m]}/{name}"
        if os.path.exists(p):
            git("rm", "-q", p)

clash = NEW in MEMBERS
if clash:
    git("mv", old_dir[NEW], f"packages/__moving_{NEW}")
os.makedirs(f"packages/{NEW}", exist_ok=True)
for m in MEMBERS:
    src = f"packages/__moving_{NEW}" if (clash and m == NEW) else old_dir[m]
    git("mv", src, new_dir[m])
    # Untracked leftovers (node_modules, dist) stay behind in the old folder: remove it.
    if os.path.isdir(src) and src != new_dir[m]:
        import shutil

        shutil.rmtree(src, ignore_errors=True)

# ---- 2. the group's manifest and configs ------------------------------------------------------


def union(section: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for m in MEMBERS:
        for name, version in (manifests[m].get(section) or {}).items():
            if name.startswith(SCOPE) and name[len(SCOPE):] in MEMBERS:
                continue
            if name in out and out[name] != version:
                notes.append(f"version clash for {name}: {out[name]} vs {version} ({m})")
            out.setdefault(name, version)
    return dict(sorted(out.items()))


scripts = {"build": "tsc -p tsconfig.build.json", "typecheck": "tsc --noEmit", "test": "vitest run"}
for m in MEMBERS:
    for name, cmd in (manifests[m].get("scripts") or {}).items():
        if name not in ("build", "typecheck", "test"):
            scripts[name] = cmd
            notes.append(f"script '{name}' from {m} copied as is, check its paths: {cmd}")

deps = union("dependencies")
dev = {k: v for k, v in union("devDependencies").items() if k not in deps}
package = {
    "name": SCOPE + NEW,
    "version": manifests[MEMBERS[0]].get("version", "0.1.0"),
    "description": "; ".join(f"{m}: {manifests[m].get('description', '')}".strip() for m in MEMBERS),
    "type": "module",
    "engines": manifests[MEMBERS[0]].get("engines", {"node": ">=24"}),
    "exports": {
        f"./{m}": {
            "@miyoria/source": f"./{m}/src/index.ts",
            "types": f"./dist/{m}/src/index.d.ts",
            "default": f"./dist/{m}/src/index.js",
        }
        for m in MEMBERS
    },
    "files": ["dist"],
    "scripts": scripts,
    "dependencies": deps,
    "devDependencies": dev,
}
write(f"packages/{NEW}/package.json", json.dumps(package, indent=2, ensure_ascii=False) + "\n")
write(f"packages/{NEW}/tsconfig.json",
      '{\n  "extends": "../../tsconfig.base.json",\n  "include": ["*/src", "*/test"]\n}\n')
write(f"packages/{NEW}/tsconfig.build.json",
      '{\n  "extends": "../../tsconfig.build.base.json",\n  "compilerOptions": { "rootDir": "." },\n'
      '  "include": ["*/src"],\n  "exclude": ["*/src/**/*.test.ts"]\n}\n')
write(f"packages/{NEW}/vitest.config.ts",
      'import { nodeProject } from "../../vitest.shared.ts";\n\n'
      "// One folder per part of the package, each with its own src/ and test/.\n"
      'export default nodeProject({\n  test: { include: ["*/test/**/*.test.ts", "*/src/**/*.test.ts"] },\n});\n')

# ---- 3. other manifests depend on the group ---------------------------------------------------

for f in [f for f in git("ls-files", "*package.json").split("\n") if f]:
    if f == f"packages/{NEW}/package.json":
        continue
    data = json.loads(read(f))
    changed = False
    for section in ("dependencies", "devDependencies", "peerDependencies"):
        block = data.get(section)
        if not block:
            continue
        hit = [k for k in block if k.startswith(SCOPE) and k[len(SCOPE):] in MEMBERS]
        if not hit:
            continue
        for k in hit:
            del block[k]
        block[SCOPE + NEW] = "workspace:*"
        data[section] = dict(sorted(block.items()))
        changed = True
    if changed:
        # a package listed in both sections keeps the dependencies entry only
        if SCOPE + NEW in (data.get("dependencies") or {}) and SCOPE + NEW in (data.get("devDependencies") or {}):
            del data["devDependencies"][SCOPE + NEW]
        write(f, json.dumps(data, indent=2, ensure_ascii=False) + "\n")

# ---- 4. import specifiers and relative paths --------------------------------------------------

SPEC = re.compile(r"""(["'])@miyoria/(""" + "|".join(re.escape(m) for m in MEMBERS) + r""")(/[^"'\n]*)?\1""")
PATHS = re.compile(r"(?<![\w/-])packages/(" + "|".join(re.escape(m) for m in MEMBERS) + r")/(src|test)(?![\w-])")
GROUP_FILES = ("package.json", "tsconfig.json", "tsconfig.build.json", "vitest.config.ts")
# Not what the pass above already wrote: when the group is named after one of its parts,
# "@miyoria/<new>/<member>" starts with "@miyoria/<member>".
BARE = re.compile(r"(?<![\w/-])@miyoria/(" + "|".join(re.escape(m) for m in MEMBERS) + r")(?![\w-])(?!/src)"
                  + (r"(?!/(?:" + "|".join(re.escape(m) for m in MEMBERS) + r")(?![\w-]))" if NEW in MEMBERS else ""))
REL = re.compile(r"""(["'])(\.\.?(?:/[^"'\n\s]*)?)\1""")


def relative(target: str, from_dir: str) -> str:
    rel = posixpath.relpath(target, from_dir or ".")
    return rel if rel.startswith(".") else "./" + rel


rewritten = 0
for new_path in [f for f in git("ls-files").split("\n") if f.endswith(CODE_EXT)]:
    if "/node_modules/" in new_path:
        continue
    old_path = None
    inside = None
    for m in MEMBERS:
        if new_path.startswith(new_dir[m] + "/"):
            old_path = old_dir[m] + new_path[len(new_dir[m]):]
            inside = m
    if old_path is None:
        old_path = new_path
    text = read(new_path)
    new_from = posixpath.dirname(new_path)
    old_from = posixpath.dirname(old_path)

    def spec(match: re.Match[str]) -> str:
        quote, member, sub = match.group(1), match.group(2), match.group(3) or ""
        if inside is None:
            return f"{quote}@miyoria/{NEW}/{member}{sub}{quote}"
        if sub:
            notes.append(f"subpath import inside the group, fix by hand: {new_path}: {match.group(0)}")
            return match.group(0)
        return f"{quote}{relative(new_dir[member] + '/src/index.js', new_from)}{quote}"

    def rel(match: re.Match[str]) -> str:
        quote, value = match.group(1), match.group(2)
        if not value.startswith(".."):
            return match.group(0)
        slash = value.endswith("/")
        target = posixpath.normpath(posixpath.join(old_from, value))
        if target.startswith(".."):
            return match.group(0)  # outside the repository: left alone
        target = "" if target == "." else target
        own = old_dir[inside] if inside else None
        owner = member_of(target)
        if owner and target[len(old_dir[owner]) + 1:] in GROUP_FILES:
            # A part's own manifest or config: the group has one for all of them now.
            return f"{quote}{relative(f'packages/{NEW}/' + target[len(old_dir[owner]) + 1:], new_from)}{quote}"
        if own and (target == own or target.startswith(own + "/")):
            return match.group(0)  # stays inside its own part
        if target not in exists_before and target.removesuffix(".js") + ".ts" not in exists_before \
                and target.removesuffix(".js") + ".tsx" not in exists_before:
            return match.group(0)  # not a path of this repository
        if inside is None and member_of(target) is None:
            return match.group(0)  # neither end moved
        out = relative(moved(target) or ".", new_from)
        if slash and not out.endswith("/"):
            out += "/"
        return f"{quote}{out}{quote}"

    updated = REL.sub(rel, SPEC.sub(spec, text))
    # Repository paths written out in full (tests that read source files, comments).
    updated = PATHS.sub(lambda m: f"packages/{NEW}/{m.group(1)}/{m.group(2)}", updated)
    # What is left are mentions in comments and messages, not imports.
    updated = BARE.sub(lambda m: f"@miyoria/{NEW}/{m.group(1)}", updated)
    if updated != text:
        write(new_path, updated)
        rewritten += 1

import shutil as _shutil

for m in MEMBERS:
    for junk in ("node_modules", "dist"):
        _shutil.rmtree(f"{new_dir[m]}/{junk}", ignore_errors=True)
print(f"merged {MEMBERS} into packages/{NEW}; rewrote {rewritten} files")
for n in notes:
    print("NOTE:", n)
