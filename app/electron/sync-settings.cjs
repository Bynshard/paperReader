const fs = require('node:fs/promises');
const path = require('node:path');

const secrets = ['password', 'access_key', 'secret_key'];
function publicProfile(profile) {
  if (!profile) return null;
  const result = {...profile};
  for (const key of secrets) delete result[key];
  return result;
}

function createSyncSettings({file, safeStorage, call}) {
  let profile = null;
  let saved = false;
  let autoMinutes = 0;
  let timer;
  function schedule() {
    clearInterval(timer);
    if (profile && autoMinutes) {
      timer = setInterval(async () => {
        try { const state=await call('sync_status'); if (!state.running) await call('sync_start'); } catch {}
      }, autoMinutes * 60_000);
      timer.unref?.();
    }
  }
  function summary() {return {profile:publicProfile(profile),credentials_saved:saved,auto_minutes:autoMinutes};}
  async function available() {
    if (process.platform==='linux' && !['gnome_libsecret','kwallet','kwallet5','kwallet6'].includes(safeStorage.getSelectedStorageBackend?.())) return false;
    return safeStorage.isAsyncEncryptionAvailable ? safeStorage.isAsyncEncryptionAvailable() : safeStorage.isEncryptionAvailable();
  }
  return {
    summary,
    async load() {
      try {
        const settings = JSON.parse(await fs.readFile(file,'utf8'));
        autoMinutes = settings.auto_minutes || 0;
        if (!settings.encrypted || !await available()) return summary();
        const bytes = Buffer.from(settings.encrypted,'base64');
        const decrypted = safeStorage.decryptStringAsync ? (await safeStorage.decryptStringAsync(bytes)).result : safeStorage.decryptString(bytes);
        const loaded = JSON.parse(decrypted);
        await call('sync_configure',loaded);
        profile=loaded;saved=true;schedule();
      } catch { /* Missing or unavailable keychain: ask for credentials in settings. */ }
      return summary();
    },
    async save(input) {
      const next = {...input.profile};
      // Blank inputs retain saved credentials only for the same service/account.
      const same = profile && ['provider','endpoint','bucket','username'].every((key)=>(next[key]||'')===(profile[key]||''));
      if (same) for(const key of secrets) if(!next[key]) next[key]=profile[key] || '';
      await call('sync_configure',next);
      const minutes = Number(input.auto_minutes || 0);
      autoMinutes=Number.isFinite(minutes) && minutes>=5 ? Math.min(1440,minutes) : 0;
      profile=next;saved=false;
      let encrypted=null;
      if(await available()) {
        const text=JSON.stringify(profile);
        const bytes=safeStorage.encryptStringAsync ? await safeStorage.encryptStringAsync(text) : safeStorage.encryptString(text);
        encrypted=bytes.toString('base64');saved=true;
      }
      // Never fall back to plaintext or rclone's reversible "obscure" storage.
      await fs.mkdir(path.dirname(file),{recursive:true});
      const temporary=file+'.tmp';
      await fs.writeFile(temporary,JSON.stringify({encrypted,auto_minutes:autoMinutes}),{mode:0o600});
      await fs.rename(temporary,file);
      schedule();return summary();
    },
    stop() {clearInterval(timer);},
  };
}
module.exports={createSyncSettings,publicProfile};
