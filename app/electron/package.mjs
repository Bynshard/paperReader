// Official Electron Packager; only a small allowlisted staging directory is packaged.
import {packager} from '@electron/packager';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'../..');
const target=process.argv[2]||process.platform;
if(!['linux','win32'].includes(target))throw new Error('支持 Linux x64 和 Windows x64 打包');
const windows=target==='win32';
const coreFile=windows?'moonlight-core.exe':'moonlight-core';
const corePath=windows?path.join(root,'core/target/x86_64-pc-windows-msvc/release',coreFile):path.join(root,'core/target/release',coreFile);
const stage=await fs.mkdtemp(path.join(os.tmpdir(),'moonlight-package-'));
const output=path.join(root,'release');await fs.mkdir(output,{recursive:true});
try{
 const pkg=JSON.parse(await fs.readFile(path.join(root,'app/package.json'),'utf8'));
 await fs.writeFile(path.join(stage,'package.json'),JSON.stringify({name:pkg.name,productName:pkg.productName,version:pkg.version,main:'electron/main.cjs',description:pkg.description}));
 await fs.cp(path.join(root,'app/dist'),path.join(stage,'dist'),{recursive:true});
 await fs.mkdir(path.join(stage,'electron'));
 for(const name of await fs.readdir(path.join(root,'app/electron')))if(name.endsWith('.cjs')&&name!=='dev.cjs')await fs.copyFile(path.join(root,'app/electron',name),path.join(stage,'electron',name));
 const bin=path.join(stage,'bin');await fs.mkdir(bin);
 await fs.copyFile(corePath,path.join(bin,coreFile));
 if(windows){
   const records=JSON.parse(await fs.readFile(path.join(root,'tools/windows/SOURCES.json'),'utf8'));
   for(const record of records){
     if(!/^[a-z0-9-]+\.exe$/i.test(record.binary))throw new Error('Invalid runtime filename');
     const data=await fs.readFile(path.join(root,'tools/windows',record.binary));
     if(createHash('sha256').update(data).digest('hex')!==record.binary_sha256)throw new Error('Runtime checksum mismatch');
     await fs.writeFile(path.join(bin,record.binary),data);
   }
   await fs.copyFile(path.join(root,'tools/windows/SOURCES.json'),path.join(bin,'SOURCES.json'));
   for(const required of ['codex-app-server.exe','rclone.exe'])await fs.access(path.join(bin,required));
 }else await fs.copyFile(path.join(root,'tools/rclone/rclone'),path.join(bin,'rclone'));
 await fs.chmod(path.join(bin,coreFile),0o755);if(!windows)await fs.chmod(path.join(bin,'rclone'),0o755);
 const electronVersion=JSON.parse(await fs.readFile(path.join(root,'app/node_modules/electron/package.json'),'utf8')).version;
 const results=await packager({dir:stage,name:'Moonlight',executableName:'moonlight',appBundleId:'io.moonlight.desktop',platform:target,arch:'x64',electronVersion,electronZipDir:process.env.MOONLIGHT_ELECTRON_ZIP_DIR,asar:true,prune:false,out:output,overwrite:true,extraResource:[bin],ignore:[/^[/\\]bin($|[/\\])/]});
 const dir=results[0];
 await fs.copyFile(path.join(root,windows?'docs/WINDOWS_TESTING.md':'docs/RELEASE.md'),path.join(dir,'README.md'));
 const archive=path.join(output,`Moonlight-${pkg.version}-${windows?'windows':'linux'}-x64.${windows?'zip':'tar.gz'}`);
 if(windows){
   execFileSync(process.env.MOONLIGHT_PYTHON||(process.platform==='win32'?'python':'python3'),['-c','import pathlib,sys,zipfile; root=pathlib.Path(sys.argv[1]); out=zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED,compresslevel=6); [out.write(p,p.relative_to(root.parent).as_posix()) for p in sorted(root.rglob("*")) if p.is_file()]; out.close()',dir,archive]);
 }else execFileSync('tar',['-czf',archive,'-C',output,path.basename(dir)]);
 const digest=createHash('sha256').update(await fs.readFile(archive)).digest('hex');
 await fs.writeFile(archive+'.sha256',`${digest}  ${path.basename(archive)}\n`);
 await fs.writeFile(path.join(output,windows?'manifest-windows.json':'manifest.json'),JSON.stringify({version:pkg.version,electron:electronVersion,platform:target,arch:'x64',directory:dir,archive,sha256:digest,commit:process.env.MOONLIGHT_BUILD_SHA||null,core:process.platform===target?execFileSync(path.join(bin,coreFile),['--version'],{encoding:'utf8'}).trim():`moonlight-core ${pkg.version} (${target} x64; not executed on this host)`},null,2));
 console.log(archive);
}finally{await fs.rm(stage,{recursive:true,force:true});}
