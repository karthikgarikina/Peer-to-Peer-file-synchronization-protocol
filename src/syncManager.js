const chokidar = require('chokidar');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const util = require('util');
const { computePatches } = require('./delta');
const { sha256, BLOCK_SIZE } = require('./hash');

/**
 * SyncManager handles all file synchronization logic:
 * - Watches a local directory for changes (chokidar)
 * - Detects offline modifications via startup reconciliation
 * - Computes and sends deltas to the peer node
 * - Batches operations for performance (bulk endpoint)
 * - Handles conflict detection via base_full_hash from SyncState
 */
class SyncManager {
  constructor(syncDir, peerUrl, syncState, syncSecret, maxFileSize) {
    this.syncDir = syncDir;
    this.peerUrl = peerUrl;
    this.syncState = syncState;
    this.syncSecret = syncSecret;
    this.maxFileSize = maxFileSize || 10485760;
    this.internalModifications = new Set();
    this.watcher = null;
    this.pendingEvents = new Map();   // relativePath -> event type
    this.debounceTimer = null;
    this.processing = false;
    this.batchSize = 500;             // Files per bulk HTTP request
    this.maxConcurrency = 10;         // Concurrent bulk requests
  }

  /**
   * Start the sync manager: wait for peer, reconcile, then watch.
   */
  async start() {
    console.log('[SyncManager] Starting...');
    await this.waitForPeer();
    console.log('[SyncManager] Peer is available. Running reconciliation...');
    await this.reconcile();
    console.log('[SyncManager] Reconciliation complete. Starting file watcher...');
    this.startWatcher();
  }

  /**
   * Wait for the peer node's health endpoint to respond.
   */
  async waitForPeer(timeoutMs = 60000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      try {
        await axios.get(`${this.peerUrl}/health`, { timeout: 2000 });
        return;
      } catch (e) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
    console.warn('[SyncManager] Peer not available after timeout, proceeding anyway');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  STARTUP RECONCILIATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Scan the sync directory and compare file hashes against the sync state
   * to detect files that were modified or deleted while the service was offline.
   */
  async reconcile() {
    try {
      const currentFiles = this.scanDirectory(this.syncDir);
      const syncedEntries = this.syncState.getAllEntries();

      const toSyncNew = [];
      const toSyncModified = [];
      const toDelete = [];

      // Find new/modified files (hash differs from last sync)
      for (const [relativePath, currentHash] of currentFiles) {
        const lastSyncedHash = this.syncState.getLastSyncedHash(relativePath);
        if (lastSyncedHash !== currentHash) {
          if (!lastSyncedHash) {
            toSyncNew.push(relativePath);
          } else {
            toSyncModified.push(relativePath);
          }
        }
      }

      // Find deleted files (in sync state but no longer on disk)
      for (const filePath of Object.keys(syncedEntries)) {
        if (!currentFiles.has(filePath)) {
          toDelete.push(filePath);
        }
      }

      console.log(`[SyncManager] Reconciliation: ${toSyncNew.length} new, ${toSyncModified.length} modified, ${toDelete.length} deleted`);

      if (toDelete.length > 0) {
        await this.processDeletes(toDelete);
      }
      if (toSyncNew.length > 0) {
        await this.processNewFiles(toSyncNew);
      }
      if (toSyncModified.length > 0) {
        await this.processModifiedFiles(toSyncModified);
      }
    } catch (e) {
      console.error('[SyncManager] Reconciliation error:', e.message);
    }
  }

  /**
   * Recursively scan a directory and compute SHA-256 hashes for all files.
   * Ignores dotfiles and conflict copies.
   */
  scanDirectory(dir, basePath) {
    if (!basePath) basePath = dir;
    const result = new Map();
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (entry.name.includes('.conflicted.')) continue;

        const fullPath = path.join(dir, entry.name);
        if (entry.isFile()) {
          const relativePath = path.relative(basePath, fullPath);
          try {
            const buf = fs.readFileSync(fullPath);
            if (buf.length <= this.maxFileSize) {
              result.set(relativePath, sha256(buf));
            }
          } catch (e) {
            // Skip files we can't read
          }
        } else if (entry.isDirectory()) {
          const subResult = this.scanDirectory(fullPath, basePath);
          for (const [k, v] of subResult) {
            result.set(k, v);
          }
        }
      }
    } catch (e) {
      console.error(`[SyncManager] Error scanning ${dir}:`, e.message);
    }
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  FILE WATCHER
  // ═══════════════════════════════════════════════════════════════════════════

  startWatcher() {
    this.watcher = chokidar.watch(this.syncDir, {
      ignored: (filePath) => {
        const basename = path.basename(filePath);
        if (basename.startsWith('.')) return true;
        if (basename.includes('.conflicted.')) return true;
        return false;
      },
      persistent: true,
      ignoreInitial: true,
      usePolling: true,
      interval: 1000,
      binaryInterval: 1000
    });

    this.watcher.on('all', (event, filePath) => {
      // Skip directory-level events
      if (event === 'addDir' || event === 'unlinkDir') return;

      const relativePath = path.relative(this.syncDir, filePath);

      // Prevent sync loops: ignore changes we made ourselves
      if (this.internalModifications.has(relativePath)) {
        this.internalModifications.delete(relativePath);
        return;
      }

      console.log(`[Chokidar] ${event}: ${relativePath}`);
      this.pendingEvents.set(relativePath, event);
      this.scheduleProcessing();
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DEBOUNCED BATCH PROCESSING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Schedule processing of pending events after a debounce window.
   * This collects rapid-fire events (e.g., 10,000 files created) into batches.
   */
  scheduleProcessing() {
    if (this.pendingEvents.size >= 500 && !this.processing) {
      if (this.processingTimeout) clearTimeout(this.processingTimeout);
      this.processPendingEvents();
      return;
    }
    if (this.processingTimeout) {
      clearTimeout(this.processingTimeout);
    }
    this.processingTimeout = setTimeout(() => {
      this.processPendingEvents();
    }, 1000); // 1 second debounce
  }

  /**
   * Process all pending file events, categorizing them and routing
   * to the appropriate handler (bulk for new files, individual for modified).
   */
  async processPendingEvents() {
    if (this.processing) {
      // If already processing, rely on the existing debounce timeout or let it naturally drain
      return;
    }
    this.processing = true;

    try {
      const events = new Map(this.pendingEvents);
      this.pendingEvents.clear();

      const newFiles = [];
      const modifiedFiles = [];
      const deletedFiles = [];

      for (const [relativePath, event] of events) {
        if (event === 'unlink') {
          deletedFiles.push(relativePath);
          continue;
        }

        // Check file size before syncing
        const absPath = path.join(this.syncDir, relativePath);
        try {
          const stat = fs.statSync(absPath);
          if (stat.size > this.maxFileSize) {
            console.log(`[SyncManager] Skipping ${relativePath}: exceeds max file size`);
            continue;
          }
        } catch (e) {
          continue; // File may have been deleted between event and processing
        }

        const lastHash = this.syncState.getLastSyncedHash(relativePath);
        if (lastHash) {
          modifiedFiles.push(relativePath);
        } else {
          newFiles.push(relativePath);
        }
      }

      // Process each category
      if (deletedFiles.length > 0) {
        await this.processDeletes(deletedFiles);
      }
      if (newFiles.length > 0) {
        await this.processNewFiles(newFiles);
      }
      if (modifiedFiles.length > 0) {
        await this.processModifiedFiles(modifiedFiles);
      }
    } catch (e) {
      console.error('[SyncManager] Error processing events:', e.message);
    } finally {
      this.processing = false;
      // If more events accumulated during processing, handle them
      if (this.pendingEvents.size > 0) {
        this.scheduleProcessing();
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  BULK NEW FILE SYNC (Performance Path)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Sync many new files efficiently using the bulk endpoint.
   * Splits files into batches and sends concurrent HTTP requests.
   */
  async processNewFiles(filePaths) {
    const batches = [];
    for (let i = 0; i < filePaths.length; i += this.batchSize) {
      batches.push(filePaths.slice(i, i + this.batchSize));
    }

    // Process batches with limited concurrency
    for (let i = 0; i < batches.length; i += this.maxConcurrency) {
      const chunk = batches.slice(i, i + this.maxConcurrency);
      await Promise.all(chunk.map(batch => this.sendBulkNewFiles(batch)));
    }
  }

  /**
   * Build and send a bulk request for a batch of new files.
   */
  async sendBulkNewFiles(filePaths) {
    const operations = [];

    for (const relativePath of filePaths) {
      const absolutePath = path.join(this.syncDir, relativePath);
      try {
        const buf = fs.readFileSync(absolutePath);
        if (buf.length > this.maxFileSize) continue;

        const finalHash = sha256(buf);
        const base_full_hash = this.syncState.getLastSyncedHash(relativePath);

        // Build patches - send full content as new blocks
        const patches = [];
        for (let j = 0; j < buf.length; j += BLOCK_SIZE) {
          const chunk = buf.slice(j, Math.min(j + BLOCK_SIZE, buf.length));
          patches.push({
            type: 'new_block',
            index: Math.floor(j / BLOCK_SIZE),
            byte_index: j,
            data: chunk.toString('base64')
          });
        }
        if (patches.length === 0) {
          patches.push({ type: 'new_block', index: 0, byte_index: 0, data: '' });
        }

        operations.push({
          filePath: relativePath,
          base_full_hash,
          patches,
          final_full_hash: finalHash
        });
      } catch (e) {
        console.error(`[SyncManager] Error reading ${relativePath}:`, e.message);
      }
    }

    if (operations.length === 0) return;

    try {
      const res = await axios.post(`${this.peerUrl}/files/_bulk`, { operations }, {
        headers: { 'x-sync-secret': this.syncSecret },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 60000
      });

      if (res.data && res.data.results) {
        const updates = {};
        for (const result of res.data.results) {
          if (result.status === 'success' || result.status === 'conflict') {
            const op = operations.find(o => o.filePath === result.filePath);
            if (op) {
              updates[result.filePath] = op.final_full_hash;
            }
          }
        }
        if (Object.keys(updates).length > 0) {
          this.syncState.setBatch(updates);
        }
      }
    } catch (e) {
      console.error('[SyncManager] Bulk new files failed:', e.message);
      // Fall back to individual sync
      for (const op of operations) {
        try {
          await this.handleIndividualChange('add', op.filePath);
        } catch (e2) {
          console.error(`[SyncManager] Individual fallback failed for ${op.filePath}:`, e2.message);
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  BULK DELETE SYNC
  // ═══════════════════════════════════════════════════════════════════════════

  async processDeletes(filePaths) {
    const operations = filePaths.map(fp => ({
      filePath: fp,
      base_full_hash: this.syncState.getLastSyncedHash(fp),
      patches: [{ type: 'delete' }],
      final_full_hash: ''
    }));

    try {
      const res = await axios.post(`${this.peerUrl}/files/_bulk`, { operations }, {
        headers: { 'x-sync-secret': this.syncSecret },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 30000
      });

      if (res.data && res.data.results) {
        const toRemove = [];
        for (const result of res.data.results) {
          if (result.status === 'success') {
            toRemove.push(result.filePath);
          }
        }
        if (toRemove.length > 0) {
          this.syncState.removeBatch(toRemove);
        }
      }
    } catch (e) {
      console.error('[SyncManager] Bulk delete failed:', e.message);
      // Fall back to individual deletes
      for (const fp of filePaths) {
        await this.handleIndividualChange('unlink', fp);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  INDIVIDUAL DELTA SYNC (Modified Files)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Process modified files using individual delta sync with concurrency.
   */
  async processModifiedFiles(filePaths) {
    const queue = [...filePaths];

    const worker = async () => {
      while (queue.length > 0) {
        const fp = queue.shift();
        if (fp) {
          await this.handleIndividualChange('change', fp);
        }
      }
    };

    const workerCount = Math.min(filePaths.length, this.maxConcurrency);
    const workers = [];
    for (let i = 0; i < workerCount; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
  }

  /**
   * Handle a single file change using the full delta sync protocol:
   * 1. Fetch remote metadata (block hashes)
   * 2. Compute delta patches locally
   * 3. Send only changed blocks to peer
   */
  async handleIndividualChange(event, relativePath) {
    const absolutePath = path.join(this.syncDir, relativePath);
    const encodedPath = encodeURIComponent(relativePath);
    let remoteMetadata = {};

    // Retry logic for remote API
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await axios.get(`${this.peerUrl}/files/${encodedPath}/metadata`, {
          headers: { 'x-sync-secret': this.syncSecret },
          timeout: 5000
        });
        remoteMetadata = res.data;
        break;
      } catch (err) {
        if (err.response && err.response.status === 404) {
          break; // File doesn't exist on remote - that's fine for new files
        }
        if (err.response && err.response.status === 429) {
          // Rate limited - wait and retry
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        if (attempt === MAX_RETRIES) {
          console.error(`[SyncManager] Failed to reach peer for ${relativePath}`);
          return;
        }
        await new Promise(r => setTimeout(r, 500));
      }
    }

    try {
      const isDelete = event === 'unlink' || event === 'unlinkDir';
      let patches = [];
      let finalHash = '';

      // KEY FIX: Use last-synced hash instead of remote's current hash
      // This enables proper conflict detection
      const base_full_hash = this.syncState.getLastSyncedHash(relativePath);

      // Compute delta patches
      try {
        const result = await computePatches(absolutePath, remoteMetadata, isDelete);
        patches = result.patches;
        finalHash = result.final_full_hash;
      } catch (e) {
        if (isDelete) {
          patches = [{ type: 'delete' }];
        } else {
          console.error(`[SyncManager] Cannot read local file ${absolutePath}:`, e.message);
          return;
        }
      }

      // Send patches to peer
      try {
        await axios.patch(`${this.peerUrl}/files/${encodedPath}`, {
          base_full_hash,
          patches,
          final_full_hash: finalHash
        }, {
          headers: { 'x-sync-secret': this.syncSecret },
          timeout: 10000,
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        });

        // Success — update sync state
        if (isDelete) {
          this.syncState.removeLastSyncedHash(relativePath);
        } else {
          this.syncState.setLastSyncedHash(relativePath, finalHash);
        }
      } catch (e) {
        if (e.response && e.response.status === 409) {
          // Conflict handled by remote — update our sync state to prevent re-syncing
          console.log(`[SyncManager] Conflict detected for ${relativePath}`);
          if (finalHash) {
            this.syncState.setLastSyncedHash(relativePath, finalHash);
          }
        } else if (e.response && e.response.status === 413) {
          console.log(`[SyncManager] File too large: ${relativePath}`);
        } else {
          console.error(`[SyncManager] Failed to send patch for ${relativePath}:`, e.message);
        }
      }
    } catch (err) {
      console.error(`[SyncManager] Error handling change for ${relativePath}:`, err.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  INTERNAL CHANGE TRACKING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Mark a file as an internal modification to prevent sync loops.
   * When we write a file due to an incoming sync, chokidar would detect it
   * and try to sync it back — this prevents that.
   */
  markInternalChange(relativePath) {
    this.internalModifications.add(relativePath);
    // Safety cleanup after 10 seconds in case the event is never fired
    setTimeout(() => {
      this.internalModifications.delete(relativePath);
    }, 10000);
  }
}

module.exports = { SyncManager };
