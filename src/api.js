const fs = require('fs');
const path = require('path');
const util = require('util');
const { getFileMetadata, sha256 } = require('./hash');
const { applyPatches } = require('./delta');

async function routes(fastify, options) {
  const syncDir = options.syncDir;
  const syncManager = options.syncManager;
  const maxFileSize = options.maxFileSize;

  fastify.get('/health', async (request, reply) => {
    return { status: 'ok' };
  });

  fastify.get('/files/*', async (request, reply) => {
    const rawPath = request.params['*'];
    
    // Path traversal check
    const normalizedPath = path.normalize(rawPath).replace(/^(\.\.(\/|\\|$))+/, '');
    const absolutePath = path.join(syncDir, normalizedPath);
    
    if (!absolutePath.startsWith(path.resolve(syncDir))) {
      return reply.code(400).send({ error: 'Invalid path' });
    }

    if (!rawPath.endsWith('/metadata')) {
      return reply.code(404).send();
    }
    
    const filePath = absolutePath.replace(/\\metadata$/, '').replace(/\/metadata$/, '');

    try {
      const metadata = await getFileMetadata(filePath);
      return metadata;
    } catch (err) {
      if (err.code === 'ENOENT') {
        return reply.code(404).send({ error: 'File not found' });
      }
      return reply.code(500).send({ error: 'Internal Server Error' });
    }
  });

  fastify.patch('/files/*', async (request, reply) => {
    const rawPath = request.params['*'];
    
    // Path traversal check
    const normalizedPath = path.normalize(rawPath).replace(/^(\.\.(\/|\\|$))+/, '');
    const absolutePath = path.join(syncDir, normalizedPath);
    
    if (!absolutePath.startsWith(path.resolve(syncDir))) {
      return reply.code(400).send({ error: 'Invalid path' });
    }

    const { base_full_hash, patches, final_full_hash } = request.body;

    let currentHash = null;
    try {
      const buf = await util.promisify(fs.readFile)(absolutePath);
      currentHash = sha256(buf);
    } catch (e) {
      // File doesn't exist
    }

    // Conflict detection
    if (currentHash && currentHash !== base_full_hash && patches.length > 0 && patches[0].type !== 'delete') {
      // Create conflict file
      const timestamp = new Date().toISOString().replace(/[-:T]/g, '').split('.')[0];
      const parsed = path.parse(absolutePath);
      const conflictPath = path.join(parsed.dir, `${parsed.name}.conflicted.${timestamp}${parsed.ext}`);
      const relativeConflictPath = path.relative(syncDir, conflictPath);
      
      syncManager.markInternalChange(relativeConflictPath);
      try {
         await applyPatches(conflictPath, { patches, final_full_hash });
      } catch(e) {
         console.error("Failed to write to conflict file", e);
      }
      return reply.code(409).send({ error: 'Conflict detected, saved as conflict copy' });
    }

    syncManager.markInternalChange(normalizedPath);
    try {
      if (patches && patches.length === 1 && patches[0].type === 'delete') {
          await applyPatches(absolutePath, request.body);
      } else {
         const newHash = await applyPatches(absolutePath, request.body);
         // Check size limits roughly
         const stat = await util.promisify(fs.stat)(absolutePath);
         if (stat.size > maxFileSize) {
             await util.promisify(fs.unlink)(absolutePath); // rollback
             return reply.code(413).send({ error: 'Payload Too Large' });
         }
      }
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }

    return { status: 'success' };
  });
}

module.exports = routes;
