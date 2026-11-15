import { useEffect, useMemo, useState } from "react";
import { Clock, ExternalLink, RotateCcw, Square, Trash2 } from "lucide-react";
import { api } from "./api";
import type { LibraryJob } from "./types";

const labels: Record<string, string> = { queued: "排队中", preparing: "准备中", parsing: "解析中", translating: "翻译中", typesetting: "排版中", validating: "校验中", cancelling: "正在停止", cancelled: "已停止", completed: "已完成", failed: "失败" };
const activeStatuses = (status: string) => !["completed", "failed", "cancelled"].includes(status);

export default function TaskCenter({ onClose, onOpen }: { onClose: () => void; onOpen: (id: string) => void }) {
  const [jobs, setJobs] = useState<LibraryJob[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = () => api.listJobs().then(setJobs).catch((e) => setError(e.message));
  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 2000);
    const off = api.onEvent((msg) => { if (msg.event === "job") void refresh(); });
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => { clearInterval(timer); off(); window.removeEventListener("keydown", key); };
  }, [onClose]);
  const act = async (job: LibraryJob, retry: boolean) => {
    setBusy(true); setError("");
    try {
      if (retry) await api.startTranslate(job.paper_id, job.pages || undefined, job.source_version_id || undefined);
      else await api.cancelJob(job.id);
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const active = useMemo(() => jobs.filter((job) => activeStatuses(job.status)).length, [jobs]);
  return <div className="modal-backdrop" onClick={onClose}>
    <section className="modal task-center" onClick={(event) => event.stopPropagation()} aria-label="任务中心">
      <header className="modal-head">
        <div><h2>任务中心</h2><p className="muted small">最近 100 条翻译任务{active ? ` · ${active} 个进行中` : ""}。异常退出的任务会标记失败，可在此重试。</p></div>
        <button className="icon-btn" aria-label="关闭任务中心" onClick={onClose}>×</button>
      </header>
      {error && <p className="error-box" role="alert">{error}</p>}
      {!jobs.length && <div className="tag-empty"><Clock size={22} /><p>暂无翻译任务</p></div>}
      <div className="task-list">
        {jobs.map((job) => {
          const running = activeStatuses(job.status);
          const elapsed = job.updated_at ? Math.max(0, Math.round((job.updated_at - job.created_at) / 1000)) : 0;
          return <article className={`task-row ${job.status}`} key={job.id}>
            <div className="task-main">
              <div className="task-title" title={job.title || job.paper_id}>{job.title || `论文 ${job.paper_id}`}</div>
              <div className="task-meta">
                <span className={`task-status ${job.status}`}>{labels[job.status] || job.status}</span>
                <span>{job.pages ? `页码 ${job.pages}` : "全文"}</span>
                <span>{new Date(job.created_at).toLocaleString()}</span>
                {!running && elapsed > 0 && <span>耗时 {elapsed < 60 ? `${elapsed} 秒` : `${Math.round(elapsed / 60)} 分钟`}</span>}
              </div>
            </div>
            <div className="task-actions">
              <button className="btn tiny" onClick={() => onOpen(job.paper_id)}><ExternalLink size={13} />打开论文</button>
              {["failed", "cancelled"].includes(job.status)
                ? <button className="btn tiny" disabled={busy} onClick={() => void act(job, true)}><RotateCcw size={13} />重试</button>
                : running && <button className="btn tiny" disabled={busy || job.status === "cancelling"} onClick={() => void act(job, false)}><Square size={12} />停止</button>}
            </div>
            {job.error && <details className="task-error"><summary>查看错误详情</summary><pre>{job.error}</pre></details>}
          </article>;
        })}
      </div>
      <div className="modal-actions"><button className="btn" onClick={onClose}>关闭任务中心</button></div>
    </section>
  </div>;
}
