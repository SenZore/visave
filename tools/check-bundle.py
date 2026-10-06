import json
import os
from pathlib import Path
import subprocess
import tempfile
from zipfile import ZipFile

root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'extension/manifest.json').read_text(encoding='utf-8'))['version']
bundle = root / 'tools/generated/visave-windows'
environment = {key: value for key, value in os.environ.items() if key.casefold() != 'psmodulepath'}
def verify(path):
    return subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(path / 'Install.ps1'), '-VerifyOnly'], env=environment, capture_output=True, text=True)
with tempfile.TemporaryDirectory(prefix='visave bundle café ') as directory:
    extracted = Path(directory)
    with ZipFile(root / 'dist' / f'visave-windows-{version}.zip') as archive:
        assert archive.testzip() is None
        archive.extractall(extracted)
    result = verify(extracted)
    assert result.returncode == 0, result.stdout + result.stderr
    assert not (extracted / 'app/bin/ffmpeg.exe').exists()
    assert not (extracted / 'app/bin/ffprobe.exe').exists()
    media = json.loads((extracted / 'app/FFMPEG-DOWNLOAD.json').read_text(encoding='utf-8'))
    def quoted(path): return "'" + str(path).replace("'", "''") + "'"
    hydrate = '. ' + quoted(extracted / 'MediaTools.ps1') + '; Install-VisaveMediaTools -MetadataPath ' + quoted(extracted / 'app/FFMPEG-DOWNLOAD.json') + ' -BinRoot ' + quoted(extracted / 'app/bin') + ' -ArchivePath ' + quoted(root / 'tools/generated/downloads' / media['archiveName'])
    subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', hydrate], env=environment, check=True)
    # Python is invoked from the bundle with no system tools on PATH.
    clean_environment = dict(environment, PATH=str(extracted / 'app/bin'))
    subprocess.run([str(extracted / 'app/runtime/python.exe'), str(extracted / 'app/selfcheck.py')], env=clean_environment, check=True)
    with (extracted / 'app/host.py').open('ab') as file:
        file.write(b'\n# checksum tampering fixture\n')
    result = verify(extracted)
    assert result.returncode != 0 and 'Checksum mismatch' in result.stderr, result
    inventory = json.loads((extracted / 'SHA256SUMS.json').read_text())
    inventory['files'][0]['path'] = '../outside-fixture'
    (extracted / 'SHA256SUMS.json').write_text(json.dumps(inventory))
    result = verify(extracted)
    assert result.returncode != 0 and 'escapes the bundle' in result.stderr, result
print('PASS extracted ZIP integrity; verification-only setup; private runtime without system PATH; changed-file rejection; manifest path traversal rejection.')
