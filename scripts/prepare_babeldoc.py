#!/usr/bin/env python3
"""Build the self-contained Windows BabelDOC runtime shipped with Moonlight.

The output layout is::

    tools/windows/babeldoc/
      babeldoc.exe            native launcher (Rust, see babeldoc-launcher.rs)
      babeldoc_cli.py         calls babeldoc.main.cli()
      runtime/python.exe      official CPython embeddable distribution
      runtime/Lib/site-packages/  pinned BabelDOC 0.6.2 dependency closure
      THIRD_PARTY_NOTICES.txt
      MANIFEST.json           tree digest used by the packager

Run on the Windows CI runner before packaging.  The renderer/core never needs a
system Python installation once this directory is packaged.
"""
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'tools/windows/babeldoc'
SCRIPT_DIR = ROOT / 'scripts/babeldoc'
REQUIREMENTS = SCRIPT_DIR / 'requirements-win-py313.txt'
LAUNCHER_SRC = SCRIPT_DIR / 'babeldoc-launcher.rs'
CLI_SRC = SCRIPT_DIR / 'babeldoc_cli.py'

PYTHON_VERSION = '3.13.5'
PYTHON_EMBED_URL = f'https://www.python.org/ftp/python/{PYTHON_VERSION}/python-{PYTHON_VERSION}-embed-amd64.zip'
# SHA-256 published for the immutable python.org release artifact.
PYTHON_EMBED_SHA256 = '7d2650fd9d1b9d002d4a315d5f354247fd6a44f30517c7ef577b08f57a0fb6d9'
BABELDOC_VERSION = '0.6.2'


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fetch(url: str) -> bytes:
    headers = {'User-Agent': 'Moonlight-BabelDOC-Builder'}
    last = None
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=180) as response:
                return response.read()
        except Exception as error:  # noqa: BLE001 - retry any transient failure
            last = error
            if attempt == 2:
                break
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f'下载失败：{url}：{last}')


def find_uv() -> Path:
    found = shutil.which('uv') or shutil.which('uv.exe')
    if found:
        return Path(found)
    target = ROOT / 'tools/uv-build'
    target.mkdir(parents=True, exist_ok=True)
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', '--quiet', '--upgrade', '--target', str(target), 'uv'])
    candidates = [target / 'uv.exe', target / 'Scripts/uv.exe', target / 'bin/uv', target / 'uv']
    for candidate in candidates:
        if candidate.exists():
            return candidate
    for candidate in target.rglob('uv*'):
        if candidate.is_file() and candidate.suffix.lower() in ('', '.exe'):
            return candidate
    raise RuntimeError('无法准备 uv（用于交叉安装 Windows wheels）')


def patch_launcher_runtime(runtime: Path) -> None:
    pth = runtime / 'python313._pth'
    if not pth.exists():
        raise RuntimeError(f'嵌入式 Python 缺少 {pth.name}')
    pth.write_text(
        'python313.zip\n'
        '.\n'
        'Lib\\site-packages\n'
        'import site\n',
        encoding='utf-8',
    )


def compile_launcher() -> None:
    rustc = shutil.which('rustc') or shutil.which('rustc.exe')
    if not rustc:
        raise RuntimeError('找不到 rustc，无法编译 babeldoc.exe 启动器')
    subprocess.check_call([
        rustc, '--edition', '2021', '-O', str(LAUNCHER_SRC), '-o', str(DEST / 'babeldoc.exe'),
    ])


def copy_vc_runtime(runtime: Path) -> None:
    """App-local MSVC runtime DLLs used by numpy/onnxruntime/scipy wheels."""
    system = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32'
    copied = []
    for name in ('msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll',
                 'concrt140.dll', 'vcomp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'):
        source = system / name
        if source.exists() and not (runtime / name).exists():
            shutil.copy2(source, runtime / name)
            copied.append(name)
    print('VC runtime DLLs:', ', '.join(copied) or 'none found (Windows usually provides them)')


def write_notices() -> None:
    license_file = DEST / 'runtime/Lib/site-packages/babeldoc-0.6.2.dist-info/licenses/LICENSE'
    (DEST / 'THIRD_PARTY_NOTICES.txt').write_text(
        'Moonlight bundles the following third-party components for offline PDF translation:\n\n'
        f'BabelDOC {BABELDOC_VERSION}\n'
        '  Source: https://github.com/funstory-ai/BabelDOC\n'
        f'  License: GNU Affero General Public License v3.0 (full text: {license_file})\n'
        '  BabelDOC is invoked as a separate command-line process by Moonlight.\n\n'
        f'CPython {PYTHON_VERSION} embeddable distribution\n'
        '  Source: https://www.python.org/downloads/windows/\n'
        '  License: PSF-2.0 (see runtime/LICENSE.txt)\n\n'
        'Microsoft Visual C++ runtime DLLs (msvcp140*, concrt140, vcomp140, vcruntime140*)\n'
        '  App-local deployment of the Visual Studio redistributable runtime.\n'
        '  Source: Windows SDK / Visual Studio redistributable.\n\n'
        'Python dependency wheels are the pinned versions in\n'
        'scripts/babeldoc/requirements-win-py313.txt; their license files remain\n'
        'inside runtime/Lib/site-packages/*.dist-info/licenses/.\n',
        encoding='utf-8',
    )


def write_manifest() -> None:
    digest = hashlib.sha256()
    count = 0
    total = 0
    for path in sorted(DEST.rglob('*')):
        if not path.is_file() or path.name == 'MANIFEST.json':
            continue
        data = path.read_bytes()
        total += len(data)
        digest.update(path.relative_to(DEST).as_posix().encode('utf-8'))
        digest.update(b'\0')
        digest.update(sha256_bytes(data).encode('ascii'))
        digest.update(b'\n')
        count += 1
    (DEST / 'MANIFEST.json').write_text(json.dumps({
        'component': 'babeldoc',
        'version': BABELDOC_VERSION,
        'python': PYTHON_VERSION,
        'platform': 'win32-x64',
        'files': count,
        'bytes': total,
        'tree_sha256': digest.hexdigest(),
    }, indent=2) + '\n', encoding='utf-8')


def main() -> int:
    if sys.platform != 'win32':
        raise SystemExit('prepare_babeldoc.py 只在 Windows 构建机上运行（需要 Windows Python wheels 与 .exe 启动器）')
    if (DEST / 'MANIFEST.json').exists() and os.environ.get('BABELDOC_FORCE') != '1':
        print(f'复用已有 BabelDOC 运行时：{DEST}')
        return 0
    if DEST.exists():
        shutil.rmtree(DEST)
    DEST.mkdir(parents=True)

    print(f'下载 CPython {PYTHON_VERSION} embeddable…')
    archive = fetch(PYTHON_EMBED_URL)
    actual = sha256_bytes(archive)
    if actual != PYTHON_EMBED_SHA256:
        raise RuntimeError(f'Python 运行时校验和不匹配：{actual}')
    runtime = DEST / 'runtime'
    with zipfile.ZipFile(io.BytesIO(archive)) as package:
        package.extractall(runtime)
    patch_launcher_runtime(runtime)
    copy_vc_runtime(runtime)

    site = runtime / 'Lib/site-packages'
    site.mkdir(parents=True)
    print(f'安装 BabelDOC {BABELDOC_VERSION} 的 Windows/Python 3.13 依赖闭包…')
    uv = find_uv()
    subprocess.check_call([
        str(uv), 'pip', 'install',
        '--target', str(site),
        '--python-platform', 'windows',
        '--python-version', '3.13',
        '--only-binary=:all:',
        '--no-cache',
        '--link-mode=copy',
        '-r', str(REQUIREMENTS),
    ])
    shutil.copy2(CLI_SRC, DEST / 'babeldoc_cli.py')
    compile_launcher()
    write_notices()
    write_manifest()
    manifest = json.loads((DEST / 'MANIFEST.json').read_text(encoding='utf-8'))
    print(f'内置 BabelDOC 完成：{manifest["files"]} 个文件，{manifest["bytes"]/1024/1024:.0f} MiB')
    return 0


if __name__ == '__main__':
    sys.exit(main())
