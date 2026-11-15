import { useMemo, useState } from "react";
import { Merge, Trash2 } from "lucide-react";
import { api } from "./api";
import type { Category } from "./types";
import { folderRows, canParent } from "./folders";

export default function FolderManager({ items, onChanged, onClose }: { items: Category[]; onChanged: () => Promise<void>; onClose: () => void }) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [mergeTarget, setMergeTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const rows = useMemo(() => folderRows(items), [items]);
  const select = (value: string) => {
    setId(value);
    const item = items.find((category) => category.id === value);
    setName(item?.name || "");
    setParent(item?.parent_id || "");
    setMergeTarget("");
    setError(""); setMessage("");
  };
  const run = async (action: () => Promise<string | void>, done: string) => {
    setBusy(true); setError("");
    try { const detail = await action(); await onChanged(); setMessage(detail || done); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setError("");
    try {
      const saved = await api.saveCategory({ id: id || undefined, name, parent_id: parent || null });
      await onChanged();
      setId(saved.id);
      setMessage("目录已保存");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const remove = () => {
    if (!id) return;
    const item = items.find((category) => category.id === id);
    if (!confirm(`删除目录「${item?.name || name}」？论文不会被删除，子目录会提升到上一级。`)) return;
    void run(async () => {
      const result = await api.folderDelete(id);
      setId(""); setName(""); setParent("");
      return `目录已删除，${result.reparented} 个子目录已提升，${result.papers_unassigned} 篇论文解除关联`;
    }, "目录已删除");
  };
  const merge = () => {
    if (!id || !mergeTarget) return;
    if (!confirm("把当前目录的论文与子目录合并到目标目录后删除当前目录？")) return;
    void run(async () => {
      const result = await api.folderMerge(id, mergeTarget);
      setId(""); setName(""); setParent(""); setMergeTarget("");
      return `已合并：移动 ${result.papers_moved} 篇论文，提升 ${result.reparented} 个子目录`;
    }, "目录已合并");
  };

  return <div className="modal-backdrop" onClick={onClose}>
    <form className="modal folder-manager" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <header className="modal-head">
        <div><h2>管理论文目录</h2><p className="muted small">目录可分层，一篇论文可以属于多个目录。父目录会包含子目录的论文。</p></div>
        <button type="button" className="icon-btn" aria-label="关闭目录管理" onClick={onClose}>×</button>
      </header>
      <label>选择操作<select aria-label="编辑目录" value={id} disabled={busy} onChange={(event) => select(event.target.value)}><option value="">新建目录</option>{rows.map((row) => <option key={row.id} value={row.id}>{row.path}</option>)}</select></label>
      <label>目录名称<input aria-label="目录名称" disabled={busy} required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>上级目录<select aria-label="上级目录" disabled={busy} value={parent} onChange={(event) => setParent(event.target.value)}><option value="">顶层目录</option>{rows.filter((row) => canParent(items, row.id, id)).map((row) => <option key={row.id} value={row.id}>{row.path}</option>)}</select></label>

      {id && <fieldset className="pill-field">
        <legend>目录整理</legend>
        <div className="folder-tools">
          <label className="inline-label">合并到
            <select aria-label="合并目标目录" disabled={busy} value={mergeTarget} onChange={(event) => setMergeTarget(event.target.value)}>
              <option value="">选择目标目录</option>
              {rows.filter((row) => row.id !== id).map((row) => <option key={row.id} value={row.id}>{row.path}</option>)}
            </select>
          </label>
          <button type="button" className="btn tiny" disabled={busy || !mergeTarget} onClick={merge}><Merge size={13} />合并目录</button>
          <button type="button" className="btn tiny danger" disabled={busy} onClick={remove}><Trash2 size={13} />删除目录</button>
        </div>
        <p className="muted small">删除与合并都不会删除论文，只调整目录关系。</p>
      </fieldset>}

      {error && <p className="error-box" role="alert">{error}</p>}
      {message && <p className="report-box" role="status">{message}</p>}
      <div className="modal-actions">
        <button type="button" className="btn" disabled={busy} onClick={onClose}>关闭</button>
        <button className="btn primary" disabled={busy || !name.trim()}>{id ? "保存目录" : "新建目录"}</button>
      </div>
    </form>
  </div>;
}
