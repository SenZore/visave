"""Build an offline, auditable x64 bundle; run after npm run build."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request
from zipfile import ZipFile, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
VERSION = json.loads((ROOT / 'extension/manifest.json').read_text(encoding='utf-8'))['version']
CACHE = ROOT / 'tools/generated/downloads'
BUNDLE = ROOT / 'tools/generated/visave-windows'
APP = BUNDLE / 'app'
PYTHON = '3.13.13'
NODE = '22.22.0'
FFMPEG = '9.0.2'
def read(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'visave-build'}), timeout=120).read()
def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()
def acquire(item):
    name, url, expected = item
    path = CACHE / name
    if not path.exists():
        temporary = path.with_suffix('.download')
        with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'visave-build'}), timeout=120) as response, temporary.open('wb') as output:
            shutil.copyfileobj(response, output)
        temporary.replace(path)
    actual = sha(path)
    if expected and actual != expected:
        raise RuntimeError(f'Publisher hash mismatch: {name}')
    print(f'Fetched {name}: {actual}', flush=True)
    return path, {'name': name, 'url': url, 'sha256': actual, 'publisherHashVerified': bool(expected)}
def extract(archive, destination):
    with ZipFile(archive) as file:
        for entry in file.infolist():
            if not (destination / entry.filename).resolve().is_relative_to(destination.resolve()):
                raise RuntimeError('Archive path escapes destination')
        file.extractall(destination)

CACHE.mkdir(parents=True, exist_ok=True)
generated = (ROOT / 'tools/generated').resolve()
if BUNDLE.exists():
    if not BUNDLE.resolve().is_relative_to(generated) or BUNDLE.resolve() == generated or BUNDLE.is_symlink() or BUNDLE.is_junction():
        raise RuntimeError('Unsafe generated bundle directory; cleanup refused')
    shutil.rmtree(BUNDLE)
APP.mkdir(parents=True, exist_ok=True)
node_name = f'node-v{NODE}-win-x64.zip'
node_hash = next(line.split()[0] for line in read(f'https://nodejs.org/dist/v{NODE}/SHASUMS256.txt').decode().splitlines() if line.endswith('  ' + node_name))
items = [
    (f'python-{PYTHON}-embed-amd64.zip', f'https://www.python.org/ftp/python/{PYTHON}/python-{PYTHON}-embed-amd64.zip', None),
    (node_name, f'https://nodejs.org/dist/v{NODE}/{node_name}', node_hash),
    (f'ffmpeg-{FFMPEG}-essentials_build.zip', f'https://github.com/GyanD/codexffmpeg/releases/download/{FFMPEG}/ffmpeg-{FFMPEG}-essentials_build.zip', '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba'),
]
with ThreadPoolExecutor(max_workers=3) as pool:
    downloads = list(pool.map(acquire, items))
runtime = APP / 'runtime'
extract(downloads[0][0], runtime)
signature_script = "(Get-AuthenticodeSignature -LiteralPath '" + str(runtime / 'python.exe').replace("'", "''") + "').Status.ToString()"
windows_environment = {key: value for key, value in os.environ.items() if key.casefold() != 'psmodulepath'}
signature = subprocess.check_output(['powershell.exe', '-NoProfile', '-Command', signature_script], text=True, env=windows_environment).strip()
if signature != 'Valid':
    raise RuntimeError(f'Python executable publisher signature is {signature}')
downloads[0][1]['executableAuthenticodeStatus'] = signature
(runtime / 'python313._pth').write_text('python313.zip\n.\n..\nsite-packages\nimport site\n', encoding='ascii')
bins = APP / 'bin'
bins.mkdir(exist_ok=True)
licenses = APP / 'licenses'
licenses.mkdir(exist_ok=True)
for archive, record in downloads[1:]:
    with ZipFile(archive) as file:
        for name in file.namelist():
            base = Path(name).name
            if base in {'node.exe', 'ffmpeg.exe', 'ffprobe.exe'}:
                (bins / base).write_bytes(file.read(name))
            elif 'license' in base.lower() or base.lower().startswith('readme'):
                (licenses / (record['name'].split('-')[0] + '-' + base)).write_bytes(file.read(name))
report = APP / 'DEPENDENCIES.json'
subprocess.run([sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check', '--only-binary=:all:', '--platform', 'win_amd64', '--python-version', '3.13', '--implementation', 'cp', '--abi', 'cp313', '--ignore-installed', '--upgrade', '--require-hashes', '--target', str(runtime / 'site-packages'), '--report', str(report), '-r', str(ROOT / 'setup/windows-requirements.txt')], check=True)
(APP / 'UPSTREAM-DOWNLOADS.json').write_text(json.dumps([record for _, record in downloads], indent=2), encoding='utf-8')
media = dict(downloads[2][1])
media['archiveName'] = media.pop('name')
media['binaries'] = {name: sha(bins / name) for name in ('ffmpeg.exe', 'ffprobe.exe')}
media['distribution'] = 'Downloaded directly from its publisher during setup; binaries are excluded from the visave release ZIP.'
(APP / 'FFMPEG-DOWNLOAD.json').write_text(json.dumps(media, indent=2), encoding='utf-8')
shutil.copy2(ROOT / 'native/host.py', APP / 'host.py')
shutil.copy2(ROOT / 'native/downloader_worker.py', APP / 'downloader_worker.py')
shutil.copy2(ROOT / 'setup/selfcheck.py', APP / 'selfcheck.py')
for name in ('Setup.cmd', 'Install.ps1', 'MediaTools.ps1', 'Uninstall.cmd', 'Uninstall.ps1'):
    shutil.copy2(ROOT / 'setup' / name, BUNDLE / name)
shutil.copy2(ROOT / 'setup/windows-requirements.txt', APP / 'windows-requirements.txt')
extension = ROOT / 'dist' / f'senzdev_visave-{VERSION}.zip'
shutil.copy2(extension, BUNDLE / f'visave-firefox-{VERSION}.zip')
shutil.copy2(ROOT / 'START-HERE.html', BUNDLE / 'START-HERE.html')
shutil.copy2(ROOT / 'INSTALLATION-PLAN.md', BUNDLE / 'INSTALLATION-PLAN.md')
shutil.copy2(ROOT / 'LICENSE', BUNDLE / 'LICENSE')
shutil.copytree(ROOT / 'docs', BUNDLE / 'docs', dirs_exist_ok=True)
subprocess.run([str(runtime / 'python.exe'), str(APP / 'selfcheck.py')], check=True)
# End users fetch the GPL tools from their publisher; developer checks use the cached binaries.
inventory = {'version': VERSION, 'files': [{'path': file.relative_to(BUNDLE).as_posix(), 'sha256': sha(file)} for file in sorted(BUNDLE.rglob('*')) if file.is_file() and file.name not in ('SHA256SUMS.json', 'ffmpeg.exe', 'ffprobe.exe') and '__pycache__' not in file.parts and file.suffix != '.pyc']}
# Distribute only manifest-listed files; bytecode produced by checks stays out of the ZIP.
(BUNDLE / 'SHA256SUMS.json').write_text(json.dumps(inventory, indent=2), encoding='utf-8')
destination = ROOT / 'dist' / f'visave-windows-{VERSION}.zip'
with ZipFile(destination, 'w', ZIP_DEFLATED, compresslevel=6) as file:
    for entry in inventory['files']:
        file.write(BUNDLE / entry['path'], entry['path'])
    file.write(BUNDLE / 'SHA256SUMS.json', 'SHA256SUMS.json')
(ROOT / 'dist' / f'visave-windows-{VERSION}.sha256').write_text(sha(destination) + '  ' + destination.name + '\n', encoding='ascii')
print(destination, flush=True)
