const path = require('path');
const fs = require('fs');
const pLimit = require('p-limit');
const config = require('../config');
const log = require('../utils/logger');
const { findProviderByUrl, DEFAULT_PROVIDER_ID } = require('../job-boards');
const { generateRequestId, setupJobLinksFolder, loadLinkReport, saveLinkReport, readGoogleResultsCsv, writeGoogleResultsCsv, getExistingJobUrls, appendToJobsCsv } = require('../utils/request-helpers');

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

    const limit = pLimit(config.crawler.concurrency);
    let totalJobLinksExtracted = 0;
    let newJobLinksAdded = 0;
    let duplicatesSkipped = 0;
    let failedExtractions = 0;

    const processJobBoardURL = async (rowData, index) => {
        const url = rowData.URL;
        const provider = findProviderByUrl(url);
        const providerId = provider ? provider.id : DEFAULT_PROVIDER_ID;

        log.progress(`Processing job board ${index + 1} of ${urlsNeedingProcessing.length}: ${url} (provider: ${providerId})`);

        try {
            if (typeof provider.collectJobLinks !== 'function') {
                const reason = `Provider '${providerId}' does not implement collectJobLinks.`;
                throw new Error(reason);
            }

            const normalizeLinkUrl = (rawUrl) => {
                if (!rawUrl) {
                    return rawUrl;
                }

                if (typeof provider.normalizeJobUrl === 'function') {
                    try {
                        return provider.normalizeJobUrl(rawUrl) || rawUrl;
                    } catch (normalizationError) {
                        log.warn(`Provider ${providerId} normalizeJobUrl failed for ${rawUrl}: ${normalizationError.message}`);
                    }
                }

                return rawUrl;
            };

            const normalizeJobLinkEntry = (value) => {
                if (!value && value !== 0) {
                    return null;
                }

                if (typeof value === 'string') {
                    const normalizedUrl = normalizeLinkUrl(value);
                    return { url: normalizedUrl, providerId };
                }

                if (typeof value === 'object') {
                    const entryUrl = value.url || value.URL || value.href || '';
                    if (!entryUrl) {
                        return null;
                    }

                    const normalizedUrl = normalizeLinkUrl(entryUrl);
                    return {
                        url: normalizedUrl,
                        providerId: value.providerId || value.provider || value.PROVIDER || providerId
                    };
                }

                return null;
            };

            let providerDiagnostics = null;
            let providerApiEndpoint = null;
            let extractedEntries = [];

            try {
                const providerResult = await provider.collectJobLinks({
                    url,
                    logger: log,
                    requestRow: rowData
                });

                const candidateList = providerResult && (providerResult.jobUrls || providerResult.jobLinks || providerResult.jobs);
                if (Array.isArray(candidateList)) {
                    extractedEntries = candidateList
                        .map(normalizeJobLinkEntry)
                        .filter(Boolean);
                    providerDiagnostics = providerResult.diagnostics || null;
                    providerApiEndpoint = providerResult.api || null;
                    log.info(`Provider ${provider.id} returned ${extractedEntries.length} job link(s).`);
                }
            } catch (providerError) {
                log.warn(`Provider ${provider.id} collectJobLinks failed for ${url}: ${providerError.message}`);
                throw providerError;
            }

            if (!Array.isArray(extractedEntries)) {
                extractedEntries = [];
            }

            if (extractedEntries.length === 0) {
                log.info(`Provider ${providerId} returned no job links.`);
            }

            totalJobLinksExtracted += extractedEntries.length;

            const newLinks = [];
            extractedEntries.forEach(entry => {
                const jobUrl = entry.url;
                if (existingJobUrls.has(jobUrl)) {
                    duplicatesSkipped++;
                } else {
                    existingJobUrls.add(jobUrl);
                    newLinks.push(entry);
                }
            });

            if (newLinks.length > 0) {
                appendToJobsCsv(jobsCsvPath, newLinks, providerId);
                newJobLinksAdded += newLinks.length;
            }

            report.link_extraction_report[url] = {
                status: true,
                provider: providerId,
                jobLinksFound: extractedEntries.length,
                newJobLinksAdded: newLinks.length,
                duplicatesSkipped: extractedEntries.length - newLinks.length,
                error: null,
                api: providerApiEndpoint
            };
            if (providerDiagnostics) {
                report.link_extraction_report[url].diagnostics = providerDiagnostics;
            }
            saveLinkReport(reportPath, report);

            const googleRows = readGoogleResultsCsv(googleResultsCsv);
            const rowToUpdate = googleRows.find(r => r.URL === url);
            if (rowToUpdate) {
                rowToUpdate.STATUS = 'completed';
                rowToUpdate.JOB_COUNT = String(extractedEntries.length);
                writeGoogleResultsCsv(googleResultsCsv, googleRows);
            }
        } catch (error) {
            log.error(`Failed to extract from ${url}: ${error.message}`);

            report.link_extraction_report[url] = {
                status: false,
                provider: providerId,
                jobLinksFound: 0,
                newJobLinksAdded: 0,
                duplicatesSkipped: 0,
                error: error.message,
                api: null
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
        }
    };

    await Promise.all(
        urlsNeedingProcessing.map((rowData, index) =>
            limit(() => processJobBoardURL(rowData, index))
        )
    );

    // Final summary
    log.success(`Stage 2 complete for jobId: ${jobId}`);
    log.info(`Job board URLs processed: ${urlsNeedingProcessing.length}\nTotal job links extracted: ${totalJobLinksExtracted}\nNew job links added: ${newJobLinksAdded}\nDuplicates skipped: ${duplicatesSkipped}\nFailed extractions: ${failedExtractions}\nResults saved to: ${jobsCsvPath}`);

    return jobId;
};

module.exports = runStage2;
