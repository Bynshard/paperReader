"""Windows CI: exercise the real native core with a generated public test PDF.

No PyMuPDF, cloud credentials or paid AI calls. No user library is opened.
"""
import json
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / 'artifacts/validation/windows'
BINARY = ROOT / 'core/target/x86_64-pc-windows-msvc/release/moonlight-core.exe'


def make_pdf(path):
    stream = b'BT /F1 14 Tf 40 750 Td (Moonlight Windows CI paper: attention evidence.) Tj ET'
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>',
               b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
               b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
               b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'\nendstream',
               b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
    data = bytearray(b'%PDF-1.4\n'); offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(data)); data.extend(f'{index} 0 obj\n'.encode() + obj + b'\nendobj\n')
    xref = len(data)
    data.extend(f'xref\n0 {len(objects)+1}\n0000000000 65535 f \n'.encode())
    for offset in offsets[1:]:
        data.extend(f'{offset:010d} 00000 n \n'.encode())
    data.extend(f'trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
    path.write_bytes(data)


class Core:
    def __init__(self, root):
        self.messages = queue.Queue(); self.seq = 0
        self.p = subprocess.Popen([str(BINARY), '--root', str(root)], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  text=True, encoding='utf-8')
        self.errors = []
        def read():
            try:
                for line in self.p.stdout:
                    self.messages.put(json.loads(line))
            except Exception as error:
                self.messages.put({'error': str(error)})
            finally:
                self.messages.put({'error': 'core exited before response'})
        def stderr():
            for line in self.p.stderr:
                self.errors.append(line.rstrip())
        self.reader = threading.Thread(target=read, daemon=True); self.reader.start()
        self.err_reader = threading.Thread(target=stderr, daemon=True); self.err_reader.start()
        ready = self.messages.get(timeout=30)
        if ready.get('event') != 'ready':
            self.close(); raise RuntimeError(ready)

    def call(self, method, **params):
        self.seq += 1
        self.p.stdin.write(json.dumps(dict(id=self.seq, method=method, params=params)) + '\n'); self.p.stdin.flush()
        until = time.monotonic() + 30
        while time.monotonic() < until:
            message = self.messages.get(timeout=max(.1, until-time.monotonic()))
            if message.get('id') == self.seq:
                if not message.get('ok'):
                    raise RuntimeError(message)
                return message['result']
            if 'error' in message and 'id' not in message:
                raise RuntimeError(message)
        raise TimeoutError(method)

    def close(self):
        if self.p.stdin and not self.p.stdin.closed:
            self.p.stdin.close()
        try:
            self.p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.p.kill(); self.p.wait(timeout=5)
        self.reader.join(timeout=2); self.err_reader.join(timeout=2)
        self.p.stdout.close(); self.p.stderr.close()


def main():
    REPORT.mkdir(parents=True, exist_ok=True)
    fixture = REPORT / 'fixture.pdf'; make_pdf(fixture)
    evidence = dict(scope='Real Windows MSVC core; generated PDF; temporary Unicode path; no inference', steps=[])
    core = None
    try:
        with tempfile.TemporaryDirectory(prefix='Moonlight Windows 测试 ') as folder:
            base = Path(folder); library = base / '论文库'
            core = Core(library)
            item = core.call('import_pdfs', paths=[str(fixture)])[0]
            assert item['status'] == 'imported', item
            pid, vid = item['paper_id'], item['version_id']
            assert core.call('import_pdfs', paths=[str(fixture)])[0]['status'] == 'duplicate'
            evidence['steps'].append('Unicode-path PDF import and dedup')
            paper = core.call('get_paper', paper_id=pid)
            fresh = core.call('save_paper', paper_id=pid, expected_updated_at=paper['updated_at'],
                              fields=dict(title='Windows 验证论文', notes='Windows 笔记', read_status='read'), tags=['CI', '论文'])
            assert len(fresh['tags']) == 2
            core.call('add_annotation', paper_id=pid, version_id=vid, page=0,
                      rects=[dict(x=.1, y=.1, w=.2, h=.1)], quote='attention evidence')
            core.call('ai_save', paper_id=pid, kind='ask', question='fixture',
                      answer='Local fixture answer', sources=[], model='fixture')
            assert core.call('list_papers_page', query='attention')['total'] == 1
            context = core.call('ai_prepare', paper_id=pid, version_id=vid, page=0, question='attention')
            assert 'attention evidence' in context['prompt']
            evidence['steps'].append('Metadata, tags, annotations, text search and local AI context')
            backup = core.call('backup_create', parent=str(base / '备份'))
            restored = core.call('backup_restore', source=backup['path'], parent=str(base / '恢复'))
            core.close(); core = Core(Path(restored['path']))
            assert core.call('get_paper', paper_id=pid)['notes'] == 'Windows 笔记'
            assert len(core.call('list_annotations', paper_id=pid)) == 1
            assert len(core.call('ai_history', paper_id=pid)) == 1
            assert Path(core.call('paper_pdf', paper_id=pid, kind='source')['path']).is_file()
            evidence['steps'].append('Verified backup, new-library restore and restart persistence')
            core.close(); core = None
        evidence['completed'] = True
    except Exception as error:
        evidence['error'] = repr(error)
        if core:
            evidence['stderr'] = core.errors[-15:]
        raise
    finally:
        if core:
            core.close()
        (REPORT / 'native.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding='utf-8')
    print('Windows native smoke passed')


if __name__ == '__main__':
    main()
