const fs = require('node:fs/promises');
const path = require('node:path');
function createTranslationSettings({file, safeStorage, env = process.env}) {
  let current = {base_url:env.MOONLIGHT_UPSTREAM || '',model:env.MOONLIGHT_MODEL || '',api_key:env.MOONLIGHT_UPSTREAM_KEY || '',babeldoc:env.MOONLIGHT_BABELDOC_BIN || '',qps:Number(env.MOONLIGHT_QPS) || 6};
  let pendingRestart=false, loadError='';
  async function available() {
    if(process.platform==='linux' && !['gnome_libsecret','kwallet','kwallet5','kwallet6'].includes(safeStorage.getSelectedStorageBackend?.())) return false;
    return safeStorage.isAsyncEncryptionAvailable ? safeStorage.isAsyncEncryptionAvailable() : safeStorage.isEncryptionAvailable();
  }
  function summary(){const {api_key,...visible}=current;return {...visible,key_configured:!!api_key,pending_restart:pendingRestart,error:loadError};}
  return {
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
      current=next;pendingRestart=true;loadError='';return summary();
    },
  };
}
module.exports={createTranslationSettings};
