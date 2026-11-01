import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PdfPane, {type PaneApi} from '../src/PdfPane';
const {pdf}=vi.hoisted(()=>({pdf:{getPage:vi.fn(),destroy:vi.fn(),cancel:vi.fn(),cleanup:vi.fn(),textCancel:vi.fn()}}));
vi.mock('pdfjs-dist',()=>({
  GlobalWorkerOptions:{},Util:{transform:(_a:any,b:any)=>b},
  getDocument:()=>({promise:Promise.resolve({numPages:500,getPage:pdf.getPage}),destroy:pdf.destroy}),
  TextLayer:class {render(){return Promise.resolve();}cancel(){pdf.textCancel();}},
}));
beforeEach(()=>{
  vi.clearAllMocks();
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
});
