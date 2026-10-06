"""Compile the Windows setup window with its reviewed PowerShell script embedded."""
import json
import os
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'extension/manifest.json').read_text(encoding='utf-8'))['version']
compiler = Path(os.environ['WINDIR']) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
destination = root / 'dist' / f'visave-setup-{version}.exe'
destination.parent.mkdir(exist_ok=True)
subprocess.run([str(compiler), '/nologo', '/target:winexe', '/platform:x64', '/optimize+',
                '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll',
                f'/resource:{root / "install.ps1"},visave.install.ps1', f'/out:{destination}',
                str(root / 'setup/Bootstrap.cs')], check=True)
print(destination)
