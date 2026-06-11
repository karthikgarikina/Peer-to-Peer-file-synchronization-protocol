require('dotenv').config();
const Fastify = require('fastify');
const path = require('path');
const fs = require('fs');
const { SyncManager } = require('./syncManager');
const { SyncState } = require('./syncState');

/**
 * Build the Fastify application with all plugins and routes.
 * Accepts optional overrides for testing.
 */
async function buildApp(options = {}) {
  const SYNC_DIR = options.syncDir || process.env.SYNC_DIR || path.join(__dirname, '../sync_dir');
  const MAX_FILE_SIZE = parseInt(options.maxFileSize || process.env.MAX_FILE_SIZE || '10485760', 10);
  const PEER_URL = options.peerUrl || process.env.PEER_URL || 'http://localhost:3001';
  const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '20', 10);
  const RATE_LIMIT_TIME_WINDOW = parseInt(process.env.RATE_LIMIT_TIME_WINDOW || '10000', 10);
  const SYNC_SECRET = process.env.SYNC_SECRET || 'p2p-sync-secret-key';

  // Ensure sync directory exists
  if (!fs.existsSync(SYNC_DIR)) {
    fs.mkdirSync(SYNC_DIR, { recursive: true });
  }

  const fastify = Fastify({
    logger: options.logger !== undefined ? options.logger : true,
    bodyLimit: 50 * 1024 * 1024 // 50MB default body limit for large patches
  });

  // Rate limiting: internal sync traffic (with secret) is unlimited,
  // external traffic is limited per the configuration
  await fastify.register(require('@fastify/rate-limit'), {
    max: (req, key) => {
      if (req.headers['x-sync-secret'] === SYNC_SECRET) {
        return 1000000; // Effectively unlimited for internal node-to-node traffic
      }
      return RATE_LIMIT_MAX;
    },
    timeWindow: RATE_LIMIT_TIME_WINDOW
  });

  // Initialize sync state (persistent hash store)
  const syncState = new SyncState(SYNC_DIR);

  // Initialize sync manager
  const syncManager = new SyncManager(SYNC_DIR, PEER_URL, syncState, SYNC_SECRET, MAX_FILE_SIZE);

  // Register API routes
  fastify.register(require('./api'), {
    syncDir: SYNC_DIR,
    syncManager,
    syncState,
    maxFileSize: MAX_FILE_SIZE,
    syncSecret: SYNC_SECRET
  });

  return { fastify, syncManager, syncState };
}

/**
 * Start the server and sync manager.
 */
async function start() {
  try {
    const { fastify, syncManager } = await buildApp();
    const port = process.env.PORT || 3000;

    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`Server listening on port ${port}`);

    // Start sync manager (runs in background: wait for peer → reconcile → watch)
    syncManager.start();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

if (require.main === module) {
  start();
}

module.exports = { buildApp };
