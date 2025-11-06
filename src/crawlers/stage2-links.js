const path = require('path');
const fs = require('fs');
const pLimit = require('p-limit');
const config = require('../config');
const log = require('../utils/logger');
const { extractJobLinks } = require('../utils/job-links');
const { generateRequestId, setupJobLinksFolder, loadLinkReport, saveLinkReport, readGoogleResultsCsv, writeGoogleResultsCsv, getExistingJobUrls, appendToJobsCsv } = require('../utils/request-helpers');
const pupBrowser = require('../utils/browser');

const runStage2 = async (options = {}) => {
    log.info('Starting Stage 2: Job Link Extractor...');

    // Validate --run parameter
    if (!options.runId) {
        log.error('Stage 2 requires --run parameter. Usage: npm start -- --stage=2 --run={runId} [--id={runId}] [--clean]');
        process.exit(1);
    }

    const requestDir = path.join(config.output.dir, 'job_boards', options.runId);
    if (!fs.existsSync(requestDir)) {
        log.error(`Stage 1 run '${options.runId}' not found at ${requestDir}\nPlease run Stage 1 first with this jobId or use an existing one.`);
        process.exit(1);
    }

    const googleResultsCsv = path.join(requestDir, 'search-results.csv');
    if (!fs.existsSync(googleResultsCsv)) {
        log.error(`search-results.csv not found in ${requestDir}`);
        process.exit(1);
    }

    let jobId = options.jobId;
    if (!jobId) {
        jobId = generateRequestId();
        log.info(`No jobId provided. Generated jobId: ${jobId}`);
    }

    const { jobLinksDir, jobsCsvPath, reportPath } = setupJobLinksFolder(config.output.dir, jobId);
    log.info(`Job links folder: ${jobLinksDir}`);

    const report = loadLinkReport(reportPath);
    if (!report.link_extraction_report) {
        report.link_extraction_report = {};
    }

    // Handle --clean flag
    if (options.clean) {
        log.info(`Clean flag detected. Resetting job board URLs to pending...`);

        const googleRows = readGoogleResultsCsv(googleResultsCsv);
        let resetCount = 0;

        googleRows.forEach(row => {
            if (row.STATUS !== 'pending') {
                row.STATUS = 'pending';
                row.JOB_COUNT = '0';
                row.REMARKS = '';
                resetCount++;
            }
        });

        writeGoogleResultsCsv(googleResultsCsv, googleRows);

        report.link_extraction_report = {};
        saveLinkReport(reportPath, report);

        log.info(`Clean flag detected. Reset ${resetCount} job board URLs to pending`);
    }

    const allGoogleRows = readGoogleResultsCsv(googleResultsCsv);
    const urlsToProcess = allGoogleRows.filter(row => {
        const status = row.STATUS.toLowerCase();
        return status === 'pending' || status === 'failed';
    });

    if (urlsToProcess.length === 0) {
        log.info(`All job board URLs completed for jobId ${jobId}. Use --clean to reset.`);
        return;
    }

    const existingJobUrls = getExistingJobUrls(jobsCsvPath);

    const urlsNeedingProcessing = urlsToProcess.filter(row => {
        const url = row.URL;
        const reportEntry = report.link_extraction_report[url];

        return !reportEntry || reportEntry.status === false;
    });

    const alreadyProcessed = urlsToProcess.length - urlsNeedingProcessing.length;
    if (alreadyProcessed > 0) {
        log.info(`Resuming Stage 2: ${alreadyProcessed} URLs already processed, ${urlsNeedingProcessing.length} URLs remaining`);
    }

    if (urlsNeedingProcessing.length === 0) {
        log.info(`All job board URLs completed for jobId ${jobId}. Use --clean to reset.`);
        return;
    }

    const browser = await pupBrowser();

    const limit = pLimit(config.crawler.concurrency);
    let totalJobLinksExtracted = 0;
    let newJobLinksAdded = 0;
    let duplicatesSkipped = 0;
    let failedExtractions = 0;
    let successfulExtractions = 0;

    const processJobBoardURL = async (rowData, index) => {
        const url = rowData.URL;
        log.progress(`Processing job board ${index + 1} of ${urlsNeedingProcessing.length}: ${url}`);

        const page = await browser.newPage();

        try {
            await page.setUserAgent(config.crawler.userAgent);
            await page.setViewport({ width: 1920, height: 1080 });
            await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

            const jobLinks = await extractJobLinks(page, url);
            totalJobLinksExtracted += jobLinks.length;

            const newLinks = [];
            jobLinks.forEach(jobUrl => {
                if (existingJobUrls.has(jobUrl)) {
                    duplicatesSkipped++;
                } else {
                    existingJobUrls.add(jobUrl);
                    newLinks.push(jobUrl);
                }
            });

            if (newLinks.length > 0) {
                appendToJobsCsv(jobsCsvPath, newLinks);
                newJobLinksAdded += newLinks.length;
            }

            report.link_extraction_report[url] = {
                status: true,
                jobLinksFound: jobLinks.length,
                error: null
            };
            saveLinkReport(reportPath, report);

            const googleRows = readGoogleResultsCsv(googleResultsCsv);
            const rowToUpdate = googleRows.find(r => r.URL === url);
            if (rowToUpdate) {
                rowToUpdate.STATUS = 'completed';
                rowToUpdate.JOB_COUNT = String(jobLinks.length);
                writeGoogleResultsCsv(googleResultsCsv, googleRows);
            }

            successfulExtractions++;

        } catch (error) {
            log.error(`Failed to extract from ${url}: ${error.message}`);

            report.link_extraction_report[url] = {
                status: false,
                jobLinksFound: 0,
                error: error.message
            };
            saveLinkReport(reportPath, report);

            const googleRows = readGoogleResultsCsv(googleResultsCsv);
            const rowToUpdate = googleRows.find(r => r.URL === url);
            if (rowToUpdate) {
                rowToUpdate.STATUS = 'failed';
                rowToUpdate.REMARKS = error.message.substring(0, 100);
                writeGoogleResultsCsv(googleResultsCsv, googleRows);
            }

            failedExtractions++;

        } finally {
            await page.close();
        }
    };

    await Promise.all(
        urlsNeedingProcessing.map((rowData, index) =>
            limit(() => processJobBoardURL(rowData, index))
        )
    );

    await browser.close();

    // Final summary
    log.success(`Stage 2 complete for jobId: ${jobId}`);
    log.info(`Job board URLs processed: ${urlsNeedingProcessing.length}\nTotal job links extracted: ${totalJobLinksExtracted}\nNew job links added: ${newJobLinksAdded}\nDuplicates skipped: ${duplicatesSkipped}\nFailed extractions: ${failedExtractions}\nResults saved to: ${jobsCsvPath}`);

    return jobId;
};

module.exports = runStage2;
