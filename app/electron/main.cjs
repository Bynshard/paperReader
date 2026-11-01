/**
 * Moonlight desktop main process.
 *
 * Security model:
 *  - renderer has no Node integration, is sandboxed and context-isolated;
 *  - the preload exposes a tiny, explicit API (no generic fs/child_process);
 *  - every file path is resolved by the Python sidecar from a paper/version id;
 *  - saved model credentials stay in encrypted app settings and the sidecar
 *    environment; the renderer receives only a configured flag;
 *  - external navigation and new windows are denied.
 */
const { app, BrowserWindow, ipcMain, dialog, shell, session, safeStorage, protocol, net } = require("electron");
const { createAiService } = require('./ai-service.cjs');
const { createTranslationSettings } = require('./translation-settings.cjs');
const { createSyncSettings } = require('./sync-settings.cjs');
const { importBatches } = require('./import-batches.cjs');
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const readline = require("node:readline");
const {pathToFileURL} = require('node:url');
protocol.registerSchemesAsPrivileged([{scheme:'moonlight-ocr',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);

if(process.env.MOONLIGHT_USER_DATA){const profile=path.resolve(process.env.MOONLIGHT_USER_DATA);fs.mkdirSync(profile,{recursive:true});app.setPath('userData',profile);}

let win = null;
let sidecar = null;
let seq = 0;
let syncSettings;
let translationSettings;
let aiService;
let libraryOverride=null;
const pending = new Map();

function projectRoot() {
  return app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "..", "..");
}

function pythonPath() {
  if (process.env.MOONLIGHT_PYTHON) return process.env.MOONLIGHT_PYTHON;
  const candidates = [
    path.join(projectRoot(), ".venv", "bin", "python"),
    path.join(projectRoot(), ".venv", "Scripts", "python.exe"),
  ];
  return candidates.find((p) => fs.existsSync(p)) || "python3";
}

function libraryRoot() {
  return libraryOverride || process.env.MOONLIGHT_LIBRARY || path.join(app.getPath("userData"), "library");
}

function startSidecar() {
  const root = libraryRoot();
  fs.mkdirSync(root, { recursive: true });
  const rustBin = app.isPackaged ? path.join(process.resourcesPath,"bin",process.platform==="win32"?"moonlight-core.exe":"moonlight-core") : path.join(projectRoot(), "core", "target", "release", "moonlight-core");
  if(app.isPackaged&&!fs.existsSync(rustBin))throw new Error("安装包缺少原生服务，请重新安装");
  const useRust = fs.existsSync(rustBin) && (app.isPackaged || process.env.MOONLIGHT_BACKEND !== "python");
  const cmd = useRust ? rustBin : pythonPath();
  const args = useRust ? ["--root", root] : ["-m", "moonlight.desktop", "--root", root];
  let readyResolve,readyReject;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const readyTimer=setTimeout(()=>{readyReject(new Error('sidecar did not become ready'));sidecar?.kill();},60000);
  sidecar = spawn(cmd, args, {
    cwd: projectRoot(),
    env: {
      ...process.env,
      MOONLIGHT_ROOT:projectRoot(),
      ...(app.isPackaged?{MOONLIGHT_RCLONE:path.join(process.resourcesPath,'bin',process.platform==='win32'?'rclone.exe':'rclone')}:{}),
      PYTHONUNBUFFERED: "1",
      PYTHONPATH: projectRoot(),
    },
    windowsHide:true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rl = readline.createInterface({ input: sidecar.stdout });
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.event === "ready") {clearTimeout(readyTimer);readyResolve();}
    if (msg.event) {
      if (win && !win.isDestroyed()) win.webContents.send("sidecar:event", msg);
      return;
    }
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || "sidecar error"));
    }
  });
  sidecar.stderr.on("data", (d) => {
    console.error("[sidecar]", d.toString().trim().slice(0, 4000));
  });
  sidecar.stdin.on("error",()=>{});
  sidecar.on("error",error=>{clearTimeout(readyTimer);readyReject(error);});
  sidecar.on("exit", (code) => {
    clearTimeout(readyTimer);readyReject(new Error("sidecar exited before ready: "+code));
    for (const [, p] of pending) {clearTimeout(p.timer);p.reject(new Error("sidecar exited with code " + code));}
    pending.clear();
    sidecar = null;
  });
  return ready;
}

function callSidecar(method, params = {}, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    if (!sidecar) return reject(new Error("sidecar is not running"));
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`sidecar timeout: ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    sidecar.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#f6f4ef",
    title: "Moonlight",
    show: !process.env.MOONLIGHT_HEADLESS,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.on("closed", () => {
    win = null;
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  return win;
}

const ownsInstance=app.requestSingleInstanceLock();
if(!ownsInstance)app.quit();
app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.focus();}});
app.whenReady().then(async () => {
  if(!ownsInstance)return;
  protocol.handle('moonlight-ocr',async request=>{
    const url=new URL(request.url),name=url.pathname.slice(1);
    if(request.method!=='GET'||url.hostname!=='assets'||!(/^(?:worker\.min\.js|tesseract-core[a-z-]*\.wasm(?:\.js)?|(?:eng|chi_sim)\.traineddata\.gz)$/.test(name)))return new Response('Not found',{status:404});
    const root=app.isPackaged?path.join(app.getAppPath(),'dist/ocr'):path.join(projectRoot(),'app/public/ocr');
    const response=await net.fetch(pathToFileURL(path.join(root,name)).href);
    return new Response(response.body,{status:response.status,headers:{'Access-Control-Allow-Origin':'*','Content-Type':name.endsWith('.js')?'text/javascript':name.endsWith('.wasm')?'application/wasm':'application/octet-stream'}});
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  app.on("web-contents-created", (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (!url.startsWith("file://") && !url.startsWith("http://127.0.0.1:5199")) event.preventDefault();
    });
  });
  try {
    const location=path.join(app.getPath('userData'),'library-location.json');
    if(fs.existsSync(location)){const saved=JSON.parse(fs.readFileSync(location,'utf8'));if(typeof saved.path!=='string'||!fs.existsSync(path.join(saved.path,'library.db')))throw new Error('已选择的论文库不可用，请恢复目录后重试');libraryOverride=saved.path;}
    translationSettings=createTranslationSettings({file:path.join(app.getPath('userData'),'translation-credentials.json'),safeStorage});
    await translationSettings.load();
    Object.assign(process.env,translationSettings.environment());
    await startSidecar();
  } catch (err) {
    dialog.showErrorBox("Moonlight 启动失败", String(err && err.message ? err.message : err));
    app.exit(1);return;
  }
  ipcMain.handle("api:call", async (_e, { method, params, timeoutMs }) => callSidecar(method, params, timeoutMs));
  syncSettings=createSyncSettings({file:path.join(app.getPath('userData'),'sync-credentials.json'),safeStorage,call:callSidecar});
  await syncSettings.load();
  ipcMain.handle('translation:action',async(_e,{action,input})=>{
    if(action==='status')return translationSettings.summary();
    if(action==='save')return translationSettings.save(input);
    if(action==='pickBabeldoc'){
      const choice=await dialog.showOpenDialog(win,{title:'选择 BabelDOC 可执行文件',properties:['openFile'],...(process.platform==='win32'?{filters:[{name:'BabelDOC',extensions:['exe']}]}:{})});
      return choice.canceled?null:choice.filePaths[0];
    }
    if(action==='restart'){
      const jobs=await callSidecar('list_jobs');
      const sync=await callSidecar('sync_status');
      if(jobs.some(j=>!['completed','failed','cancelled'].includes(j.status))||sync.running||aiService?.isBusy()||pending.size)throw new Error('请等待导入、翻译、问答和同步任务结束后再重启');
      setTimeout(()=>{app.relaunch();app.quit();},500);return {restarting:true};
    }
    throw new Error('未知翻译配置操作');
  });
  ipcMain.handle('sync:settings',()=>syncSettings.summary());
  ipcMain.handle('sync:configure',(_e,input)=>syncSettings.save(input));
  ipcMain.handle("dialog:pick-pdfs", async () => {
    const res = await dialog.showOpenDialog(win, {
      title: "导入论文 PDF",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (res.canceled) return [];
    return importBatches(res.filePaths, callSidecar, (progress) => {
      if (win && !win.isDestroyed()) win.webContents.send('sidecar:event', {event:'import_progress', ...progress});
    });
  });
  ipcMain.handle("dialog:pick-directory", async () => {
    const res = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
    return res.canceled ? null : res.filePaths[0];
  });
  ipcMain.handle("attachment:reveal", async (_e, {paperId, fileId}) => {
    const info = await callSidecar("zotero_attachment_path", {paper_id:paperId,file_id:fileId});
    shell.showItemInFolder(info.path);
  });
  ipcMain.handle("pdf:bytes", async (_e, { paperId, kind, versionId }) => {
    const info = await callSidecar("paper_pdf", { paper_id: paperId, kind, version_id:versionId });
    const data = await fs.promises.readFile(info.path);
    return { bytes: new Uint8Array(data), versionId: info.version_id, pages: info.pages };
  });
  ipcMain.handle("dialog:save-text", async (_e, { defaultName, text }) => {
    const res = await dialog.showSaveDialog(win, { defaultPath: defaultName });
    if (res.canceled || !res.filePath) return { saved: false };
    fs.writeFileSync(res.filePath, text, "utf8");
    return { saved: true, path: res.filePath };
  });
  ipcMain.handle("app:info", async () => ({
    version: app.getVersion(),
    library: libraryRoot(),
    headless: !!process.env.MOONLIGHT_HEADLESS,
    model: process.env.MOONLIGHT_MODEL || "qwen3.8-flash",
    credentialConfigured: !!process.env.MOONLIGHT_UPSTREAM_KEY,
  }));
  aiService=createAiService({directory:app.getPath('userData'),codexBinary:app.isPackaged&&process.platform==='win32'?path.join(process.resourcesPath,'bin','codex-app-server.exe'):undefined,call:callSidecar,openExternal:url=>shell.openExternal(url),emit:msg=>{
    if(win&&!win.isDestroyed())win.webContents.send('sidecar:event',msg);
  }});
  await aiService.load();
  ipcMain.handle('ai:action',(_e,{action,input})=>{
    if(!['preferences','preview','status','configure','login','cancelLogin','logout','run','cancel'].includes(action))throw new Error('Unknown AI action');
    return aiService[action](input);
  });
  ipcMain.handle('library:backup',async(_e,action)=>{
    if(!['create','restore'].includes(action))throw new Error('无效备份操作');
    if(action==='create'){
      const choice=await dialog.showOpenDialog(win,{title:'选择备份存放目录',properties:['openDirectory','createDirectory']});
      return choice.canceled?{cancelled:true}:callSidecar('backup_create',{parent:choice.filePaths[0]},30*60*1000);
    }
    const source=await dialog.showOpenDialog(win,{title:'选择含 manifest.json 的备份目录',properties:['openDirectory']});
    if(source.canceled)return {cancelled:true};
    const target=await dialog.showOpenDialog(win,{title:'选择恢复位置（将创建新目录，保留原库）',properties:['openDirectory','createDirectory']});
    if(target.canceled)return {cancelled:true};
    const result=await callSidecar('backup_restore',{source:source.filePaths[0],parent:target.filePaths[0]},30*60*1000);
    const location=path.join(app.getPath('userData'),'library-location.json');
    await fs.promises.writeFile(location+'.tmp',JSON.stringify({path:result.path}),{mode:0o600});await fs.promises.rename(location+'.tmp',location);
    setTimeout(()=>{app.relaunch();app.quit();},500);return result;
  });
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
let shuttingDown=false;
app.on("before-quit",event=>{
  if(shuttingDown)return;
  event.preventDefault();shuttingDown=true;
  aiService?.stop();syncSettings?.stop();
  const child=sidecar;
  (async()=>{
    if(child){
      await Promise.allSettled([callSidecar('shutdown',{},2000),callSidecar('sync_cancel',{},2000)]);
      child.stdin.end();
      await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();resolve();},5000);child.once('exit',()=>{clearTimeout(timer);resolve();});if(child.exitCode!==null){clearTimeout(timer);resolve();}});
    }
    app.quit();
  })().catch(()=>{child?.kill();app.quit();});
});
