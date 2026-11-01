import type { ImportedAttachment } from './types';
import { api } from './api';

export default function ImportedFiles({paperId,files,onOpen,onError}: {
  paperId:string;files:ImportedAttachment[];onOpen?:(version:string)=>void;onError:(message:string)=>void;
}) {
  if (!files.length) return null;
  return <section className="imported-files"><h3>Zotero 附件</h3>{files.map((file)=><div className="note-item" key={file.id}>
    <div>{file.title}</div>
    <div className="muted small">{file.status==='missing'?'文件尚未下载或路径缺失':file.status==='linked'?'链接文件':'已保存到本地库'}</div>
    {file.status!=='missing' && <div className="row-actions">
      {file.version_id && onOpen && <button className="link" onClick={()=>onOpen(file.version_id!)}>阅读 PDF</button>}
      <button className="link" onClick={()=>api.revealAttachment(paperId,file.id).catch((e)=>onError(String(e)))}>在文件夹中显示</button>
    </div>}
  </div>)}</section>;
}
