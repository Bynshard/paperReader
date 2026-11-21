import { memo, useDeferredValue, useMemo } from 'react';
import ReactMarkdown,{type Components} from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
const remarkPlugins=[remarkGfm,remarkMath];
const rehypePlugins:NonNullable<React.ComponentProps<typeof ReactMarkdown>['rehypePlugins']>=[[rehypeKatex,{trust:false,throwOnError:false,maxExpand:1000,maxSize:20}]];
function safeUrl(url:string){
  if(url.startsWith('#'))return url;
  try{const parsed=new URL(url);return ['https:','http:','mailto:'].includes(parsed.protocol)?url:'';}catch{return '';}
}
const baseComponents:Components={
  table:({node:_,...props})=><div className="markdown-table-scroll" tabIndex={0} role="region" aria-label="回答表格"><table {...props}/></div>,
  // Keep model-generated image URLs from issuing automatic network requests.
  img:({alt})=><span className="markdown-image-alt">{alt?`[图片：${alt}]`:'[图片]'}</span>,
};
/**
 * Markdown renderer shared by AI answers and the paper digest.  `[p.3](#p-3)`
 * links become in-reader jumps instead of opening a new tab.
 */
export default memo(function MarkdownAnswer({text,onPageRef}:{text:string;onPageRef?:(page:number)=>void}){
  const deferred=useDeferredValue(text);
  const components=useMemo<Components>(()=>({
    ...baseComponents,
    a:({node:_,href,children,...props})=>{
      const match=href?.match(/^#p-(\d+)$/);
      if(match&&onPageRef)return <button type="button" className="page-ref" onClick={()=>onPageRef(Number(match[1]))}>{children}</button>;
      return href?<a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>:<span>{children}</span>;
    },
  }),[onPageRef]);
  return <div className="answer-text markdown-answer"><ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components} urlTransform={safeUrl} skipHtml>{deferred}</ReactMarkdown></div>;
});
