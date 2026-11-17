"""Writes ``contracts.py``: the pydantic models of the workers' JSON bodies, generated from the JSON
Schema that ``pnpm contracts:gen`` emits from the zod schemas (``packages/contracts/workers/src``)
into ``packages/contracts/schema/workers.json``. That file is checked in, so Node is not needed here.

    pip install -r requirements-contracts.txt     # the pinned generator
    python gen_contracts.py                       # writes contracts.py
    python gen_contracts.py --check               # exit 1 (and a diff) when contracts.py is stale

Standard library only; the generator runs as a child process. The output does not depend on the
platform or the Python version: the generator's own formatter is used (not black / isort, whose
versions are not pinned), the header is ours (no path, no date), and the file is written with LF.
"""

from __future__ import annotations

import argparse
import difflib
import importlib.metadata
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCHEMA = HERE.parent / "packages" / "contracts" / "schema" / "workers.json"
OUTPUT = HERE / "contracts.py"
PIN_FILE = HERE / "requirements-contracts.txt"
GENERATOR = "datamodel-code-generator"

OPTIONS = [
    "--input-file-type", "jsonschema",
    "--output-model-type", "pydantic_v2.BaseModel",
    # The oldest Python and pydantic the workers run on; the output is the same on newer ones.
    "--target-python-version", "3.11",
    "--target-pydantic-version", "2",
    # A field with a default is not nullable unless the schema says so: `key` takes 0..12, not
    # null. Without it every field that may be left out also takes null.
    "--strict-nullable",
    # Enums as Literal, as the hand models had: an attribute is the plain string ("keep"), never an
    # Enum member, so `model_dump`, f-strings and comparisons stay what they were.
    "--enum-field-as-literal", "all",
    # Named root models (WorkersSingBacking, the max-length strings) are inlined into their fields,
    # so `req.query` is a str and `req.backing` a str, not a wrapper object.
    "--collapse-root-models",
    # conint / constr inline in the field. The Annotated form leaves a nullable integer with bounds
    # (`pitch`) as a separate root model even with --collapse-root-models.
    "--no-use-annotated",
    # Unknown keys are ignored, as before: an older worker accepts a newer client's body.
    "--extra-fields", "ignore",
    # No model for the document's root (it only has a title).
    "--skip-root-model",
    # Stable text: the generator's own formatter, and no timestamp.
    "--formatters", "builtin",
    "--disable-timestamp",
    "--use-double-quotes",
    "--use-standard-collections",
    "--use-union-operator",
]

HEADER = """\
# Generated, do not edit. Made from packages/contracts/schema/workers.json by
#     python workers/gen_contracts.py
# with {generator} {version} (pinned in workers/requirements-contracts.txt).
# To change a model, change its zod schema in packages/contracts/workers/src, run
# `pnpm contracts:gen`, then the command above.
"""


def pinned_version() -> str:
    for line in PIN_FILE.read_text(encoding="utf-8").splitlines():
        m = re.fullmatch(rf"\s*{re.escape(GENERATOR)}\s*==\s*([^\s#]+)\s*(#.*)?", line)
        if m:
            return m.group(1)
    raise SystemExit(f"{PIN_FILE.name} does not pin {GENERATOR}")


def installed_version() -> str | None:
    try:
        return importlib.metadata.version(GENERATOR)
    except importlib.metadata.PackageNotFoundError:
        return None


def generate() -> str:
    """The text ``contracts.py`` should have."""
    want, have = pinned_version(), installed_version()
    if have != want:
        raise SystemExit(f"{GENERATOR} {want} is needed, this Python has {have or 'none'}: "
                         f"pip install -r {PIN_FILE.name}")
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONWARNINGS="ignore")
    run = subprocess.run([sys.executable, "-m", "datamodel_code_generator", "--input", str(SCHEMA), *OPTIONS],
                         capture_output=True, text=True, encoding="utf-8", env=env, check=False)
    if run.returncode != 0:
        raise SystemExit(f"{GENERATOR} failed ({run.returncode}):\n{run.stderr}")
    lines = run.stdout.replace("\r\n", "\n").split("\n")
    while lines and lines[0].startswith("#"):  # the generator's own header names the input file
        lines.pop(0)
    body = "\n".join(lines).strip("\n")
    return HEADER.format(generator=GENERATOR, version=want) + "\n" + body + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--check", action="store_true", help="do not write; exit 1 when contracts.py is stale")
    args = parser.parse_args()
    text = generate()
    current = OUTPUT.read_text(encoding="utf-8") if OUTPUT.exists() else ""
    if args.check:
        if current == text:
            return 0
        sys.stdout.writelines(difflib.unified_diff(current.splitlines(True), text.splitlines(True),
                                                   "contracts.py (checked in)", "contracts.py (generated)"))
        print(f"\n{OUTPUT.name} is stale: run python workers/gen_contracts.py", file=sys.stderr)
        return 1
    if current != text:
        with open(OUTPUT, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        print(f"wrote {OUTPUT.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
