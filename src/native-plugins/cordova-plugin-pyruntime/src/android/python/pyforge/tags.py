"""Which wheels can this interpreter actually load?

On a desktop, `packaging.tags.sys_tags()` answers that. On Android it would
be actively dangerous: Chaquopy's CPython may report itself as "linux", and
`sys_tags()` would then happily accept `manylinux` wheels, which are linked
against glibc and crash on import under Android's bionic libc. So on Android
we use a strict allow-list instead:

  * pure-Python wheels (platform tag `any`), and
  * wheels tagged `android_<api>_<abi>` for *this* device's ABI and an API
    level no newer than the device's  (PEP 738 / Chaquopy tagging).

Nothing else is ever accepted on Android.
"""

from __future__ import annotations

import os
import platform
import re
import sys
import sysconfig
from typing import Optional

_ANDROID_TAG = re.compile(r"^android_(\d+)_(.+)$")
_ABI_FROM_MACHINE = {
    "aarch64": "arm64_v8a",
    "arm64": "arm64_v8a",
    "armv7l": "armeabi_v7a",
    "armv8l": "armeabi_v7a",
    "x86_64": "x86_64",
    "i686": "x86",
    "i386": "x86",
}


def _detect() -> tuple[Optional[str], int]:
    """Return (android_abi or None, android_api)."""
    # 1. Explicit override (tests, or Kotlin telling us authoritatively).
    forced = os.environ.get("PYFORGE_PLATFORM")  # e.g. "android_24_arm64_v8a"
    if forced:
        m = _ANDROID_TAG.match(forced)
        if m:
            return m.group(2), int(m.group(1))
        return None, 0

    abi = os.environ.get("PYFORGE_ABI", "").replace("-", "_") or None
    api = int(os.environ.get("PYFORGE_API") or 0)
    if abi:
        return abi, api or 24

    # 2. PEP 738: sysconfig.get_platform() == "android-24-arm64_v8a"
    plat = sysconfig.get_platform()
    m = re.match(r"^android[-_](\d+)[-_](.+)$", plat)
    if m:
        return m.group(2), int(m.group(1))
    if sys.platform == "android" or "ANDROID_DATA" in os.environ:
        return _ABI_FROM_MACHINE.get(platform.machine(), "arm64_v8a"), api or 24
    return None, 0


def is_android() -> bool:
    return _detect()[0] is not None


def describe_platform() -> dict:
    abi, api = _detect()
    return {
        "android": abi is not None,
        "abi": abi,
        "api": api,
        "cp": f"cp{sys.version_info.major}{sys.version_info.minor}",
    }


def wheel_rank(tags) -> Optional[int]:
    """Lower is better; None means "can't use this wheel".

    `tags` is the set of packaging.tags.Tag objects a wheel filename expands
    to (from packaging.utils.parse_wheel_filename).
    """
    abi_dev, api_dev = _detect()
    major, minor = sys.version_info[:2]
    cp = f"cp{major}{minor}"
    best: Optional[int] = None

    def consider(rank: int) -> None:
        nonlocal best
        if best is None or rank < best:
            best = rank

    host_tags = None
    for tag in tags:
        interp, abi, plat = tag.interpreter, tag.abi, tag.platform
        interp_ok = (
            interp == cp
            or interp == f"py{major}"
            or interp == f"py{major}{minor}"
            or (interp.startswith("cp3") and abi == "abi3" and int(interp[3:] or 0) <= minor)
        )
        abi_ok = abi in (cp, "abi3", "none")

        if plat == "any":
            if interp_ok and abi == "none":
                consider(0)
            continue

        if abi_dev is None:
            # Desktop preview: defer to packaging's idea of the host.
            if host_tags is None:
                from packaging import tags as ptags

                host_tags = set(ptags.sys_tags())
            if tag in host_tags:
                consider(10)
            continue

        m = _ANDROID_TAG.match(plat)
        if not m or not interp_ok or not abi_ok:
            continue
        if m.group(2) != abi_dev:
            continue
        if api_dev and int(m.group(1)) > api_dev:
            continue
        # Prefer the exact-ABI cp wheel over abi3, and a newer API level.
        consider(1 + (0 if abi == cp else 1) + (100 - int(m.group(1))) // 100)
    return best
