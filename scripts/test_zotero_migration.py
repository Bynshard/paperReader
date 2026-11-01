"""Offline regression against Zotero's official userdata schema.

Run after cargo build --release with .venv/bin/python scripts/test_zotero_migration.py.
All source/destination data is created under a temporary directory.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time
import unittest

import pymupdf

ROOT = Path(__file__).resolve().parents[1]
RESULTS: dict = {}


class Migration(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='moonlight-zotero-test-')
        self.base = Path(self.temp.name)
        self.source = self.base / 'Zotero'
        self.source.mkdir()
        self.linked = self.base / 'Linked'
        self.linked.mkdir()
        self.db = sqlite3.connect(self.source / 'zotero.sqlite')
        self.db.executescript((ROOT / 'tests/fixtures/zotero/userdata.sql').read_text())
        self.db.execute("INSERT INTO version VALUES('userdata',130)")
        for i, name in enumerate(['journalArticle','attachment','note','annotation'], 1):
            self.db.execute('INSERT INTO itemTypes(itemTypeID,typeName) VALUES(?,?)',(i,name))
        self.db.execute("INSERT INTO libraries(libraryID,type,editable,filesEditable) VALUES(1,'user',1,1),(3,'group',1,1)")
        self.db.execute("INSERT INTO groups VALUES(77,3,'Lab','',0)")
        self.db.execute("INSERT INTO fields(fieldID,fieldName) VALUES(1,'title'),(2,'DOI'),(3,'date')")
        self.item(1,'PAPER001',title='Main Paper',doi='https://doi.org/10.1234/EXAMPLE')
        self.item(2,'PAPER001',library=3,title='Group Paper')
        self.item(3,'DELETED1',title='Deleted Paper')
        self.db.execute("INSERT INTO deletedItems(itemID) VALUES(3)")
        self.item(4,'NOTE0001',kind=3)
        self.db.execute("INSERT INTO itemNotes(itemID,note,title) VALUES(4,'<p>Standalone &amp; rich note</p>','Standalone')")
        self.item(5,'NOTE0002',kind=3)
        self.db.execute("INSERT INTO itemNotes(itemID,parentItemID,note,title) VALUES(5,1,'<p>First paragraph</p><p>Second &amp; paragraph</p>','Child')")
        self.item(6,'META0001',title='Metadata only')
        self.db.execute("INSERT INTO collections(collectionID,collectionName,libraryID,key) VALUES(1,'Research',1,'COLL0001')")
        self.db.execute("INSERT INTO collections(collectionID,collectionName,parentCollectionID,libraryID,key) VALUES(2,'Child',1,1,'COLL0002')")
        self.db.execute("INSERT INTO collectionItems VALUES(2,1,0)")
        self.db.execute("INSERT INTO tags(tagID,name) VALUES(1,'important')")
        self.db.execute("INSERT INTO itemTags VALUES(1,1,0)")
        self.pdf = self.make_pdf('primary.pdf')
        self.other = self.make_pdf('supplement.pdf',rotated=True)
        self.attachment(10,'ATTACH01',1,'storage:primary.pdf',self.pdf)
        self.attachment(11,'ATTACH02',1,'storage:supplement.pdf',self.other)
        self.attachment(12,'ATTACH03',1,'storage:missing.pdf')
        self.attachment(13,'ATTACH04',1,'attachments:linked.pdf')
        (self.linked/'linked.pdf').write_bytes(self.make_pdf('linked.pdf').read_bytes())
        self.attachment(14,'SNAP0001',1,'storage:index.html',mime='text/html')
        snapshot = self.source/'storage/SNAP0001'
        snapshot.mkdir(parents=True)
        (snapshot/'index.html').write_text('<p>snapshot</p><img src="assets/figure.png">')
        (snapshot/'assets').mkdir()
        (snapshot/'assets/figure.png').write_bytes(b'resource')
        self.attachment(15,'LONE0001',None,'storage:standalone.pdf',self.pdf)
        self.annotation(20,'ANNOT001',10,1,[100,600,300,620])
        self.annotation(21,'ANNOT002',11,5,[100,100,180,120])
        self.annotation(22,'ANNOT003',10,4,None)  # Ink is archived, not painted as a rectangle.
        self.db.commit()
        self.source_hash = self.digest()
        env={k:v for k,v in os.environ.items() if not k.startswith('MOONLIGHT_')}
        self.process=subprocess.Popen([str(ROOT/'core/target/release/moonlight-core'),'--root',str(self.base/'library')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,env=env)
        self.counter=0

    def tearDown(self):
        self.process.stdin.close()
        self.process.wait(timeout=5)
        self.process.stdout.close()
        self.db.close()
        self.temp.cleanup()

    def item(self,id,key,kind=1,library=1,title=None,doi=None):
        self.db.execute('INSERT INTO items(itemID,itemTypeID,libraryID,key) VALUES(?,?,?,?)',(id,kind,library,key))
        for fid,value in [(1,title),(2,doi)]:
            if value:
                vid=self.db.execute('INSERT INTO itemDataValues(value) VALUES(?)',(value,)).lastrowid
                self.db.execute('INSERT INTO itemData VALUES(?,?,?)',(id,fid,vid))

    def make_pdf(self,name,rotated=False):
        path=self.base/name
        doc=pymupdf.open()
        page=doc.new_page(width=612,height=792)
        page.insert_text((100,100),name)
        if rotated:
            page.set_cropbox(pymupdf.Rect(20,40,592,752))
            page.set_rotation(90)
        doc.save(path)
        doc.close()
        return path

    def attachment(self,id,key,parent,raw,pdf=None,mime='application/pdf'):
        library=self.db.execute('SELECT libraryID FROM items WHERE itemID=?',(parent,)).fetchone()[0] if parent else 1
        self.item(id,key,kind=2,library=library)
        self.db.execute('INSERT INTO itemAttachments(itemID,parentItemID,linkMode,contentType,path) VALUES(?,?,0,?,?)',(id,parent,mime,raw))
        if pdf:
            dest=self.source/'storage'/key/raw.removeprefix('storage:')
            dest.parent.mkdir(parents=True,exist_ok=True)
            dest.write_bytes(pdf.read_bytes())

    def annotation(self,id,key,parent,kind,rect):
        self.item(id,key,kind=4)
        position={'pageIndex':0,'rects':[rect]} if rect else {'pageIndex':0,'paths':[[1,2,3,4]]}
        self.db.execute('INSERT INTO itemAnnotations(itemID,parentItemID,type,text,comment,color,sortIndex,position,isExternal) VALUES(?,?,?,?,?,?,?,?,0)',(id,parent,kind,'quoted text','comment','#ffd400','0000',json.dumps(position)))

    def digest(self):
        return {str(p.relative_to(self.source)):hashlib.sha256(p.read_bytes()).hexdigest() for p in self.source.rglob('*') if p.is_file() and not p.name.endswith(('-wal','-shm'))}

    def call(self,method,**params):
        self.counter+=1
        self.process.stdin.write(json.dumps(dict(id=self.counter,method=method,params=params))+'\n')
        self.process.stdin.flush()
        for line in self.process.stdout:
            reply=json.loads(line)
            if reply.get('id')==self.counter:
                if not reply.get('ok'):
                    raise RuntimeError(reply.get('error'))
                return reply['result']
        raise RuntimeError('core exited')

    def migrate(self,**options):
        report=self.call('zotero_import',data_dir=str(self.source),**options)
        self.assertEqual(report['errors'],[])
        return report

    def main_paper(self):
        return self.call('list_papers_page',query='Main Paper')['items'][0]

    def test_complete_copy_idempotence_geometry_and_independence(self):
        probe=self.call('zotero_probe',data_dir=str(self.source))
        self.assertEqual(probe['items'],5) # Includes standalone note and attachment.
        report=self.migrate(linked_base_dir=str(self.linked))
        self.assertEqual(report['items'],5)
        self.assertEqual(report['imported'],4) # Standalone identical PDF deduplicates.
        self.assertEqual(len(report['missing_attachments']),1)
        self.assertEqual(report['missing_attachments'][0]['attachment'],'ATTACH03')
        self.assertTrue(any(w['annotation']=='ANNOT003' for w in report['warnings']))
        paper=self.main_paper()
        full=self.call('get_paper',paper_id=paper['id'])
        self.assertEqual(len(full['versions']),3)
        self.assertIn('First paragraph\nSecond & paragraph',full['notes'])
        self.assertEqual(full['doi'],'10.1234/example')
        child=next(c for c in full['categories'] if c['name']=='Child')
        taxonomy=self.call('list_taxonomy')['categories']
        parent=next(c for c in taxonomy if c['id']==child['parent_id'])
        self.assertEqual(parent['name'],'Research')
        anns=self.call('list_annotations',paper_id=paper['id'])
        self.assertEqual(len(anns),2)
        self.assertEqual(len({a['version_id'] for a in anns}),2)
        for a in anns:
            info=self.call('paper_pdf',paper_id=paper['id'],kind='source',version_id=a['version_id'])
            with pymupdf.open(info['path']) as doc:
                page=doc[0]
                raw=[100,600,300,620] if page.rotation==0 else [100,100,180,120]
                # Use the actual reading engine as the oracle. PyMuPDF's
                # transformation_matrix has different crop-origin semantics
                # for rotated pages and is not interchangeable with PDF.js.
                code="""
import {readFileSync} from 'node:fs';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
const doc=await getDocument({data:new Uint8Array(readFileSync(process.argv[1]))}).promise;
const page=await doc.getPage(1),v=page.getViewport({scale:1});
const r=v.convertToViewportRectangle(JSON.parse(process.argv[2]));
console.log(JSON.stringify([Math.min(r[0],r[2])/v.width,Math.min(r[1],r[3])/v.height,Math.abs(r[2]-r[0])/v.width,Math.abs(r[3]-r[1])/v.height]));
await doc.destroy();
"""
                output=subprocess.check_output([os.environ.get('NODE_BINARY','node'),'--input-type=module','-e',code,info['path'],json.dumps(raw)],cwd=ROOT/'app',text=True)
                expected=json.loads(output.strip().splitlines()[-1])
                actual=a['rects'][0]
                for value,target in zip([actual['x'],actual['y'],actual['w'],actual['h']],expected):
                    self.assertAlmostEqual(value,target,places=5)
        again=self.migrate(linked_base_dir=str(self.linked))
        self.assertEqual(again['imported'],0)
        self.assertEqual(self.call('list_papers_page')['total'],4)
        self.assertEqual(self.call('list_annotations',paper_id=paper['id']),anns)
        self.assertEqual(self.digest(),self.source_hash)
        files=self.call('zotero_files',paper_id=paper['id'])
        html=next(f for f in files if f['content_type']=='text/html')
        html_path=Path(self.call('zotero_attachment_path',paper_id=paper['id'],file_id=html['id'])['path'])
        self.assertEqual((html_path.parent/'assets/figure.png').read_bytes(),b'resource')
        self.source.rename(self.base/'Zotero-removed')
        self.linked.rename(self.base/'Linked-removed')
        for version in full['versions']:
            self.assertTrue(Path(self.call('paper_pdf',paper_id=paper['id'],kind='source',version_id=version['id'])['path']).exists())
        archive=Path(report['archive'])/'zotero.sqlite'
        with sqlite3.connect(archive) as archived:
            self.assertEqual(archived.execute('SELECT COUNT(*) FROM itemAnnotations').fetchone()[0],3)
        RESULTS['copy_report']=report

    def test_filter_descendants_unknown_filter_and_missing_file_repair(self):
        with self.assertRaisesRegex(RuntimeError,'分类不存在'):
            self.call('zotero_import',data_dir=str(self.source),collections=['does-not-exist'])
        self.assertEqual(self.call('list_papers_page')['total'],0)
        report=self.migrate(collections=['1:COLL0001'])
        self.assertEqual(report['items'],1)
        self.assertEqual(len(report['missing_attachments']),2)
        paper=self.main_paper()
        missing=self.source/'storage/ATTACH03/missing.pdf'
        missing.parent.mkdir(parents=True)
        missing.write_bytes(self.make_pdf('recovered.pdf').read_bytes())
        second=self.migrate(collections=['COLL0001'],linked_base_dir=str(self.linked))
        self.assertEqual(second['imported'],0)
        self.assertEqual(second['missing_attachments'],[])
        self.assertEqual(len(self.call('get_paper',paper_id=paper['id'])['versions']),4)

    def test_linked_files_are_never_deleted_and_local_edits_survive(self):
        self.migrate(copy_attachments=False,linked_base_dir=str(self.linked))
        paper=self.main_paper()
        self.call('update_paper',paper_id=paper['id'],fields={'title':'Local title','notes':'My own note'})
        self.db.execute("UPDATE itemDataValues SET value='Updated source title' WHERE value='Main Paper'")
        self.db.execute("UPDATE itemDataValues SET value='Updated group title' WHERE value='Group Paper'")
        self.db.commit()
        self.migrate(copy_attachments=False,linked_base_dir=str(self.linked))
        full=self.call('get_paper',paper_id=paper['id'])
        self.assertEqual(full['title'],'Local title')
        self.assertEqual(full['notes'],'My own note')
        self.assertEqual(self.call('list_papers_page',query='Updated group title')['total'],1)
        self.call('trash_paper',paper_id=paper['id'])
        self.call('purge_paper',paper_id=paper['id'])
        self.assertTrue((self.source/'storage/ATTACH01/primary.pdf').exists())
        self.assertTrue((self.linked/'linked.pdf').exists())
        report=self.migrate(copy_attachments=False,linked_base_dir=str(self.linked))
        self.assertGreater(report['imported'],0) # Deleted provenance cannot strand a record.

    def test_live_wal_snapshot_includes_committed_rows(self):
        self.db.execute('PRAGMA journal_mode=WAL')
        self.item(100,'WAL00001',title='WAL-only committed paper')
        self.db.commit()
        self.assertTrue((self.source/'zotero.sqlite-wal').exists())
        self.migrate()
        self.assertEqual(self.call('list_papers_page',query='WAL-only')['total'],1)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM items WHERE itemID=100').fetchone()[0],1)

    def test_failed_record_rolls_back_and_can_be_retried(self):
        bad=self.source/'storage/BAD00001/bad.pdf'
        self.attachment(30,'BAD00001',6,'storage:bad.pdf')
        bad.parent.mkdir(parents=True)
        bad.write_bytes(b'not a PDF')
        self.db.commit()
        first=self.call('zotero_import',data_dir=str(self.source))
        self.assertEqual(len(first['errors']),1)
        self.assertEqual(first['errors'][0]['item'],'META0001')
        self.assertEqual(self.call('list_papers_page',query='Metadata only')['total'],0)
        self.assertEqual(self.call('list_papers_page',query='Main Paper')['total'],1)
        bad.write_bytes(self.make_pdf('fixed.pdf').read_bytes())
        self.migrate()
        self.assertEqual(self.call('list_papers_page',query='Metadata only')['total'],1)

    def test_conflicting_dois_remain_separate_and_shared_copy_is_retained(self):
        vid=self.db.execute("INSERT INTO itemDataValues(value) VALUES('10.5678/different')").lastrowid
        self.db.execute('INSERT INTO itemData VALUES(2,2,?)',(vid,))
        self.attachment(30,'GROUPPDF',2,'storage:shared.pdf',self.pdf)
        self.db.commit()
        self.migrate()
        main=self.main_paper()
        group=self.call('list_papers_page',query='Group Paper')['items'][0]
        self.assertNotEqual(main['id'],group['id'])
        main_path=self.call('paper_pdf',paper_id=main['id'],kind='source')['path']
        self.call('trash_paper',paper_id=group['id'])
        self.call('purge_paper',paper_id=group['id'])
        self.assertTrue(Path(main_path).exists())

    def test_many_metadata_records(self):
        for i in range(1000,2000):
            self.item(i,f'M{i:07d}',title=f'Bulk metadata {i}')
        self.db.commit()
        start=time.monotonic()
        report=self.migrate(include_annotations=False)
        RESULTS['metadata_1000']={'duration_seconds':time.monotonic()-start,'items':report['items'],'errors':report['errors']}
        self.assertEqual(report['items'],1005)
        self.assertEqual(self.call('list_papers_page',limit=100)['limit'],100)


if __name__=='__main__':
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(Migration)
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    if result.wasSuccessful():
        out=ROOT/'artifacts/validation/zotero-20261101'
        out.mkdir(parents=True,exist_ok=True)
        # Temporary source paths are retained as test evidence, not user paths.
        (out/'migration.json').write_text(json.dumps({'tests':result.testsRun,'source':'official Zotero userdata.sql, schema 130; synthetic records and PDFs','results':RESULTS},indent=2)+'\n')
    raise SystemExit(not result.wasSuccessful())
