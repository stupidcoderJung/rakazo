#!/usr/bin/env python3
"""Stream files using a Vault command variable; never print its value."""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import ssl
import tempfile
from urllib.parse import urlencode, urlsplit

CHUNK = 256 * 1024


class StorageHttpError(Exception):
    def __init__(self, status):
        self.status = status


def main():
    parser = argparse.ArgumentParser(description='Transfer files to the bot workspace')
    sub = parser.add_subparsers(dest='op', required=True)
    upload = sub.add_parser('upload'); upload.add_argument('local'); upload.add_argument('remote')
    download = sub.add_parser('download'); download.add_argument('remote'); download.add_argument('local')
    listing = sub.add_parser('list'); listing.add_argument('remote', nargs='?', default='')
    args = parser.parse_args()
    config = json.loads(os.environ['BOT_STORAGE_CONFIG'])
    url = urlsplit(config['url'])
    if url.scheme != 'https' or url.username or url.path not in ('', '/') or url.query or url.fragment:
        raise ValueError('HTTPS origin required')
    context = ssl.create_default_context(cadata=config['ca_pem'])
    conn = http.client.HTTPSConnection(url.hostname, url.port, context=context, timeout=120)
    endpoint = '/v1/list' if args.op == 'list' else '/v1/file'
    headers = {'Authorization': 'Bearer ' + config['token']}
    body = None
    digest = hashlib.sha256()
    try:
        if args.op == 'upload':
            body = open(args.local, 'rb')
            size = os.fstat(body.fileno()).st_size
            headers['Content-Length'] = str(size)
        conn.putrequest('PUT' if body else 'GET', endpoint + '?' + urlencode({'path': args.remote}))
        for k, v in headers.items():
            conn.putheader(k, v)
        conn.endheaders()
        if body:
            while chunk := body.read(CHUNK):
                digest.update(chunk); conn.send(chunk)
        response = conn.getresponse()
        if response.status not in (200, 201):
            raise StorageHttpError(response.status)
        if args.op == 'download':
            dest = Path(args.local)
            if dest.exists():
                raise ValueError('local destination exists')
            name = None
            try:
                with tempfile.NamedTemporaryFile(dir=dest.parent, delete=False) as output:
                    name = output.name
                    count = 0
                    while chunk := response.read(CHUNK):
                        output.write(chunk); digest.update(chunk); count += len(chunk)
                    output.flush(); os.fsync(output.fileno())
                expected = response.getheader('Content-Length')
                if expected is not None and count != int(expected):
                    raise RuntimeError('incomplete download')
                # Atomic publication that cannot overwrite an existing destination.
                os.link(name, dest)
                print(json.dumps({'path': str(dest), 'size': count, 'sha256': digest.hexdigest()}))
            finally:
                if name:
                    os.unlink(name)
        else:
            raw = response.read(2 * 1024 * 1024 + 1)
            if len(raw) > 2 * 1024 * 1024:
                raise RuntimeError('response too large')
            result = json.loads(raw)
            if args.op == 'upload' and (result.get('sha256') != digest.hexdigest() or result.get('size') != size):
                raise RuntimeError('upload integrity mismatch')
            print(json.dumps(result, ensure_ascii=False))
    finally:
        if body:
            body.close()
        conn.close()


if __name__ == '__main__':
    try:
        main()
    except StorageHttpError as error:
        hints = {
            400: 'Invalid relative path or request.',
            401: 'Ask the owner to check the Vault credential.',
            403: 'Path is forbidden.',
            404: 'Path does not exist. A new upload creates its parent directories.',
            409: 'Destination exists. Choose a new filename; do not overwrite.',
            413: 'File exceeds the upload limit.',
            502: 'Storage unavailable. Check the destination before retrying an upload.',
            503: 'Transfers are busy. Retry later.',
        }
        print('Transfer failed: HTTP ' + str(error.status) + '. ' + hints.get(error.status, 'Ask the owner to check the service.'))
        raise SystemExit(1)
    except (OSError, ValueError, KeyError, RuntimeError, http.client.HTTPException) as error:
        # Avoid exception strings that could include configuration or response contents.
        print('Transfer failed (' + type(error).__name__ + '). Check credentials, destination, and service status.')
        raise SystemExit(1)
