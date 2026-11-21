import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PdfPane, {extractFiguresFromPage, matchTextReference, type PaneApi, pixelBudget} from '../src/PdfPane';
const {pdf}=vi.hoisted(()=>({pdf:{getPage:vi.fn(),destroy:vi.fn(),cancel:vi.fn(),cleanup:vi.fn(),textCancel:vi.fn(),getDocument:vi.fn(),numPages:500}}));
vi.mock('pdfjs-dist',()=>({
  GlobalWorkerOptions:{},Util:{transform:(_a:any,b:any)=>b},
  getDocument:(options:any)=>{pdf.getDocument(options);return {promise:Promise.resolve({numPages:pdf.numPages,getPage:pdf.getPage}),destroy:pdf.destroy};},
  TextLayer:class {
    private options:any;
    constructor(options:any){this.options=options;}
    async render(){
      // Minimal text layer: one span so click-to-reference can be exercised.
      const container:HTMLElement|undefined=this.options?.container;
      if(container&&!container.querySelector('span')){
        const span=document.createElement('span');
        span.textContent='see Fig. 2';
        container.append(span);
      }
    }
    cancel(){pdf.textCancel();}
  },
}));
beforeEach(()=>{
  vi.clearAllMocks();
  pdf.numPages=500;
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  pdf.getPage.mockImplementation(async()=>({
    getViewport:({scale}:any)=>({width:600*scale,height:800*scale,transform:[scale,0,0,-scale,0,800*scale]}),
    render:()=>({promise:Promise.resolve(),cancel:pdf.cancel}),
    getTextContent:async()=>({items:[{str:'Page source text',transform:[1,0,0,10,10,700],width:80}]}),
    cleanup:pdf.cleanup,
  }));
});
describe('virtual PDF pages',()=>{
  it('bounds backing pixels at high zoom on a HiDPI screen without changing layout size',async()=>{
    const old=window.devicePixelRatio;
    Object.defineProperty(window,'devicePixelRatio',{value:2,configurable:true});
    const view=render(<PdfPane bytes={new Uint8Array([1])} scale={3} annotations={[]} side="source"/>);
    try {
      await waitFor(()=>expect(view.container.querySelector('canvas[data-rendered="true"]')).not.toBeNull());
      for(const canvas of view.container.querySelectorAll('canvas')){
        expect(canvas.width*canvas.height).toBeLessThanOrEqual(8_388_608);
        expect(canvas.style.width).toBe('1800px');
        expect(canvas.style.height).toBe('2400px');
      }
    } finally {
      view.unmount();
      Object.defineProperty(window,'devicePixelRatio',{value:old,configurable:true});
    }
  });
  it('streams a range-capable URL instead of copying the whole file',async()=>{
    const view=render(<PdfPane url="moonlight-pdf://version/v-1" scale={1} annotations={[]} side="source"/>);
    try {
      await waitFor(()=>expect(view.container.querySelector('canvas')).not.toBeNull());
      const options=pdf.getDocument.mock.calls[0][0];
      expect(options).toEqual({url:'moonlight-pdf://version/v-1',rangeChunkSize:65536});
      expect(options.data).toBeUndefined();
    } finally { view.unmount(); }
  });
  it('keeps the in-memory bytes path for legacy/desktop fallback',async()=>{
    const bytes=new Uint8Array([1,2,3]);
    const view=render(<PdfPane bytes={bytes} scale={1} annotations={[]} side="source"/>);
    try {
      await waitFor(()=>expect(view.container.querySelector('canvas')).not.toBeNull());
      const options=pdf.getDocument.mock.calls[0][0];
      expect(options.data).toBeInstanceOf(Uint8Array);
      expect(options.url).toBeUndefined();
    } finally { view.unmount(); }
  });
  it('keeps the current scale when a hidden pane cannot be measured for fit',async()=>{
    let api:PaneApi|null=null;
    const view=render(<PdfPane bytes={new Uint8Array([1])} scale={1.15} annotations={[]} side="source" registerApi={(value)=>{api=value;}}/>);
    try {
      await waitFor(()=>expect(view.container.querySelector('canvas')).not.toBeNull());
      const scroll=view.container.querySelector<HTMLElement>('.pane-scroll')!;
      Object.defineProperty(scroll,'clientWidth',{value:0,configurable:true});
      Object.defineProperty(scroll,'clientHeight',{value:0,configurable:true});
      expect(api!.fit('width')).toBe(1.15);
    } finally { view.unmount(); }
  });
  it('restores a distant initial page without emitting a user scroll',async()=>{
    const changed=vi.fn();
    const view=render(<PdfPane bytes={new Uint8Array([1])} scale={1} annotations={[]} initialPage={120} initialFraction={.25} side="source" onScrollFraction={changed}/>);
    await waitFor(()=>expect(view.container.querySelector('[data-page="120"] canvas')).not.toBeNull());
    expect(changed).not.toHaveBeenCalled();
  });
  it('mounts only visible pages, navigates silently and sends zero-based block pages',async()=>{
    let api:PaneApi|null=null;
    const register=(value:PaneApi|null)=>{api=value;};
    const pageChanged=vi.fn();const scrolled=vi.fn();const blocks=vi.fn();
    const view=render(<PdfPane bytes={new Uint8Array([1])} scale={1} annotations={[]} side="source" registerApi={register} onPageChange={pageChanged} onScrollFraction={scrolled} onBlocks={blocks}/>);
    await waitFor(()=>expect(view.container.querySelectorAll('canvas').length).toBeGreaterThan(0));
    expect(view.container.querySelectorAll('.page-holder').length).toBeLessThan(8);
    expect(pdf.getPage.mock.calls.length).toBeLessThan(10);
    expect(blocks).toHaveBeenCalledWith(0,expect.any(Array));
    act(()=>{api!.goTo(250,0);});
    await waitFor(()=>expect(view.container.querySelector('[data-page="250"]')).not.toBeNull());
    expect(pageChanged).not.toHaveBeenCalled();expect(scrolled).not.toHaveBeenCalled();
    expect(view.container.querySelectorAll('canvas').length).toBeLessThan(8);
    await waitFor(()=>expect(blocks).toHaveBeenCalledWith(249,expect.any(Array)));
    view.unmount();expect(pdf.cancel).toHaveBeenCalled();expect(pdf.destroy).toHaveBeenCalled();expect(api).toBeNull();
  });
  it('cancels old drawing tasks on zoom and preserves a bounded page set',async()=>{
    const bytes=new Uint8Array([1]);
    const view=render(<PdfPane bytes={bytes} scale={1} annotations={[]} side="source"/>);
    await waitFor(()=>expect(view.container.querySelector('canvas')).not.toBeNull());
    view.rerender(<PdfPane bytes={bytes} scale={2} annotations={[]} side="source"/>);
    await waitFor(()=>expect(pdf.cancel).toHaveBeenCalled());
    expect(view.container.querySelectorAll('.page-holder').length).toBeLessThan(8);
  });
  it('draws a marquee from a single finger without an Alt key in area mode',async()=>{
    const onArea=vi.fn();
    const view=render(<PdfPane bytes={new Uint8Array([1])} scale={1} annotations={[]} side="source" areaMode onAreaSelect={onArea}/>);
    await waitFor(()=>expect(view.container.querySelector('.page-holder')).not.toBeNull());
    const holder=view.container.querySelector<HTMLElement>('.page-holder')!;
    const send=(type:string,x:number,y:number)=>act(()=>{holder.dispatchEvent(pointerEvent(type,{clientX:x,clientY:y,pointerId:7}));});
    send('pointerdown',100,100);
    send('pointermove',220,240);
    send('pointerup',220,240);
    expect(onArea).toHaveBeenCalledTimes(1);
    const selection=onArea.mock.calls[0][0];
    expect(selection.area).toBe(true);
    expect(selection.rects).toHaveLength(1);
    expect(selection.rects[0].w).toBeGreaterThan(0);
    expect(selection.rects[0].h).toBeGreaterThan(0);
  });
  it('previews with a CSS transform and commits a two-finger pinch once',async()=>{
    const onPinchScale=vi.fn();
    const view=render(<PdfPane bytes={new Uint8Array([1])} scale={1} annotations={[]} side="source" onPinchScale={onPinchScale}/>);
    await waitFor(()=>expect(view.container.querySelector('.page-holder')).not.toBeNull());
    const holder=view.container.querySelector<HTMLElement>('.page-holder')!;
    const send=(type:string,x:number,y:number,id:number)=>act(()=>{holder.dispatchEvent(pointerEvent(type,{clientX:x,clientY:y,pointerId:id}));});
    send('pointerdown',100,100,1);
    send('pointerdown',200,100,2);
    send('pointermove',300,100,2);
    // Live preview must stay on the compositor (inline transform, no React state).
    const stage=view.container.querySelector<HTMLElement>('.pane-scroll > div')!;
    expect(stage.style.transform).toBe('scale(2)');
    expect(onPinchScale).not.toHaveBeenCalled();
    send('pointerup',300,100,2);
    expect(onPinchScale).toHaveBeenCalledTimes(1);
    expect(onPinchScale.mock.calls[0][0]).toBeCloseTo(2,2);
    expect(stage.style.transform).toBe('');
  });
  it('clips page margins with autoCrop, keeps 0-1 coordinates and fits the body width',async()=>{
    pdf.getPage.mockImplementation(async()=>({
      getViewport:({scale}:any)=>({width:600*scale,height:800*scale,transform:[scale,0,0,-scale,0,800*scale]}),
      render:()=>({promise:Promise.resolve(),cancel:pdf.cancel}),
      getTextContent:async()=>({items:[
        {str:'Body line one',transform:[1,0,0,10,10,700],width:500},
        {str:'Body line two',transform:[1,0,0,10,10,300],width:500},
      ]}),
      cleanup:pdf.cleanup,
    }));
    let api:PaneApi|null=null;
    const view=render(<PdfPane bytes={new Uint8Array([1])} scale={1} annotations={[]} side="source" autoCrop registerApi={(value)=>{api=value;}}/>);
    await waitFor(()=>expect(view.container.querySelector('.page-holder')).not.toBeNull());
    const holder=view.container.querySelector<HTMLElement>('.page-holder')!;
    await waitFor(()=>expect(holder.style.width).not.toBe('600px'));
    // The holder is clipped...
    expect(parseFloat(holder.style.width)).toBeLessThan(600);
    expect(parseFloat(holder.style.height)).toBeLessThan(800);
    // ...while the page layer keeps the full page, so annotation rects (x*100%)
    // and pdf.js coordinates never move.
    const inner=view.container.querySelector<HTMLElement>('.page-inner')!;
    expect(inner.classList.contains('cropped')).toBe(true);
    expect(inner.style.width).toBe('600px');
    expect(inner.style.height).toBe('800px');
    // fit-width uses the cropped body width, so the body text really gets bigger.
    expect(api!.fit('width')).toBeCloseTo((900-36)/parseFloat(holder.style.width),2);
  });
});
describe('figure caption extraction',()=>{
  it('matches Figure / Fig. / Table / Algorithm captions and computes page fractions',()=>{
    const rows=extractFiguresFromPage(3,[
      {text:'Figure 1: Overview of the proposed pipeline',bbox:[40,200,560,214]},
      {text:'Fig. 2. Ablation results',bbox:[40,400,560,414]},
      {text:'Table 3：主实验结果',bbox:[40,600,560,614]},
      {text:'Algorithm 1: Training loop',bbox:[40,700,560,714]},
      {text:'Figures 4 and 5 are discussed below.',bbox:[40,720,560,734]},
      {text:'Table of contents',bbox:[40,740,560,754]},
      {text:'as shown in Figure 6, the trend is clear',bbox:[40,760,560,774]},
    ],800);
    expect(rows.map((row)=>row.label)).toEqual(['Figure 1','Figure 2','Table 3','Algorithm 1']);
    expect(rows[0]).toMatchObject({page:3,fraction:0.25,caption:'Figure 1: Overview of the proposed pipeline'});
    expect(rows[3].fraction).toBeCloseTo(0.875,3);
  });
  it('deduplicates repeated labels on a page and tolerates missing geometry',()=>{
    const rows=extractFiguresFromPage(2,[
      {text:'Table 1: Results',bbox:[10,80,300,94]},
      {text:'Table 1: Results (repeated running header)',bbox:[10,90,300,104]},
      {text:'   Figure    7:   Sparse view  ',bbox:[] as number[]},
      {text:'',bbox:[0,0,10,10]},
    ],1000);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({label:'Table 1',page:2,fraction:0.08});
    expect(rows[1]).toMatchObject({label:'Figure 7',caption:'Figure 7: Sparse view',fraction:0});
    expect(extractFiguresFromPage(0,rows.map((row)=>({text:row.caption,bbox:[0,0,1,1]})),800)).toEqual([]);
    expect(extractFiguresFromPage(1,[],0)).toEqual([]);
  });
  it('scans every page once and caches the caption list per document',async()=>{
    pdf.numPages=3;
    const captions:Record<number,string[]>={
      1:['Figure 1: Overview','Body paragraph'],
      2:['Table 1: Baseline results'],
      3:['Algorithm 1: Inference'],
    };
    pdf.getPage.mockImplementation(async(pageNumber:number)=>({
      getViewport:({scale}:any)=>({width:600*scale,height:800*scale,transform:[scale,0,0,-scale,0,800*scale]}),
      render:()=>({promise:Promise.resolve(),cancel:pdf.cancel}),
      getTextContent:async()=>({items:(captions[pageNumber]??[]).map((str,index)=>({str,transform:[1,0,0,10,10,760-index*20],width:120}))}),
      cleanup:pdf.cleanup,
    }));
    let api:PaneApi|null=null;
    const view=render(<PdfPane bytes={new Uint8Array([1])} scale={1} annotations={[]} side="source" registerApi={(value)=>{api=value;}}/>);
    try {
      await waitFor(()=>expect(view.container.querySelector('canvas')).not.toBeNull());
      const rows=await api!.extractFigures();
      expect(rows.map((row)=>row.label)).toEqual(['Figure 1','Table 1','Algorithm 1']);
      expect(rows.map((row)=>row.page)).toEqual([1,2,3]);
      const calls=pdf.getPage.mock.calls.length;
      const cached=await api!.extractFigures();
      expect(cached).toBe(rows);
      expect(pdf.getPage.mock.calls.length).toBe(calls);
    } finally { view.unmount(); }
  });
});
describe('in-text reference matching (FEAT-AI-01)',()=>{
  it('recognises every supported reference kind with a canonical label and block queries',()=>{
    expect(matchTextReference('as shown in Figure 2, the trend is clear')).toMatchObject({
      kind:'figure',label:'Figure 2',number:'2',text:'Figure 2',
      queries:['Figure 2','Fig. 2','Fig 2','Fig.2'],
    });
    expect(matchTextReference('see Fig. 3 for details')).toMatchObject({kind:'figure',label:'Figure 3',number:'3',text:'Fig. 3'});
    expect(matchTextReference('Table 4：主实验结果')).toMatchObject({kind:'table',label:'Table 4',number:'4'});
    expect(matchTextReference('Equation (5) defines the loss')).toMatchObject({
      kind:'equation',label:'Eq. (5)',number:'5',queries:['(5)','Eq. 5','Equation 5'],
    });
    expect(matchTextReference('Section 4.2 explains why')).toMatchObject({kind:'section',label:'Section 4.2',number:'4.2'});
    expect(matchTextReference('Algorithm 2: Inference loop')).toMatchObject({kind:'algorithm',label:'Algorithm 2',number:'2'});
    expect(matchTextReference('prior work [12] shows this')).toMatchObject({kind:'citation',label:'[12]',number:'12',queries:['[12]']});
    expect(matchTextReference('multi [3, 4] citations')).toMatchObject({kind:'citation',label:'[3, 4]',number:'3, 4',queries:['[3]','[4]']});
  });
  it('rejects prose, plural captions, tables of contents and bare numbers',()=>{
    const prose=[
      'Figure out how to train the model',
      'Table of contents',
      'Figures 4 and 5 are related',
      'the value is 3.14 and the model has 12 layers',
      'Section shortcuts are configured below',
      'configure 2 servers before running',
      '[2024] was a good year',
      'Figure 1st place',
    ];
    for(const line of prose) expect(matchTextReference(line)).toBeNull();
    expect(matchTextReference('')).toBeNull();
    expect(matchTextReference(undefined as unknown as string)).toBeNull();
  });
  it('resolves a click on a text-layer span into a reference with its click anchor',async()=>{
    const found=vi.fn();
    const view=render(<PdfPane bytes={new Uint8Array([1])} scale={1} annotations={[]} side="source" onTextReference={found}/>);
    try {
      await waitFor(()=>expect(view.container.querySelector('.textLayer span')).not.toBeNull());
      const span=view.container.querySelector<HTMLElement>('.textLayer span')!;
      fireEvent.mouseUp(span,{clientX:120,clientY:340});
      expect(found).toHaveBeenCalledTimes(1);
      expect(found.mock.calls[0][0]).toMatchObject({kind:'figure',label:'Figure 2',number:'2',text:'Fig. 2'});
      expect(found.mock.calls[0][1]).toEqual({x:120,y:340});
    } finally { view.unmount(); }
  });
  it('never resolves a reference while a text selection or a pan gesture is in progress',async()=>{
    const found=vi.fn();
    const view=render(<PdfPane bytes={new Uint8Array([1])} scale={1} annotations={[]} side="source" onTextReference={found}/>);
    try {
      await waitFor(()=>expect(view.container.querySelector('.textLayer span')).not.toBeNull());
      const span=view.container.querySelector<HTMLElement>('.textLayer span')!;
      // A real drag selection leaves a non-collapsed range behind. jsdom has no
      // Range geometry, so stub the selection the browser would expose.
      const selection=vi.spyOn(window,'getSelection').mockReturnValue({isCollapsed:false,rangeCount:0,toString:()=>'selected words'} as unknown as ReturnType<typeof window.getSelection>);
      fireEvent.mouseUp(span,{clientX:120,clientY:340});
      expect(found).not.toHaveBeenCalled();
      selection.mockRestore();
      // A pan drag (> 6 px) must not be mistaken for a reference click.
      const holder=view.container.querySelector<HTMLElement>('.page-holder')!;
      act(()=>{holder.dispatchEvent(pointerEvent('pointerdown',{clientX:100,clientY:100,pointerId:3,pointerType:'mouse'}));});
      act(()=>{holder.dispatchEvent(pointerEvent('pointermove',{clientX:180,clientY:160,pointerId:3,pointerType:'mouse'}));});
      fireEvent.mouseUp(span,{clientX:180,clientY:160});
      expect(found).not.toHaveBeenCalled();
      // A plain click still works after the drag guard reset.
      fireEvent.mouseUp(span,{clientX:120,clientY:340});
      expect(found).toHaveBeenCalledTimes(1);
    } finally { view.unmount(); }
  });
});
describe('tablet canvas budget',()=>{
  it('keeps 8 MP on ordinary desktops and gives 12 MP to 3.1K HiDPI tablets',()=>{
    // Desktop / HiDPI laptop with a 1440 CSS-px wide window.
    expect(pixelBudget(1440,1)).toBe(8_388_608);
    // Small HiDPI window: 1024 CSS px × 2 = 2048 physical px, still 8 MP.
    expect(pixelBudget(1024,2)).toBe(8_388_608);
    // vivo Pad 5 Pro: 3096×2064 physical at 2.75× DPR ≈ 1126 CSS px,
    // or at 3× DPR ≈ 1032 CSS px — both must get the 12 MP budget.
    expect(pixelBudget(1126,2.75)).toBe(12_582_912);
    expect(pixelBudget(1032,3)).toBe(12_582_912);
    expect(pixelBudget(1548,2)).toBe(12_582_912);
  });
});
/** jsdom has no PointerEvent, so build a MouseEvent carrying the pointer props React reads. */
function pointerEvent(type:string,init:{clientX:number;clientY:number;pointerId:number;pointerType?:string}){
  const event=new window.MouseEvent(type,{bubbles:true,cancelable:true,clientX:init.clientX,clientY:init.clientY,button:0,buttons:1});
  Object.defineProperties(event,{pointerId:{value:init.pointerId},pointerType:{value:init.pointerType??'touch'},isPrimary:{value:true}});
  return event;
}
