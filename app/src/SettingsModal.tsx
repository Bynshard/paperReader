import { useState, type ReactNode } from "react";
import { Cloud, Copy, CopyCheck, DatabaseBackup, Languages, LibraryBig, Sparkles, Tablet, X } from "lucide-react";
import AiSettings from "./AiSettings";
import BackupSettings from "./BackupSettings";
import CloudSync from "./CloudSync";
import DuplicateFinder from "./DuplicateFinder";
import LanPairing from "./LanPairing";
import TranslationSettings from "./TranslationSettings";
import type { AppInfo, Paper } from "./types";

export type TabKey = "general" | "translation" | "ai" | "cloud" | "backup" | "tablet";

/**
 * FEAT-AI-03: JSON snippet users paste into Cursor / Claude Desktop / VS Code.
 * The backend serves MCP over stdio (`moonlight-core --root <library> --mcp`);
 * this helper only builds the client-side configuration.
 */
export function mcpConfigText(library?: string | null): string {
  return JSON.stringify({
    mcpServers: {
      moonlight: { command: "moonlight-core", args: ["--root", library || "<library>", "--mcp"] },
    },
  }, null, 2);
}

/** Clipboard write with the same legacy fallback used by App (LAN / PWA). */
async function copyText(text: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let copied = false;
  try { copied = document.execCommand?.("copy") === true; } finally { area.remove(); }
  if (!copied) throw new Error("当前环境不支持剪贴板");
}

const TABS: { key: TabKey; label: string; icon: ReactNode }[] = [
  { key: "general", label: "通用与论文库", icon: <LibraryBig size={16} /> },
  { key: "translation", label: "翻译引擎", icon: <Languages size={16} /> },
  { key: "ai", label: "AI 阅读助手", icon: <Sparkles size={16} /> },
  { key: "cloud", label: "云同步", icon: <Cloud size={16} /> },
  { key: "backup", label: "备份与恢复", icon: <DatabaseBackup size={16} /> },
  { key: "tablet", label: "平板伴读", icon: <Tablet size={16} /> },
];

export default function SettingsModal({ info, onClose, onChanged, onOpenPaper, initialTab }: { info: AppInfo | null; onClose: () => void; onChanged: () => void; onOpenPaper?: (paper: Paper) => void; /** FEAT-UX-01: open directly on a specific settings pane (defaults to general). */ initialTab?: TabKey }) {
  const [tab, setTab] = useState<TabKey>(initialTab ?? "general");
  const [duplicates, setDuplicates] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const mcpJson = mcpConfigText(info?.library);
  const copyMcp = async () => {
    try { await copyText(mcpJson); setCopyState("copied"); }
    catch { setCopyState("failed"); }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="modal settings-modal" onClick={(event) => event.stopPropagation()} aria-label="设置与状态">
        <header className="modal-head">
          <h2>设置与状态</h2>
          <button className="icon-btn" aria-label="关闭设置" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="settings-body">
          <nav className="settings-nav" aria-label="设置分类">
            {TABS.map((item) => (
              <button key={item.key} className={tab === item.key ? "on" : ""} aria-current={tab === item.key ? "page" : undefined} onClick={() => setTab(item.key)}>
                {item.icon}<span>{item.label}</span>
              </button>
            ))}
          </nav>
          <div className="settings-pane">
            {tab === "general" && (
              <section className="settings-section">
                <h3>通用与论文库</h3>
                <dl>
                  <dt>版本</dt><dd>{info?.version || "—"}</dd>
                  <dt>论文库目录</dt><dd className="mono small">{info?.library || "—"}</dd>
                  <dt>PDF 翻译模型</dt><dd>{info?.model || "—"}</dd>
                  <dt>凭据</dt><dd>{info?.credentialConfigured ? "已配置（仅主进程 / 服务进程可见）" : "未配置 API：可在翻译引擎中填写，或登录 Codex 使用论文问答"}</dd>
                  <dt>离线能力</dt><dd>导入、分类、检索、原文阅读、批注与导出不依赖网络</dd>
                  <dt>升级快照</dt><dd className="mono small">{info?.library ? `${info.library}/backups` : "—"}（结构升级前自动生成，保留最近 5 份）</dd>
                </dl>
                <section className="settings-section">
                  <h3>论文库维护</h3>
                  <p className="muted small">检查同一篇论文的重复下载（按 DOI、arXiv ID 与归一化标题）。</p>
                  <div><button className="btn" onClick={() => setDuplicates(true)}><CopyCheck size={14} />查找重复论文</button></div>
                </section>
                {/* FEAT-AI-03: local MCP server card (backend --mcp is built separately). */}
                <section className="settings-section mcp-card" aria-label="MCP Server">
                  <h3>MCP Server（外部 IDE 联动）</h3>
                  <p className="muted small">在 Cursor / Claude Desktop / VS Code 的 MCP 配置中加入以下片段，即可让外部编程 Agent 通过只读工具检索本地论文库的元数据、笔记与原文证据（需要支持 <span className="mono">--mcp</span> 的 moonlight-core）。</p>
                  <pre className="mcp-json mono small" aria-label="MCP 配置 JSON">{mcpJson}</pre>
                  <div className="row-actions">
                    <button className="btn tiny" aria-label="复制 MCP 配置" onClick={() => void copyMcp()}><Copy size={13} />复制 MCP 配置</button>
                    {copyState === "copied" && <span className="small" role="status">已复制到剪贴板</span>}
                    {copyState === "failed" && <span className="small error-inline" role="alert">复制失败，请手动选择上方文本</span>}
                  </div>
                </section>
              </section>
            )}
            {tab === "translation" && <TranslationSettings />}
            {tab === "ai" && <AiSettings />}
            {tab === "cloud" && <CloudSync onChanged={onChanged} />}
            {tab === "backup" && <BackupSettings />}
            {tab === "tablet" && <LanPairing />}
          </div>
        </div>
        {duplicates && <DuplicateFinder onClose={() => setDuplicates(false)} onOpen={(paper) => { setDuplicates(false); onOpenPaper?.(paper); }} />}
      </section>
    </div>
  );
}
