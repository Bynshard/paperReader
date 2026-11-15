const fs = require('node:fs/promises');
const path = require('node:path');

// Actions this module answers.  `pickBabeldoc` needs a native dialog and
// `restart` needs the app lifecycle, so both stay in main.cjs.
const TRANSLATION_SETTINGS_ACTIONS = ['status', 'save', 'test', 'checkBabeldoc'];
const RELOAD_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 25_000;
const BABELDOC_TIMEOUT_MS = 15_000;

function createTranslationSettings({file, safeStorage, env = process.env, call}) {
  let current = {base_url:env.MOONLIGHT_UPSTREAM || '',model:env.MOONLIGHT_MODEL || '',api_key:env.MOONLIGHT_UPSTREAM_KEY || '',babeldoc:env.MOONLIGHT_BABELDOC_BIN || '',qps:Number(env.MOONLIGHT_QPS) || 6};
  let pendingRestart=false, loadError='';
  async function available() {
    if(process.platform==='linux' && !['gnome_libsecret','kwallet','kwallet5','kwallet6'].includes(safeStorage.getSelectedStorageBackend?.())) return false;
    return safeStorage.isAsyncEncryptionAvailable ? safeStorage.isAsyncEncryptionAvailable() : safeStorage.isEncryptionAvailable();
  }
  function summary(){const {api_key,...visible}=current;return {...visible,key_configured:!!api_key,pending_restart:pendingRestart,error:loadError};}
  // Push a freshly saved configuration into the running sidecar so the very
  // next translation/chat request uses it.  A failure is surfaced, never
  // hidden: the settings then keep the old "restart to apply" contract.
  async function applyHotReload(next) {
    if (typeof call !== 'function') return {applied: false, error: ''};
    try {
      const result = await call('reload_gateway', {
        base_url: next.base_url,
        model: next.model,
        api_key: next.api_key,
        qps: next.qps,
        babeldoc: next.babeldoc,
      }, RELOAD_TIMEOUT_MS);
      const applied = !!(result && result.ok);
      return applied ? {applied, error: ''} : {applied, error: String((result && result.error) || 'sidecar 未确认热更新结果')};
    } catch (error) {
      return {applied: false, error: error && error.message ? error.message : String(error)};
    }
  }
  async function runProbe(input){
    if (typeof call !== 'function') throw new Error('sidecar 未连接，无法测试 API 连接');
    const typed = (key) => (input && typeof input[key] === 'string' ? input[key].trim() : '');
    const params = {};
    if (typed('base_url')) params.base_url = typed('base_url');
    if (typed('model')) params.model = typed('model');
    // The saved key never leaves the main process, so an untouched key field
    // simply reuses it for the probe.
    if (typed('api_key')) params.api_key = typed('api_key');
    else if (current.api_key) params.api_key = current.api_key;
    if (!params.base_url && current.base_url) params.base_url = current.base_url;
    if (!params.model && current.model) params.model = current.model;
    if (input && Number.isFinite(Number(input.timeout_ms)) && Number(input.timeout_ms) > 0) params.timeout_ms = Number(input.timeout_ms);
    const result = await call('translation_probe', params, PROBE_TIMEOUT_MS);
    return result && typeof result === 'object' ? result : {ok: false, error: 'sidecar 返回了无法识别的测试结果'};
  }
  async function runBabeldocCheck(input){
    if (typeof call !== 'function') throw new Error('sidecar 未连接，无法检查 BabelDOC');
    const requested = input && typeof input.path === 'string' ? input.path.trim() : '';
    const target = requested || String(current.babeldoc || '').trim();
    const result = await call('check_babeldoc', target ? {path: target} : {}, BABELDOC_TIMEOUT_MS);
    return result && typeof result === 'object' ? result : {ok: false, error: 'sidecar 返回了无法识别的检查结果'};
  }
  const settings = {
    summary,
    environment(){return {
      ...(current.base_url?{MOONLIGHT_UPSTREAM:current.base_url}:{}),
      ...(current.model?{MOONLIGHT_MODEL:current.model}:{}),
      ...(current.api_key?{MOONLIGHT_UPSTREAM_KEY:current.api_key}:{}),
      ...(current.babeldoc?{MOONLIGHT_BABELDOC_BIN:current.babeldoc}:{}),
      MOONLIGHT_QPS:String(current.qps),
    };},
    async load(){
      try {
        const saved=JSON.parse(await fs.readFile(file,'utf8'));
        if(!await available())throw new Error('系统凭据存储不可用，无法读取翻译 API 配置');
        const bytes=Buffer.from(saved.encrypted,'base64');
        const text=safeStorage.decryptStringAsync?(await safeStorage.decryptStringAsync(bytes)).result:safeStorage.decryptString(bytes);
        const parsed=JSON.parse(text);
        if(!parsed||typeof parsed.base_url!=='string'||typeof parsed.model!=='string'||typeof parsed.api_key!=='string'||typeof parsed.babeldoc!=='string'||!Number.isInteger(parsed.qps))throw new Error('invalid configuration');
        current=parsed;
      }catch(e){if(e.code!=='ENOENT')loadError='无法读取翻译 API 配置，请重新保存';}
      return summary();
    },
    async save(input){
      const base_url=String(input.base_url||'').trim().replace(/\/+$/,'');
      let url;try{url=new URL(base_url);}catch{throw new Error('请输入完整的 API Base URL');}
      if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('API 地址必须是 HTTP(S) 地址，不能含账号、查询参数或片段');
      if(/\/chat\/completions$/i.test(url.pathname))throw new Error('请填写 Base URL（通常以 /v1 结尾），不要包含 /chat/completions');
      const model=String(input.model||'').trim();if(!model)throw new Error('请输入模型 ID');
      const api_key=String(input.api_key||'').trim()||(base_url===current.base_url?current.api_key:'');
      if(!api_key)throw new Error('请输入 API Key；更换地址时需要重新填写');
      const qps=Number(input.qps);if(!Number.isInteger(qps)||qps<1||qps>20)throw new Error('翻译 QPS 应为 1–20 的整数');
      const babeldoc=String(input.babeldoc||'').trim();
      if(babeldoc){if(!path.isAbsolute(babeldoc))throw new Error('BabelDOC 路径必须是完整路径');await fs.access(babeldoc);}
      const next={base_url,model,api_key,babeldoc,qps};
      if(!await available())throw new Error('系统凭据存储不可用，未保存 API Key');
      const bytes=safeStorage.encryptStringAsync?await safeStorage.encryptStringAsync(JSON.stringify(next)):safeStorage.encryptString(JSON.stringify(next));
      await fs.mkdir(path.dirname(file),{recursive:true});
      await fs.writeFile(file+'.tmp',JSON.stringify({encrypted:bytes.toString('base64')}),{mode:0o600});
      await fs.rename(file+'.tmp',file);
      current=next;pendingRestart=true;loadError='';
      const reload=await applyHotReload(next);
      if(reload.applied)pendingRestart=false;
      else if(reload.error)loadError=`翻译配置已保存，但立即生效失败：${reload.error}；请重启软件后生效`;
      return summary();
    },
    // Renderer facing diagnostics: a broken connection is a value, not a throw.
    test(input){return runProbe(input);},
    checkBabeldoc(input){return runBabeldocCheck(input);},
    // Single entry point for `translation:action`, so the IPC whitelist and the
    // implementation cannot drift apart.
    async handle(action,input){
      if(!TRANSLATION_SETTINGS_ACTIONS.includes(action))throw new Error('未知翻译配置操作');
      if(action==='status')return summary();
      if(action==='save')return settings.save(input);
      if(action==='test')return runProbe(input);
      return runBabeldocCheck(input);
    },
    actions:()=>[...TRANSLATION_SETTINGS_ACTIONS],
  };
  return settings;
}
module.exports={createTranslationSettings,TRANSLATION_SETTINGS_ACTIONS};
