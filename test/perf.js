const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NUM_FILES = 100; 
const FILE_SIZE = 1024; // 1KB per file
const TIMEOUT_MS = 30000; // 30 seconds timeout
const POLL_INTERVAL_MS = 200;
const SETTLE_TIME_MS = 2000; // Time to wait for writes to finish

/**
 * Performance test: creates 100 small files in sync_dir_a and verifies
 * they all appear with matching content in sync_dir_b within 30 seconds.
 */
async function run() {
  const syncDirA = path.resolve(__dirname, '../sync_dir_a');
  const syncDirB = path.resolve(__dirname, '../sync_dir_b');

  // Ensure directories exist
  if (!fs.existsSync(syncDirA)) fs.mkdirSync(syncDirA, { recursive: true });
  if (!fs.existsSync(syncDirB)) fs.mkdirSync(syncDirB, { recursive: true });

  // Clean up directories (only perf_* files, preserve .sync_state.json etc.)
  const cleanDir = (dir) => {
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file.startsWith('.')) continue; // Skip dotfiles
        const fullPath = path.join(dir, file);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isFile()) {
            fs.unlinkSync(fullPath);
          }
        } catch (e) {}
      }
    } catch (e) {}
  };

  console.log('Cleaning sync directories...');
  cleanDir(syncDirA);
  cleanDir(syncDirB);

  // Wait for cleanup to propagate
  await new Promise(r => setTimeout(r, 2000));

  const runId = Date.now();
  console.log(`Writing ${NUM_FILES} files (${FILE_SIZE} bytes each) to sync_dir_a...`);
  const startTime = Date.now();

  // Generate file contents and write to sync_dir_a
  const fileContents = new Map();
  for (let i = 0; i < NUM_FILES; i++) {
    const fileName = `perf_${runId}_${i}.txt`;
    const content = crypto.randomBytes(FILE_SIZE).toString('hex').slice(0, FILE_SIZE);
    fileContents.set(fileName, content);
    fs.writeFileSync(path.join(syncDirA, fileName), content);
  }

  const writeTime = Date.now() - startTime;
  console.log(`Finished writing ${NUM_FILES} files in ${writeTime}ms. Polling sync_dir_b...`);

  // Poll sync_dir_b until all files appear
  return new Promise((resolve) => {
    let lastCount = 0;

    const pollInterval = setInterval(() => {
      let syncedCount = 0;

      try {
        const bFiles = fs.readdirSync(syncDirB).filter(f => f.startsWith(`perf_${runId}_`));
        syncedCount = bFiles.length;
      } catch (e) {
        // Directory might be temporarily unavailable
      }

      const elapsed = Date.now() - startTime;

      // Progress reporting (only when count changes)
      if (syncedCount !== lastCount) {
        console.log(`  [${(elapsed / 1000).toFixed(1)}s] ${syncedCount}/${NUM_FILES} files detected`);
        lastCount = syncedCount;
      }

      if (syncedCount >= NUM_FILES) {
        clearInterval(pollInterval);
        const duration = Date.now() - startTime;
        console.log(`\nAll ${NUM_FILES} files detected in ${duration}ms (${(duration / 1000).toFixed(1)}s)`);
        console.log(`Allowing ${SETTLE_TIME_MS / 1000} seconds for the sync agent to finish writing data to disk...`);

        // Wait for the files to be fully written before verifying
        setTimeout(() => {
          let mismatches = 0;
          
          // Verify EVERY file instead of random sampling
          for (let i = 0; i < NUM_FILES; i++) {
            const fileName = `perf_${runId}_${i}.txt`; 
            try {
              const contentA = fs.readFileSync(path.join(syncDirA, fileName), 'utf8');
              const contentB = fs.readFileSync(path.join(syncDirB, fileName), 'utf8');
              
              if (contentA !== contentB) {
                console.error(`Mismatch in ${fileName}: Expected ${contentA.length} chars, got ${contentB.length} chars.`);
                mismatches++;
              }
            } catch (e) {
              console.error(`Error reading ${fileName} during verification:`, e.message);
              mismatches++;
            }
          }

          if (mismatches > 0) {
            console.error(`\n❌ Content mismatch in ${mismatches}/${NUM_FILES} files!`);
            process.exit(1);
          }

          console.log(`Content verification passed (All ${NUM_FILES} files match perfectly).`);

          if (duration <= TIMEOUT_MS) {
            console.log(`\n✅ PASS: Synced ${NUM_FILES} files in ${(duration / 1000).toFixed(1)}s (limit: ${TIMEOUT_MS / 1000}s)`);
            resolve();
            process.exit(0);
          } else {
            console.error(`\n❌ FAIL: Took ${(duration / 1000).toFixed(1)}s (limit: ${TIMEOUT_MS / 1000}s)`);
            process.exit(1);
          }
        }, SETTLE_TIME_MS);
      } else if (Date.now() - startTime > TIMEOUT_MS) {
        // Timeout check
        clearInterval(pollInterval);
        console.error(`\n❌ TIMEOUT: Only synced ${syncedCount}/${NUM_FILES} files in ${TIMEOUT_MS / 1000}s`);
        process.exit(1);
      }
    }, POLL_INTERVAL_MS);
  });
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});