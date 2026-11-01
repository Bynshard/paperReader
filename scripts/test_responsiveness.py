"""Real-process regression: bulk import must not block interactive RPC."""
from pathlib import Path
import tempfile
import time
import unittest

import pymupdf

from benchmark_library import Core, ROOT


class Responsiveness(unittest.TestCase):
    def test_reads_complete_before_bulk_import_and_protocol_survives(self):
        with tempfile.TemporaryDirectory(prefix='moonlight-responsive-') as directory:
            base=Path(directory)
            paths=[]
            for i in range(24):
                path=base/f'{i}.pdf'
                with pymupdf.open() as doc:
                    doc.set_metadata(dict(title=f'Queue test {i}'))
                    for p in range(12):
                        page=doc.new_page()
                        page.insert_textbox((40,40,550,780),
                            f'Document {i} page {p}. '+('Repeatable academic text for actual import. '*100),fontsize=9)
                    doc.save(path,deflate=True)
                paths.append(str(path))
            core=Core(base/'library')
            try:
                batch=core.send('import_pdfs',paths=paths)
                overflow=[core.send('export',paper_ids=[],format='bibtex') for _ in range(40)]
                reads_before_completion=0
                delays=[]
                while batch.empty():
                    start=time.perf_counter()
                    result=core.call('list_papers_page')
                    delays.append(time.perf_counter()-start)
                    self.assertLessEqual(len(result['items']),100)
                    if batch.empty(): reads_before_completion+=1
                    time.sleep(.01)
                self.assertGreater(reads_before_completion,2,'interactive requests queued behind import')
                self.assertLess(max(delays),1.,'interactive RPC stalled for over one second')
                result=core.result(batch)
                self.assertTrue(all(item['status']=='imported' for item in result))
                self.assertEqual(core.call('list_papers_page')['total'],24)
                rejected=0
                for waiter in overflow:
                    response=waiter.get(timeout=30)
                    if not response.get('ok'):
                        self.assertIn('queue is full',response['error'])
                        rejected+=1
                self.assertGreater(rejected,0,'queue must reject excess work explicitly')
                self.assertEqual(core.protocol_errors,[])
            finally:
                core.close()

    def test_broken_pdf_does_not_poison_worker_or_lose_following_requests(self):
        with tempfile.TemporaryDirectory(prefix='moonlight-worker-') as directory:
            base=Path(directory)
            bad=base/'bad.pdf'
            bad.write_bytes(b'%PDF-1.7\ninvalid objects')
            core=Core(base/'library')
            try:
                batch=core.send('import_pdfs',paths=[str(bad),str(ROOT/'corpus/raw/attn.pdf'),str(ROOT/'corpus/raw/hybridflow.pdf')])
                pings=[core.send('ping') for _ in range(25)]
                for ping in pings:
                    self.assertTrue(core.result(ping)['pong'])
                imported=core.result(batch)
                self.assertEqual(imported[0]['status'],'failed')
                self.assertEqual(imported[1]['status'],'imported')
                self.assertEqual(imported[2]['status'],'imported')
                self.assertTrue(imported[2]['title'].startswith('HybridFlow:'))
                self.assertNotIn('\x00',imported[2]['title'])
                self.assertEqual(core.protocol_errors,[])
            finally:
                core.close()


if __name__=='__main__':
    unittest.main(verbosity=2)
