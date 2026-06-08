const crypto = require('crypto');
const fs = require('fs');
const util = require('util');

const BLOCK_SIZE = 1024; // 1KB blocks

function adler32(buf) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return (b << 16) | a;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function getFileMetadata(filePath) {
  const stat = await util.promisify(fs.stat)(filePath);
  const buffer = await util.promisify(fs.readFile)(filePath);
  
  const full_hash = sha256(buffer);
  const blocks = [];
  
  for (let i = 0; i < buffer.length; i += BLOCK_SIZE) {
    const chunk = buffer.slice(i, i + BLOCK_SIZE);
    blocks.push({
      index: i / BLOCK_SIZE,
      weak_hash: adler32(chunk),
      strong_hash: sha256(chunk)
    });
  }
  
  return {
    size: stat.size,
    modified_at: stat.mtime.toISOString(),
    full_hash,
    block_size: BLOCK_SIZE,
    blocks
  };
}

module.exports = {
  BLOCK_SIZE,
  adler32,
  sha256,
  getFileMetadata
};
