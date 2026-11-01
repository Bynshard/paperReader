import {createWorker,type Worker} from 'tesseract.js';
export type OcrBlock={bbox:number[];text:string;kind?:string};
let active=false,worker:Worker|null=null,idle:ReturnType<typeof setTimeout>|undefined;
export async function recognizePage(image:HTMLCanvasElement,width:number,height:number,progress:(value:string)=>void,signal?:AbortSignal):Promise<OcrBlock[]> {
  if(active)throw new Error('已有 OCR 正在运行，请稍后重试');
  active=true;clearTimeout(idle);
  let ended=false,rejectAbort:(error:Error)=>void=()=>{};
  const stop=()=>{const owned=worker;worker=null;void owned?.terminate();};
  const aborted=new Promise<never>((_,reject)=>{rejectAbort=reject;});
  const cancel=()=>{ended=true;stop();rejectAbort(new Error('OCR 已取消'));};
  const timeout=setTimeout(()=>{ended=true;stop();rejectAbort(new Error('OCR 超时，请重试当前页'));},120000);
  signal?.addEventListener('abort',cancel,{once:true});
  try{
    if(signal?.aborted)cancel();
    return await Promise.race([aborted,(async()=>{
      const base=location.protocol==='file:'?'moonlight-ocr://assets/':new URL('ocr/',document.baseURI).href;
      progress('加载本地 OCR 引擎…');
      if(!worker){
        const created=await createWorker(['eng','chi_sim'],1,{workerPath:base+'worker.min.js',corePath:base,langPath:base,workerBlobURL:true,cacheMethod:'none'});
        if(ended){await created.terminate();throw new Error('OCR 已取消');}worker=created;
      }
      if(ended)throw new Error('OCR 已取消');
      progress('正在本地识别文字…');
      const {data}=await worker.recognize(image,{}, {text:true,blocks:true});
      if(ended)throw new Error('OCR 已取消');
      const out:OcrBlock[]=[];
      for(const block of data.blocks||[])for(const paragraph of block.paragraphs)for(const line of paragraph.lines){
        const text=line.text.trim(),b=line.bbox;
        if(!text)continue;
        const bbox=[b.x0/image.width*width,b.y0/image.height*height,b.x1/image.width*width,b.y1/image.height*height];
        if(bbox.every(Number.isFinite))out.push({text,bbox,kind:'ocr'});
      }
      return out;
    })()]);
  }catch(e){ended=true;stop();throw e;}finally{clearTimeout(timeout);signal?.removeEventListener('abort',cancel);active=false;idle=setTimeout(stop,30000);}
}
