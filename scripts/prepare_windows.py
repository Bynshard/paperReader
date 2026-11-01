"""Download only official Windows x64 binaries, checking upstream SHA-256.

Runs in GitHub's Windows job. No accounts, inference, or model secrets needed.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'tools/windows'
CODEX_VERSION = '0.159.2'
RCLONE_VERSION = 'v1.75.2'


def fetch(url):
    headers = {'User-Agent': 'Moonlight-Windows-CI'}
    if url.startswith('https://api.github.com/') and os.environ.get('GH_TOKEN'):
        headers['Authorization'] = 'Bearer ' + os.environ['GH_TOKEN']
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=180) as response:
                return response.read()
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2 * (attempt + 1))


def checked(url, expected):
    if not isinstance(expected, str) or len(expected) != 64:
        raise RuntimeError('Missing upstream SHA-256: ' + url)
    data = fetch(url)
    if hashlib.sha256(data).hexdigest() != expected:
        raise RuntimeError('Checksum mismatch: ' + url)
    return data


def exe(data, name):
    if data[:2] != b'MZ':
        raise RuntimeError('Not a Windows executable: ' + name)
    (DEST / name).write_bytes(data)


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    # Only files explicitly listed here will be copied into the release.
    records = []
    archive = f'rclone-{RCLONE_VERSION}-windows-amd64.zip'
    base = f'https://downloads.rclone.org/{RCLONE_VERSION}/'
    lines = fetch(base + 'SHA256SUMS').decode().splitlines()
    expected = next(row.split()[0] for row in lines
                    if row.split() and row.split()[-1].lstrip('*') == archive)
    with zipfile.ZipFile(io.BytesIO(checked(base + archive, expected))) as package:
        exe(package.read(f'rclone-{RCLONE_VERSION}-windows-amd64/rclone.exe'), 'rclone.exe')
    records.append(dict(component='rclone', version=RCLONE_VERSION,
                        url=base + archive, sha256=expected, binary='rclone.exe'))
    release = json.loads(fetch(f'https://api.github.com/repos/openai/codex/releases/tags/rust-v{CODEX_VERSION}'))
    # Official standalone App Server uses --listen directly; no npm .cmd shim.
    helpers = ['codex-app-server', 'codex-command-runner', 'codex-windows-sandbox-setup']
    for component in helpers:
        asset_name = component + '-x86_64-pc-windows-msvc.exe.zip'
        asset = next((a for a in release['assets'] if a['name'] == asset_name), None)
        if asset is None:
            if component == 'codex-app-server':
                raise RuntimeError('Official Windows App Server release is missing')
            continue
        expected = (asset.get('digest') or '').removeprefix('sha256:')
        data = checked(asset['browser_download_url'], expected)
        with zipfile.ZipFile(io.BytesIO(data)) as package:
            members = [p for p in package.namelist()
                       if Path(p).name in (component + '.exe', component + '-x86_64-pc-windows-msvc.exe')]
            if len(members) != 1:
                raise RuntimeError('Unexpected upstream archive: ' + asset_name)
            exe(package.read(members[0]), component + '.exe')
        records.append(dict(component=component, version=CODEX_VERSION,
                            url=asset['browser_download_url'], sha256=expected,
                            binary=component + '.exe'))
    for record in records:
        record['binary_sha256'] = hashlib.sha256((DEST / record['binary']).read_bytes()).hexdigest()
    (DEST / 'SOURCES.json').write_text(json.dumps(records, indent=2) + '\n', encoding='utf-8')
    print('Verified Windows binaries:', ', '.join(record['binary'] for record in records))


if __name__ == '__main__':
    main()
