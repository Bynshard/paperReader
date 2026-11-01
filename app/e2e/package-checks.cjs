const assert=require('node:assert/strict');
const offlineOcrAssets=['worker.min.js','eng.traineddata.gz','chi_sim.traineddata.gz','tesseract-core-lstm.wasm'];
function checkOfflineOcrAssets(entries){
  // ASAR listPackage uses the host's path separator, including on Windows.
  const normalized=new Set(entries.map(entry=>entry.replaceAll('\\','/').replace(/^\/+/,'')));
  for(const asset of offlineOcrAssets){
    assert(normalized.has('dist/ocr/'+asset),`Missing offline OCR asset: ${asset}`);
  }
}
module.exports={checkOfflineOcrAssets};
