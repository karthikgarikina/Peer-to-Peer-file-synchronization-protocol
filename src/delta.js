const fs = require('fs');
const util = require('util');
const { BLOCK_SIZE, adler32, sha256 } = require('./hash');

async function computePatches(localFilePath, remoteMetadata, fileDeleted = false) {
  if (fileDeleted) {
      return { patches: [{ type: 'delete' }], final_full_hash: '' };
  }

  const buf = await util.promisify(fs.readFile)(localFilePath);
  const final_full_hash = sha256(buf);

  // Map remote blocks for easy lookup
  const remoteBlocksMap = new Map();
  if (remoteMetadata.blocks) {
    for (const b of remoteMetadata.blocks) {
      if (!remoteBlocksMap.has(b.weak_hash)) {
        remoteBlocksMap.set(b.weak_hash, []);
      }
      remoteBlocksMap.get(b.weak_hash).push(b);
    }
  }

  const patches = [];
  let i = 0;
  
  while (i < buf.length) {
    let matchedBlock = null;

    if (i + BLOCK_SIZE <= buf.length) {
        const weak = adler32(buf.slice(i, i + BLOCK_SIZE));
        if (remoteBlocksMap.has(weak)) {
            const strong = sha256(buf.slice(i, i + BLOCK_SIZE));
            const potentialMatches = remoteBlocksMap.get(weak);
            matchedBlock = potentialMatches.find(b => b.strong_hash === strong);
        }
    }

    if (matchedBlock) {
      patches.push({
        type: 'copy_block',
        from_index: matchedBlock.index,
        to_index: i / BLOCK_SIZE
      });
      i += BLOCK_SIZE; // Jump forward
    } else {
      // Find where the chunk ends
      const end = Math.min(i + BLOCK_SIZE, buf.length);
      const chunk = buf.slice(i, end);
      patches.push({
        type: 'new_block',
        index: i / BLOCK_SIZE, // We store block-aligned indexes even if partial at the end
        byte_index: i,
        data: chunk.toString('base64')
      });
      i += chunk.length;
    }
  }

  // consolidate matches for cleaner output (optional but skip for now, just sending block operations)

  return { patches, final_full_hash };
}

async function applyPatches(localFilePath, patchData) {
  if (patchData.patches.length === 1 && patchData.patches[0].type === 'delete') {
      try {
          await util.promisify(fs.unlink)(localFilePath);
      } catch (e) {} // Ignore if already deleted
      return '';
  }

  let existingBuf = Buffer.alloc(0);
  try {
      existingBuf = await util.promisify(fs.readFile)(localFilePath);
  } catch(e) {} // File might be new

  // Compute final size and allocate
  let finalSize = 0;
  for (const p of patchData.patches) {
      if (p.type === 'copy_block') {
          finalSize = Math.max(finalSize, (p.to_index * BLOCK_SIZE) + BLOCK_SIZE);
      } else if (p.type === 'new_block') {
          const chunk = Buffer.from(p.data, 'base64');
          finalSize = Math.max(finalSize, p.byte_index + chunk.length);
      }
  }
  
  const newBuf = Buffer.alloc(finalSize);
  
  for (const p of patchData.patches) {
    if (p.type === 'copy_block') {
      const srcStart = p.from_index * BLOCK_SIZE;
      const srcEnd = srcStart + BLOCK_SIZE;
      const dstStart = p.to_index * BLOCK_SIZE;
      existingBuf.copy(newBuf, dstStart, srcStart, Math.min(srcEnd, existingBuf.length));
    } else if (p.type === 'new_block') {
      const data = Buffer.from(p.data, 'base64');
      data.copy(newBuf, p.byte_index);
    }
  }
  
  const reconstructedSizeBuf = newBuf; // Should ideally trim trailing nulls if exactly allocating, but allocation max logic does that.
  
  // Here we must make sure actual file length is exactly what we reconstructed without zero byte padding if possible, 
  // but allocation handled it via exact base64 decoding sizes and copy block sizes.
  // Wait, existingBuf.copy might not fill the whole BLOCK_SIZE if EOF.
  // So a better approach is appending chunks.
  
  let chunks = [];
  for(const p of patchData.patches){
      if(p.type === 'copy_block'){
          const start = p.from_index * BLOCK_SIZE;
          const end = Math.min(start + BLOCK_SIZE, existingBuf.length);
          chunks.push(existingBuf.slice(start, end));
      } else if (p.type === 'new_block') {
          chunks.push(Buffer.from(p.data, 'base64'));
      }
  }
  
  const finalBuffer = Buffer.concat(chunks);
  const resultHash = sha256(finalBuffer);

  if (resultHash !== patchData.final_full_hash) {
      throw new Error(`Hash mismatch after patching. Expected ${patchData.final_full_hash}, got ${resultHash}`);
  }

  await util.promisify(fs.writeFile)(localFilePath, finalBuffer);
  return resultHash;
}

module.exports = {
  computePatches,
  applyPatches
};
