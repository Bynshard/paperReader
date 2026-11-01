// Yield the bulk queue between batches so AI/export work can also make progress.
async function importBatches(paths, call, progress, batchSize = 50) {
  const results = [];
  progress({ completed: 0, total: paths.length });
  for (let offset = 0; offset < paths.length; offset += batchSize) {
    const batch = await call('import_pdfs', { paths: paths.slice(offset, offset + batchSize) }, 10 * 60 * 1000);
    results.push(...batch);
    progress({ completed: results.length, total: paths.length });
  }
  return results;
}
module.exports = { importBatches };
