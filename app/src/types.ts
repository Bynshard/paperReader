export type Version = {
  id: string;
  paper_id: string;
  kind: "source" | "translated";
  sha256: string;
  rel_path: string;
  pages: number;
  bytes: number;
  lang: string;
  engine?: string | null;
  model?: string | null;
  created_at: number;
};

export type Category = { id: string; name: string; color?: string | null };
export type ImportedAttachment = { id:string; title:string; content_type:string; status:"copied"|"linked"|"missing"; version_id?:string|null };
export type SyncProfile = {provider:'qiniu'|'aliyun'|'webdav'|'s3';endpoint:string;bucket:string;region:string;prefix:string;username:string;password?:string;access_key?:string;secret_key?:string;force_path_style:boolean;request_rate?:number};
export type SyncSettings = {profile:SyncProfile|null;credentials_saved:boolean;auto_minutes:number};
export type SyncStatus = {id?:string;configured:boolean;running:boolean;status?:'idle'|'running'|'completed'|'failed'|'cancelled';phase?:string;error?:string;conflicts?:number;report?:{pulled:number;pushed:number;changed_documents:number;uploaded_files:number}};
export type SyncConflict = {id:string;key:string;local:any;remote:any;base:any;paths:string[];created_at:number};

export type Tag = { id: string; name: string; color?: string | null };

export type Paper = {
  id: string;
  title: string;
  authors: string;
  year?: string | null;
  venue?: string | null;
  doi?: string | null;
  arxiv?: string | null;
  abstract?: string | null;
  imported_at: number;
  updated_at: number;
  favorite: boolean;
  read_status: "unread" | "reading" | "read";
  deleted: boolean;
  notes: string;
  categories: Category[];
  tags: Tag[];
  versions: Version[];
};

export type Block = {
  id: string;
  page: number;
  block_index: number;
  kind: string;
  bbox: number[];
  text: string;
};

export type PaperSummary = Omit<Paper, "versions" | "abstract" | "notes"> & { has_translation: boolean };
export type PaperSort = "recent" | "title" | "year";
export type PaperPageOptions = {
  query?: string; category?: string; tag?: string; trashed?: boolean;
  status?: string; favorite?: boolean; sort?: PaperSort; offset?: number; limit?: number;
};
export type PaperPage = { items: PaperSummary[]; total: number; offset: number; limit: number };

export type Annotation = {
  id: string;
  paper_id: string;
  version_kind: "source" | "translated";
  version_id?: string | null;
  page: number;
  rects: { x: number; y: number; w: number; h: number }[];
  quote: string;
  color: string;
  comment: string;
  created_at: number;
};

export type Source = {
  version_id?: string|null;
  n: number;
  block_id: string;
  page: number;
  bbox: number[];
  text: string;
};

export type JobEvent = {
  event: "job";
  jobId: string;
  status?: string;
  phase?: string;
  error?: string | null;
  outputVersionId?: string;
  seq?: number;
};

export type AppInfo = {
  version: string;
  library: string;
  headless: boolean;
  model: string;
  credentialConfigured: boolean;
};

export type PdfBytes = { bytes: Uint8Array; versionId: string; pages: number };

export type LibraryJob={id:string;paper_id:string;status:string;pages?:string;created_at:number;error?:string;output_version_id?:string};
