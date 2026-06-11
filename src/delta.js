const fs = require('fs');
const util = require('util');
const path = require('path');
const { BLOCK_SIZE, adler32, sha256 } = require('./hash');

/**
 * Compute delta patches between a local file and remote metadata.
 * Implements the rsync algorithm: uses weak+strong hashes to identify
 * matching blocks and only sends new/changed data.
 *
 * @param {string} localFilePath - Absolute path to the local (updated) file
 * @param {Object} remoteMetadata - Block-level metadata from the remote node
 * @param {boolean} fileDeleted - Whether the file was deleted locally
 * @returns {Object} { patches, final_full_hash }
 */
async function computePatches(localFilePath, remoteMetadata, fileDeleted = false) {
  if (fileDeleted) {
    return { patches: [{ type: 'delete' }], final_full_hash: '' };
  }

  const buf = await util.promisify(fs.readFile)(localFilePath);
  const final_full_hash = sha256(buf);

  // If remote has no blocks (file is new on remote), send full content as new blocks
  if (!remoteMetadata.blocks || remoteMetadata.blocks.length === 0) {
    const patches = [];
    for (let i = 0; i < buf.length; i += BLOCK_SIZE) {
      const chunk = buf.slice(i, Math.min(i + BLOCK_SIZE, buf.length));
      patches.push({
        type: 'new_block',
        index: Math.floor(i / BLOCK_SIZE),
        byte_index: i,
        data: chunk.toString('base64')
      });
    }
    // Handle empty file - still need at least an empty block to create the file
    if (patches.length === 0) {
      patches.push({ type: 'new_block', index: 0, byte_index: 0, data: '' });
    }
    return { patches, final_full_hash };
  }

  // Map remote blocks by weak hash for O(1) lookup
  const remoteBlocksMap = new Map();
  for (const b of remoteMetadata.blocks) {
    if (!remoteBlocksMap.has(b.weak_hash)) {
      remoteBlocksMap.set(b.weak_hash, []);
    }
    remoteBlocksMap.get(b.weak_hash).push(b);
  }

  const patches = [];
  let i = 0;

  while (i < buf.length) {
    let matchedBlock = null;

    // Only check for block match if we have a full block to compare
    if (i + BLOCK_SIZE <= buf.length) {
      const weak = adler32(buf.slice(i, i + BLOCK_SIZE));
      if (remoteBlocksMap.has(weak)) {
        // Weak hash matched - verify with strong hash to avoid collisions
        const strong = sha256(buf.slice(i, i + BLOCK_SIZE));
        const potentialMatches = remoteBlocksMap.get(weak);
        matchedBlock = potentialMatches.find(b => b.strong_hash === strong);
      }
    }

    if (matchedBlock) {
      // Block already exists on remote - just reference it
      patches.push({
        type: 'copy_block',
        from_index: matchedBlock.index,
        to_index: Math.floor(i / BLOCK_SIZE)
      });
      i += BLOCK_SIZE;
    } else {
      // New or changed data - send the literal bytes
      const end = Math.min(i + BLOCK_SIZE, buf.length);
      const chunk = buf.slice(i, end);
      patches.push({
        type: 'new_block',
        index: Math.floor(i / BLOCK_SIZE),
        byte_index: i,
        data: chunk.toString('base64')
      });
      i += chunk.length;
    }
  }

  return { patches, final_full_hash };
}

/**
 * Apply patches to reconstruct a file.
 * Reads the base file, applies copy_block and new_block instructions,
 * verifies the result with a hash check, and writes the output.
 *
 * @param {string} outputPath - Path to write the reconstructed file
 * @param {Object} patchData - { patches, final_full_hash }
 * @param {string} [baseFilePath] - Optional path to read base blocks from
 *                                   (defaults to outputPath). Used for conflict copies
 *                                   where we read from the existing file but write elsewhere.
 * @returns {string} SHA-256 hash of the reconstructed file
 */
async function applyPatches(outputPath, patchData, baseFilePath) {
  // Handle delete operation
  if (patchData.patches.length === 1 && patchData.patches[0].type === 'delete') {
    try {
      await util.promisify(fs.unlink)(outputPath);
    } catch (e) {} // Ignore if already deleted
    return '';
  }

  // Read base file (from baseFilePath if provided, otherwise from outputPath)
  let existingBuf = Buffer.alloc(0);
  const readPath = baseFilePath || outputPath;
  try {
    existingBuf = await util.promisify(fs.readFile)(readPath);
  } catch (e) {} // File might be new

  // Ensure output directory exists
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Reconstruct file from patch instructions
  const chunks = [];
  for (const p of patchData.patches) {
    if (p.type === 'copy_block') {
      // Copy existing block from the base file
      const start = p.from_index * BLOCK_SIZE;
      const end = Math.min(start + BLOCK_SIZE, existingBuf.length);
      chunks.push(existingBuf.slice(start, end));
    } else if (p.type === 'new_block') {
      // Insert new literal data
      chunks.push(Buffer.from(p.data, 'base64'));
    }
  }

  const finalBuffer = Buffer.concat(chunks);
  const resultHash = sha256(finalBuffer);

  // Verify integrity
  if (patchData.final_full_hash && resultHash !== patchData.final_full_hash) {
    throw new Error(`Hash mismatch after patching. Expected ${patchData.final_full_hash}, got ${resultHash}`);
  }

  await util.promisify(fs.writeFile)(outputPath, finalBuffer);
  return resultHash;
}

module.exports = {
  computePatches,
  applyPatches
};
