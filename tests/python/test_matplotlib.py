import pytest

pytest.importorskip("matplotlib")


def test_plt_show_emits_png_path(host, script):
    host.run(path=script(
        "import matplotlib.pyplot as plt\nplt.plot([1, 2, 3], [1, 4, 9])\nplt.title('Squares')\nplt.show()\nprint('shown')"))
    host.dirs["cache"].mkdir(parents=True, exist_ok=True)
    ev = host.finish(timeout=60)
    assert ev["code"] == 0, host.stderr
    img = [e for e in host.events if e["t"] == "img"]
    assert len(img) == 1 and img[0]["title"] == "Squares"
    with open(img[0]["path"], "rb") as f:
        assert f.read(8) == b"\x89PNG\r\n\x1a\n"
    assert "non-interactive" not in host.stderr


def test_two_figures_and_second_show_does_not_resend(host, script):
    host.run(path=script(
        "import matplotlib.pyplot as plt\nplt.figure(); plt.plot([1]); plt.figure(); plt.plot([2])\nplt.show()\nplt.show()"))
    host.finish(timeout=60)
    assert len([e for e in host.events if e["t"] == "img"]) == 2
