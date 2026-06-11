const fs = require('fs');
const path = require('path');

/**
 * Persistent store for last-synced file hashes.
 * Stored as .sync_state.json in the sync directory (ignored by chokidar as a dotfile).
 * Used to detect conflicts: if a file's current hash differs from the last-synced hash,
 * it means the file was modified independently (e.g., while offline).
 */
class SyncState {
  constructor(syncDir) {
    this.syncDir = syncDir;
    this.stateFile = path.join(syncDir, '.sync_state.json');
    this.state = {};
    this.dirty = false;
    this.saveTimer = null;
    this.load();
  }

  /**
   * Load sync state from disk.
   */
  load() {
    try {
      if (fs.existsSync(this.stateFile)) {
        const data = fs.readFileSync(this.stateFile, 'utf8');
        this.state = JSON.parse(data);
        console.log(`[SyncState] Loaded ${Object.keys(this.state).length} entries`);
      }
    } catch (e) {
      console.error('[SyncState] Failed to load:', e.message);
      this.state = {};
    }
  }

  /**
   * Save sync state to disk immediately.
   */
  saveImmediate() {
    if (!this.dirty) return;
    this.dirty = false;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state));
    } catch (e) {
      console.error('[SyncState] Failed to save:', e.message);
    }
  }

  /**
   * Schedule a debounced save (200ms delay for batching rapid updates).
   */
  scheduleSave() {
    this.dirty = true;
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.saveImmediate();
      }, 200);
    }
  }

  /**
   * Get the last synced hash for a file.
   * @param {string} filePath - Relative path within sync directory
   * @returns {string|null} SHA-256 hash or null if never synced
   */
  getLastSyncedHash(filePath) {
    return this.state[filePath] || null;
  }

  /**
   * Record a successful sync for a file.
   * @param {string} filePath - Relative path within sync directory
   * @param {string} hash - SHA-256 hash of the synced content
   */
  setLastSyncedHash(filePath, hash) {
    this.state[filePath] = hash;
    this.scheduleSave();
  }

  /**
   * Remove sync state for a deleted file.
   * @param {string} filePath - Relative path within sync directory
   */
  removeLastSyncedHash(filePath) {
    delete this.state[filePath];
    this.scheduleSave();
  }

  /**
   * Batch-update sync state for multiple files (saves immediately).
   * @param {Object} entries - { filePath: hash } mapping
   */
  setBatch(entries) {
    for (const [filePath, hash] of Object.entries(entries)) {
      this.state[filePath] = hash;
    }
    this.dirty = true;
    this.saveImmediate();
  }

  /**
   * Batch-remove sync state for multiple deleted files (saves immediately).
   * @param {string[]} filePaths - Array of relative paths
   */
  removeBatch(filePaths) {
    for (const fp of filePaths) {
      delete this.state[fp];
    }
    this.dirty = true;
    this.saveImmediate();
  }

  /**
   * Get all sync state entries.
   * @returns {Object} Copy of the full state
   */
  getAllEntries() {
    return { ...this.state };
  }
}

module.exports = { SyncState };
