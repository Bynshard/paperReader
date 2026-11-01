const {test}=require('node:test');
const assert=require('node:assert/strict');
const {importBatches}=require('../electron/import-batches.cjs');

test('large imports yield between bounded batches and report completed counts',async()=>{
  const paths=Array.from({length:123},(_,i)=>`paper-${i}.pdf`);
  const sizes=[],progress=[];
  let active=0;
  const results=await importBatches(paths,async(method,params,timeout)=>{
    assert.equal(method,'import_pdfs');assert.equal(timeout,600000);
    assert.equal(active++,0);
    await Promise.resolve();
    sizes.push(params.paths.length);active--;
    return params.paths.map(path=>({status:'imported',path}));
  },state=>progress.push(state.completed));
  assert.deepEqual(sizes,[50,50,23]);
  assert.deepEqual(progress,[0,50,100,123]);
  assert.deepEqual(results.map(result=>result.path),paths);
});

test('batch errors propagate without silently advancing progress or starting further batches',async()=>{
  let calls=0;const progress=[];
  await assert.rejects(importBatches(Array(120).fill('paper.pdf'),async()=>{
    calls++;if(calls===2)throw new Error('core exited');
    return Array(50).fill({status:'imported'});
  },state=>progress.push(state.completed)),/core exited/);
  assert.equal(calls,2);assert.deepEqual(progress,[0,50]);
});
