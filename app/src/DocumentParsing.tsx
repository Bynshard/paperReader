import {useEffect,useRef,useState,type RefObject} from 'react';
import {api} from './api';
import type {PaneApi} from './PdfPane';
export default function DocumentParsing({paperId,versionId,pages,page,pane,onIndexed}:{paperId:string;versionId:string;pages:number;page:number;pane:RefObject<PaneApi|null>;onIndexed:()=>void}){
  const [progress,setProgress]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[indexed,setIndexed]=useState<number|null>(null);
  const controller=useRef<AbortController|null>(null),alive=useRef(true);
  const refresh=()=> (api.textStatus?api.textStatus(paperId,versionId):Promise.resolve({indexed_pages:0})).then(s=>{if(alive.current)setIndexed(s.indexed_pages);}).catch(()=>{});
  useEffect(()=>{alive.current=true;void refresh();return()=>{alive.current=false;controller.current?.abort();};},[paperId,versionId]);
  const run=async(all:boolean,forceOcr=false)=>{
    if(controller.current)return;
    if(!pane.current){setError('原文 PDF 尚未加载');return;}
    const control=new AbortController();controller.current=control;setBusy(true);setError('');
    try{
      const targets=all?Array.from({length:pages},(_,i)=>i+1):[page];
      for(const p of targets){
        if(control.signal.aborted)break;
        setProgress(`解析第 ${p}/${pages} 页`);
        const blocks=await pane.current!.parsePage(p,{forceOcr,signal:control.signal,progress:message=>{if(alive.current)setProgress(`第 ${p}/${pages} 页：${message}`);}});
        if(control.signal.aborted)break;
        if(blocks.length)await api.setBlocks(paperId,versionId,p-1,blocks);
        if(alive.current){
          const visible=pane.current?.getPosition().page||page;
          if(Math.abs(p-visible)<=2||p===targets.at(-1))onIndexed();
          if(Math.abs(p-visible)<=2||p%10===0||p===targets.at(-1))await refresh();
        }
        await new Promise(resolve=>setTimeout(resolve,0));
      }
      if(alive.current)setProgress(control.signal.aborted?'解析已停止，已完成页面已保留':'解析完成；空白页或无法识别的页面可能没有正文');
    }catch(e){if(alive.current){if(control.signal.aborted)setProgress('解析已停止，已完成页面已保留');else setError((e as Error).message);}}
    finally{controller.current=null;if(alive.current)setBusy(false);}
  };
  return <section className="document-parsing" aria-label="文档解析"><span className="small">正文索引：{indexed===null?'检查中':`${indexed}/${pages} 页`} · 先提取文字，缺少文字层时本地 OCR</span>
    <div className="actions"><button className="btn tiny" disabled={busy} onClick={()=>void run(false)}>解析当前页</button><button className="btn tiny" disabled={busy} onClick={()=>void run(false,true)}>OCR 当前页</button><button className="btn tiny" disabled={busy} onClick={()=>void run(true)}>解析全文</button>{busy&&<button className="btn tiny" onClick={()=>controller.current?.abort()}>停止解析</button>}</div>
    {progress&&<span className="small" role="status">{progress}</span>}{error&&<p role="alert">{error}</p>}
  </section>;
}
