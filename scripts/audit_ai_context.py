"""Audit actual retrieval/prompt/citation handling with a loopback mock model."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading

from benchmark_library import Core, ROOT


def main():
    parser=argparse.ArgumentParser();parser.add_argument("--enforce",action="store_true");parser.add_argument("--report",type=Path,default=ROOT/"artifacts/validation/maturity-20261101/ai-context.json");args=parser.parse_args()
    prompts=[]
    class Model(BaseHTTPRequestHandler):
        def log_message(self,*_):pass
        def do_POST(self):
            payload=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            prompts.append('\n'.join(m.get('content','') for m in payload['messages']))
            data=json.dumps({'choices':[{'message':{'content':'Local mock answer with an invalid citation [999].'}}]}).encode()
            self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    server=ThreadingHTTPServer(('127.0.0.1',0),Model)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    findings=[]
    try:
        with tempfile.TemporaryDirectory(prefix='moonlight-ai-audit-') as folder:
            core=Core(Path(folder),env_overrides=dict(MOONLIGHT_UPSTREAM_KEY='local-mock-only',MOONLIGHT_UPSTREAM=f'http://127.0.0.1:{server.server_port}/v1'))
            try:
                item=core.call('import_pdfs',paths=[str(ROOT/'corpus/raw/attn.pdf')])[0]
                pid=item['paper_id'];vid=item['version_id']
                blocks=[dict(text=f'Page fragment {i:03}'+(' PAGE_TAIL_SENTINEL' if i==59 else ''),bbox=[10,i*5,200,i*5+4]) for i in range(60)]
                core.call('set_blocks',paper_id=pid,version_id=vid,page=0,blocks=blocks)
                answer=core.call('explain',paper_id=pid,version_id=vid,page=0,question='Summarize this page.',kind='summary')
                findings.append(dict(id='page-summary-truncation',observed=dict(page_fragments=60,provided_sources=len(answer['sources']),page_tail_in_prompt='PAGE_TAIL_SENTINEL' in prompts[-1]),reproduced=len(answer['sources'])==20 and 'PAGE_TAIL_SENTINEL' not in prompts[-1]))
                findings.append(dict(id='unvalidated-citation',observed=dict(answer_contains_999='[999]' in answer['answer'],source_count=len(answer['sources']),warnings=answer.get('warnings',[])),reproduced='[999]' in answer['answer'] and not answer.get('warnings')))
                blocks=[dict(text=f'Body fragment {i:04}'+(' deepneedle DEEP_EVIDENCE_SENTINEL' if i==1299 else ''),bbox=[10,10,200,30]) for i in range(1300)]
                core.call('set_blocks',paper_id=pid,version_id=vid,page=1,blocks=blocks)
                answer=core.call('explain',paper_id=pid,version_id=vid,question='Where is deepneedle?',kind='ask')
                findings.append(dict(id='document-retrieval-cap',observed=dict(relevant_block_exists=True,relevant_evidence_in_prompt='DEEP_EVIDENCE_SENTINEL' in prompts[-1],fallback_sources=len(answer['sources'])),reproduced='DEEP_EVIDENCE_SENTINEL' not in prompts[-1]))
            finally:core.close()
    finally:
        server.shutdown();server.server_close();thread.join(timeout=2)
    report=args.report
    report.parent.mkdir(parents=True,exist_ok=True)
    report.write_text(json.dumps(dict(scope='Actual RPC, gateway, retrieval, controlled geometry and local mock model; no paid request or model-quality evaluation',findings=findings),indent=2)+'\n')
    print(json.dumps(findings,indent=2))
    if args.enforce:assert not any(f['reproduced'] for f in findings),findings


if __name__=='__main__':main()
