const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("moonlight", {
  call: (method, params, timeoutMs) => ipcRenderer.invoke("api:call", { method, params, timeoutMs }),
  pickPdfs: () => ipcRenderer.invoke("dialog:pick-pdfs"),
  readPdf: (paperId, kind, versionId) => ipcRenderer.invoke("pdf:bytes", { paperId, kind, versionId }),
  pickDirectory: () => ipcRenderer.invoke("dialog:pick-directory"),
  revealAttachment: (paperId, fileId) => ipcRenderer.invoke("attachment:reveal", { paperId, fileId }),
  syncSettings: () => ipcRenderer.invoke('sync:settings'),
  configureSync: (input) => ipcRenderer.invoke('sync:configure',input),
  saveText: (defaultName, text) => ipcRenderer.invoke("dialog:save-text", { defaultName, text }),
  aiAction: (action, input) => ipcRenderer.invoke("ai:action", {action,input}),
  backup: action => ipcRenderer.invoke("library:backup",action),
  appInfo: () => ipcRenderer.invoke("app:info"),
  onEvent: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on("sidecar:event", handler);
    return () => ipcRenderer.removeListener("sidecar:event", handler);
  },
});
