const {test}=require('node:test');
const assert=require('node:assert/strict');
const {checkOfflineOcrAssets}=require('../e2e/package-checks.cjs');
const assets=['worker.min.js','eng.traineddata.gz','chi_sim.traineddata.gz','tesseract-core-lstm.wasm'];
for(const separator of ['/','\\']){
  test(`offline OCR archive check accepts ${JSON.stringify(separator)} path separators`,()=>{
    checkOfflineOcrAssets(assets.map(asset=>separator+['dist','ocr',asset].join(separator)));
  });
}
test('offline OCR archive check still rejects a missing packaged worker',()=>{
  assert.throws(()=>checkOfflineOcrAssets(assets.slice(1).map(asset=>'/dist/ocr/'+asset)),/Missing offline OCR asset: worker.min.js/);
  assert.throws(()=>checkOfflineOcrAssets(assets.map(asset=>'/other/dist/ocr/'+asset)),/Missing offline OCR asset/);
});
