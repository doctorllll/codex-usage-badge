"""Build our macOS startup helper for Apple Silicon and Intel. No client binaries."""
from pathlib import Path
import platform
import subprocess

root = Path(__file__).resolve().parents[1]
if platform.system() != 'Darwin':
    raise SystemExit('Build the macOS helper on macOS with Xcode Command Line Tools.')
dest = root / '.devtools/macos-startup-bridge'
dest.parent.mkdir(exist_ok=True)
subprocess.run(['/usr/bin/xcrun', 'clang', '-fobjc-arc', '-O2', '-Wall', '-Wextra', '-Werror',
                '-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=12.0',
                '-framework', 'AppKit', '-framework', 'ApplicationServices',
                'macos/startup/bridge.m', '-o', str(dest)], cwd=root, check=True)
subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', '--timestamp=none', str(dest)], check=True)
# Newer lipo accepts one architecture per -verify_arch call.
for arch in ('arm64', 'x86_64'):
    subprocess.run(['/usr/bin/lipo', str(dest), '-verify_arch', arch], check=True)
subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(dest)], check=True)
print('Built universal macOS startup helper (arm64 + x86_64)')
