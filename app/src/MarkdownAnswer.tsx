import {memo,useDeferredValue} from 'react';
import ReactMarkdown,{type Components} from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
const remarkPlugins=[remarkGfm,remarkMath];
const rehypePlugins:NonNullable<React.ComponentProps<typeof ReactMarkdown>['rehypePlugins']>=[[rehypeKatex,{trust:false,throwOnError:false,maxExpand:1000,maxSize:20}]];
const components:Components={
  table:({node:_,...props})=><div className="markdown-table-scroll" tabIndex={0} role="region" aria-label="回答表格"><table {...props}/></div>,
  a:({node:_,href,children,...props})=>href?<a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>:<span>{children}</span>,
  // Keep model-generated image URLs from issuing automatic network requests.
  img:({alt})=><span className="markdown-image-alt">{alt?`[图片：${alt}]`:'[图片]'}</span>,
};
function safeUrl(url:string){
  if(url.startsWith('#'))return url;
  try{const parsed=new URL(url);return ['https:','http:','mailto:'].includes(parsed.protocol)?url:'';}catch{return '';}
}
export default memo(function MarkdownAnswer({text}:{text:string}){
  const deferred=useDeferredValue(text);
  return <div className="answer-text markdown-answer"><ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components} urlTransform={safeUrl} skipHtml>{deferred}</ReactMarkdown></div>;
});
