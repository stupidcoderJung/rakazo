"""Token-authenticated, streaming WebHDFS gateway confined to one operator-owned root."""
import hashlib
import hmac
import http.client
import json
import os
import re
import ssl
import tempfile
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlencode, urlsplit

CHUNK = 256 * 1024


def clean_path(value, allow_empty=False):
    if not isinstance(value, str) or len(value) > 1024:
        raise ValueError('invalid path')
    if allow_empty and value == '':
        return ''
    parts = value.split('/')
    if any(not p or p in ('.', '..') or p.startswith('.') for p in parts):
        raise ValueError('invalid path')
    if any(ord(c) < 32 or ord(c) == 127 or c in '\\%?#' for c in value):
        raise ValueError('invalid path')
    return value


class Storage:
    def __init__(self):
        self.origin = os.environ['WEBHDFS_ORIGIN'].rstrip('/')
        self.root = '/' + clean_path(os.environ['HDFS_ROOT'].strip('/'))
        self.user = os.environ['HDFS_USER']
        self.publish_lock = threading.Lock()
        self.allowed = set(os.environ['WEBHDFS_DATA_ORIGINS'].split(',')) | {self.origin}
        self.maximum = int(os.environ.get('MAX_FILE_BYTES', str(512 * 1024 * 1024)))
        if self.maximum <= 0:
            raise ValueError('invalid maximum')
        self.token_hash = open(os.environ['TOKEN_HASH_FILE']).read().strip()
        if not re.fullmatch('[0-9a-f]{64}', self.token_hash):
            raise ValueError('invalid token digest')

    def request(self, method, path, op, body=None, length=0, **params):
        url = self.origin + '/webhdfs/v1' + quote(path, safe='/') + '?' + urlencode(
            {'op': op, 'user.name': self.user, **params})
        return self.fetch(method, url, body, length)

    def fetch(self, method, url, body=None, length=0):
        for _ in range(2):
            p = urlsplit(url)
            if p.scheme + '://' + p.netloc not in self.allowed or p.username or p.fragment:
                raise RuntimeError('unapproved storage redirect')
            cls = http.client.HTTPSConnection if p.scheme == 'https' else http.client.HTTPConnection
            conn = cls(p.hostname, p.port, timeout=120)
            # NameNode CREATE must not receive file bytes. Follow its validated redirect first.
            send_body = body if p.scheme + '://' + p.netloc != self.origin else None
            conn.putrequest(method, p.path + '?' + p.query)
            conn.putheader('Content-Length', str(length if send_body else 0))
            conn.endheaders()
            if send_body:
                send_body.seek(0)
                while data := send_body.read(CHUNK):
                    conn.send(data)
            response = conn.getresponse()
            if response.status == 307:
                url = response.getheader('Location', '')
                response.close()
                conn.close()
                continue
            return conn, response
        raise RuntimeError('too many redirects')

    def meta(self, method, path, op, **params):
        conn, r = self.request(method, path, op, **params)
        try:
            raw = r.read(2 * 1024 * 1024 + 1)
            if len(raw) > 2 * 1024 * 1024:
                raise RuntimeError('directory too large')
            return r.status, json.loads(raw) if raw else {}
        finally:
            conn.close()

    def check_path(self, relative, parents=False):
        """Reject symlinks at the root and every existing ancestor; caller cannot create links."""
        parts = (self.root + ('/' + relative if relative else '')).strip('/').split('/')
        for i in range(len(parts)):
            path = '/' + '/'.join(parts[:i + 1])
            status, data = self.meta('GET', path, 'GETFILESTATUS')
            if status == 404:
                if parents and i < len(parts) - 1 and path.startswith(self.root + '/'):
                    code, result = self.meta('PUT', path, 'MKDIRS', permission='750')
                    if code != 200 or not result.get('boolean'):
                        raise RuntimeError('cannot create parent')
                    continue
                if i == len(parts) - 1 and parents:
                    return
                raise FileNotFoundError()
            if status != 200 or data['FileStatus']['type'] == 'SYMLINK':
                raise PermissionError()
            if i < len(parts) - 1 and data['FileStatus']['type'] != 'DIRECTORY':
                raise ValueError('parent is not a directory')


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'FileGateway'
    def log_message(self, *args):
        pass  # Never log tokens, paths, or request bodies.

    def setup(self):
        super().setup()
        self.connection.settimeout(120)

    def end_headers(self):
        self.response_started = True
        super().end_headers()

    def reply(self, status, body):
        if getattr(self, 'response_started', False):
            # Once streaming has started, a second HTTP response would corrupt the file.
            self.close_connection = True
            return
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.close_connection = True
        self.wfile.write(data)

    def do_GET(self):
        self.handle_request()

    def do_PUT(self):
        self.handle_request()

    def handle_request(self):
        self.response_started = False
        storage = self.server.storage
        supplied = self.headers.get('Authorization', '')
        if not supplied.startswith('Bearer ') or not hmac.compare_digest(
                hashlib.sha256(supplied[7:].encode()).hexdigest(), storage.token_hash):
            return self.reply(401, {'error': 'unauthorized'})
        if not self.server.slots.acquire(blocking=False):
            return self.reply(503, {'error': 'transfer capacity busy; retry later'})
        try:
            p = urlsplit(self.path)
            if p.path == '/v1/client' and self.command == 'GET' and not p.query:
                with open(os.environ['CLIENT_FILE'], 'rb') as client:
                    data = client.read(65536)
                self.send_response(200)
                self.send_header('Content-Type', 'text/x-python')
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Connection', 'close')
                self.end_headers()
                self.close_connection = True
                self.wfile.write(data)
                return
            query = parse_qs(p.query, keep_blank_values=True)
            if set(query) != {'path'} or len(query['path']) != 1:
                raise ValueError('one path is required')
            relative = clean_path(query['path'][0], allow_empty=p.path == '/v1/list')
            full = storage.root + ('/' + relative if relative else '')
            if p.path == '/v1/list' and self.command == 'GET':
                storage.check_path(relative)
                status, data = storage.meta('GET', full, 'LISTSTATUS')
                if status != 200:
                    raise FileNotFoundError()
                return self.reply(200, {'files': [
                    {'name': f['pathSuffix'], 'size': f['length'], 'type': f['type']}
                    for f in data['FileStatuses']['FileStatus'] if not f['pathSuffix'].startswith('.')]})
            if p.path != '/v1/file':
                return self.reply(404, {'error': 'unknown operation'})
            if self.command == 'PUT':
                if self.headers.get('Transfer-Encoding') or len(self.headers.get_all('Content-Length', [])) != 1:
                    return self.reply(411, {'error': 'one Content-Length is required'})
                length = int(self.headers['Content-Length'])
                if not 0 <= length <= storage.maximum:
                    return self.reply(413, {'error': 'file size exceeds limit'})
                with storage.publish_lock:
                    storage.check_path(relative, parents=True)
                status, _ = storage.meta('GET', full, 'GETFILESTATUS')
                if status != 404:
                    return self.reply(409, {'error': 'destination exists or is inaccessible'})
                with tempfile.TemporaryFile() as body:
                    remaining, digest = length, hashlib.sha256()
                    while remaining:
                        chunk = self.rfile.read(min(CHUNK, remaining))
                        if not chunk:
                            raise ValueError('incomplete upload')
                        body.write(chunk)
                        digest.update(chunk)
                        remaining -= len(chunk)
                    staging = storage.root + '/.uploads/' + uuid.uuid4().hex
                    try:
                        conn, response = storage.request('PUT', staging, 'CREATE', body, length, overwrite='false', permission='640')
                        try:
                            if response.status != 201:
                                raise RuntimeError('storage write failed')
                            response.read(4096)
                        finally:
                            conn.close()
                        # WebHDFS RENAME refuses an existing file. Reject existing directories too.
                        with storage.publish_lock:
                            status, _ = storage.meta('GET', full, 'GETFILESTATUS')
                            if status != 404:
                                return self.reply(409, {'error': 'destination exists'})
                            status, result = storage.meta('PUT', staging, 'RENAME', destination=full)
                            if status != 200 or not result.get('boolean'):
                                return self.reply(409, {'error': 'cannot publish file'})
                    finally:
                        storage.meta('DELETE', staging, 'DELETE', recursive='false')
                return self.reply(201, {'path': relative, 'size': length, 'sha256': digest.hexdigest()})
            storage.check_path(relative)
            conn, response = storage.request('GET', full, 'OPEN')
            try:
                if response.status != 200:
                    return self.reply(404, {'error': 'file unavailable'})
                self.send_response(200)
                self.send_header('Content-Type', 'application/octet-stream')
                if response.getheader('Content-Length'):
                    self.send_header('Content-Length', response.getheader('Content-Length'))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Connection', 'close')
                self.end_headers()
                self.close_connection = True
                while chunk := response.read(CHUNK):
                    self.wfile.write(chunk)
            finally:
                conn.close()
        except FileNotFoundError:
            self.reply(404, {'error': 'path not found'})
        except PermissionError:
            self.reply(403, {'error': 'path forbidden'})
        except (ValueError, KeyError):
            self.reply(400, {'error': 'invalid request'})
        except (OSError, RuntimeError, http.client.HTTPException):
            self.close_connection = True
            try:
                self.reply(502, {'error': 'transfer failed; inspect destination before retrying'})
            except OSError:
                pass
        finally:
            self.server.slots.release()


if __name__ == '__main__':
    server = ThreadingHTTPServer(('0.0.0.0', 8443), Handler)
    server.storage = Storage()
    server.slots = threading.BoundedSemaphore(4)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(os.environ['TLS_CERT_FILE'], os.environ['TLS_KEY_FILE'])
    server.socket = context.wrap_socket(server.socket, server_side=True)
    server.serve_forever()
