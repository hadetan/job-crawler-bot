const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./utils/logger');
const runStage1 = require('./crawlers/stage1-search');
const runStage2 = require('./crawlers/stage2-links');
const runStage3 = require('./crawlers/stage3-details');

const parseArgs = () => {
    const args = process.argv.slice(2);
    const stageArg = args.find(arg => arg.startsWith('--stage='));
    const idArg = args.find(arg => arg.startsWith('--id='));
    const runArg = args.find(arg => arg.startsWith('--run='));
    const cleanFlag = args.includes('--clean');

    let stage = null;
    if (stageArg) {
        stage = parseInt(stageArg.split('=')[1], 10);
    }

    let requestId = null;
    if (idArg) {
        requestId = idArg.split('=')[1];
    }

    let runId = null;
    if (runArg) {
        runId = runArg.split('=')[1];
    }

    return { stage, requestId, runId, clean: cleanFlag };
};

const validateInputFile = (filePath, stageName) => {
    if (!fs.existsSync(filePath)) {
        log.error(`Cannot run ${stageName} - ${filePath} not found. Run previous stage first.`);
        process.exit(1);
    }
};

(async () => {
    const startTime = Date.now();

    try {
        const { stage, requestId, runId, clean } = parseArgs();

        if (stage !== null) {
            if (stage === 1) {
                await runStage1({ requestId, clean });
            } else if (stage === 2) {
                /**
                 * --run specifies which Stage 1 output to read from (requestId)
                 * --id specifies where to save Stage 2 results (jobId)
                 */
                await runStage2({ requestId: runId, jobId: requestId, clean });
            } else if (stage === 3) {
                validateInputFile(path.join(config.output.dir, 'job_links.csv'), 'Stage 3');
                await runStage3();
            } else {
                log.error(`Invalid stage '${stage}'. Valid stages are 1, 2, or 3.`);
                process.exit(1);
            }
        } else {
            await runStage1({ requestId, clean });
            await runStage2();
            await runStage3();
        }

        const endTime = Date.now();
        const duration = ((endTime - startTime) / 1000).toFixed(2);
        log.success(`All operations completed in ${duration}s`);
    } catch (error) {
        log.error(`Fatal error: ${error.message}`);
        process.exit(1);
    }
})();
