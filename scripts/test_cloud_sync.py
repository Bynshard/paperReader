"""Two real sidecars and rclone's authenticated loopback WebDAV/S3 servers.

No cloud account, external upload or real credentials are used.
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import unittest

ROOT=Path(__file__).resolve().parents[1]
RCLONE=ROOT/'tools/rclone/rclone'
REPORT={}

class Client:
    def __init__(self,root):
        self.root=Path(root)
        env={k:v for k,v in os.environ.items() if not k.startswith(('MOONLIGHT_','RCLONE_'))}
        env['MOONLIGHT_RCLONE']=str(RCLONE)
        self.p=subprocess.Popen([str(ROOT/'core/target/release/moonlight-core'),'--root',str(root)],cwd=ROOT,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
        self.seq=0
    def call(self,method,**params):
        self.seq+=1;self.p.stdin.write(json.dumps(dict(id=self.seq,method=method,params=params))+'\n');self.p.stdin.flush()
        for line in self.p.stdout:
            reply=json.loads(line)
            if reply.get('id')==self.seq:
                if not reply.get('ok'):raise RuntimeError(reply.get('error'))
                return reply['result']
        raise RuntimeError('sidecar exited')
    def wait(self,timeout=60):
        start=time.monotonic()
        while time.monotonic()-start<timeout:
            status=self.call('sync_status')
            if not status['running']:return status
            time.sleep(.05)
        self.call('sync_cancel');raise RuntimeError('sync timeout')
    def sync(self):
        self.call('sync_start');status=self.wait()
        if status['status']!='completed':raise RuntimeError(status)
        return status
    def close(self):
        try:self.call('sync_cancel');self.wait(5)
        finally:
            self.p.stdin.close();self.p.wait(timeout=5);self.p.stdout.close()

class Server:
    def __init__(self,root,kind='webdav'):
        self.root=Path(root);self.root.mkdir(parents=True,exist_ok=True)
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));self.port=sock.getsockname()[1]
        env={k:v for k,v in os.environ.items() if not k.startswith('RCLONE_')}
        if kind=='webdav':env.update(RCLONE_USER='test-user',RCLONE_PASS='test-password')
        else:
            env['RCLONE_AUTH_KEY']='"test-access,test-secret"'
            (self.root/'bucket').mkdir(exist_ok=True)
        self.log=tempfile.TemporaryFile()
        if kind=='s3':
            command=[str(ROOT/'.venv/bin/python'),'-m','moto.server','-H','127.0.0.1','-p',str(self.port)]
        else:command=[str(RCLONE),'serve',kind,str(root),'--addr',f'127.0.0.1:{self.port}','--config',os.devnull,'--dir-cache-time','1s']
        self.p=subprocess.Popen(command,stdout=self.log,stderr=self.log,env=env)
        self.url=f'http://127.0.0.1:{self.port}/'
        for _ in range(100):
            if self.p.poll() is not None:self.log.seek(0);raise RuntimeError(self.log.read().decode())
            try:
                with socket.create_connection(('127.0.0.1',self.port),timeout=.1):break
            except OSError:time.sleep(.05)
        else:raise RuntimeError('server did not start')
        if kind=='s3':
            import boto3
            boto3.client('s3',endpoint_url=self.url,region_name='us-east-1',aws_access_key_id='test-access',aws_secret_access_key='test-secret').create_bucket(Bucket='bucket')
    def close(self):
        self.p.terminate()
        try:self.p.wait(timeout=5)
        except subprocess.TimeoutExpired:self.p.kill();self.p.wait(timeout=5)
        self.log.close()

class SyncTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='moonlight-sync-test-');self.base=Path(self.temp.name)
        self.server=Server(self.base/'cloud')
        self.a=Client(self.base/'a');self.b=Client(self.base/'b')
        self.profile=dict(provider='webdav',endpoint=self.server.url,username='test-user',password='test-password',prefix='Moonlight')
        for client in [self.a,self.b]:client.call('sync_configure',**self.profile)
    def tearDown(self):
        self.a.close();self.b.close();self.server.close();self.temp.cleanup()
    def seed(self):
        item=self.a.call('import_pdfs',paths=[str(ROOT/'corpus/raw/attn.pdf')])[0]
        self.id=item['paper_id'];self.version=item['version_id']
        self.a.call('update_paper',paper_id=self.id,fields={'notes':'baseline note'})
        self.a.sync();self.b.sync()
        return self.id
    def get(self,client):return client.call('get_paper',paper_id=self.id)
    def test_webdav_roundtrip_and_incremental_merge(self):
        self.seed();self.assertEqual(self.get(self.b)['notes'],'baseline note')
        pdf=self.b.call('paper_pdf',paper_id=self.id,kind='source')
        self.assertEqual(hashlib.sha256(Path(pdf['path']).read_bytes()).hexdigest(),self.get(self.b)['versions'][0]['sha256'])
        self.a.call('update_paper',paper_id=self.id,fields={'title':'Changed on A'})
        self.b.call('update_paper',paper_id=self.id,fields={'notes':'Changed on B'})
        changed=self.a.sync();self.assertEqual(changed['report']['metadata_candidates'],1)
        REPORT['incremental_metadata']=changed['report']
        self.b.sync();self.a.sync()
        for client in [self.a,self.b]:
            self.assertEqual(self.get(client)['title'],'Changed on A');self.assertEqual(self.get(client)['notes'],'Changed on B')
            self.assertEqual(client.call('sync_status')['conflicts'],0)
        status=self.b.sync();self.assertEqual(status['report']['pushed'],0);self.assertEqual(status['report']['uploaded_files'],0)
        status=self.b.sync();self.assertFalse(status['report']['metadata_scanned'])
        commits=list((self.server.root/'Moonlight/v1/commits').rglob('*.json'))
        for path in commits:
            text=path.read_text();self.assertNotIn('test-password',text);self.assertNotIn('sync_base',text)
        self.assertFalse(any(p.name=='library.db' for p in self.server.root.rglob('*')))
        REPORT['webdav']={'commits':len(commits),'unchanged_sync':status['report']}
    def test_note_conflict_is_retained_and_resolvable(self):
        self.seed()
        self.a.call('update_paper',paper_id=self.id,fields={'notes':'A conflicting note'})
        self.b.call('update_paper',paper_id=self.id,fields={'notes':'B conflicting note'})
        self.a.sync();self.b.sync()
        self.assertEqual(self.get(self.b)['notes'],'B conflicting note')
        conflicts=self.b.call('sync_conflicts');self.assertEqual(len(conflicts),1)
        self.assertEqual(conflicts[0]['remote']['paper']['notes'],'A conflicting note')
        self.b.call('sync_resolve',id=conflicts[0]['id'],choice='local');self.b.sync();self.a.sync()
        self.assertEqual(self.get(self.a)['notes'],'B conflicting note')
    def test_delete_vs_annotation_conflicts_without_losing_the_annotation(self):
        self.seed()
        self.b.call('add_annotation',paper_id=self.id,version_id=self.version,version_kind='source',page=0,quote='local annotation',rects=[])
        self.a.call('trash_paper',paper_id=self.id);self.a.call('purge_paper',paper_id=self.id);self.a.sync();self.b.sync()
        self.assertEqual(len(self.b.call('list_annotations',paper_id=self.id)),1)
        conflicts=self.b.call('sync_conflicts');self.assertEqual(len(conflicts),1)
        self.assertIsNone(conflicts[0]['remote'])
        self.b.call('sync_resolve',id=conflicts[0]['id'],choice='remote');self.b.sync()
        self.assertEqual(self.b.call('list_papers_page')['total'],0)
    def test_corrupt_attachment_does_not_enter_the_library(self):
        item=self.a.call('import_pdfs',paths=[str(ROOT/'corpus/raw/attn.pdf')])[0]
        self.a.sync()
        blob=next(p for p in (self.server.root/'Moonlight/v1/objects').rglob('*') if p.is_file())
        original=blob.read_bytes();blob.write_bytes(b'X'+original[1:])
        self.b.call('sync_start');status=self.b.wait()
        self.assertEqual(status['status'],'failed');self.assertIn('校验失败',status['error'])
        self.assertEqual(self.b.call('list_papers_page')['total'],0)
    def test_background_request_remains_responsive_and_can_cancel(self):
        self.a.call('sync_configure',**{**self.profile,'endpoint':'http://127.0.0.1:1/'})
        self.a.call('sync_start')
        started=time.monotonic();self.assertTrue(self.a.call('ping')['pong']);self.assertLess(time.monotonic()-started,.5)
        self.a.call('sync_cancel');status=self.a.wait(5);self.assertEqual(status['status'],'cancelled')
    def test_pending_upload_survives_failure_restart_and_new_local_edits(self):
        item=self.a.call('import_pdfs',paths=[str(ROOT/'corpus/raw/attn.pdf')])[0]
        self.id=item['paper_id']
        commits=self.server.root/'Moonlight/v1/commits'
        commits.mkdir(parents=True);commits.chmod(0o500)
        try:
            self.a.call('sync_start');failed=self.a.wait(20)
            self.assertEqual(failed['status'],'failed',failed)
            queued=list(self.a.root.glob('.sync/*/outbox/*.json'))
            self.assertEqual(len(queued),1)
        finally:commits.chmod(0o755)
        self.a.close();self.a=Client(self.base/'a');self.a.call('sync_configure',**self.profile)
        self.a.call('update_paper',paper_id=self.id,fields={'notes':'Edited after interrupted upload'})
        self.a.sync();self.b.sync()
        self.assertEqual(self.get(self.b)['notes'],'Edited after interrupted upload')
        self.assertEqual(self.b.call('list_papers_page')['total'],1)
        self.assertEqual(list(self.a.root.glob('.sync/*/outbox/*.json')),[])
    def test_s3_qiniu_and_aliyun_transport_profiles(self):
        server=Server(self.base/'s3','s3')
        try:
            for provider in ['s3','qiniu','aliyun']:
                with self.subTest(provider=provider):
                    profile=dict(provider=provider,endpoint=server.url,bucket='bucket',region='us-east-1',prefix=f'Moonlight-{provider}',access_key='test-access',secret_key='test-secret',force_path_style=True)
                    self.a.call('sync_configure',**profile)
                    self.a.call('sync_test');status=self.a.wait();self.assertEqual(status['status'],'completed',status)
                    self.a.sync();self.b.call('sync_configure',**profile);self.b.sync()
                    REPORT[provider]={'read_write_verified':True,'endpoint':'Moto loopback S3 server; no live cloud account'}
        finally:server.close()

if __name__=='__main__':
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(SyncTests)
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    if result.wasSuccessful():
        out=ROOT/'artifacts/validation/cloud-sync-20261101';out.mkdir(parents=True,exist_ok=True)
        (out/'report.json').write_text(json.dumps({'tests':result.testsRun,'transport':'real rclone with authenticated loopback WebDAV and Moto S3','results':REPORT},indent=2)+'\n')
    raise SystemExit(not result.wasSuccessful())
