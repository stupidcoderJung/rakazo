import hashlib
import http.client
import threading
import unittest
from types import SimpleNamespace
from http.server import ThreadingHTTPServer
from gateway import Handler, Storage, clean_path


class BoundaryTests(unittest.TestCase):
    def test_paths(self):
        for value in ['', '/etc/passwd', '../outside', 'a/../b', 'a//b', '.uploads/a', 'a/%2e%2e/b', 'a\\b', 'x\x00z', 'x?op=DELETE']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                clean_path(value)
        self.assertEqual(clean_path('reports/한글 파일.pdf'), 'reports/한글 파일.pdf')
        self.assertEqual(clean_path('', True), '')

    def test_redirect_is_not_an_arbitrary_url(self):
        storage = Storage.__new__(Storage)
        storage.allowed = {'http://storage.example.test:9870'}
        with self.assertRaises(RuntimeError):
            storage.fetch('GET', 'http://127.0.0.1:1234/private')

    def test_symlink_in_any_ancestor_is_rejected(self):
        for linked in ['/bots', '/bots/example', '/bots/example/folder', '/bots/example/folder/file']:
            storage = Storage.__new__(Storage)
            storage.root = '/bots/example'
            storage.meta = lambda method, path, op: (200, {'FileStatus': {
                'type': 'SYMLINK' if path == linked else 'DIRECTORY'}})
            with self.subTest(linked=linked), self.assertRaises(PermissionError):
                storage.check_path('folder/file')

    def test_requests_rejected_before_storage_access(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        server.storage = SimpleNamespace(token_hash=hashlib.sha256(b'unit-token').hexdigest())
        server.slots = threading.BoundedSemaphore(4)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            for path, auth, status in [('/v1/list?path=', '', 401), ('/v1/list?path=', 'Bearer wrong', 401), ('/v1/file?path=..%2Fsecret', 'Bearer unit-token', 400), ('/v1/list?path=a&path=b', 'Bearer unit-token', 400), ('/v1/list?path=a&user.name=root', 'Bearer unit-token', 400)]:
                with self.subTest(path=path, auth=bool(auth)):
                    c = http.client.HTTPConnection(*server.server_address)
                    c.request('GET', path, headers={'Authorization': auth})
                    r = c.getresponse(); self.assertEqual(r.status, status); r.read(); c.close()
        finally:
            server.shutdown(); server.server_close(); thread.join()


class TransferTests(unittest.TestCase):
    """Exercise HTTP publication and download with a deterministic WebHDFS stand-in."""
    def setUp(self):
        import io
        self.files = {}
        files = self.files

        class MemoryStorage:
            root = '/bots/example'
            maximum = 1024
            token_hash = hashlib.sha256(b'unit-token').hexdigest()
            publish_lock = threading.Lock()

            def check_path(self, path, parents=False):
                if path == 'link/file':
                    raise PermissionError()
                if not parents and self.root + '/' + path not in files:
                    raise FileNotFoundError()

            def meta(self, method, path, op, **params):
                if op == 'GETFILESTATUS':
                    return (200, {}) if path in files else (404, {})
                if op == 'RENAME':
                    files[params['destination']] = files.pop(path)
                    return 200, {'boolean': True}
                if op == 'DELETE':
                    files.pop(path, None)
                    return 200, {'boolean': True}
                raise AssertionError(op)

            def request(self, method, path, op, body=None, length=0, **params):
                if op == 'CREATE':
                    body.seek(0)
                    files[path] = body.read()
                    assert len(files[path]) == length
                    return SimpleNamespace(close=lambda: None), SimpleNamespace(status=201, read=lambda n: b'')
                if op == 'OPEN':
                    payload = files[path]
                    stream = io.BytesIO(payload)
                    return SimpleNamespace(close=stream.close), SimpleNamespace(
                        status=200, read=stream.read, getheader=lambda name: str(len(payload)))
                raise AssertionError(op)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.storage = MemoryStorage()
        self.server.slots = threading.BoundedSemaphore(4)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection(*self.server.server_address)
        c.request(method, '/v1/file?path=' + path, body=body,
                  headers={'Authorization': 'Bearer unit-token', **(headers or {})})
        r = c.getresponse()
        status, data = r.status, r.read()
        c.close()
        return status, data

    def test_publish_download_and_no_overwrite(self):
        import json
        content = b'synthetic content\x00\xff'
        status, data = self.request('PUT', 'report.bin', content)
        self.assertEqual(status, 201)
        self.assertEqual(json.loads(data)['sha256'], hashlib.sha256(content).hexdigest())
        self.assertEqual(self.request('GET', 'report.bin'), (200, content))
        self.assertEqual(self.request('PUT', 'report.bin', b'replacement')[0], 409)
        self.assertEqual(self.request('GET', 'report.bin'), (200, content))
        self.assertEqual(list(self.files), ['/bots/example/report.bin'])

    def test_limits_and_symlink_rejection_leave_storage_unchanged(self):
        self.assertEqual(self.request('PUT', 'large', b'a' * 1025)[0], 413)
        self.assertEqual(self.request('PUT', 'negative', b'', {'Content-Length': '-1'})[0], 413)
        self.assertEqual(self.request('PUT', 'chunked', b'', {'Transfer-Encoding': 'chunked'})[0], 411)
        self.assertEqual(self.request('GET', 'missing')[0], 404)
        self.assertEqual(self.request('GET', 'link/file')[0], 403)
        self.assertFalse(self.files)

    def test_zero_byte_file(self):
        self.assertEqual(self.request('PUT', 'empty', b'')[0], 201)
        self.assertEqual(self.request('GET', 'empty'), (200, b''))


if __name__ == '__main__':
    unittest.main()
