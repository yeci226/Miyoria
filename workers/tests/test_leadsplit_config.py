"""The lead splitter's config loader reads tuples and nothing else of Python."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "sing"))

yaml = pytest.importorskip("yaml")

from leadsplit import load_config  # noqa: E402


def test_reads_the_tuples_these_configs_are_written_with():
    cfg = load_config(
        "audio:\n  chunk_size: 352800\n  sample_rate: 44100\n"
        "model:\n  dim: 256\n  multi_stft_resolutions_window_sizes: !!python/tuple\n  - 4096\n  - 2048\n"
        "  freqs_per_bands: !!python/tuple [2, 2, 4]\n"
    )
    assert cfg["audio"]["chunk_size"] == 352800
    assert cfg["model"]["multi_stft_resolutions_window_sizes"] == (4096, 2048)
    assert cfg["model"]["freqs_per_bands"] == (2, 2, 4)


@pytest.mark.parametrize("text", [
    "x: !!python/object/apply:os.system ['echo run']\n",
    "x: !!python/name:os.system\n",
    "x: !!python/object/new:subprocess.Popen [['true']]\n",
])
def test_refuses_a_config_that_names_python_to_run(text):
    with pytest.raises(yaml.YAMLError):
        load_config(text)


def test_refuses_a_config_that_is_not_a_mapping():
    with pytest.raises(RuntimeError):
        load_config("- 1\n- 2\n")
