const chokidar = require('chokidar');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const util = require('util');
const { computePatches } = require('./delta');

class SyncManager {
  constructor(syncDir, peerUrl) {
    this.syncDir = syncDir;
    this.peerUrl = peerUrl;
    this.internalModifications = new Set();
    this.watcher = null;
  }

  start() {
    this.watcher = chokidar.watch(this.syncDir, {
      ignored: /(^|[\/\\])\..|.*\.conflicted\..*/,
      persistent: true,
      ignoreInitial: true,
      usePolling: true,
      interval: 100,
    });

    this.watcher.on('all', async (event, filePath) => {
      console.log(`[Chokidar] Detected ${event} on ${filePath}`);
      const relativePath = path.relative(this.syncDir, filePath);
      
      // Prevent loops
      if (this.internalModifications.has(relativePath)) {
        this.internalModifications.delete(relativePath);
        return;
      }

      await this.handleLocalChange(event, relativePath, filePath);
    });
  }

  async handleLocalChange(event, relativePath, absolutePath) {
    const encodedPath = encodeURIComponent(relativePath);
    let remoteMetadata = {};
    const MAX_RETRIES = 5;
    
    // retry logic for remote API
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const res = await axios.get(`${this.peerUrl}/files/${encodedPath}/metadata`);
            remoteMetadata = res.data;
            break;
        } catch (err) {
            if (err.response && err.response.status === 404) {
               // remote doesn't have it, that's fine for new files
               break; 
            }
            if (attempt === MAX_RETRIES) {
                console.error(`Failed to reach peer for ${relativePath}`);
                return;
            }
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    try {
        const isDelete = event === 'unlink' || event === 'unlinkDir';
        let patches = [];
        let finalHash = '';
        
        let shouldSync = true;
        let base_full_hash = remoteMetadata.full_hash || null;
        
        // Compute patches
        try {
            const result = await computePatches(absolutePath, remoteMetadata, isDelete);
            patches = result.patches;
            finalHash = result.final_full_hash;
        } catch (e) {
            if(isDelete) {
               patches = [{type: 'delete'}];
            } else {
               console.error(`Cannot read local file ${absolutePath}:`, e);
               shouldSync = false;
            }
        }
        
        if (shouldSync) {
            try {
               await axios.patch(`${this.peerUrl}/files/${encodedPath}`, {
                   base_full_hash,
                   patches,
                   final_full_hash: finalHash
               });
            } catch(e) {
               if(e.response && e.response.status === 409) {
                  // Conflict handled by remote, that's fine
                  console.log(`Conflict detected by peer for ${relativePath}`);
               } else {
                  console.error(`Failed to send patch for ${relativePath}:`, e.message);
               }
            }
        }
    } catch (err) {
        console.error(`Error handling local change for ${relativePath}:`, err);
    }
  }

  markInternalChange(relativePath) {
    this.internalModifications.add(relativePath);
    setTimeout(() => {
        this.internalModifications.delete(relativePath); // Safety cleanup
    }, 5000);
  }
}

module.exports = { SyncManager };
