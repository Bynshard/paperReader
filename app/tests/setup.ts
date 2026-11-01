import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 600; } });
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 900; } });
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 600; } });
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 900; } });
Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get() {
  return Math.max(600,parseFloat((this.firstElementChild as HTMLElement | null)?.style.height || '600'));
} });
HTMLElement.prototype.getBoundingClientRect = function () {
  const height = this.classList.contains('paper-row') ? 120 : 600;
  return { x:0,y:0,left:0,top:0,right:900,bottom:height,width:900,height,toJSON:()=>({}) };
};
class ResizeObserverMock {
  private observed = new Set<Element>();
  constructor(private callback: ResizeObserverCallback) {}
  observe(element: Element) {
    this.observed.add(element);
    queueMicrotask(()=>{ if(this.observed.has(element)) this.callback([{ target:element, borderBoxSize:[{inlineSize:900,blockSize:element.getBoundingClientRect().height}], contentRect:element.getBoundingClientRect() } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver); });
  }
  unobserve(element:Element) { this.observed.delete(element); } disconnect() {this.observed.clear();}
}
vi.stubGlobal('ResizeObserver', ResizeObserverMock);
HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number, y?: number) {
  this.scrollTop = typeof options === 'object' ? options.top ?? this.scrollTop : y ?? 0;
  queueMicrotask(()=>this.dispatchEvent(new Event('scroll')));
};
