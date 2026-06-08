const fs = require('fs');
const path = require('path');

const NUM_FILES = 10000;
const TIMEOUT_MS = 30000;

async function run() {
    const syncDirA = path.resolve(__dirname, '../sync_dir_a');
    const syncDirB = path.resolve(__dirname, '../sync_dir_b');

    if (!fs.existsSync(syncDirA)) fs.mkdirSync(syncDirA, { recursive: true });
    if (!fs.existsSync(syncDirB)) fs.mkdirSync(syncDirB, { recursive: true });

    // Clean up directories
    const cleanDir = (dir) => {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            fs.unlinkSync(path.join(dir, file));
        }
    };
    cleanDir(syncDirA);
    cleanDir(syncDirB);

    console.log(`Writing ${NUM_FILES} files to ${syncDirA}...`);

    const startTime = Date.now();

    for (let i = 0; i < NUM_FILES; i++) {
        fs.writeFileSync(path.join(syncDirA, `perf_${i}.txt`), `Content of file ${i}`);
    }

    console.log('Finished writing files. Polling syncDirB...');

    const pollInterval = setInterval(() => {
        const bFiles = fs.readdirSync(syncDirB).filter(f => f.startsWith('perf_'));
        
        if (bFiles.length === NUM_FILES) {
            clearInterval(pollInterval);
            const duration = Date.now() - startTime;
            console.log(`All files synced in ${duration}ms!`);
            
            // Random check
            const sampleCheck = Math.floor(Math.random() * NUM_FILES);
            const sampleContentA = fs.readFileSync(path.join(syncDirA, `perf_${sampleCheck}.txt`), 'utf8');
            const sampleContentB = fs.readFileSync(path.join(syncDirB, `perf_${sampleCheck}.txt`), 'utf8');
            
            if (sampleContentA === sampleContentB) {
                if (duration <= TIMEOUT_MS) {
                    process.exit(0);
                } else {
                    console.error('Test passed but took longer than 30 seconds');
                    process.exit(1);
                }
            } else {
                console.error('Content mismatch!');
                process.exit(1);
            }
        }

        if (Date.now() - startTime > TIMEOUT_MS) {
            clearInterval(pollInterval);
            console.error(`Timeout! Only synced ${bFiles.length} files in 30 seconds.`);
            process.exit(1);
        }
    }, 1000);
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
