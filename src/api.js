const fs = require('fs');
const path = require('path');
const util = require('util');
const { getFileMetadata, sha256 } = require('./hash');
const { applyPatches } = require('./delta');

async function routes(fastify, options) {
  const syncDir = options.syncDir;
  const syncManager = options.syncManager;
  const syncState = options.syncState;
  const maxFileSize = options.maxFileSize;
  const resolvedSyncDir = path.resolve(syncDir);

  /**
   * Validate and sanitize a file path to prevent path traversal attacks.
   * Returns null if the path escapes the sync directory.
   */
  function validatePath(rawPath) {
    // Decode any remaining URL encoding
    let decoded;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch (e) {
      return null;
    }

    const normalizedPath = path.normalize(decoded);
    const absolutePath = path.resolve(syncDir, normalizedPath);

    // Ensure resolved path is within the sync directory
    if (!absolutePath.startsWith(resolvedSyncDir + path.sep) && absolutePath !== resolvedSyncDir) {
      return null;
    }

    return { normalizedPath: decoded, absolutePath };
  }

  // ── Health Check ──────────────────────────────────────────────────────────
  fastify.get('/health', async (request, reply) => {
    return { status: 'ok' };
  });

  // ── File Metadata Endpoint ────────────────────────────────────────────────
  // GET /files/{filepath*}/metadata
  fastify.get('/files/*', async (request, reply) => {
    const rawPath = request.params['*'];

    if (!rawPath.endsWith('/metadata')) {
      return reply.code(404).send({ error: 'Not found' });
    }

    // Strip the /metadata suffix to get the file path
    const fileRelPath = rawPath.slice(0, -'/metadata'.length);

    const validated = validatePath(fileRelPath);
    if (!validated) {
      return reply.code(400).send({ error: 'Invalid path: path traversal detected' });
    }

    try {
      const metadata = await getFileMetadata(validated.absolutePath, validated.normalizedPath);
      return metadata;
    } catch (err) {
      if (err.code === 'ENOENT') {
        return reply.code(404).send({ error: 'File not found' });
      }
      return reply.code(500).send({ error: 'Internal Server Error' });
    }
  });

  // ── Individual Patch Endpoint ─────────────────────────────────────────────
  // PATCH /files/{filepath*}
  fastify.patch('/files/*', async (request, reply) => {
    const rawPath = request.params['*'];

    const validated = validatePath(rawPath);
    if (!validated) {
      return reply.code(400).send({ error: 'Invalid path: path traversal detected' });
    }

    const { base_full_hash, patches, final_full_hash } = request.body;

    // ── Handle Delete ──
    if (patches && patches.length === 1 && patches[0].type === 'delete') {
      syncManager.markInternalChange(validated.normalizedPath);
      try {
        await applyPatches(validated.absolutePath, request.body);
        syncState.removeLastSyncedHash(validated.normalizedPath);
      } catch (e) {
        // Ignore errors on delete (file may already be gone)
      }
      return { status: 'success' };
    }

    // ── Conflict Detection ──
    let currentHash = null;
    try {
      const buf = await util.promisify(fs.readFile)(validated.absolutePath);
      currentHash = sha256(buf);
    } catch (e) {
      // File doesn't exist yet - no conflict possible
    }

    // Conflict: file exists locally AND has been modified since last sync
    // (currentHash differs from what the sender thinks we have)
    if (currentHash && base_full_hash && currentHash !== base_full_hash) {
      // Create conflict file with the sender's version
      const timestamp = new Date().toISOString().replace(/[-:T]/g, '').split('.')[0];
      const parsed = path.parse(validated.absolutePath);
      const conflictPath = path.join(parsed.dir, `${parsed.name}.conflicted.${timestamp}${parsed.ext}`);
      const relativeConflictPath = path.relative(syncDir, conflictPath);

      syncManager.markInternalChange(relativeConflictPath);
      try {
        // Apply patches using current file as base (patches were computed against it)
        await applyPatches(conflictPath, { patches, final_full_hash }, validated.absolutePath);
      } catch (e) {
        console.error('[API] Failed to create conflict file:', e.message);
      }
      return reply.code(409).send({ error: 'Conflict detected, saved as conflict copy' });
    }

    // ── Normal Patch Application ──
    syncManager.markInternalChange(validated.normalizedPath);

    // Ensure directory exists
    const dir = path.dirname(validated.absolutePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    try {
      const newHash = await applyPatches(validated.absolutePath, request.body);

      // Check file size limit
      try {
        const stat = await util.promisify(fs.stat)(validated.absolutePath);
        if (stat.size > maxFileSize) {
          await util.promisify(fs.unlink)(validated.absolutePath); // rollback
          return reply.code(413).send({ error: 'Payload Too Large' });
        }
      } catch (e) {
        // stat failed, skip check
      }

      // Record successful sync
      syncState.setLastSyncedHash(validated.normalizedPath, newHash || final_full_hash);
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }

    return { status: 'success' };
  });

  // ── Bulk Operations Endpoint ──────────────────────────────────────────────
  // POST /files/_bulk - Process multiple file operations in a single request
  // Used for efficient batch sync of many small files
  fastify.post('/files/_bulk', { bodyLimit: 100 * 1024 * 1024 }, async (request, reply) => {
    const { operations } = request.body;

    if (!operations || !Array.isArray(operations)) {
      return reply.code(400).send({ error: 'Invalid request: operations array required' });
    }

    const processOp = async (op) => {
      const { filePath, base_full_hash, patches, final_full_hash } = op;

      // Validate path
      const validated = validatePath(filePath);
      if (!validated) {
        return { filePath, status: 'error', error: 'Invalid path' };
      }

      try {
        // ── Delete ──
        if (op.type === 'delete' || (patches && patches.length === 1 && patches[0].type === 'delete')) {
          syncManager.markInternalChange(filePath);
          try {
            await util.promisify(fs.unlink)(validated.absolutePath);
          } catch (e) {} // Ignore if already deleted
          return { filePath, status: 'success', _delete: true };
        }

        // ── New File ──
        if (op.type === 'new') {
          syncManager.markInternalChange(filePath);
          const dir = path.dirname(validated.absolutePath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

          const buf = Buffer.from(op.content, 'base64');
          if (buf.length > maxFileSize) {
            return { filePath, status: 'error', error: 'Payload Too Large' };
          }
          await util.promisify(fs.writeFile)(validated.absolutePath, buf);
          syncState.setLastSyncedHash(filePath, op.hash);
          return { filePath, status: 'success' };
        }

        // ── Conflict Detection ──
        let currentHash = null;
        try {
          const buf = await util.promisify(fs.readFile)(validated.absolutePath);
          currentHash = sha256(buf);
        } catch (e) {
          // File doesn't exist
        }

        if (currentHash && base_full_hash && currentHash !== base_full_hash) {
          // Create conflict copy
          const timestamp = new Date().toISOString().replace(/[-:T]/g, '').split('.')[0];
          const parsed = path.parse(validated.absolutePath);
          const conflictPath = path.join(parsed.dir, `${parsed.name}.conflicted.${timestamp}${parsed.ext}`);
          const relativeConflictPath = path.relative(syncDir, conflictPath);

          syncManager.markInternalChange(relativeConflictPath);
          try {
            await applyPatches(conflictPath, { patches, final_full_hash }, validated.absolutePath);
          } catch (e) {
            console.error(`[API] Bulk conflict file error for ${filePath}:`, e.message);
          }
          return { filePath, status: 'conflict' };
        }

        // ── Apply Patches ──
        syncManager.markInternalChange(filePath);

        // Ensure directory exists
        const dir = path.dirname(validated.absolutePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        const newHash = await applyPatches(validated.absolutePath, { patches, final_full_hash });

        // Check file size limit
        try {
          const stat = await util.promisify(fs.stat)(validated.absolutePath);
          if (stat.size > maxFileSize) {
            await util.promisify(fs.unlink)(validated.absolutePath);
            return { filePath, status: 'error', error: 'File too large' };
          }
        } catch (e) {}

        return { filePath, status: 'success', _hash: newHash || final_full_hash };
      } catch (e) {
        return { filePath, status: 'error', error: e.message };
      }
    };

    // Process all operations in parallel
    const results = await Promise.all(operations.map(processOp));

    // Batch update sync state
    const hashUpdates = {};
    const deleteList = [];
    for (const r of results) {
      if (r._hash) {
        hashUpdates[r.filePath] = r._hash;
        delete r._hash;
      }
      if (r._delete) {
        deleteList.push(r.filePath);
        delete r._delete;
      }
    }
    if (Object.keys(hashUpdates).length > 0) {
      syncState.setBatch(hashUpdates);
    }
    if (deleteList.length > 0) {
      syncState.removeBatch(deleteList);
    }

    return { results };
  });
}

module.exports = routes;
