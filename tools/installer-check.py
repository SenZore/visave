"""Run real Windows install/upgrade/uninstall against isolated paths and a test registry key."""
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import uuid
import winreg
from zipfile import ZipFile

root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'extension/manifest.json').read_text(encoding='utf-8'))['version']
environment = {key: value for key, value in os.environ.items() if key.casefold() != 'psmodulepath'}
registry_suffix = 'com.visave.installertest.' + uuid.uuid4().hex
key_path = 'Software\\Mozilla\\NativeMessagingHosts\\' + registry_suffix
def run(script):
    args = ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(script)]
    if script.name == 'Install.ps1':
        args.append('-NoOpenGuide')
    return subprocess.run(args, env=environment, capture_output=True, text=True, timeout=180)
def registered():
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as key:
        return Path(winreg.QueryValueEx(key, '')[0])
with tempfile.TemporaryDirectory(prefix='visave-installer-', dir=root / 'test-results') as directory:
    test_root = Path(directory).resolve()
    bundle = test_root / 'bundle'
    app_root = test_root / 'installed'
    saved = test_root / 'personal-media'
    saved.mkdir(); (saved / 'keep.mp4').write_bytes(b'keep downloaded media')
    with ZipFile(root / 'dist' / f'visave-windows-{version}.zip') as archive:
        archive.extractall(bundle)
    original = "[IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'senzdev\\visave'))"
    replacement = "[IO.Path]::GetFullPath('" + str(app_root).replace("'", "''") + "')"
    for name in ('Install.ps1', 'Uninstall.ps1'):
        path = bundle / name
        source = path.read_text(encoding='utf-8')
        assert original in source
        source = source.replace(original, replacement).replace('HKCU:\\Software\\Mozilla\\NativeMessagingHosts\\com.videolens.downloader', 'HKCU:\\' + key_path)
        if name == 'Install.ps1':
            media = json.loads((bundle / 'app/FFMPEG-DOWNLOAD.json').read_text(encoding='utf-8'))
            archive = root / 'tools/generated/downloads' / media['archiveName']
            source = source.replace("-CacheRoot (Join-Path $appRoot 'cache')", "-ArchivePath '" + str(archive).replace("'", "''") + "'")
        path.write_text(source, encoding='utf-8')
    inventory_path = bundle / 'SHA256SUMS.json'
    inventory = json.loads(inventory_path.read_text(encoding='utf-8'))
    for entry in inventory['files']:
        if entry['path'] in ('Install.ps1', 'Uninstall.ps1'):
            entry['sha256'] = hashlib.sha256((bundle / entry['path']).read_bytes()).hexdigest()
    inventory_path.write_text(json.dumps(inventory), encoding='utf-8')
    # An extra source file must not sneak into the installed runtime.
    (bundle / 'app/extra-unlisted.py').write_text('raise Exception("must never run")')
    try:
        result = run(bundle / 'Install.ps1')
        assert result.returncode == 0, result.stdout + result.stderr
        first = registered()
        assert first.is_relative_to(app_root) and first.is_file(), first
        assert not (first.parent / 'extra-unlisted.py').exists()
        launcher = Path(json.loads(first.read_text(encoding='utf-8'))['path'])
        payload = json.dumps({'id': 'install', 'action': 'probe'}).encode()
        response = subprocess.run(['cmd.exe', '/d', '/c', str(launcher)], input=struct.pack('=I', len(payload)) + payload, env=environment, capture_output=True, check=True, timeout=30)
        length = struct.unpack('=I', response.stdout[:4])[0]
        reply = json.loads(response.stdout[4:4 + length])
        assert reply['ok'] and reply['result']['version'] == '1.5.0', reply
        original_host = (bundle / 'app/host.py').read_bytes()
        (bundle / 'app/host.py').write_bytes(original_host + b'\n# changed\n')
        result = run(bundle / 'Install.ps1')
        assert result.returncode != 0 and registered() == first
        (bundle / 'app/host.py').write_bytes(original_host)
        result = run(bundle / 'Install.ps1')
        assert result.returncode == 0, result.stdout + result.stderr
        second = registered()
        assert second != first and first.is_file() and second.is_file()
        result = run(bundle / 'Uninstall.ps1')
        assert result.returncode == 0, result.stdout + result.stderr
        assert not app_root.exists() and (saved / 'keep.mp4').read_bytes() == b'keep downloaded media'
        try: registered(); raise AssertionError('Uninstall retained registration')
        except FileNotFoundError: pass
        print('PASS real isolated install + native launcher; unlisted files excluded; failed install retains registration; upgrade; uninstall removes only application files and preserves media.')
    finally:
        # This exact, uniquely named test key is never the user's production connection.
        try: winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_path)
        except FileNotFoundError: pass
