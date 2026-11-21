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
  importPaths?: (paths: string[]) => Promise<unknown[]>;
  getPathForFile?: (file: File) => string;
  importIdentifier?: (input: string) => Promise<unknown>;
};

declare global {
  interface Window {
    moonlight?: MoonlightBridge;
  }
}

/** localStorage key shared by both storage fallbacks below. */
const LAN_TOKEN_KEY = "moonlight-lan-token";

/**
 * The LAN listener answers `503 server busy` when its thread budget is
 * exhausted (dual-pane PDF Range bursts + SSE).  A transient 503 is retried
 * twice with a short backoff before the tablet shows a failure, so a burst no
 * longer breaks the page (BUG-05 §3).
 */
const RETRY_503_DELAYS_MS = [250, 750] as const;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The pairing token arrives as `?token=…` in the link the desktop shows for
 * the vivo Pad.  Keep it in sessionStorage (primary) + localStorage (so a PWA
 * relaunch still works) and strip it from the address bar so it never ends up
 * in a screenshot, screen recording or shared history entry.
 */
function lanToken(): string {
  if (typeof window === "undefined") return "";
  let token = "";
  try { token = window.sessionStorage.getItem(LAN_TOKEN_KEY) || ""; } catch { /* storage may be blocked */ }
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get("token");
    if (fromUrl) {
      token = fromUrl;
      try {
        window.sessionStorage.setItem(LAN_TOKEN_KEY, fromUrl);
        window.localStorage.setItem(LAN_TOKEN_KEY, fromUrl);
      } catch { /* storage may be blocked */ }
      url.searchParams.delete("token");
      const search = url.searchParams.toString();
      window.history.replaceState(window.history.state, "", `${url.pathname}${search ? `?${search}` : ""}${url.hash}`);
    }
  } catch { /* opaque origin / disabled history */ }
  if (!token) {
    try { token = window.localStorage.getItem(LAN_TOKEN_KEY) || ""; } catch { /* storage may be blocked */ }
  }
  return token;
}

/**
 * Bridge for the LAN/PWA build: the same origin serves the frontend and the
 * `moonlight-core --serve` JSON-RPC/SSE/PDF endpoints, so no Electron preload
 * exists and every call becomes a fetch to `/api/rpc`.  Without this fallback
 * a plain Chrome tab on the tablet used to crash on boot (`window.moonlight`
 * is undefined) instead of showing the library.
 */
export function createHttpBridge(): MoonlightBridge {
  let token = lanToken();
  const requireToken = () => {
    if (!token) token = lanToken();
    if (!token) throw new Error("平板端尚未配对：请用桌面端显示的带 token 链接重新打开");
    return token;
  };
  const call = async <T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> => {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller && timeoutMs && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : 0;
    const send = () => fetch("/api/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${requireToken()}` },
      body: JSON.stringify({ method, params }),
      signal: controller?.signal,
    });
    try {
      let response = await send();
      // 503 means the sidecar hit MAX_CONNECTIONS; it is transient, so retry
      // twice (250 ms, 750 ms) instead of failing the tablet interaction.
      for (let attempt = 0; response.status === 503 && attempt < RETRY_503_DELAYS_MS.length; attempt += 1) {
        await sleep(RETRY_503_DELAYS_MS[attempt]!);
        response = await send();
      }
      if (response.status === 503) throw new Error("局域网服务繁忙（HTTP 503），请稍后重试");
      if (response.status === 401) throw new Error("平板配对已失效：请用桌面端重新生成的链接打开");
      const payload = await response.json().catch(() => null) as { ok?: boolean; result?: T; error?: string } | null;
      if (!payload) throw new Error(`局域网服务返回了无法解析的响应（HTTP ${response.status}）`);
      if (!payload.ok) throw new Error(payload.error || "局域网调用失败");
      return payload.result as T;
    } catch (error) {
      if ((error as { name?: string })?.name === "AbortError") throw new Error(`局域网请求超时：${method}`);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const readPdf = async (paperId: string, kind: string, versionId?: string): Promise<PdfBytes> => {
    const info = await call<{ version_id: string; pages: number }>("paper_pdf", { paper_id: paperId, kind, version_id: versionId });
    // Hand pdf.js a 206-capable URL; the token stays in the query string
    // because <embed>/fetch on a plain URL cannot attach an Authorization
    // header (the server accepts either form).
    return {
      versionId: info.version_id,
      pages: info.pages,
      url: `/api/pdf/${encodeURIComponent(info.version_id)}?token=${encodeURIComponent(requireToken())}`,
    };
  };
  const onEvent: MoonlightBridge["onEvent"] = (cb) => {
    if (typeof EventSource === "undefined") return () => undefined;
    let source: EventSource;
    try {
      source = new EventSource(`/api/events?token=${encodeURIComponent(requireToken())}`);
    } catch {
      return () => undefined;
    }
    const listener = (event: MessageEvent) => {
      try { cb(JSON.parse(event.data)); } catch { /* ignore malformed frame */ }
    };
    source.addEventListener("message", listener as EventListener);
    return () => {
      source.removeEventListener("message", listener as EventListener);
      source.close();
    };
  };
  const saveText = async (defaultName: string, text: string) => {
    // A browser cannot write to an arbitrary path; a download is the closest
    // equivalent and keeps “保存回答/导出” working on the tablet.
    const href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = defaultName || "moonlight.txt";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
    return { saved: true };
  };
  const desktopOnly = (message: string) => () => Promise.reject(new Error(message));
  // The LAN build answers with the same custom API the desktop uses, so the
  // reader's streaming (`request_id` → `ai_delta` SSE) and 停止 button keep
  // working; only provider switching stays desktop-only.
  const aiAction = async (action: string, input?: unknown) => {
    if (action === "preferences") return { provider: "api" };
    if (action === "status") return { provider: "api", model: "", account: null, models: [], loginPending: false };
    if (action === "preview") return call("ai_preview", input as Record<string, unknown>);
    if (action === "cancel") return call("ai_cancel", { request_id: (input as { request_id?: string } | undefined)?.request_id });
    if (action === "run") {
      const request = input as { kind?: string; question?: string } & Record<string, unknown>;
      if (request.kind === "translate") {
        const translated = await call<{ text: string }>("translate_text", { text: request.question }, 300000);
        return { answer: translated.text, sources: [] };
      }
      return call("explain", request, 300000);
    }
    throw new Error("平板端不支持该 AI 设置操作，请在桌面端修改");
  };
  return {
    call: call as MoonlightBridge["call"],
    readPdf,
    onEvent,
    aiAction: aiAction as NonNullable<MoonlightBridge["aiAction"]>,
    appInfo: () => call<AppInfo>("app_info"),
    saveText,
    pickPdfs: desktopOnly("平板端无法打开本机文件选择器，请用桌面端导入 PDF") as MoonlightBridge["pickPdfs"],
    pickDirectory: desktopOnly("平板端无法选择本机目录，请用桌面端操作") as MoonlightBridge["pickDirectory"],
    revealAttachment: desktopOnly("平板端无法在文件管理器中定位附件，请用桌面端操作") as MoonlightBridge["revealAttachment"],
    syncSettings: desktopOnly("平板端不支持云端同步设置，请在桌面端配置") as MoonlightBridge["syncSettings"],
    configureSync: desktopOnly("平板端不支持云端同步设置，请在桌面端配置") as MoonlightBridge["configureSync"],
    translationAction: desktopOnly("请在桌面客户端配置翻译引擎") as NonNullable<MoonlightBridge["translationAction"]>,
    importPaths: desktopOnly("平板端请使用桌面端导入 PDF 文件") as NonNullable<MoonlightBridge["importPaths"]>,
    importIdentifier: desktopOnly("请用桌面端导入 DOI / arXiv") as NonNullable<MoonlightBridge["importIdentifier"]>,
  };
}

let httpBridge: MoonlightBridge | null = null;
/** Desktop = preload bridge; plain browser = same-origin HTTP bridge. */
const bridge = (): MoonlightBridge => {
  if (typeof window !== "undefined" && window.moonlight) return window.moonlight;
  if (!httpBridge) httpBridge = createHttpBridge();
  return httpBridge;
};

export type ChatMessage={id:string;kind:string;question:string;answer:string;sources:Source[];warnings?:string[];model?:string};
export type AiStatus={provider:'api'|'codex';model:string;chat_model?:string;account:{type:string;email:string;plan:string}|null;models:{id:string;name:string;isDefault?:boolean}[];limits?:{primary?:{usedPercent:number;windowDurationMins:number;resetsAt:number};secondary?:{usedPercent:number;windowDurationMins:number;resetsAt:number}};error?:string;loginPending:boolean};
export type TranslationSettings={base_url:string;model:string;babeldoc:string;qps:number;key_configured:boolean;pending_restart:boolean;error?:string};
export type GlossaryTerm={source:string;target:string;domain?:string;enabled?:boolean};
export const api = {
  translationAction: (action:string,input?:unknown) => bridge().translationAction?bridge().translationAction!(action,input):Promise.reject(new Error('请升级桌面客户端以配置翻译 API')),
  listJobs: () => bridge().call('list_jobs') as Promise<import('./types').LibraryJob[]>,
  savePaper: (input:Record<string,unknown>) => bridge().call('save_paper',input) as Promise<Paper>,
  appendNote: (paper_id:string,text:string) => bridge().call('append_note',{paper_id,text}) as Promise<Paper>,
  saveCategory: (input:{id?:string;name:string;parent_id?:string|null}) => bridge().call('save_category',input) as Promise<import('./types').Category>,
  bulkAssign: (input:{paper_ids:string[];category_id?:string;tags:string[]}) => bridge().call('bulk_assign',input),
  bulkUnassign: (input:{paper_ids:string[];category_id?:string;tags:string[]}) => bridge().call('bulk_unassign',input) as Promise<{updated:number;removed:number}>,
  bulkSetStatus: (paper_ids:string[],status:'unread'|'reading'|'read') => bridge().call('bulk_set_status',{paper_ids,status}) as Promise<{updated:number;status:string}>,
  bulkTrash: (paper_ids:string[]) => bridge().call('bulk_trash',{paper_ids}) as Promise<{updated:number}>,
  bulkRestore: (paper_ids:string[]) => bridge().call('bulk_restore',{paper_ids}) as Promise<{updated:number}>,
  bulkPurge: (paper_ids:string[]) => bridge().call('bulk_purge',{paper_ids}) as Promise<{purged:number;failed:{paper_id:string;error:string}[]}>,
  emptyTrash: () => bridge().call('empty_trash',{}) as Promise<{purged:number;failed:{paper_id:string;error:string}[]}>,
  folderDelete: (category_id:string) => bridge().call('folder_delete',{category_id}) as Promise<{ok:boolean;deleted:string;parent_id:string|null;reparented:number;papers_unassigned:number}>,
  folderMove: (category_id:string,parent_id:string|null) => bridge().call('folder_move',{category_id,parent_id}) as Promise<import('./types').Category>,
  folderMerge: (source_id:string,target_id:string) => bridge().call('folder_merge',{source_id,target_id}) as Promise<{ok:boolean;papers_moved:number;reparented:number}>,
  tagRename: (tag_id:string,new_name:string) => bridge().call('tag_rename',{tag_id,new_name}) as Promise<import('./types').Tag>,
  tagSetColor: (tag_id:string,color:string) => bridge().call('tag_set_color',{tag_id,color}) as Promise<import('./types').Tag>,
  tagDelete: (tag_id:string) => bridge().call('tag_delete',{tag_id}) as Promise<{ok:boolean;deleted:string;papers_unassigned:number}>,
  listDuplicates: () => bridge().call('list_duplicates',{}) as Promise<{count:number;groups:{kind:string;key:string;paper_ids:string[];count:number}[]}>,
  refreshMetadata: (paper_id:string,force=false) => bridge().call('refresh_metadata',{paper_id,force},90000) as Promise<Paper & {metadata_source?:string;updated_fields?:string[]}>,
  importPaths: (paths:string[]) => { const desktop = bridge(); return desktop.importPaths ? desktop.importPaths(paths) : Promise.reject(new Error('请升级桌面客户端以支持拖拽导入')); },
  importIdentifier: (input:string) => { const desktop = bridge(); return desktop.importIdentifier ? desktop.importIdentifier(input) : Promise.reject(new Error('请升级桌面客户端以支持 DOI / arXiv 导入')); },
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
  aiDelete: (chat_id:string) => bridge().call('ai_delete',{chat_id}) as Promise<{deleted:number}>,
  aiClear: (paper_id:string) => bridge().call('ai_clear',{paper_id}) as Promise<{deleted:number}>,
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
  // Cross-device reading position (Schema v3). `page` is zero-based, `fraction`
  // is [0, 1] and `mode` is one of source|translated|dual (backend also accepts
  // paper-code). Deliberately fire-and-forget: turning a page must never block
  // the reader UI, and the backend never touches `papers.updated_at` for it.
  setReadingPosition: (paper_id: string, page: number, fraction: number, mode: string) =>
    bridge().call("set_reading_position", { paper_id, page, fraction, mode }) as Promise<{ ok: boolean }>,
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
  exportPapers: (ids: string[], format: "bibtex" | "ris" | "gbt7714" | "apa") => bridge().call("export", { paper_ids: ids, format }) as Promise<{ text: string }>,
  /** Batch E: merge duplicate paper rows without losing versions/annotations. */
  mergePapers: (primary_id: string, secondary_ids: string[]) =>
    bridge().call("merge_papers", { primary_id, secondary_ids }, 120000) as Promise<{ merged: number; primary?: Paper }>,
  /** Batch E: metadata-only import from .bib / .ris text. */
  importBibliography: (format: "bibtex" | "ris", text: string) =>
    bridge().call("import_bibliography", { format, text }, 120000) as Promise<{ imported: number; duplicates: number; failed: number; errors?: string[] }>,
  /** Batch E: custom terminology glossary. */
  glossary: () => bridge().call("list_glossary", {}) as Promise<{ terms: GlossaryTerm[] }>,
  saveGlossary: (terms: GlossaryTerm[]) => bridge().call("save_glossary", { terms }) as Promise<{ ok: boolean; count: number }>,
  /** Batch F: verify a claim against the paper's evidence. */
  claimVerify: (paper_id: string, claim: string, version_id?: string) =>
    bridge().call("claim_verify", { paper_id, claim, version_id }, 300000) as Promise<{ verdict: "supported" | "conditional" | "unsupported"; answer: string; sources: Source[] }>,
  /** Batch F: cross-paper comparison matrix (backend aggregates evidence + model). */
  synthesisMatrix: (paper_ids: string[], dimensions?: string[]) =>
    bridge().call("synthesis_matrix", { paper_ids, dimensions }, 600000) as Promise<{ dimensions: string[]; rows: { paper_id: string; title: string; cells: Record<string, { text: string; page?: number; version_id?: string }> }[] }>,
  /** Batch F: AI organize plan (preview only; applying uses existing bulk APIs). */
  organizePlan: (paper_ids: string[], goal: string) =>
    bridge().call("organize_plan", { paper_ids, goal }, 300000) as Promise<{ plan: { paper_id: string; title: string; before: unknown; after: unknown; reason: string }[] }>,
  startTranslate: (id: string, pages?: string, versionId?: string) => bridge().call("start_translate", { paper_id: id, pages, version_id: versionId }) as Promise<{ job_id: string }>,
  cancelJob: (jobId: string) => bridge().call("cancel_job", { job_id: jobId }),
  pdf: (id: string, kind: "source" | "translated", versionId?:string) => bridge().readPdf(id, kind, versionId),
  textStatus: (paper_id:string,version_id:string) => bridge().call("document_text_status",{paper_id,version_id}) as Promise<{indexed_pages:number;pages:number}>,
  searchBlocks: (paper_id:string,query:string,limit=20) => bridge().call("search_blocks",{paper_id,query,limit}) as Promise<Block[]>,
  setBlocks: (paperId: string, versionId: string, page: number, blocks: { bbox: number[]; text: string;kind?:string }[]) =>
    bridge().call("set_blocks", { paper_id: paperId, version_id: versionId, page, blocks }),
  blocks: (paperId: string, versionId: string, page: number) => bridge().call("blocks", { paper_id: paperId, version_id: versionId, page }) as Promise<Block[]>,
  explain: (input: { paper_id: string; question: string; block_ids?: string[]; page?: number; kind?: string; version_id?:string }) =>
    bridge().call("explain", input, 300000) as Promise<{ answer: string; sources: Source[]; warnings?:string[] }>,
  /** In-reader look-up: answers without appending to the persistent chat log. */
  quickExplain: (input: { paper_id: string; question: string; page?: number; version_id?: string; request_id?: string; scope?: string; kind?: string; include_history?: boolean; image_data_url?: string }) => {
    const desktop = bridge();
    // Prefer aiAction so Codex users get the quick bubble too and the desktop
    // AI service applies its provider-specific checks (e.g. vision requires API).
    if (desktop.aiAction) return desktop.aiAction("run", { ...input, kind: input.kind ?? "explain", ephemeral: true }) as Promise<{ answer: string; sources: Source[]; warnings?: string[] }>;
    return desktop.call("explain", { ...input, ephemeral: true }, 300000) as Promise<{ answer: string; sources: Source[]; warnings?: string[] }>;
  },
  /** Generate (or read the cached) one-page structured digest. */
  aiDigest: (paper_id: string, version_id?: string, force = false) =>
    bridge().call("ai_digest", { paper_id, version_id, force }, 300000) as Promise<{ markdown: string; generated_at: number; model?: string | null; version_id?: string | null }>,
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
