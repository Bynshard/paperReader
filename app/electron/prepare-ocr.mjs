// Vendor upstream worker, WASM and language data into the app. No runtime CDN.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'public/ocr');
await fs.mkdir(out,{recursive:true});
const dir=name=>path.dirname(require.resolve(`${name}/package.json`));
await fs.copyFile(path.join(dir('tesseract.js'),'dist/worker.min.js'),path.join(out,'worker.min.js'));
for(const name of await fs.readdir(dir('tesseract.js-core')))if(/\.wasm(?:\.js)?$/.test(name))await fs.copyFile(path.join(dir('tesseract.js-core'),name),path.join(out,name));
for(const lang of ['eng','chi_sim'])await fs.copyFile(path.join(dir(`@tesseract.js-data/${lang}`),'4.0.0',`${lang}.traineddata.gz`),path.join(out,`${lang}.traineddata.gz`));
