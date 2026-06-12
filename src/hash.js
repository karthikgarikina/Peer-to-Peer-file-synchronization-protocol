const crypto = require('crypto');
const fs = require('fs');
const util = require('util');

const BLOCK_SIZE = 1024; // 1KB blocks
const ADLER_MOD = 65521;

function normalizeAdlerPart(value) {
  const normalized = value % ADLER_MOD;
  return normalized < 0 ? normalized + ADLER_MOD : normalized;
}

function combineAdlerParts(a, b) {
  // Keep the same signed 32-bit representation the original adler32() returned.
  return (b << 16) | a;
}

/**
 * Rolling Adler-style checksum state.
 * Supports O(1) updates for a fixed-size sliding window.
 */
class RollingAdler32 {
  constructor(buf) {
    this.length = buf.length;
    this.a = 1;
    this.b = 0;

    for (let i = 0; i < buf.length; i++) {
      this.a = (this.a + buf[i]) % ADLER_MOD;
      this.b = (this.b + this.a) % ADLER_MOD;
    }
  }

  value() {
    return combineAdlerParts(this.a, this.b);
  }

  roll(outByte, inByte) {
    if (this.length === 0) {
      throw new Error('Cannot roll an empty checksum window');
    }

    this.a = normalizeAdlerPart(this.a - outByte + inByte);
    this.b = normalizeAdlerPart(this.b - (this.length * outByte) + this.a - 1);
    return this.value();
  }
}

/**
 * Compute Adler-32 rolling hash for a buffer.
 * Used as the "weak hash" for quick block matching in the rsync algorithm.
 * @param {Buffer} buf - Data buffer
 * @returns {number} 32-bit Adler-32 checksum
 */
function adler32(buf) {
  return new RollingAdler32(buf).value();
}

/**
 * Compute SHA-256 hash for a buffer.
 * Used as the "strong hash" to confirm block matches and for full-file integrity.
 * @param {Buffer} buf - Data buffer
 * @returns {string} Hex-encoded SHA-256 hash
 */
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Generate complete file metadata including block-level hashes.
 * @param {string} filePath - Absolute path to the file
 * @param {string} relativePath - Relative path for the response
 * @returns {Object} File metadata with block hashes
 */
async function getFileMetadata(filePath, relativePath) {
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
    filePath: relativePath || '',
    size: stat.size,
    modified_at: stat.mtime.toISOString(),
    full_hash,
    block_size: BLOCK_SIZE,
    blocks
  };
}

module.exports = {
  BLOCK_SIZE,
  RollingAdler32,
  adler32,
  sha256,
  getFileMetadata
};
