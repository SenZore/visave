"""Offline checks run before native-host registration."""
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parent
environment = dict(os.environ, PATH=str(root / 'bin'))
def run(args):
    return subprocess.run(args, env=environment, capture_output=True, check=True, timeout=90)

run([sys.executable, '-m', 'yt_dlp', '--version'])
run([str(root / 'bin/node.exe'), '--version'])
run([sys.executable, '-c', 'import yt_dlp_ejs; import ssl; import sqlite3'])
with tempfile.TemporaryDirectory(prefix='visave-check-') as directory:
    for extension, arguments in [('mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']), ('mp3', ['-vn', '-c:a', 'libmp3lame'])]:
        output = str(Path(directory) / ('check.' + extension))
        run([str(root / 'bin/ffmpeg.exe'), '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=60', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '0.25', *arguments, output])
        run([str(root / 'bin/ffprobe.exe'), '-v', 'error', '-show_streams', output])
message = json.dumps({'id': 'setup-check', 'action': 'probe'}).encode()
response = subprocess.run([sys.executable, str(root / 'host.py')], input=struct.pack('=I', len(message)) + message, env=environment, capture_output=True, check=True, timeout=30).stdout
length = struct.unpack('=I', response[:4])[0]
reply = json.loads(response[4:4 + length])
assert reply['ok'], reply
info = reply['result']
assert all(info[key] for key in ('ytDlp', 'ejs', 'ffmpeg', 'ffprobe', 'jsRuntime', 'saveFolderSupported', 'filenameSupported')), info
print('Offline checks passed: private Python, yt-dlp/EJS, Node.js, MP4/MP3 conversion, native-message protocol.')
