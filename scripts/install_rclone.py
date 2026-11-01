"""Install a pinned, checksum-verified official rclone beside the application."""
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import urllib.request
import zipfile

VERSION = 'v1.75.2'


def fetch(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'Moonlight-Desktop'})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def main():
    system = {'Linux': 'linux', 'Darwin': 'osx', 'Windows': 'windows'}[platform.system()]
    arch = {'x86_64': 'amd64', 'AMD64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}[platform.machine()]
    archive = f'rclone-{VERSION}-{system}-{arch}.zip'
    base = f'https://downloads.rclone.org/{VERSION}/'
    checksums = fetch(base + 'SHA256SUMS').decode()
    expected = next(line.split()[0] for line in checksums.splitlines() if line.split() and line.split()[-1].lstrip('*') == archive)
    data = fetch(base + archive)
    if hashlib.sha256(data).hexdigest() != expected:
        raise RuntimeError('rclone checksum mismatch')
    binary = 'rclone.exe' if system == 'windows' else 'rclone'
    folder = Path(__file__).resolve().parents[1] / 'tools/rclone'
    folder.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(data)) as package:
        payload = package.read(f'rclone-{VERSION}-{system}-{arch}/{binary}')
    temporary = folder / (binary + '.tmp')
    temporary.write_bytes(payload)
    temporary.chmod(0o755)
    os.replace(temporary, folder / binary)
    (folder / 'SOURCE.json').write_text(json.dumps({'version': VERSION, 'url': base + archive, 'sha256': expected}, indent=2) + '\n')
    print(f'Installed rclone {VERSION}: {folder / binary}')


if __name__ == '__main__':
    main()
