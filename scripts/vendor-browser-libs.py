#!/usr/bin/env python3
"""
Fetch the system libraries headless Chromium needs, without root.

On a locked-down host (no apt/sudo) Playwright's Chromium cannot start because
shared libraries such as libnspr4.so / libgbm.so.1 are missing. This script
downloads the matching Arch packages and extracts only usr/lib/* into
vendor/browser-libs, so the capture server can be started with

    LD_LIBRARY_PATH=vendor/browser-libs node server/index.mjs

Nothing outside the project directory is touched.
"""
import io
import os
import shutil
import subprocess
import sys
import tarfile
from urllib.request import Request, urlopen

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "vendor", "browser-libs")
REPOS = ("extra", "core", "multilib")

PACKAGES = [
    "nspr",
    "nss",
    "at-spi2-core",  # libatk-1.0, libatk-bridge-2.0, libatspi
    "libx11",
    "libxcomposite",
    "libxdamage",
    "libxext",
    "libxfixes",
    "libxrandr",
    "libxrender",
    "libxi",
    "libxtst",
    "libxcb",
    "libxau",
    "libxdmcp",
    "libxkbcommon",
    "mesa",          # libgbm
    "libdrm",
    "alsa-lib",      # libasound
]


def download(pkg: str) -> bytes | None:
    for repo in REPOS:
        url = f"https://archlinux.org/packages/{repo}/x86_64/{pkg}/download/"
        try:
            req = Request(url, headers={"User-Agent": "longshot-setup"})
            with urlopen(req, timeout=60) as resp:
                data = resp.read()
            if data[:2] == b"\x28\xb5" or data[:4] == b"\x28\xb5\x2f\xfd":
                return data
            return data
        except Exception:
            continue
    return None


def decompress(data: bytes) -> bytes:
    try:
        from compression import zstd  # Python 3.14+
        return zstd.decompress(data)
    except Exception:
        p = subprocess.run(["zstd", "-dc"], input=data, capture_output=True)
        if p.returncode == 0:
            return p.stdout
        raise RuntimeError("cannot decompress package (need python3.14+ or zstd)")


def extract(pkg: str) -> int:
    data = download(pkg)
    if data is None:
        print(f"  !! {pkg}: download failed")
        return 0
    tar = decompress(data)
    count = 0
    links = []
    with tarfile.open(fileobj=io.BytesIO(tar)) as tf:
        for member in tf.getmembers():
            name = member.name.lstrip("./")
            base = os.path.basename(name)
            if member.isdir() or not name.startswith("usr/lib/") or ".so" not in base:
                continue
            if member.issym():
                links.append((base, os.path.basename(member.linkname)))
                continue
            if not member.isfile():
                continue
            member.name = base
            tf.extract(member, OUT, filter="data")
            count += 1
    # Symlinks are flattened: copy the real file for each soname alias present.
    for base, target in links:
        src = os.path.join(OUT, target)
        dst = os.path.join(OUT, base)
        if os.path.exists(src) and not os.path.exists(dst):
            shutil.copy2(src, dst)
            count += 1
    print(f"  {pkg}: {count} shared objects")
    return count


def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    print(f"vendoring libs into {OUT}")
    total = 0
    for pkg in PACKAGES:
        total += extract(pkg)
    print(f"done: {total} files")

    ldd = subprocess.run(["ldd", "--version"], capture_output=True, text=True).stdout
    env = dict(os.environ, LD_LIBRARY_PATH=OUT)
    return 0 if ldd else 1


if __name__ == "__main__":
    sys.exit(main())
