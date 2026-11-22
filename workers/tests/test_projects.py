"""The uv projects of the workers against the requirement files, the descriptors and the locks.

While the requirement files still exist (the old `miyoria install` and the Docker images read
them), every requirement line must be in the matching project's dependencies or extra, and the
other way round, so the two cannot drift. The CUDA torch step that the files describe in their
header comment (`pip install torch ... --index-url <url>`) must be the project's torch
dependencies, taken from an explicit index with that url, and nothing else may come from it.
Standard library only; the lock check runs `uv lock --check` when uv is on PATH.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tomllib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

# Each requirement file and the extra of its project that installs the same set (None: the
# project's own dependencies only).
FILES: dict[str, dict[str, str | None]] = {
    "asr": {
        "requirements.txt": None,
        "requirements-qwen3.txt": "qwen3",
        "requirements-sensevoice.txt": "sensevoice",
    },
    "tts": {"requirements-faster.txt": "faster", "requirements.txt": "qwen-tts"},
    "turn": {"requirements.txt": None},
    "sing": {"requirements.txt": None},
    "lyrics": {"requirements.txt": None},
}

# Requirement files outside the uv project: the project locks Windows and Linux only, and these
# install on macOS (requirements-mlx.txt: TTS_BACKEND=mlx on Apple silicon, no torch).
UNLOCKED: dict[str, set[str]] = {"tts": {"requirements-mlx.txt"}}

PIP_TORCH = re.compile(r"pip install ((?:(?!--)\S+\s+)+)--index-url\s+(\S+)")


def norm(req: str) -> str:
    """A requirement without spaces, with the PEP 503 name, so equal lines compare equal."""
    req = re.sub(r"\s+", "", req)
    m = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)(.*)$", req)
    assert m, f"not a requirement: {req!r}"
    return re.sub(r"[-_.]+", "-", m.group(1)).lower() + m.group(2)


def name_of(req: str) -> str:
    return re.match(r"^[a-z0-9-]+", norm(req)).group(0)  # type: ignore[union-attr]


def read_requirements(path: Path) -> tuple[set[str], list[tuple[list[str], str]]]:
    """The requirement lines (following `-r`) and the torch steps of the header comments."""
    reqs: set[str] = set()
    steps: list[tuple[list[str], str]] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line.startswith("#"):
            m = PIP_TORCH.search(line)
            if m:
                steps.append((m.group(1).split(), m.group(2)))
            continue
        line = line.split(" #", 1)[0].strip()
        if not line:
            continue
        if line.startswith("-r"):
            sub, sub_steps = read_requirements(path.parent / line[2:].strip())
            reqs |= sub
            steps += sub_steps
            continue
        assert not line.startswith("-"), f"{path.name}: option lines are not mirrored: {line}"
        reqs.add(norm(line))
    return reqs, steps


def load(name: str) -> dict:
    return tomllib.loads((ROOT / name / "pyproject.toml").read_text(encoding="utf-8"))


def torch_index(project: dict) -> tuple[str | None, set[str]]:
    """The url of the explicit index and the packages whose source is that index."""
    indexes = project.get("tool", {}).get("uv", {}).get("index", [])
    explicit = {i["name"]: i["url"] for i in indexes if i.get("explicit")}
    assert len(explicit) == len(indexes), "every extra index must be explicit"
    from_index: set[str] = set()
    for pkg, sources in project.get("tool", {}).get("uv", {}).get("sources", {}).items():
        for source in sources if isinstance(sources, list) else [sources]:
            if "index" in source:
                assert source["index"] in explicit, f"{pkg}: unknown index {source['index']}"
                from_index.add(norm(pkg))
    urls = set(explicit.values())
    assert len(urls) <= 1, "one CUDA index per project"
    return (urls.pop() if urls else None), from_index


@pytest.mark.parametrize("name", sorted(FILES))
def test_requirement_files_match_the_project(name: str) -> None:
    project = load(name)
    base = {norm(r) for r in project["project"].get("dependencies", [])}
    extras = {
        k: {norm(r) for r in v}
        for k, v in project["project"].get("optional-dependencies", {}).items()
    }
    url, from_index = torch_index(project)

    on_disk = {p.name for p in (ROOT / name).glob("requirements*.txt")} - UNLOCKED.get(name, set())
    assert on_disk == set(FILES[name]), "a requirement file without a mapping here"
    assert set(extras) == {e for e in FILES[name].values() if e}, "an extra without a file"

    torch_names: set[str] = set()
    for file, extra in FILES[name].items():
        reqs, steps = read_requirements(ROOT / name / file)
        expected = set(reqs)
        for packages, step_url in steps:
            assert step_url == url, f"{file}: torch index {step_url}, project {url}"
            expected |= {norm(p) for p in packages}
            torch_names |= {name_of(p) for p in packages}
        got = base | (extras[extra] if extra else set())
        assert sorted(got - expected) == [], f"{file}: in pyproject.toml only"
        assert sorted(expected - got) == [], f"{file}: in {file} only"

    # Only the torch step's packages come from the CUDA index, and all of them do.
    assert from_index == torch_names


@pytest.mark.parametrize("name", sorted(FILES))
def test_descriptor_points_at_the_project(name: str) -> None:
    project = load(name)
    service = tomllib.loads((ROOT / name / "service.toml").read_text(encoding="utf-8"))
    install = service["install"]
    assert install["runtime"] == "python"
    assert install["project"] == "."
    assert (ROOT / name / install["project"] / "uv.lock").is_file()
    extras = project["project"].get("optional-dependencies", {})
    # One backend extra when the project has extras, none otherwise.
    assert len(install.get("extras", [])) == (1 if extras else 0)
    assert set(install.get("extras", [])) <= set(extras)
    assert project["tool"]["uv"]["package"] is False
    assert install["python"].replace(" ", "") == project["project"]["requires-python"].replace(
        " ", ""
    )


@pytest.mark.skipif(shutil.which("uv") is None, reason="uv is not on PATH")
@pytest.mark.parametrize("name", sorted(FILES))
def test_lock_is_up_to_date(name: str) -> None:
    env = dict(os.environ)
    # Windows machines whose antivirus inspects TLS need the system certificate store.
    env.setdefault("UV_NATIVE_TLS", "1")
    r = subprocess.run(
        ["uv", "lock", "--check"],
        cwd=ROOT / name,
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
    )
    assert r.returncode == 0, r.stderr
