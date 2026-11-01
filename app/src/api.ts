import type { Annotation, AppInfo, Block, ImportedAttachment, JobEvent, Paper, PaperPage, PaperPageOptions, PdfBytes, Source } from "./types";
import type {SyncProfile,SyncSettings,SyncStatus,SyncConflict} from './types';

type MoonlightBridge = {
  call: (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
  pickPdfs: () => Promise<unknown[]>;
  readPdf: (paperId: string, kind: string, versionId?:string) => Promise<PdfBytes>;
  pickDirectory: () => Promise<string|null>;
  revealAttachment: (paperId:string,fileId:string) => Promise<void>;
  syncSettings: () => Promise<SyncSettings>;
  configureSync: (input:{profile:SyncProfile;auto_minutes:number}) => Promise<SyncSettings>;
  saveText: (defaultName: string, text: string) => Promise<{ saved: boolean; path?: string }>;
  translationAction?: (action:string,input?:unknown) => Promise<unknown>;
  aiAction?: (action:string,input?:unknown) => Promise<unknown>;
  backup?: (action:string)=>Promise<{cancelled?:boolean;path?:string}>;
  appInfo: () => Promise<AppInfo>;
  onEvent: (cb: (msg: JobEvent | { event: string; [k: string]: unknown }) => void) => () => void;
};

declare global {
  interface Window {
    moonlight: MoonlightBridge;
  }
}

const bridge = () => window.moonlight;

export type ChatMessage={id:string;kind:string;question:string;answer:string;sources:Source[];warnings?:string[];model?:string};
export type AiStatus={provider:'api'|'codex';model:string;account:{type:string;email:string;plan:string}|null;models:{id:string;name:string;isDefault?:boolean}[];limits?:{primary?:{usedPercent:number;windowDurationMins:number;resetsAt:number};secondary?:{usedPercent:number;windowDurationMins:number;resetsAt:number}};error?:string;loginPending:boolean};
export type TranslationSettings={base_url:string;model:string;babeldoc:string;qps:number;key_configured:boolean;pending_restart:boolean;error?:string};
export const api = {
  translationAction: (action:string,input?:unknown) => bridge().translationAction?bridge().translationAction!(action,input):Promise.reject(new Error('请升级桌面客户端以配置翻译 API')),
  listJobs: () => bridge().call('list_jobs') as Promise<import('./types').LibraryJob[]>,
  savePaper: (input:Record<string,unknown>) => bridge().call('save_paper',input) as Promise<Paper>,
  appendNote: (paper_id:string,text:string) => bridge().call('append_note',{paper_id,text}) as Promise<Paper>,
  saveCategory: (input:{id?:string;name:string;parent_id?:string|null}) => bridge().call('save_category',input) as Promise<import('./types').Category>,
  bulkAssign: (input:{paper_ids:string[];category_id?:string;tags:string[]}) => bridge().call('bulk_assign',input),
  setShortNote: (paper_id:string,text:string,expected_updated_at:number) => bridge().call('set_short_note',{paper_id,text,expected_updated_at}),
  refreshCitations: (paper_id:string,force=false) => bridge().call('refresh_citations',{paper_id,force},120000) as Promise<{cached:boolean;citation_count:number;citation_source:string;citation_updated_at:number}>,
  addCategory: (name:string) => bridge().call('add_category',{name}) as Promise<{id:string;name:string}>,
  backup: (action:string) => bridge().backup?bridge().backup!(action):Promise.reject(new Error('需要桌面客户端')),

  aiAction: (action:string,input?:unknown) => {
    if(!bridge().aiAction)return Promise.reject(new Error('此功能需要更新后的桌面客户端'));
    return bridge().aiAction!(action,input);
  },
  aiPreferences: () => bridge().aiAction ? bridge().aiAction!('preferences') as Promise<{provider:string}> : Promise.resolve({provider:'api'}),
  aiStatus: () => bridge().aiAction ? bridge().aiAction!('status') as Promise<AiStatus> : Promise.reject(new Error('此功能需要桌面客户端')),
  aiHistory: (paper_id:string) => bridge().call('ai_history',{paper_id}) as Promise<ChatMessage[]>,
  aiRun: (input:{paper_id:string;question:string;kind:string;version_id?:string;page?:number;scope?:string;include_history?:boolean;request_id:string}) =>
    bridge().aiAction ? bridge().aiAction!('run',input) as Promise<{answer:string;sources:Source[];warnings?:string[]}> :
    (input.kind==='translate'?bridge().call('translate_text',{text:input.question},300000).then(v=>({answer:(v as {text:string}).text,sources:[]})):bridge().call('explain',input,300000) as Promise<{answer:string;sources:Source[];warnings?:string[]}>),
  syncSettings: () => bridge().syncSettings(),
  configureSync: (profile:SyncProfile,auto_minutes:number) => bridge().configureSync({profile,auto_minutes}),
  syncStatus: () => bridge().call('sync_status') as Promise<SyncStatus>,
  syncStart: () => bridge().call('sync_start'),
  syncTest: () => bridge().call('sync_test'),
  syncCancel: () => bridge().call('sync_cancel'),
  syncConflicts: () => bridge().call('sync_conflicts') as Promise<SyncConflict[]>,
  syncResolve: (id:string,choice:'local'|'remote') => bridge().call('sync_resolve',{id,choice}),
  paperPage: (opts: PaperPageOptions) => bridge().call("list_papers_page", opts) as Promise<PaperPage>,
  listPapers: (opts: { query?: string; category?: string; tag?: string; trashed?: boolean; status?: string } = {}) =>
    bridge().call("list_papers", opts) as Promise<Paper[]>,
  getPaper: (id: string) => bridge().call("get_paper", { paper_id: id }) as Promise<Paper>,
  updatePaper: (id: string, fields: Record<string, unknown>) => bridge().call("update_paper", { paper_id: id, fields }) as Promise<Paper>,
  trash: (id: string) => bridge().call("trash_paper", { paper_id: id }),
  restore: (id: string) => bridge().call("restore_paper", { paper_id: id }),
  purge: (id: string) => bridge().call("purge_paper", { paper_id: id }),
  taxonomy: () => bridge().call("list_taxonomy") as Promise<{categories:import('./types').Category[];tags:import('./types').Tag[]}>,
  setCategories: (id: string, ids: string[]) => bridge().call("set_categories", { paper_id: id, category_ids: ids }),
  setTags: (id: string, tags: string[]) => bridge().call("set_tags", { paper_id: id, tags }),
  annotations: (id: string) => bridge().call("list_annotations", { paper_id: id }) as Promise<Annotation[]>,
  addAnnotation: (input: { paper_id: string; page: number; rects: Annotation["rects"]; quote: string; color?: string; comment?: string; version_kind?: Annotation["version_kind"]; version_id?: string }) =>
    bridge().call("add_annotation", input),
  updateAnnotation: (id: string, fields: Record<string, unknown>) => bridge().call("update_annotation", { annotation_id: id, fields }),
  deleteAnnotation: (id: string) => bridge().call("delete_annotation", { annotation_id: id }),
  exportPapers: (ids: string[], format: "bibtex" | "ris") => bridge().call("export", { paper_ids: ids, format }) as Promise<{ text: string }>,
  startTranslate: (id: string, pages?: string) => bridge().call("start_translate", { paper_id: id, pages }) as Promise<{ job_id: string }>,
  cancelJob: (jobId: string) => bridge().call("cancel_job", { job_id: jobId }),
  pdf: (id: string, kind: "source" | "translated", versionId?:string) => bridge().readPdf(id, kind, versionId),
  textStatus: (paper_id:string,version_id:string) => bridge().call("document_text_status",{paper_id,version_id}) as Promise<{indexed_pages:number;pages:number}>,
  setBlocks: (paperId: string, versionId: string, page: number, blocks: { bbox: number[]; text: string;kind?:string }[]) =>
    bridge().call("set_blocks", { paper_id: paperId, version_id: versionId, page, blocks }),
  blocks: (paperId: string, versionId: string, page: number) => bridge().call("blocks", { paper_id: paperId, version_id: versionId, page }) as Promise<Block[]>,
  explain: (input: { paper_id: string; question: string; block_ids?: string[]; page?: number; kind?: string; version_id?:string }) =>
    bridge().call("explain", input, 300000) as Promise<{ answer: string; sources: Source[]; warnings?:string[] }>,
  translateText: (text: string) => bridge().call("translate_text", { text }, 300000) as Promise<{ text: string }>,
  zoteroProbe: (dataDir?:string) => bridge().call("zotero_probe", {data_dir:dataDir}, 60000) as Promise<any>,
  zoteroFiles: (id:string) => bridge().call("zotero_files", {paper_id:id}) as Promise<ImportedAttachment[]>,
  pickDirectory: () => bridge().pickDirectory(),
  revealAttachment: (paperId:string,fileId:string) => bridge().revealAttachment(paperId,fileId),
  zoteroImport: (params: Record<string, unknown>) => bridge().call("zotero_import", params, 10 * 60 * 1000) as Promise<any>,
  zoteroApiImport: (params: Record<string, unknown>) => bridge().call("zotero_api_import", params, 10 * 60 * 1000) as Promise<any>,
  pickPdfs: () => bridge().pickPdfs(),
  saveText: (name: string, text: string) => bridge().saveText(name, text),
  appInfo: () => bridge().appInfo(),
  onEvent: (cb: (msg: JobEvent | { event: 'import_progress'; completed:number; total:number }) => void) => bridge().onEvent(cb as never),
};
