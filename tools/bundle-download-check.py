"""Exercise packaged native downloads with system tools excluded from PATH."""
import http.server
import json
import os
from pathlib import Path
import queue
import struct
import subprocess
import tempfile
import threading

root = Path(__file__).resolve().parents[1]
app = root / 'tools/generated/visave-windows/app'
environment = dict(os.environ, PATH=str(app / 'bin'))
python = app / 'runtime/python.exe'
def framed(message):
    data = json.dumps(message).encode()
    return struct.pack('=I', len(data)) + data
with tempfile.TemporaryDirectory(prefix='visave-download café ') as directory:
    folder = Path(directory)
    fixture = folder / 'fixture.mp4'
    subprocess.run([str(app / 'bin/ffmpeg.exe'), '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=60', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(fixture)], check=True, env=environment)
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            data = fixture.read_bytes()
            self.send_response(200); self.send_header('Content-Type', 'video/mp4'); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
        def log_message(self, *_): pass
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    process = subprocess.Popen([str(python), str(app / 'host.py')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment)
    messages = queue.Queue()
    def read():
        while True:
            header = process.stdout.read(4)
            if not header: break
            length = struct.unpack('=I', header)[0]
            messages.put(json.loads(process.stdout.read(length)))
    threading.Thread(target=read, daemon=True).start()
    try:
        for extension in ('mp4', 'mp3'):
            filename = 'Instagram-bundlecheck.' + extension
            process.stdin.write(framed({'id': extension, 'action': 'download', 'url': f'http://127.0.0.1:{server.server_port}/fixture.mp4', 'output': extension, 'quality': 'best', 'saveFolder': str(folder), 'filename': filename, 'saveAs': True, 'reveal': True})); process.stdin.flush()
            reply = messages.get(timeout=30)
            assert reply.get('ok'), reply
            while True:
                result = messages.get(timeout=90)
                if result.get('event') in ('complete', 'error', 'cancelled'): break
            assert result.get('event') == 'complete', result
            output = Path(result['filename'])
            assert output == folder / filename and output.is_file(), result
            info = json.loads(subprocess.check_output([str(app / 'bin/ffprobe.exe'), '-v', 'error', '-show_streams', '-of', 'json', str(output)], env=environment))
            if extension == 'mp4':
                assert any(stream['codec_type'] == 'video' and stream['avg_frame_rate'] == '60/1' for stream in info['streams']), info
            else:
                assert all(stream['codec_type'] == 'audio' for stream in info['streams']), info
            print(f'PASS packaged {extension.upper()} native download to Unicode folder, explicit filename, no dialogs/Explorer; output codecs verified' + ('; 60 FPS preserved' if extension == 'mp4' else ''), flush=True)
    finally:
        process.stdin.close(); process.wait(timeout=30); server.shutdown()
