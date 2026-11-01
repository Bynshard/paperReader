"""Disk-backed end-to-end scale benchmark; never opens the user's library.

Default: 10,000 distinct valid PDF documents, including two supplied papers.
Generated PDFs are controlled fixtures, NOT 10,000 independently sourced papers.
Uses actual import/extraction/indexing/JSONL RPC. No direct seeding of paper rows.
Run with .venv/bin/python scripts/benchmark_library.py --work-dir /tmp/ml-10k
Use --reuse after a core change to repeat measurements without reimporting.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import queue
import random
import sqlite3
import subprocess
import threading
import time

import pymupdf

ROOT = Path(__file__).resolve().parents[1]


def stats(samples):
    ordered = sorted(samples)
    def percentile(p):
        return round(ordered[max(0, math.ceil(len(ordered)*p)-1)], 3)
    return dict(runs=len(samples), median_ms=percentile(.5), p95_ms=percentile(.95),
                p99_ms=percentile(.99), max_ms=round(max(samples), 3))


class Core:
    def __init__(self, root, binary=None, env_overrides=None):
        env = {k:v for k,v in os.environ.items() if not k.startswith('MOONLIGHT_')}
        if env_overrides:
            env.update(env_overrides)
        self.started = time.perf_counter()
        self.process = subprocess.Popen([str(binary or ROOT/'core/target/release/moonlight-core'), '--root', str(root)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env,
            start_new_session=os.name!='nt')
        self.lock, self.pending, self.counter = threading.Lock(), {}, 0
        self.ready = threading.Event()
        self.protocol_errors = []
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        if not self.ready.wait(60):
            self.close()
            raise TimeoutError('core startup timed out')
        self.startup_ms = (time.perf_counter()-self.started)*1000

    def _read(self):
        try:
            for line in self.process.stdout:
                try:
                    response = json.loads(line)
                except ValueError:
                    self.protocol_errors.append(line[:200])
                    continue
                if response.get('event') == 'ready':
                    self.ready.set()
                if 'id' in response:
                    with self.lock:
                        waiter = self.pending.pop(response['id'], None)
                    if waiter is not None:
                        waiter.put(response)
        finally:
            with self.lock:
                for waiter in self.pending.values():
                    waiter.put(dict(ok=False, error='core exited'))
                self.pending.clear()

    def send(self, method, **params):
        with self.lock:
            self.counter += 1
            waiter = queue.Queue()
            self.pending[self.counter] = waiter
            self.process.stdin.write(json.dumps(dict(id=self.counter, method=method, params=params))+'\n')
            self.process.stdin.flush()
        return waiter

    def result(self, waiter, timeout=120):
        response = waiter.get(timeout=timeout)
        if not response.get('ok'):
            raise AssertionError(response)
        return response['result']

    def call(self, method, **params):
        return self.result(self.send(method, **params))

    def close(self):
        if self.process.stdin and not self.process.stdin.closed:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.reader.join(timeout=2)
        self.process.stdout.close()

    def memory(self):
        # Linux RSS/PSS of the core plus descendants (including extraction worker).
        if not Path('/proc').exists():
            return None
        pids = [self.process.pid]
        known = set(pids)
        for pid in pids:
            try:
                # Children spawned by an import worker belong to that TID,
                # not necessarily to the thread-group leader's children list.
                for task in Path(f'/proc/{pid}/task').iterdir():
                    for child in map(int,(task/'children').read_text().split()):
                        if child not in known:
                            known.add(child)
                            pids.append(child)
            except OSError:
                pass
        result = dict(rss_mib=0., pss_mib=0., processes=len(pids))
        for pid in pids:
            try:
                for line in Path(f'/proc/{pid}/smaps_rollup').read_text().splitlines():
                    if line.startswith('Rss:'):
                        result['rss_mib'] += int(line.split()[1])/1024
                    if line.startswith('Pss:'):
                        result['pss_mib'] += int(line.split()[1])/1024
            except OSError:
                pass
        return {k:round(v, 3) for k,v in result.items()}


def generate(directory, count):
    directory.mkdir(parents=True, exist_ok=True)
    paths = []
    for i in range(count-2):
        path = directory/f'fixture-{i:05}.pdf'
        if not path.exists():
            doc = pymupdf.open()
            doc.set_metadata(dict(title=f'Benchmark Paper {i:05}: topic {i%100:03}',
                                  author=f'Researcher {i%500:03}', creationDate=f'D:{2000+i%26}0101000000'))
            for page_number in range(4+i%9):
                page = doc.new_page(width=612 if i%5 else 595, height=792 if i%5 else 842)
                page.insert_text((40,40),f'Controlled paper {i:05} / page {page_number+1}',fontsize=14)
                for section in range(4):
                    needle = f' raretoken{i:05}' if page_number == 1 and section == 0 else ''
                    text = (f'Section {section}. Topic topic{i%100:03}. '+
                            'This experiment evaluates attention training and inference with reproducible results. '*5+
                            needle)
                    page.insert_textbox(pymupdf.Rect(40,70+section*165,570,225+section*165),text,fontsize=10)
                if i%10 == 0:
                    for j in range(25):
                        page.draw_line((40+j*15,740),(50+j*15,710),color=(.2,.4,.6))
            doc.save(path,garbage=4,deflate=True)
            doc.close()
        paths.append(path)
    paths += [ROOT/'corpus/raw/attn.pdf',ROOT/'corpus/raw/hybridflow.pdf']
    return paths


def measure(core, method, repeats, **params):
    samples, sizes = [], []
    first = None
    for _ in range(repeats):
        start = time.perf_counter()
        result = core.call(method, **params)
        samples.append((time.perf_counter()-start)*1000)
        sizes.append(len(json.dumps(result,ensure_ascii=False).encode()))
        if first is None:
            first = result
    return dict(**stats(samples), response_bytes=max(sizes)), first


def run(args):
    base = args.work_dir.resolve()
    base.mkdir(parents=True,exist_ok=True)
    library = base/'library'
    if not args.reuse and (library/'library.db').exists():
        raise RuntimeError('benchmark library exists: choose another --work-dir or use --reuse')
    report = dict(schema=1,count=args.count,fixture='Distinct generated 4–12-page text/vector PDFs plus two existing real papers; not 10k sourced papers',
                  scope='Actual Rust JSONL, disk files, PDF extraction and SQLite FTS; excludes Electron IPC and GUI',
                  environment=dict(platform=platform.platform(),cpu=platform.processor(),logical_cpus=os.cpu_count(),
                                   python=platform.python_version(),binary_sha256=hashlib.sha256(args.binary.read_bytes()).hexdigest()),
                  cache='OS cache not dropped; reopen is process-cold only', results={}, failures=[])
    def save():
        args.report.parent.mkdir(parents=True,exist_ok=True)
        args.report.write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n')
    core = None
    try:
        if not args.reuse:
            start = time.perf_counter()
            paths = generate(base/'pdfs',args.count)
            report['generation_seconds'] = round(time.perf_counter()-start,3)
            core = Core(library,args.binary)
            samples, imports = [], []
            for i,path in enumerate(paths):
                start = time.perf_counter()
                item = core.call('import_pdfs',paths=[str(path)])[0]
                samples.append((time.perf_counter()-start)*1000)
                assert item['status']=='imported',item
                imports.append(item)
                if (i+1)%1000 == 0:
                    print(f'imported {i+1}/{args.count}; last 1000: {stats(samples[-1000:])}',flush=True)
                    report['import_progress'] = i+1
                    save()
            (base/'imports.json').write_text(json.dumps(imports))
            report['results']['import_single_pdf'] = stats(samples)
            report['import_seconds'] = round(sum(samples)/1000,3)
            report['memory_after_import'] = core.memory()
            save()
            core.close()
            core = None
            # Add realistic library state through public methods, not direct SQL inserts.
            core = Core(library,args.binary)
            cats = [core.call('add_category',name=f'Category {i:03}')['id'] for i in range(100)]
            for i,item in enumerate(imports):
                pid = item['paper_id']
                core.call('set_categories',paper_id=pid,category_ids=[cats[i%100]])
                core.call('set_tags',paper_id=pid,tags=[f'topic{i%100:03}',f'method{i%20:02}'])
                core.call('update_paper',paper_id=pid,fields=dict(favorite=i%5==0,read_status='read' if i%3==0 else 'unread',
                          notes=f'Controlled benchmark note {i:05}. 中文笔记。'))
                core.call('add_annotation',paper_id=pid,version_id=item['version_id'],page=0,
                          quote=f'Annotation {i:05}',rects=[dict(x=.1,y=.1,w=.2,h=.03)],version_kind='source')
                if (i+1)%1000==0:
                    report['state_progress']=i+1
                    save()
                    print(f'enriched {i+1}/{args.count} via public RPC',flush=True)
            core.close()
            core = None
        imports = json.loads((base/'imports.json').read_text())
        assert len(imports)==args.count
        starts=[]
        for _ in range(5):
            core=Core(library,args.binary)
            starts.append(core.startup_ms)
            assert core.call('list_papers_page')['total']==args.count
            core.close()
            core=None
        report['results']['process_startup']=stats(starts)
        core=Core(library,args.binary)
        paper=imports[args.count//2]
        cats=core.call('list_taxonomy')['categories']
        category=next(c['id'] for c in cats if c['name']=='Category 000')
        scenarios = {
            'recent_first':dict(), 'recent_deep':dict(offset=args.count-100),
            'sort_title':dict(sort='title'), 'sort_year':dict(sort='year'),
            'favorite':dict(favorite=True), 'read_status':dict(status='read'),
            'category':dict(category=category),'tag':dict(tag='topic000'),
            'search_title_rare':dict(query='Paper 01234'),
            'search_body_rare':dict(query='raretoken01234'),
            'search_body_common':dict(query='attention'),
            'search_no_match':dict(query='neverappearsxyzz'),
            'search_short':dict(query='at'),
        }
        for name,params in scenarios.items():
            result,value=measure(core,'list_papers_page',args.repeats,limit=100,**params)
            assert len(value['items'])<=100
            if value['items']:
                assert 'notes' not in value['items'][0] and 'versions' not in value['items'][0]
            result['matches']=value['total']
            if name=='search_body_common':
                assert value['total']>=args.count-2, 'body search must actually hit generated documents'
            if name in ('search_title_rare','search_body_rare') and args.count>1234:
                assert value['total']==1, 'rare queries must actually hit their target document'
            report['results'][name]=result
            print(name,result,flush=True)
        for name,method,params in [
            ('detail','get_paper',dict(paper_id=paper['paper_id'])),
            ('annotations','list_annotations',dict(paper_id=paper['paper_id'])),
            ('page_blocks','blocks',dict(paper_id=paper['paper_id'],version_id=paper['version_id'],page=1)),
            ('paper_pdf_path','paper_pdf',dict(paper_id=imports[-1]['paper_id'],kind='source')),
            ('taxonomy','list_taxonomy',dict()),
            ('note_save','update_paper',dict(paper_id=paper['paper_id'],fields=dict(notes='Updated benchmark note'))),
            ('export_100','export',dict(paper_ids=[p['paper_id'] for p in imports[:100]],format='bibtex')),
        ]:
            result,_=measure(core,method,args.repeats,**params)
            report['results'][name]=result
            print(name,result,flush=True)
        with pymupdf.open(ROOT/'corpus/raw/attn.pdf') as pdf:
            geometry=[]
            for block in pdf[0].get_text('dict')['blocks']:
                for line in block.get('lines',[]):
                    text=' '.join(span['text'] for span in line['spans']).strip()
                    if text:geometry.append(dict(text=text,bbox=list(line['bbox'])))
        source=imports[-2]
        begin=time.perf_counter()
        core.call('set_blocks',paper_id=source['paper_id'],version_id=source['version_id'],page=0,blocks=geometry)
        report['results']['page_geometry_first_write']=dict(milliseconds=round((time.perf_counter()-begin)*1000,3),blocks=len(geometry))
        report['results']['page_geometry_unchanged'],_=measure(core,'set_blocks',args.repeats,
            paper_id=source['paper_id'],version_id=source['version_id'],page=0,blocks=geometry)
        pending=core.send('list_papers_page',query='attention')
        time.sleep(.005)
        interactive=[]
        while pending.empty():
            begin=time.perf_counter()
            core.call('ping')
            interactive.append((time.perf_counter()-begin)*1000)
            time.sleep(.005)
        core.result(pending)
        if interactive:
            report['results']['interactive_during_search']=stats(interactive)
        # Queue an actual long batch, then time interactive work while it runs.
        # Distinct PDFs ensure this isn't the fast dedup path.
        contention=base/'contention'
        paths=generate(contention,42)[:-2]
        for i,path in enumerate(paths):
            # File identities differ from initial generated fixtures, content too.
            with pymupdf.open(path) as doc:
                doc.set_metadata(dict(title=f'Concurrent import {i} {time.time_ns()}'))
                new=path.with_name(f'load-{i}.pdf')
                doc.save(new,deflate=True)
            paths[i]=new
        batch_started=time.perf_counter()
        batch=core.send('import_pdfs',paths=[str(p) for p in paths])
        time.sleep(.02)
        latencies=[]
        operations=[]
        while batch.empty() and time.perf_counter()-batch_started<120:
            operation=['ping','list_papers_page','get_paper'][len(latencies)%3]
            params=dict(paper_id=paper['paper_id']) if operation=='get_paper' else {}
            begin=time.perf_counter()
            core.call(operation,**params)
            latencies.append((time.perf_counter()-begin)*1000)
            operations.append(operation)
            time.sleep(.01)
        imported=core.result(batch)
        assert all(i['status']=='imported' for i in imported)
        report['results']['interactive_during_import']=dict(**stats(latencies),operations=operations,
            batch_seconds=round(time.perf_counter()-batch_started,3),batch_count=len(paths))
        report['results']['interactive_during_import']['by_operation']={operation:stats(
            [sample for sample,name in zip(latencies,operations) if name==operation]) for operation in set(operations)}
        # Return fixture to exactly count papers, exercising actual purge paths.
        for item in imported:
            core.call('trash_paper',paper_id=item['paper_id'])
            core.call('purge_paper',paper_id=item['paper_id'])
        # Database checks are done again after workload/restart, not only after seeding.
        # Repeated navigation and resource growth: deterministic shuffled paper IDs.
        memory_before=core.memory()
        latencies=[]
        rng=random.Random(42)
        for i in range(args.soak_operations):
            item=rng.choice(imports)
            begin=time.perf_counter()
            if i%4==0:
                core.call('list_papers_page',offset=rng.randrange(0,args.count//100)*100,sort=['title','year','recent'][i%3])
            else:
                core.call('get_paper',paper_id=item['paper_id'])
            latencies.append((time.perf_counter()-begin)*1000)
        report['results']['navigation_soak']=stats(latencies)
        report['memory_before_soak']=memory_before
        report['memory_after_soak']=core.memory()
        assert core.call('list_papers_page')['total']==args.count
        report['protocol_errors']=core.protocol_errors
        assert not core.protocol_errors
        core.close()
        core=None
        with sqlite3.connect(library/'library.db') as db:
            report['counts']={table:db.execute(f'SELECT count(*) FROM {table}').fetchone()[0] for table in
                              ['papers','versions','blocks','annotations','paper_categories','paper_tags']}
            report['integrity_check']=db.execute('PRAGMA integrity_check').fetchone()[0]
            assert report['integrity_check']=='ok'
            assert not db.execute('PRAGMA foreign_key_check').fetchall()
            report['legacy_fts_rows']=db.execute('SELECT count(*) FROM blocks_fts').fetchone()[0]
            report['legacy_fts_orphans']=db.execute('SELECT count(*) FROM blocks_fts f LEFT JOIN blocks b ON b.rowid=f.rowid WHERE b.rowid IS NULL OR b.id!=f.block_id').fetchone()[0]
            assert report['legacy_fts_orphans']==0,'stale token index entries remain after delete'
        report['library_bytes']=sum(p.stat().st_size for p in library.rglob('*') if p.is_file())
        # Budgets apply to this fixture and machine; report measured breaches.
        budgets=dict(process_startup=2000,interactive_during_import=100,
                     recent_first=100,recent_deep=100,sort_title=100,sort_year=100,
                     search_body_common=200,search_body_rare=200,detail=100,note_save=100,
                     navigation_soak=100)
        report['budgets_ms_p95']=budgets
        report['failures']=[f'{name}: p95 {report["results"][name]["p95_ms"]} > {budget} ms'
                            for name,budget in budgets.items() if report['results'][name]['p95_ms']>budget]
        report['completed']=True
        save()
        print('REPORT',args.report, 'FAILURES',report['failures'],flush=True)
        return 1 if args.enforce and report['failures'] else 0
    except BaseException as error:
        report['error']=f'{type(error).__name__}: {error}'
        save()
        raise
    finally:
        if core is not None:
            core.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work-dir',type=Path,required=True)
    parser.add_argument('--report',type=Path,default=ROOT/'artifacts/validation/scale-10k/report.json')
    parser.add_argument('--binary',type=Path,default=ROOT/'core/target/release/moonlight-core')
    parser.add_argument('--count',type=int,default=10000)
    parser.add_argument('--repeats',type=int,default=50)
    parser.add_argument('--soak-operations',type=int,default=3000)
    parser.add_argument('--reuse',action='store_true')
    parser.add_argument('--enforce',action='store_true')
    options=parser.parse_args()
    assert options.count>=200 and options.count%100==0
    assert options.repeats>=10 and options.soak_operations>0
    raise SystemExit(run(options))
