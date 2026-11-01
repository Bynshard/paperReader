import { useEffect, useState } from 'react';
import { api } from './api';
import type { SyncProfile,SyncSettings,SyncStatus,SyncConflict } from './types';

const initial:SyncProfile={provider:'webdav',endpoint:'https://dav.jianguoyun.com/dav/',bucket:'',region:'',prefix:'Moonlight',username:'',force_path_style:false};
const providers={webdav:'坚果云 / WebDAV',qiniu:'七牛云 Kodo',aliyun:'阿里云 OSS',s3:'其他 S3 兼容存储'};
function preview(value:any,paths:string[]) {
  if (value===null) return '已删除';
  if(value?.paper && paths.length) {
    const labels:Record<string,string>={notes:'笔记',title:'标题',comment:'批注评论',color:'批注颜色',favorite:'星标',read_status:'阅读状态'};
    return paths.map((pointer)=>{
      const keys=pointer.split('/').slice(1).map((s)=>s.replace(/~1/g,'/').replace(/~0/g,'~'));
      let field=value;for(const key of keys) field=field?.[key];
      const name=labels[keys.at(-1) || ''] || (keys[0]==='annotations'?'批注':'论文');
      const text=field===null || field===undefined?'已删除':typeof field==='string'?field:JSON.stringify(field,null,2);
      return `${name}：${text}`;
    }).join('\n');
  }
  return JSON.stringify(value,null,2);
}
export default function CloudSync({onChanged}:{onChanged:()=>void}) {
  const [profile,setProfile]=useState<SyncProfile>(initial);
  const [settings,setSettings]=useState<SyncSettings|null>(null);
  const [state,setState]=useState<SyncStatus|null>(null);
  const [auto,setAuto]=useState(false);
  const [busy,setBusy]=useState(false);
  const [dirty,setDirty]=useState(false);
  const [error,setError]=useState('');
  const [conflicts,setConflicts]=useState<SyncConflict[]>([]);
  useEffect(()=>{let active=true;
    api.syncSettings().then((data)=>{if(active){setSettings(data);if(data.profile)setProfile({...initial,...data.profile});setAuto(!!data.auto_minutes);}}).catch((e)=>{if(active)setError(String(e));});
    return()=>{active=false;};
  },[]);
  useEffect(()=>{let active=true;let running=false;
    const poll=async()=>{try{const next=await api.syncStatus();if(active){setState(next);if(running && !next.running){onChanged();if(next.conflicts)setConflicts(await api.syncConflicts());}running=next.running;}}catch(e){if(active)setError(String(e));}};
    void poll();const timer=setInterval(poll,1000);return()=>{active=false;clearInterval(timer);};
  },[onChanged]);
  const update=(field:keyof SyncProfile,value:string|boolean|number)=>{setProfile((p)=>({...p,[field]:value}));setDirty(true);};
  const changeProvider=(provider:SyncProfile['provider'])=>{
    setProfile({...initial,provider,endpoint:provider==='webdav'?initial.endpoint:provider==='qiniu'?'https://s3.cn-east-1.qiniucs.com':provider==='aliyun'?'https://oss-cn-hangzhou.aliyuncs.com':'',region:provider==='qiniu'?'cn-east-1':''});setDirty(true);
  };
  const action=async(kind:'save'|'test'|'sync')=>{setBusy(true);setError('');try{
    const saved=await api.configureSync(profile,auto?15:0);setSettings(saved);setProfile({...profile,password:'',access_key:'',secret_key:''});setDirty(false);
    if(kind==='test')await api.syncTest();if(kind==='sync')await api.syncStart();setState(await api.syncStatus());
  }catch(e){setError(String(e));}finally{setBusy(false);}};
  const disabled=busy || state?.running;
  const resolve=async(conflict:SyncConflict,choice:'local'|'remote')=>{setBusy(true);try{await api.syncResolve(conflict.id,choice);setConflicts(await api.syncConflicts());setState(await api.syncStatus());onChanged();}catch(e){setError(String(e));}finally{setBusy(false);}};
  return <section className="cloud-sync"><h3>云同步</h3>
    <p className="muted small">同步论文、原译文、笔记、批注和附件。多端使用相同的存储桶或 WebDAV 目录。</p>
    <label>服务<select aria-label="同步服务" value={profile.provider} disabled={disabled} onChange={(e)=>changeProvider(e.target.value as SyncProfile['provider'])}>{Object.entries(providers).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>
    <label>服务地址<input aria-label="同步服务地址" value={profile.endpoint} disabled={disabled} onChange={(e)=>update('endpoint',e.target.value)}/></label>
    {profile.provider==='webdav'?<>
      <label>用户名<input aria-label="WebDAV 用户名" autoComplete="off" value={profile.username} disabled={disabled} onChange={(e)=>update('username',e.target.value)}/></label>
      <label>应用密码<input aria-label="WebDAV 应用密码" type="password" autoComplete="new-password" value={profile.password || ''} disabled={disabled} placeholder={settings?.profile?'留空沿用本机已配置凭据':''} onChange={(e)=>update('password',e.target.value)}/></label>
      <p className="muted small">坚果云请填写“第三方应用管理”生成的应用密码。</p>
      <label>请求速度<select aria-label="WebDAV 请求速度" value={profile.request_rate===undefined?'auto':String(profile.request_rate)} disabled={disabled} onChange={(e)=>{setProfile((p)=>({...p,request_rate:e.target.value==='auto'?undefined:Number(e.target.value)}));setDirty(true);}}>
        <option value="auto">自动（坚果云采用保守限速）</option><option value="0.2">慢速：每秒 0.2 次</option><option value="0.6">较快：每秒 0.6 次</option><option value="0">不限速，按服务商额度使用</option>
      </select></label>
    </>:<>
      <label>存储桶<input aria-label="同步存储桶" value={profile.bucket} disabled={disabled} onChange={(e)=>update('bucket',e.target.value)}/></label>
      <label>区域（按服务商要求，可留空）<input aria-label="存储区域" value={profile.region} disabled={disabled} onChange={(e)=>update('region',e.target.value)}/></label>
      <label>AccessKey<input aria-label="同步 AccessKey" type="password" autoComplete="new-password" value={profile.access_key || ''} disabled={disabled} onChange={(e)=>update('access_key',e.target.value)}/></label>
      <label>SecretKey<input aria-label="同步 SecretKey" type="password" autoComplete="new-password" value={profile.secret_key || ''} disabled={disabled} onChange={(e)=>update('secret_key',e.target.value)}/></label>
      <label className="sync-check"><input type="checkbox" checked={profile.force_path_style} disabled={disabled} onChange={(e)=>update('force_path_style',e.target.checked)}/>使用路径式桶地址</label>
    </>}
    <label>同步文件夹<input aria-label="同步文件夹" value={profile.prefix} disabled={disabled} onChange={(e)=>update('prefix',e.target.value)}/></label>
    <label className="sync-check"><input type="checkbox" checked={auto} disabled={disabled} onChange={(e)=>{setAuto(e.target.checked);setDirty(true);}}/>应用运行时每 15 分钟同步</label>
    <p className="muted small">外链附件会复制到本地库后同步。首次同步可能较久，后续只传变化内容。</p>
    {settings && <p className="muted small">{settings.credentials_saved?'凭据已通过系统密钥服务保存在本机':'凭据仅用于本次会话；下次启动需重新填写'}</p>}
    <div className="row-actions">
      <button className="btn tiny" disabled={disabled} onClick={()=>action('save')}>保存同步设置</button>
      <button className="btn tiny" disabled={disabled} onClick={()=>action('test')}>测试连接</button>
      <button className="btn primary tiny" disabled={disabled} onClick={()=>action('sync')}>{dirty?'保存并同步':'立即同步'}</button>
      {state?.running && <button className="btn tiny" onClick={()=>api.syncCancel().catch((e)=>setError(String(e)))}>取消同步</button>}
    </div>
    {state && <p role="status">{state.phase || (state.configured?'已配置，等待同步':'尚未配置')}{state.status==='cancelled'?' · 已取消':''}</p>}
    {state?.report && <p className="small">收到 {state.report.pulled} 次变更，本次上传 {state.report.changed_documents} 项记录、{state.report.uploaded_files} 个变化文件。</p>}
    {(error || state?.error) && <p className="error-box" role="alert">{error || state?.error}</p>}
    {!!state?.conflicts && <button className="btn" onClick={()=>api.syncConflicts().then(setConflicts).catch((e)=>setError(String(e)))}>查看待处理冲突（{state.conflicts}）</button>}
    {conflicts.map((c)=><article key={c.id} className="sync-conflict">
      <h4>{c.local?.paper?.title || c.remote?.paper?.title || (c.key.startsWith('file:')?'附件文件':'分类或标签')}：两端修改冲突</h4>
      <div className="sync-comparison"><div><strong>本地</strong><pre>{preview(c.local,c.paths)}</pre></div><div><strong>云端</strong><pre>{preview(c.remote,c.paths)}</pre></div></div>
      <p className="muted small">未冲突的修改已合并。选择要保留的冲突内容，再同步到其他设备。</p>
      <button className="btn tiny" disabled={disabled} onClick={()=>resolve(c,'local')}>保留本地冲突内容</button>
      <button className="btn tiny" disabled={disabled} onClick={()=>resolve(c,'remote')}>采用云端冲突内容</button>
    </article>)}
  </section>;
}
