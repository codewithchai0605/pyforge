"""PyForge's on-device Python support code.

This package is deliberately plain Python with no Android-specific imports,
so the exact same files run (a) inside Chaquopy on the phone and (b) under an
ordinary desktop CPython for the browser preview and the automated tests.
Anything Android-specific (starting the interpreter, killing a runaway
script, handing events to the WebView) lives on the Kotlin side and talks to
this package through `pyforge.api` only.
"""

__version__ = "0.1.0"
