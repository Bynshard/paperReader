"""Fail-fast repeatable local/CI verification. No real cloud/model credentials.

Run using the prepared Python environment and Node 22+ on PATH.
The optional expensive scale benchmark creates its own isolated data directory.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT=Path(__file__).resolve().parents[1]


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report',type=Path,default=ROOT/'artifacts/validation/project-checks.json')
    parser.add_argument('--scale-work-dir',type=Path)
    parser.add_argument('--reuse-scale',action='store_true')
    args=parser.parse_args()
    cargo=shutil.which('cargo') or str(Path.home()/'.cargo/bin/cargo')
    npm=shutil.which('npm')
    if not npm:
        parser.error('Node 22+ and npm must be on PATH')
    env={k:v for k,v in os.environ.items() if not k.startswith('MOONLIGHT_')}
    env['PYTHONPATH']=str(ROOT)
    tasks=[
        ('rust_tests',[cargo,'test','--manifest-path','core/Cargo.toml','--release','--offline']),
        ('rust_build',[cargo,'build','--manifest-path','core/Cargo.toml','--release','--offline']),
        ('frontend_tests',[npm,'--prefix','app','test']),
        ('production_build',[npm,'--prefix','app','run','build']),
        ('real_pdf_smoke',[sys.executable,'scripts/smoke_library.py']),
        ('responsiveness',[sys.executable,'scripts/test_responsiveness.py']),
        ('zotero_migration',[sys.executable,'scripts/test_zotero_migration.py']),
        ('reliability',[sys.executable,'scripts/test_release_reliability.py']),
        ('fault_paths',[sys.executable,'scripts/audit_failure_paths.py','--enforce','--report',str(args.report.parent/'faults.json')]),
        ('ai_evidence',[sys.executable,'scripts/audit_ai_context.py','--enforce','--report',str(args.report.parent/'ai-context.json')]),
        ('cloud_transports',[sys.executable,'scripts/test_cloud_sync.py']),
    ]
    if args.scale_work_dir:
        command=[sys.executable,'scripts/benchmark_library.py','--work-dir',str(args.scale_work_dir),'--enforce']
        if args.reuse_scale:command.append('--reuse')
        tasks.append(('scale_10000',command))
    report=dict(steps=[],completed=False)
    args.report.parent.mkdir(parents=True,exist_ok=True)
    for name,command in tasks:
        print(f'\nRunning {name}',flush=True)
        start=time.perf_counter()
        result=subprocess.run(command,cwd=ROOT,env=env)
        report['steps'].append(dict(name=name,exit_code=result.returncode,seconds=round(time.perf_counter()-start,3)))
        args.report.write_text(json.dumps(report,indent=2)+'\n')
        if result.returncode:
            print(f'FAILED {name}; report: {args.report}',flush=True)
            return result.returncode
    report['completed']=True
    args.report.write_text(json.dumps(report,indent=2)+'\n')
    print(f'PASS: {args.report}',flush=True)
    return 0


if __name__=='__main__':
    raise SystemExit(main())
