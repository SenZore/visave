import gzip
import http.server
import io
import os
from pathlib import Path
import subprocess
import sys
import threading
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from native import downloader_worker as worker


class WorkerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.response_type, cls.downloader_type = worker.install_guards()

    def test_containment_failure_stops_before_loading_downloader(self):
        with mock.patch.object(worker, "contain_memory", side_effect=OSError("cannot set limits")), mock.patch.object(worker, "install_guards") as guards, mock.patch.object(sys, "stderr", io.StringIO()):
            self.assertEqual(worker.main(), 1)
        guards.assert_not_called()

    def test_metadata_limit_is_checked_before_accumulating_or_decoding(self):
        stream = io.BytesIO(b"a" * 33)
        response = self.response_type(stream, 32)
        with self.assertRaisesRegex(Exception, "16 MiB limit"):
            response.read()
        self.assertTrue(stream.closed)

    def test_repeated_reads_share_the_metadata_budget(self):
        response = self.response_type(io.BytesIO(b"a" * 33), 32)
        self.assertEqual(response.read(24), b"a" * 24)
        with self.assertRaisesRegex(Exception, "16 MiB limit"):
            response.read(9)

    def test_collections_are_rejected_without_consuming_their_entries(self):
        def entries():
            self.fail("Collection entries must not be expanded or downloaded")
            yield {}
        for kind in ("playlist", "multi_video", "compat_list"):
            with self.downloader_type({"quiet": True}) as downloader:
                with self.assertRaisesRegex(Exception, "contains a collection"):
                    downloader.process_ie_result({"_type": kind, "entries": entries()})

    def test_second_video_is_rejected_before_download_processing(self):
        import yt_dlp
        base = self.downloader_type.__mro__[1]
        with mock.patch.object(base, "process_video_result", return_value={}) as process:
            with self.downloader_type({"quiet": True}) as downloader:
                downloader.process_video_result({"id": "one"})
                with self.assertRaisesRegex(Exception, "Only one selected video"):
                    downloader.process_video_result({"id": "two"})
        self.assertEqual(process.call_count, 1)

    @unittest.skipUnless(os.name == "nt", "Windows Job Object")
    def test_windows_memory_ceiling_applies_to_worker_and_children(self):
        code = '''import sys, subprocess
sys.path.insert(0, sys.argv[1])
from native import downloader_worker as worker
worker.PROCESS_MEMORY_BYTES = 64 * 1024 * 1024
worker.JOB_MEMORY_BYTES = 128 * 1024 * 1024
worker.contain_memory()
try:
    bytearray(96 * 1024 * 1024)
except MemoryError:
    print("WORKER_LIMIT")
else:
    raise RuntimeError("Worker escaped the memory ceiling")
child = subprocess.run([sys.executable, "-c", "try:\\n bytearray(96 * 1024 * 1024)\\nexcept MemoryError:\\n print('CHILD_LIMIT')\\nelse:\\n raise RuntimeError('Child escaped')"], capture_output=True, text=True)
assert child.returncode == 0, child.stderr
assert "CHILD_LIMIT" in child.stdout
print(child.stdout)
'''
        result = subprocess.run([sys.executable, "-c", code, str(ROOT)], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("WORKER_LIMIT", result.stdout)
        self.assertIn("CHILD_LIMIT", result.stdout)

    def test_actual_downloader_rejects_compressed_metadata_and_template_collection(self):
        calls = []
        compressed = gzip.compress(b"<html>" + b" " * (worker.MAX_METADATA_BYTES + 1) + b"</html>")
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_HEAD(self):
                self.do_GET()

            def do_GET(self):
                calls.append(self.path)
                if self.path == "/large":
                    body, encoding = compressed, "gzip"
                elif self.path == "/collection":
                    body = b'<html><title>Collection</title><template><video src="/one.mp4"></video><video src="/two.mp4"></video></template></html>'
                    encoding = None
                else:
                    body, encoding = b"unexpected media request", None
                self.send_response(200)
                self.send_header("Content-Type", "text/html" if self.path in {"/large", "/collection"} else "video/mp4")
                self.send_header("Content-Length", str(len(body)))
                if encoding:
                    self.send_header("Content-Encoding", encoding)
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(body)

            def log_message(self, *_):
                pass
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for path, error in (("large", "16 MiB limit"), ("collection", "contains a collection")):
                result = subprocess.run([sys.executable, str(ROOT / "native/downloader_worker.py"), "--ignore-config", "--no-playlist", "--no-warnings", "http://127.0.0.1:" + str(server.server_port) + "/" + path], capture_output=True, text=True, timeout=30)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(error, result.stderr, result.stdout + result.stderr)
            self.assertFalse(any(path.endswith(".mp4") for path in calls), calls)
        finally:
            server.shutdown()
            server.server_close()
