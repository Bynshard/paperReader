"""Disposable real-core tests for transaction failures, backup/restore and ownership."""
from pathlib import Path
import json,sqlite3,subprocess,tempfile,unittest,time,sys
import pymupdf
from benchmark_library import Core,ROOT

class Reliability(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(prefix='moonlight-release-');self.base=Path(self.tmp.name);self.root=self.base/'library';self.core=Core(self.root)
  item=self.core.call('import_pdfs',paths=[str(ROOT/'corpus/raw/attn.pdf')])[0];self.pid=item['paper_id'];self.vid=item['version_id']
 def tearDown(self):self.core.close();self.tmp.cleanup()
 def test_exclusive_library_ownership(self):
  other=subprocess.run([str(ROOT/'core/target/release/moonlight-core'),'--root',str(self.root)],input='',capture_output=True,text=True,timeout=10)
  self.assertNotEqual(other.returncode,0);self.assertIn('另一个',other.stderr)
 def test_atomic_edit_and_stale_save(self):
  before=self.core.call('get_paper',paper_id=self.pid)
  bad=self.core.send('save_paper',paper_id=self.pid,expected_updated_at=before['updated_at'],fields={'title':'Should roll back'},category_ids=['missing']).get(timeout=10)
  self.assertFalse(bad['ok']);self.assertEqual(self.core.call('get_paper',paper_id=self.pid)['title'],before['title'])
  fresh=self.core.call('save_paper',paper_id=self.pid,expected_updated_at=before['updated_at'],fields={'title':'Edited title','notes':'Persistent note','read_status':'read'},tags=['test','中文'])
  self.assertEqual(len(fresh['tags']),2)
  stale=self.core.send('save_paper',paper_id=self.pid,expected_updated_at=before['updated_at'],fields={'title':'Stale'}).get(timeout=10);self.assertFalse(stale['ok'])
  self.assertEqual(self.core.call('get_paper',paper_id=self.pid)['title'],'Edited title')
 def test_backup_restore_wal_annotations_notes_and_history(self):
  self.core.call('append_note',paper_id=self.pid,text='AI saved note')
  self.core.call('ai_save',paper_id=self.pid,answer='Stored answer [1]',question='Question',sources=[],model='fixture')
  self.core.call('add_annotation',paper_id=self.pid,page=0,version_id=self.vid,rects=[{'x':.1,'y':.1,'w':.1,'h':.1}],quote='quote')
  backup=self.core.call('backup_create',parent=str(self.base/'backups'))
  restored=self.core.call('backup_restore',source=backup['path'],parent=str(self.base/'restores'))
  new=Core(Path(restored['path']))
  try:
   self.assertIn('AI saved note',new.call('get_paper',paper_id=self.pid)['notes'])
   self.assertEqual(len(new.call('ai_history',paper_id=self.pid)),1)
   self.assertEqual(len(new.call('list_annotations',paper_id=self.pid)),1)
   self.assertTrue(Path(new.call('paper_pdf',paper_id=self.pid,kind='source')['path']).is_file())
  finally:new.close()
  self.assertTrue(Path(self.core.call('paper_pdf',paper_id=self.pid,kind='source')['path']).is_file())
 def test_linked_pdf_backup_is_independent_and_keeps_pdf_extension(self):
  linked=self.base/'external.pdf';linked.write_bytes((ROOT/'corpus/raw/attn.pdf').read_bytes())
  with sqlite3.connect(self.root/'library.db') as db:db.execute('UPDATE versions SET rel_path=? WHERE id=?',[str(linked),self.vid])
  backup=self.core.call('backup_create',parent=str(self.base/'backups'))
  linked.unlink()
  restored=self.core.call('backup_restore',source=backup['path'],parent=str(self.base/'restore'))
  new=Core(Path(restored['path']))
  try:
   pdf=Path(new.call('paper_pdf',paper_id=self.pid,kind='source')['path']);self.assertTrue(pdf.is_file());self.assertEqual(pdf.suffix,'.pdf')
  finally:new.close()
 def test_tampering_and_traversal_rejected_without_partial_restore(self):
  backup=Path(self.core.call('backup_create',parent=str(self.base/'backups'))['path']);manifest=json.loads((backup/'manifest.json').read_text())
  target=backup/next(f['path'] for f in manifest['files'] if f['path'].endswith('.pdf'));target.write_bytes(b'corrupted')
  reply=self.core.send('backup_restore',source=str(backup),parent=str(self.base/'restore')).get(timeout=10);self.assertFalse(reply['ok']);self.assertEqual(list((self.base/'restore').iterdir()),[])
  manifest['files'].append({'path':'../outside','sha256':'x'});(backup/'manifest.json').write_text(json.dumps(manifest))
  reply=self.core.send('backup_restore',source=str(backup),parent=str(self.base/'restore')).get(timeout=10);self.assertFalse(reply['ok']);self.assertFalse((self.base/'outside').exists())
 def fake_engine(self,delay):
  script=self.base/'engine'
  script.write_text(f'#!{sys.executable}\n'+f"import pathlib,sys,time,shutil\na=sys.argv;out=pathlib.Path(a[a.index('--output')+1]);out.mkdir(parents=True,exist_ok=True)\nprint('Translating',flush=True);time.sleep({delay})\nshutil.copyfile(a[a.index('--files')+1],out/'fixture.zh-CN.mono.pdf')\n")
  script.chmod(0o755);self.core.close();self.core=Core(self.root,env_overrides={'MOONLIGHT_UPSTREAM_KEY':'fixture-only','MOONLIGHT_UPSTREAM':'http://127.0.0.1:9/v1','MOONLIGHT_BABELDOC_BIN':str(script)})
 def wait_job(self,job):
  until=time.monotonic()+10
  while time.monotonic()<until:
   state=self.core.call('get_job',job_id=job)
   if state['status'] in ['completed','failed','cancelled']:return state
   time.sleep(.03)
  self.fail('Job did not finish')
 def test_single_worker_queue_duplicate_and_queued_cancel(self):
  self.fake_engine(10)
  doc=pymupdf.open();page=doc.new_page();page.insert_text((30,30),'Different queue test paper.');pdf=self.base/'second.pdf';doc.save(pdf);doc.close()
  second=self.core.call('import_pdfs',paths=[str(pdf)])[0]['paper_id']
  first_job=self.core.call('start_translate',paper_id=self.pid)['job_id']
  until=time.monotonic()+5
  while self.core.call('get_job',job_id=first_job)['status']=='queued' and time.monotonic()<until:time.sleep(.02)
  second_job=self.core.call('start_translate',paper_id=second)['job_id']
  self.assertEqual(self.core.call('get_job',job_id=second_job)['status'],'queued')
  self.assertFalse(self.core.send('start_translate',paper_id=second).get(timeout=10)['ok'])
  self.core.call('cancel_job',job_id=second_job);self.assertEqual(self.wait_job(second_job)['status'],'cancelled')
  self.core.call('cancel_job',job_id=first_job);self.assertEqual(self.wait_job(first_job)['status'],'cancelled')
 def test_completion_database_failure_does_not_publish_a_version(self):
  self.fake_engine(.3)
  with sqlite3.connect(self.root/'library.db') as db:db.executescript("CREATE TRIGGER fail_completion BEFORE UPDATE ON jobs WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'injected completion failure'); END;")
  job=self.core.call('start_translate',paper_id=self.pid)['job_id'];self.assertEqual(self.wait_job(job)['status'],'failed')
  self.assertFalse(any(v['kind']=='translated' for v in self.core.call('get_paper',paper_id=self.pid)['versions']))
 def test_purge_requires_trash_and_keeps_shared_source(self):
  reply=self.core.send('purge_paper',paper_id=self.pid).get(timeout=10);self.assertFalse(reply['ok'])
  with sqlite3.connect(self.root/'library.db') as db:
   db.execute("INSERT INTO papers(id,title,authors,imported_at,updated_at) VALUES('shared','Other','',0,0)")
   db.execute("INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,created_at) SELECT 'shared-v','shared',kind,sha256,rel_path,pages,bytes,created_at FROM versions WHERE id=?",[self.vid])
  original=Path(self.core.call('paper_pdf',paper_id=self.pid,kind='source')['path']);self.core.call('trash_paper',paper_id=self.pid);self.core.call('purge_paper',paper_id=self.pid);self.assertTrue(original.exists())

if __name__=='__main__':unittest.main(verbosity=2)
