require('dotenv').config();
const Fastify = require('fastify');
const path = require('path');
const { SyncManager } = require('./syncManager');

const fs = require('fs');

async function buildApp() {
  const fastify = Fastify({ logger: true });

  const ST_SYNC_DIR = process.env.SYNC_DIR || path.join(__dirname, '../sync_dir');
  const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || '10485760', 10);
  const PEER_URL = process.env.PEER_URL || 'http://localhost:3001';
  const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '20', 10);
  const RATE_LIMIT_TIME_WINDOW = parseInt(process.env.RATE_LIMIT_TIME_WINDOW || '10000', 10);

  // Ensure sync dir exists
  if (!fs.existsSync(ST_SYNC_DIR)) {
      fs.mkdirSync(ST_SYNC_DIR, { recursive: true });
  }

  await fastify.register(require('@fastify/rate-limit'), {
    max: RATE_LIMIT_MAX,
    timeWindow: RATE_LIMIT_TIME_WINDOW
  });

  const syncManager = new SyncManager(ST_SYNC_DIR, PEER_URL);

  fastify.register(require('./api'), {
      syncDir: ST_SYNC_DIR,
      syncManager,
      maxFileSize: MAX_FILE_SIZE
  });

  return { fastify, syncManager };
}

async function start() {
  try {
    const { fastify, syncManager } = await buildApp();
    const port = process.env.PORT || 3000;
    
    await fastify.listen({ port, host: '0.0.0.0' });
    syncManager.start();
    
    console.log(`Server listening on port ${port}`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

if (require.main === module) {
  start();
}

module.exports = { buildApp };
