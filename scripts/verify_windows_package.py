"""CI release gate: validate the produced ZIP, ASAR and native Windows binaries."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import struct
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts/validation/windows'


def windows_x64(data):
    if data[:2] != b'MZ' or len(data) < 64:
        return False
    offset = struct.unpack_from('<I', data, 0x3c)[0]
    return data[offset:offset+4] == b'PE\0\0' and struct.unpack_from('<H', data, offset+4)[0] == 0x8664


def main():
    manifest = json.loads((ROOT / 'release/manifest-windows.json').read_text(encoding='utf-8'))
    archive = Path(manifest['archive']); digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if digest != manifest['sha256'] or manifest['platform'] != 'win32':
        raise RuntimeError('Windows archive checksum or platform mismatch')
    prefix = 'Moonlight-win32-x64/'
    with zipfile.ZipFile(archive) as package:
        for name in package.namelist():
            p = PurePosixPath(name)
            if p.is_absolute() or '..' in p.parts or not name.startswith(prefix):
                raise RuntimeError('Unsafe archive member: ' + name)
        required = ['moonlight.exe', 'resources/app.asar', 'resources/bin/moonlight-core.exe',
                    'resources/bin/rclone.exe', 'resources/bin/codex-app-server.exe', 'README.md']
        for name in required:
            data = package.read(prefix + name)
            if name.endswith('.exe') and not windows_x64(data):
                raise RuntimeError('Not a Windows x64 executable: ' + name)
        records = json.loads(package.read(prefix + 'resources/bin/SOURCES.json'))
        for record in records:
            data = package.read(prefix + 'resources/bin/' + record['binary'])
            if hashlib.sha256(data).hexdigest() != record['binary_sha256']:
                raise RuntimeError('Bundled executable checksum mismatch')
    directory = Path(manifest['directory'])
    core = subprocess.check_output([str(directory/'resources/bin/moonlight-core.exe'), '--version'], text=True, encoding='utf-8', timeout=20).strip()
    rclone = subprocess.check_output([str(directory/'resources/bin/rclone.exe'), '--version'], text=True, encoding='utf-8', timeout=20).splitlines()[0]
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT/'package.json').write_text(json.dumps(dict(completed=True, archive=str(archive),
        sha256=digest, core=core, rclone=rclone, members_checked=required), indent=2), encoding='utf-8')
    print('Verified Windows ZIP and bundled native executables')


if __name__ == '__main__':
    main()
