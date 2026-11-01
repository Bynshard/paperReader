//! rclone owns authentication, retries, streaming and provider compatibility.
//! Credentials are environment variables, never command-line arguments.
use anyhow::{anyhow,Result};
use serde::{Deserialize,Serialize};
use std::{collections::BTreeMap,fs,io::Write,path::{Path,PathBuf},process::{Command,Stdio},sync::atomic::{AtomicBool,Ordering},thread,time::Duration};

#[derive(Clone,Serialize,Deserialize)]
pub struct Profile {
    pub provider:String,
    pub endpoint:String,
    #[serde(default)] pub bucket:String,
    #[serde(default)] pub region:String,
    #[serde(default="prefix")] pub prefix:String,
    #[serde(default)] pub username:String,
    #[serde(default)] pub password:String,
    #[serde(default)] pub access_key:String,
    #[serde(default)] pub secret_key:String,
    #[serde(default)] pub force_path_style:bool,
    #[serde(default)] pub request_rate:Option<f64>,
}
fn prefix()->String {"Moonlight".into()}
impl Profile {
    pub fn validate(&self)->Result<()> {
        if !["qiniu","aliyun","webdav","s3"].contains(&self.provider.as_str()){return Err(anyhow!("不支持的同步服务"));}
        let url=reqwest::Url::parse(&self.endpoint).map_err(|_|anyhow!("请输入有效服务地址"))?;
        let loopback=matches!(url.host_str(),Some("localhost"|"127.0.0.1"|"[::1]"|"::1"));
        if url.scheme()!="https" && !(url.scheme()=="http" && loopback) {return Err(anyhow!("云服务地址需要 HTTPS"));}
        if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some(){return Err(anyhow!("地址中请勿包含密码、查询参数或片段"));}
        if self.prefix.is_empty() || !Path::new(&self.prefix).components().all(|c|matches!(c,std::path::Component::Normal(_))) || self.prefix.contains([':', '\\','\n','\r']) {return Err(anyhow!("同步文件夹必须是相对路径"));}
        if self.provider=="webdav" {if self.username.is_empty() || self.password.is_empty(){return Err(anyhow!("请填写 WebDAV 用户名和应用密码"));}}
        else if self.bucket.is_empty() || !self.bucket.chars().all(|c|c.is_ascii_alphanumeric() || c=='-' || c=='.') || self.access_key.is_empty() || self.secret_key.is_empty(){return Err(anyhow!("请填写存储桶、AccessKey 和 SecretKey"));}
        if [&self.password,&self.access_key,&self.secret_key].iter().any(|s|s.contains(['\r','\n'])){return Err(anyhow!("凭据不能包含换行"));}
        if self.request_rate.is_some_and(|n|!n.is_finite() || n<0.0 || n>100.0){return Err(anyhow!("请求速率范围为 0 到 100"));}
        Ok(())
    }
    pub fn target_id(&self)->String {super::sync::digest(&format!("{}|{}|{}|{}|{}",self.provider,self.endpoint.trim_end_matches('/'),self.bucket,self.prefix,self.username))}
}
fn hidden_command(binary:&Path)->Command {
    let mut command=Command::new(binary);
    #[cfg(windows)]
    {use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
    command
}
pub struct Remote { binary:PathBuf, env:BTreeMap<String,String>, root:String, config:PathBuf,rate:f64 }
impl Remote {
    pub fn new(profile:&Profile,work:&Path)->Result<Self> {
        profile.validate()?;
        let bundled=PathBuf::from("tools/rclone").join(if cfg!(windows){"rclone.exe"}else{"rclone"});
        let binary=std::env::var_os("MOONLIGHT_RCLONE").map(PathBuf::from).unwrap_or_else(||if bundled.is_file(){bundled}else{"rclone".into()});
        let config=work.join("rclone-empty.conf");fs::write(&config,"")?;
        let mut env=BTreeMap::new();
        if profile.provider=="webdav" {
            env.insert("TYPE".into(),"webdav".into());env.insert("URL".into(),profile.endpoint.clone());env.insert("VENDOR".into(),"other".into());env.insert("USER".into(),profile.username.clone());
            let mut child=hidden_command(&binary).args(["obscure","-"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|_|anyhow!("未找到 rclone，请运行 scripts/install_rclone.py"))?;
            child.stdin.take().unwrap().write_all(format!("{}\n",profile.password).as_bytes())?;
            let result=child.wait_with_output()?;if !result.status.success(){return Err(anyhow!("rclone 凭据初始化失败"));}
            env.insert("PASS".into(),String::from_utf8(result.stdout)?.trim().into());
        } else {
            for (key,value) in [("TYPE","s3"),("PROVIDER",match profile.provider.as_str(){"qiniu"=>"Qiniu","aliyun"=>"Alibaba",_=>"Other"}),("ENDPOINT",profile.endpoint.as_str()),("REGION",profile.region.as_str()),("ACCESS_KEY_ID",profile.access_key.as_str()),("SECRET_ACCESS_KEY",profile.secret_key.as_str()),("ENV_AUTH","false"),("FORCE_PATH_STYLE",if profile.force_path_style {"true"}else{"false"}),("NO_CHECK_BUCKET","true")] {env.insert(key.into(),value.into());}
        }
        let root=if profile.provider=="webdav" {format!("moon:{}/v1",profile.prefix)}else{format!("moon:{}/{}/v1",profile.bucket,profile.prefix)};
        let rate=profile.request_rate.unwrap_or_else(||if profile.provider=="webdav" && reqwest::Url::parse(&profile.endpoint).ok().and_then(|u|u.host_str().map(|s|s=="dav.jianguoyun.com")).unwrap_or(false){0.2}else{0.0});
        Ok(Self{binary,env,root,config,rate})
    }
    pub fn path(&self,key:&str)->String {format!("{}/{}",self.root,key)}
    pub fn run(&self,args:&[String],cancel:&AtomicBool)->Result<String> {
        if cancel.load(Ordering::SeqCst){return Err(anyhow!("同步已取消"));}
        let mut command=hidden_command(&self.binary);
        // Remove inherited rclone overrides, so a user's unrelated configuration
        // cannot redirect this app's transfers or log credentials.
        for (key,_) in std::env::vars().filter(|(k,_)|k.starts_with("RCLONE_")){command.env_remove(key);}
        for (key,value) in &self.env {command.env(format!("RCLONE_CONFIG_MOON_{key}"),value);}
        command.args(args).args(["--config",self.config.to_str().ok_or_else(||anyhow!("invalid config path"))?,"--retries","3","--low-level-retries","3","--contimeout","10s","--timeout","60s","--transfers","2","--checkers","4","--log-level","ERROR","--stats","0"]);
        if self.rate>0.0 {command.args(["--tpslimit",&self.rate.to_string(),"--tpslimit-burst","1"]);}
        let output=self.config.with_file_name(format!("rclone-{}.out",uuid::Uuid::new_v4()));
        let mut child=command.stdout(fs::File::create(&output)?).stderr(Stdio::null()).stdin(Stdio::null()).spawn().map_err(|_|anyhow!("未找到 rclone，请运行 scripts/install_rclone.py"))?;
        let status=loop {
            if cancel.load(Ordering::SeqCst){let _=child.kill();let _=child.wait();let _=fs::remove_file(&output);return Err(anyhow!("同步已取消"));}
            if let Some(status)=child.try_wait()? {break status;}thread::sleep(Duration::from_millis(50));
        };
        let text=fs::read_to_string(&output).unwrap_or_default();
        // Raw provider diagnostics can contain usernames, signed URLs and keys.
        // Do not forward or persist them as a user-visible error report.
        let _=fs::remove_file(&output);
        if !status.success(){return Err(anyhow!("云存储请求失败（rclone 退出码 {}）；请检查地址、凭据、网络与读写权限",status.code().unwrap_or(-1)));}Ok(text)
    }
    pub fn mkdir(&self,key:&str,cancel:&AtomicBool)->Result<()> {self.run(&["mkdir".into(),self.path(key)],cancel)?;Ok(())}
    pub fn upload(&self,local:&Path,key:&str,cancel:&AtomicBool)->Result<()> {self.run(&["copyto".into(),local.to_string_lossy().into(),self.path(key),"--immutable".into()],cancel)?;Ok(())}
    pub fn download(&self,key:&str,local:&Path,cancel:&AtomicBool)->Result<()> {self.run(&["copyto".into(),self.path(key),local.to_string_lossy().into()],cancel)?;Ok(())}
    pub fn copy(&self,local:&Path,key:&str,cancel:&AtomicBool)->Result<()> {self.run(&["copy".into(),local.to_string_lossy().into(),self.path(key),"--immutable".into(),"--no-traverse".into()],cancel)?;Ok(())}
    pub fn list(&self,key:&str,cancel:&AtomicBool)->Result<Vec<String>> {
        let text=self.run(&["lsf".into(),self.path(key),"--recursive".into(),"--files-only".into()],cancel)?;
        Ok(text.lines().filter(|s|!s.is_empty()).map(str::to_string).collect())
    }
}
