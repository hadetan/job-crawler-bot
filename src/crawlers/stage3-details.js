const path = require('path');
const fs = require('fs');
const pLimit = require('p-limit');
const config = require('../config');
const log = require('../utils/logger');
const { generateRequestId, setupJobsFolder, readJobsCsv, loadDetailReport } = require('../utils/request-helpers');
const { DEFAULT_PROVIDER_ID } = require('../job-boards');
const processJobURL = require('../utils/process-job-url');
const pupBrowser = require('../utils/browser');

const runStage3 = async (options = {}) => {
    log.info('Starting Stage 3: Job Details Extractor...');

    // Validate --run parameter
    if (!options.runId) {
        log.error('Stage 3 requires --run parameter. Usage: npm start -- --stage=3 --run={jobId} [--id={extractionId}] [--force]');
        process.exit(1);
    }

    const jobId = options.runId;

    const jobLinksDir = path.join(config.output.dir, 'job_links', jobId);
    if (!fs.existsSync(jobLinksDir)) {
        log.error(`Job ID '${jobId}' not found at ${jobLinksDir}`);
        log.error('Please run Stage 2 first with this jobId or use an existing one.');
        process.exit(1);
    }

    let extractionId = options.extractionId;
    if (!extractionId) {
        extractionId = generateRequestId();
        log.info(`No extractionId provided. Generated extractionId: ${extractionId}`);
    }

    const { jobsDir, reportPath } = setupJobsFolder(config.output.dir, extractionId);

    const isResume = fs.existsSync(reportPath);
    if (isResume) {
        log.info(`Resuming extraction from existing folder: ${extractionId}`);
    }
    log.info(`Extraction folder: ${jobsDir}`);

    const jobsCsvPath = path.join(jobLinksDir, 'jobs.csv');
    if (!fs.existsSync(jobsCsvPath)) {
        log.error(`jobs.csv not found at ${jobsCsvPath}`);
        process.exit(1);
    }

    const allJobs = readJobsCsv(jobsCsvPath);
    if (allJobs.length === 0) {
        log.info('No jobs found in jobs.csv');
        return;
    }

    const maxRetryCount = config.retry.maxRetryCount;
    let urlsToProcess = [];
    let doneCount = 0;
    let skippedMaxRetries = 0;

    if (options.force) {
        // Force mode: only process failed URLs, ignore retry count
        log.info('Force mode: Processing only failed URLs (ignoring retry count)');
        urlsToProcess = allJobs.filter(job => job.STATUS.toLowerCase() === 'failed');
    } else {
        // Normal mode: process pending OR (failed with RETRY < MAX_RETRY_COUNT)
        urlsToProcess = allJobs.filter(job => {
            const status = job.STATUS.toLowerCase();
            const retryCount = parseInt(job.RETRY, 10) || 0;

            if (status === 'done') {
                doneCount++;
                return false;
            }

            if (status === 'pending') {
                return true;
            }

            if (status === 'failed') {
                if (retryCount >= maxRetryCount) {
                    skippedMaxRetries++;
                    return false;
                }
                return true;
            }

            return false;
        });
    }

    log.info(`Total jobs in CSV: ${allJobs.length}`);
    log.info(`Jobs to process: ${urlsToProcess.length}`);
    log.info(`Already completed: ${doneCount}`);

    if (skippedMaxRetries > 0) {
        log.info(`Skipped (max retries): ${skippedMaxRetries}`);
        log.info(`Skipping ${skippedMaxRetries} URLs that reached max retry count (${maxRetryCount})`);
    }

    if (urlsToProcess.length === 0) {
        log.info('No jobs to process. All jobs are either completed or have reached max retry count.');
        return;
    }

    const detailReport = loadDetailReport(reportPath);

    const browser = await pupBrowser();

    const stats = {
        successCount: 0,
        failedCount: 0,
        structuredCount: 0,
        intelligentCount: 0,
        companyJobCounts: {}
    };

    const limit = pLimit(config.crawler.concurrency);
    await Promise.all(
        urlsToProcess.map((job, index) =>
            limit(() => processJobURL(
                browser,
                job.URL,
                index,
                urlsToProcess.length,
                jobsDir,
                stats,
                {
                    jobsCsvPath,
                    detailReport,
                    reportPath,
                    currentRetryCount: parseInt(job.RETRY, 10) || 0,
                    providerId: job.PROVIDER || DEFAULT_PROVIDER_ID
                }
            ))
        )
    );

    await browser.close();

    // Log summary
    log.success(`Stage 3 complete: ${stats.successCount} jobs saved to ${jobsDir}`);
    log.info(`Summary - Total processed: ${urlsToProcess.length}, Successful: ${stats.successCount}, Failed: ${stats.failedCount}`);
    
    if (skippedMaxRetries > 0) {
        log.info(`URLs skipped (max retries reached): ${skippedMaxRetries}`);
    }
    
    log.info(`Extraction methods - Structured Data: ${stats.structuredCount}, Intelligent Analysis: ${stats.intelligentCount}`);

    if (Object.keys(stats.companyJobCounts).length > 0) {
        log.info('Jobs saved by company:');
        Object.entries(stats.companyJobCounts).sort().forEach(([company, count]) => {
            log.info(`  ${company}: ${count} jobs`);
        });
    }

    return extractionId;
};

module.exports = runStage3;
