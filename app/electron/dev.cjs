// Keep Vite and Electron lifecycle together; no shell or string interpolation.
const { spawn } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1'], { cwd: root, stdio: 'inherit' });
let desktop;
let stopped = false;
function stop() { if (stopped) return; stopped = true; desktop?.kill(); vite.kill(); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
vite.on('exit', stop);
(async () => {
  for (let attempt=0;attempt<100 && !stopped;attempt++) {
    try { const response=await fetch('http://127.0.0.1:5199'); if(response.ok) break; } catch {}
    if(attempt===99) throw new Error('Vite did not become ready');
    await new Promise((resolve)=>setTimeout(resolve,100));
  }
  if(stopped) return;
  desktop=spawn(require('electron'), ['.'], {cwd:root,stdio:'inherit',env:{...process.env,VITE_DEV_SERVER_URL:'http://127.0.0.1:5199'}});
  desktop.on('exit',stop);desktop.on('error',(error)=>{console.error(error.message);stop();});
})().catch((error)=>{console.error(error.message);stop();process.exitCode=1;});
