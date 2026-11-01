"""Loopback-only browser bridge to an isolated benchmark library.

Uses actual Rust RPC and production frontend; substitutes HTTP for Electron IPC.
Requires benchmark_library.py's imports.json, refusing ordinary user libraries.
"""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import sqlite3
import hashlib
import shutil
import time
import uuid
import signal
from urllib.parse import parse_qs, urlparse

from benchmark_library import Core, ROOT


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def json(self, result, status=200):
        data=json.dumps(result,ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path!='/rpc':
            return self.json(dict(error='unknown route'),404)
        try:
            size=int(self.headers.get('Content-Length','0'))
            if not 0<size<8*1024*1024:
                raise ValueError('invalid request size')
            body=json.loads(self.rfile.read(size))
            result=self.server.core.call(body['method'],**body.get('params',{}))
            self.json(dict(result=result))
        except Exception as error:
            self.json(dict(error=str(error)),400)

    def do_GET(self):
        url=urlparse(self.path)
        if url.path=='/fixtures':
            return self.json(self.server.fixtures)
        if url.path=='/pdf':
            try:
                query=parse_qs(url.query)
                result=self.server.core.call('paper_pdf',paper_id=query['id'][0],kind=query.get('kind',['source'])[0])
                # Only the sidecar resolves a file; never accept raw client paths.
                data=Path(result['path']).read_bytes()
                self.send_response(200)
                self.send_header('Content-Type','application/pdf')
                self.send_header('X-Version-Id',result['version_id'])
                self.send_header('X-Pages',str(result['pages']))
                self.send_header('Content-Length',str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except Exception as error:
                self.json(dict(error=str(error)),404)
            return
        super().do_GET()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work-dir',type=Path,required=True)
    parser.add_argument('--port',type=int,default=5201)
    parser.add_argument('--dual-fixture',action='store_true',help='Copy source as a test translated version; no AI/translation quality claim')
    parser.add_argument('--stress-fixtures',action='store_true')
    args=parser.parse_args()
    imports=json.loads((args.work_dir/'imports.json').read_text())
    translated=None
    if args.dual_fixture:
        # The test-only translated slot holds the same real PDF. This isolates
        # dual-pane rendering cost without calling a model or changing text.
        with sqlite3.connect(args.work_dir/'library/library.db') as db:
            source=db.execute('SELECT rel_path,pages FROM versions WHERE id=?',(imports[-1]['version_id'],)).fetchone()
            translated=args.work_dir/'library/derived/browser-test-dual.pdf'
            shutil.copyfile(args.work_dir/'library'/source[0],translated)
            db.execute("INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,created_at) VALUES(?,?,'translated',?,?,?,?,?)",
                (str(uuid.uuid4()),imports[-1]['paper_id'],hashlib.sha256(translated.read_bytes()).hexdigest(),
                 'derived/browser-test-dual.pdf',source[1],translated.stat().st_size,int(time.time()*1000)))
    core=Core(args.work_dir/'library')
    stress=[]
    if args.stress_fixtures:
        from stress_pdfs import create
        for name,path in create(args.work_dir/'browser-fixtures',ROOT/'corpus/raw/attn.pdf'):
            item=core.call('import_pdfs',paths=[str(path)])[0]
            assert item['status']=='imported',item
            stress.append(dict(name=name,**item))
    server=ThreadingHTTPServer(('127.0.0.1',args.port),partial(Handler,directory=str(ROOT/'app/dist')))
    server.core=core
    server.fixtures=dict(count=len(imports),papers=imports[-2:],generated=imports[min(1234,len(imports)-3)],dual_fixture=args.dual_fixture,stress=stress)
    print(json.dumps(dict(port=server.server_port)),flush=True)
    def stop(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGINT,stop)
    signal.signal(signal.SIGTERM,stop)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        for item in stress:
            core.call('trash_paper',paper_id=item['paper_id'])
            core.call('purge_paper',paper_id=item['paper_id'])
        core.close()
        if translated:
            with sqlite3.connect(args.work_dir/'library/library.db') as db:
                db.execute("DELETE FROM versions WHERE rel_path='derived/browser-test-dual.pdf'")
            translated.unlink(missing_ok=True)
