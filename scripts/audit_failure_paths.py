"""Readiness audit against disposable libraries. Reproductions are findings,
not passing product requirements. Uses a local fake translation executable;
never sends an AI request or touches the user's library.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import sqlite3
import sys
import tempfile
import time

from benchmark_library import Core, ROOT


REPORT=ROOT/'artifacts/validation/maturity-20261101/failure-paths.json'


def db_execute(root,sql):
    with sqlite3.connect(root/'library.db') as db:
        db.executescript(sql)


def finish(core,job):
    deadline=time.monotonic()+15
    while time.monotonic()<deadline:
        state=core.call('get_job',job_id=job)
        if state['status'] in ('completed','failed','cancelled'):
            return state
        time.sleep(.03)
    raise TimeoutError('fake translation did not finish')


def main():
    parser=argparse.ArgumentParser();parser.add_argument("--enforce",action="store_true");parser.add_argument("--report",type=Path,default=REPORT);args=parser.parse_args()
    findings=[]
    with tempfile.TemporaryDirectory(prefix='moonlight-maturity-') as directory:
        base=Path(directory)
        # Inject a deterministic database-write failure after import's first commit.
        root=base/'import-fault'; core=Core(root)
        try:
            db_execute(root,"CREATE TRIGGER audit_fail_index BEFORE INSERT ON blocks BEGIN SELECT RAISE(ABORT,'audit injected index write failure'); END;")
            first=core.call('import_pdfs',paths=[str(ROOT/'corpus/raw/attn.pdf')])[0]
            db_execute(root,'DROP TRIGGER audit_fail_index;')
            retry=core.call('import_pdfs',paths=[str(ROOT/'corpus/raw/attn.pdf')])[0]
            with sqlite3.connect(root/'library.db') as db:
                count=db.execute('SELECT count(*) FROM papers').fetchone()[0]
                blocks=db.execute('SELECT count(*) FROM blocks').fetchone()[0]
            findings.append(dict(id='import-partial-commit',observed=dict(first_status=first['status'],retry_status=retry['status'],papers=count,blocks=blocks),
                reproduced=first['status']=='failed' and retry['status']=='duplicate' and count==1 and blocks==0))
        finally: core.close()
        # A failed row deletion must not make an existing referenced file disappear.
        root=base/'purge-fault'; core=Core(root)
        try:
            item=core.call('import_pdfs',paths=[str(ROOT/'corpus/raw/attn.pdf')])[0]
            pid=item['paper_id']; path=Path(core.call('paper_pdf',paper_id=pid,kind='source')['path'])
            core.call('trash_paper',paper_id=pid)
            db_execute(root,"CREATE TRIGGER audit_fail_delete BEFORE DELETE ON papers BEGIN SELECT RAISE(ABORT,'audit injected row deletion failure'); END;")
            response=core.send('purge_paper',paper_id=pid).get(timeout=20)
            remains=core.call('get_paper',paper_id=pid)
            findings.append(dict(id='purge-file-before-row',observed=dict(purge_ok=response.get('ok'),paper_still_exists=bool(remains),referenced_pdf_exists=path.exists()),
                reproduced=not response.get('ok') and bool(remains) and not path.exists()))
        finally: core.close()

        executable=base/'fake-babeldoc'
        executable.write_text(f'#!{sys.executable}\n'+'''import json,os,pathlib,shutil,sys,time
args=sys.argv[1:]
out=pathlib.Path(args[args.index('--output')+1]);out.mkdir(parents=True,exist_ok=True)
marker=pathlib.Path(os.environ['MOONLIGHT_AUDIT_MARKER']);marker.write_text(str(os.getpid()))
print('Translating',flush=True)
time.sleep(float(os.environ.get('MOONLIGHT_AUDIT_DELAY','0.5')))
if not os.environ.get('MOONLIGHT_AUDIT_EMPTY'):
 shutil.copyfile(args[args.index('--files')+1],out/'audit.zh-CN.mono.pdf')
else:
 (out/'audit.zh-CN.mono.pdf').write_bytes(b'not a PDF')
''')
        executable.chmod(0o755)
        for scenario in ['trash-during-translation','cancel-completed','invalid-output','crash-restart']:
            root=base/scenario
            marker=base/f'{scenario}.pid'
            env=dict(MOONLIGHT_UPSTREAM_KEY='local-audit-dummy',MOONLIGHT_UPSTREAM='http://127.0.0.1:9/v1',
                     MOONLIGHT_BABELDOC_BIN=str(executable),MOONLIGHT_AUDIT_MARKER=str(marker),MOONLIGHT_AUDIT_DELAY='0.5')
            if scenario=='crash-restart':env['MOONLIGHT_AUDIT_DELAY']='10'
            if scenario=='invalid-output':env['MOONLIGHT_AUDIT_EMPTY']='1'
            core=Core(root,env_overrides=env)
            try:
                item=core.call('import_pdfs',paths=[str(ROOT/'corpus/raw/attn.pdf')])[0]
                pid=item['paper_id']; job=core.call('start_translate',paper_id=pid)['job_id']
                if scenario=='trash-during-translation':
                    core.call('trash_paper',paper_id=pid)
                    state=finish(core,job)
                    paper=core.call('get_paper',paper_id=pid)
                    count=sum(v['kind']=='translated' for v in paper['versions'])
                    findings.append(dict(id=scenario,observed=dict(status=state['status'],paper_deleted=paper['deleted'],translated_versions=count),
                        reproduced=state['status']=='completed' and paper['deleted'] and count>0))
                elif scenario=='cancel-completed':
                    state=finish(core,job)
                    core.call('cancel_job',job_id=job)
                    after=core.call('get_job',job_id=job)
                    findings.append(dict(id=scenario,observed=dict(before=state['status'],after=after['status']),
                        reproduced=state['status']=='completed' and after['status']=='cancelling'))
                elif scenario=='invalid-output':
                    state=finish(core,job)
                    paper=core.call('get_paper',paper_id=pid)
                    versions=[v for v in paper['versions'] if v['kind']=='translated']
                    findings.append(dict(id=scenario,observed=dict(status=state['status'],translated_pages=[v['pages'] for v in versions]),
                        reproduced=state['status']=='completed' and any(v['pages']==0 for v in versions)))
                else:
                    deadline=time.monotonic()+10
                    while not marker.exists() and time.monotonic()<deadline:time.sleep(.02)
                    assert marker.exists(),'fake engine did not start'
                    core.process.kill();core.process.wait(timeout=5);core.close()
                    try: os.killpg(int(marker.read_text()),signal.SIGKILL)
                    except ProcessLookupError: pass
                    core=Core(root)
                    state=core.call('get_job',job_id=job)
                    findings.append(dict(id=scenario,observed=dict(status_after_restart=state['status']),
                        reproduced=state['status'] in ('queued','parsing','translating','typesetting','validating','cancelling')))
            finally: core.close()
    expected={
      'import-partial-commit':lambda o:o['first_status']=='failed' and o['retry_status']=='imported' and o['papers']==1 and o['blocks']>0,
      'purge-file-before-row':lambda o:not o['purge_ok'] and o['paper_still_exists'] and o['referenced_pdf_exists'],
      'trash-during-translation':lambda o:o['status']=='cancelled' and o['translated_versions']==0,
      'cancel-completed':lambda o:o['before']==o['after']=='completed',
      'invalid-output':lambda o:o['status']=='failed' and not o['translated_pages'],
      'crash-restart':lambda o:o['status_after_restart']=='failed',
    }
    for finding in findings:finding['passed']=expected[finding['id']](finding['observed'])
    global_report=args.report
    global_report.parent.mkdir(parents=True,exist_ok=True)
    global_report.write_text(json.dumps(dict(scope='Actual core; temporary libraries; database fault triggers and fake local translation engine; no paid model calls',findings=findings),indent=2)+'\n')
    print(json.dumps(findings,indent=2))
    if args.enforce:assert all(f['passed'] for f in findings),findings
    print('Fault regression report:',global_report)


if __name__=='__main__':main()
