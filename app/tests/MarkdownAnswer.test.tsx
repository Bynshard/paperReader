import {render,screen,waitFor} from '@testing-library/react';
import {describe,it,expect} from 'vitest';
import MarkdownAnswer from '../src/MarkdownAnswer';
describe('AI answer Markdown',()=>{
 it('renders the reported table and heading, including an incomplete streaming row',async()=>{
  const prefix='# 2. 原文中的例子说明什么？\n\n| 平台 | 连接方式及规模 | 原文给出的带宽 |\n|---|---|---|\n| NVIDIA DGX H100 | 8';
  const view=render(<MarkdownAnswer text={prefix}/>);
  expect(screen.getByRole('heading',{name:'2. 原文中的例子说明什么？'})).toBeTruthy();
  expect(screen.getAllByRole('columnheader')).toHaveLength(3);
  expect(screen.getByRole('cell',{name:'NVIDIA DGX H100'})).toBeTruthy();
  view.rerender(<MarkdownAnswer text={prefix+' GPUs | 900 GB/s |'}/>);
  await screen.findByRole('cell',{name:'900 GB/s'});
  expect(screen.getByRole('region',{name:'回答表格'})).toBeTruthy();
 });
 it('renders formulas and preserves Markdown examples inside code fences',()=>{
  const view=render(<MarkdownAnswer text={'**结论**：$E=mc^2$\n\n```md\n# literal heading\n| literal | table |\n```'}/>);
  expect(view.container.querySelector('strong')?.textContent).toBe('结论');
  expect(view.container.querySelector('.katex')).toBeTruthy();
  expect(view.container.querySelector('pre code')?.textContent).toContain('# literal heading');
  expect(view.container.querySelector('table')).toBeNull();
 });
 it('blocks raw HTML and executable links and never fetches model-supplied images',async()=>{
  const view=render(<MarkdownAnswer text={'<script>alert(1)</script>\n\n[危险链接](javascript:alert%281%29)\n\n![external](https://example.test/track.png)\n\n[文献](https://example.test/paper)'}/>);
  await waitFor(()=>expect(view.container.querySelector('script,img')).toBeNull());
  expect(screen.getByRole('link',{name:'文献'}).getAttribute('href')).toBe('https://example.test/paper');
  expect(screen.queryByRole('link',{name:'危险链接'})).toBeNull();
 });
});
