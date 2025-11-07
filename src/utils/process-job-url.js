const path = require('path');
const fs = require('fs');
const { log, extractCompanyName, getNextJobNumber, saveJobToFile } = require('../utils');
const { updateJobStatus, saveDetailReport } = require('./request-helpers');
const { findProviderByUrl, getProviderById, DEFAULT_PROVIDER_ID } = require('../job-boards');

/**
 * Process a single job URL with retry logic
 * @param {string} url - Job URL to process
 * @param {number} index - Index in processing queue
 * @param {number} total - Total URLs to process
 * @param {string} jobsDir - Output directory for jobs
 * @param {Object} stats - Statistics object to update
 * @param {Object} opts - Additional options
 * @param {string} opts.jobsCsvPath - Path to jobs.csv to update
 * @param {Object} opts.detailReport - Reference to detail report object
 * @param {string} opts.reportPath - Path to save report.json
 * @param {number} opts.currentRetryCount - Current retry count from CSV
 * @returns {Promise<void>}
 */
const processJobURL = async (url, index, total, jobsDir, stats, opts = {}) => {
    const {
        jobsCsvPath,
        detailReport,
        reportPath,
        currentRetryCount = 0,
        providerId: providerIdHint = DEFAULT_PROVIDER_ID,
        jobRecord = null
    } = opts;

    const providerFromRecord = providerIdHint ? getProviderById(providerIdHint) : null;
    const providerFromUrl = findProviderByUrl(url);
    const provider = providerFromRecord || providerFromUrl || null;
    const resolvedProviderId = provider ? provider.id : (providerIdHint || DEFAULT_PROVIDER_ID);
    const providerSupportsDetail = provider && typeof provider.fetchJobDetail === 'function';

    if (!providerSupportsDetail) {
        const reason = provider ? `Provider ${resolvedProviderId} does not support detail extraction` : 'No provider found';
        log.error(`Extraction failed for ${url}: ${reason}`);

        stats.failedCount++;

        if (jobsCsvPath) {
            const newRetryCount = currentRetryCount + 1;
            updateJobStatus(jobsCsvPath, url, 'failed', reason, '', newRetryCount, 'unavailable');
        }

        if (detailReport && reportPath) {
            const companyName = extractCompanyName(url);
            if (!detailReport.detail_extraction_report[companyName]) {
                detailReport.detail_extraction_report[companyName] = {
                    passedUrls: [],
                    failedUrls: []
                };
            }

            detailReport.detail_extraction_report[companyName].failedUrls.push({
                url,
                provider: resolvedProviderId,
                reason,
            });

            saveDetailReport(reportPath, detailReport);
        }

        return;
    }

    let providerContext = null;
    if (provider && typeof provider.prepareJobDetail === 'function') {
        try {
            providerContext = await provider.prepareJobDetail({
                url,
                jobRecord,
                logger: log
            });
        } catch (prepareError) {
            log.warn(`Provider ${resolvedProviderId} prepareJobDetail failed for ${url}: ${prepareError.message}`);
        }
    }

    log.progress(`Processing job ${index + 1}/${total}: ${url} (provider: ${resolvedProviderId})`);

    const maxRetries = process.env.MAX_RETRIES || 3;
    let lastError = null;
    const companyName = extractCompanyName(url);
    let providerDiagnostics = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        let usedProviderExtractor = false;
        const attemptNumber = attempt + 1;

        providerDiagnostics = null;

        try {
            let jobData = null;

            try {
                const providerResult = await provider.fetchJobDetail({
                    url,
                    providerId: resolvedProviderId,
                    attempt,
                    logger: log,
                    context: providerContext || undefined,
                    jobRecord
                });

                if (providerResult) {
                    const candidateJob = providerResult.job || providerResult;
                    if (providerResult.diagnostics) {
                        providerDiagnostics = {
                            attempt: attemptNumber,
                            ...providerResult.diagnostics
                        };
                    }

                    if (candidateJob) {
                        jobData = candidateJob;
                        usedProviderExtractor = true;
                    }
                }
            } catch (providerError) {
                providerDiagnostics = providerDiagnostics || { attempt: attemptNumber };
                providerDiagnostics.error = providerDiagnostics.error || providerError.message;
                providerDiagnostics.status = providerDiagnostics.status || providerError.status || providerError.code;
                log.warn(`Provider ${resolvedProviderId} fetchJobDetail failed for ${url}: ${providerError.message}`);
                throw providerError;
            }

            if (!jobData) {
                const diagnosticsError = providerDiagnostics && providerDiagnostics.error
                    ? providerDiagnostics.error
                    : 'provider-returned-no-job';
                const detailError = new Error(diagnosticsError);
                detailError.nonRetryable = true;
                detailError.providerDiagnostics = providerDiagnostics;
                throw detailError;
            }

            if (provider && typeof provider.postProcessJobDetail === 'function' && jobData) {
                try {
                    const refined = await provider.postProcessJobDetail({
                        jobData,
                        context: providerContext || undefined
                    });
                    if (refined) {
                        jobData = refined;
                    }
                } catch (postProcessError) {
                    log.warn(`Provider ${resolvedProviderId} postProcessJobDetail failed for ${url}: ${postProcessError.message}`);
                }
            }
            const companyDir = path.join(jobsDir, companyName);

            if (!fs.existsSync(companyDir)) {
                fs.mkdirSync(companyDir, { recursive: true });
            }

            const jobNumber = getNextJobNumber(companyDir);
            const fileName = saveJobToFile(jobData, companyDir, jobNumber);

            stats.companyJobCounts[companyName] = (stats.companyJobCounts[companyName] || 0) + 1;
            stats.successCount++;

            if (jobData.source === 'structured-data') stats.structuredCount++;
            if (jobData.source === 'intelligent-analysis') stats.intelligentCount++;

            if (!stats.detailStrategyCounts) {
                stats.detailStrategyCounts = {};
            }

            const extractionTag = jobData.source ? `${jobData.source}${usedProviderExtractor ? ' (provider)' : ''}` : (usedProviderExtractor ? 'provider' : 'unknown');
            log.info(`Extracted via ${extractionTag}`);
            log.info(`Saved: ${companyName}/${fileName} - "${jobData.title}" [provider: ${resolvedProviderId}]`);

            if (jobsCsvPath) {
                const fileNamePath = `${companyName}/${fileName}`;
                updateJobStatus(jobsCsvPath, url, 'done', '', fileNamePath, currentRetryCount);
            }

            if (detailReport && reportPath) {
                if (!detailReport.detail_extraction_report[companyName]) {
                    detailReport.detail_extraction_report[companyName] = {
                        passedUrls: [],
                        failedUrls: []
                    };
                }

                detailReport.detail_extraction_report[companyName].passedUrls.push({
                    url,
                    provider: resolvedProviderId,
                    diagnostics: providerDiagnostics || undefined
                });

                saveDetailReport(reportPath, detailReport);
            }
            return; // Success - exit retry loop

        } catch (error) {
            lastError = error;
            if (error.providerDiagnostics) {
                providerDiagnostics = error.providerDiagnostics;
            }

            const isRetryable = (() => {
                if (error && error.nonRetryable) {
                    return false;
                }

                const message = (error && error.message) || '';
                const retryablePatterns = ['ERR_HTTP2_PROTOCOL_ERROR', 'ERR_CONNECTION', 'timeout', 'Navigation'];
                if (retryablePatterns.some(pattern => message.includes(pattern))) {
                    return true;
                }

                const status = providerDiagnostics && providerDiagnostics.status;
                if (typeof status === 'number') {
                    if (status === 429) {
                        return true;
                    }
                    if (status >= 500 && status < 600) {
                        return true;
                    }
                }

                return false;
            })();

            if (isRetryable && attempt < maxRetries - 1) {
                const delay = 2000 * Math.pow(2, attempt);
                log.info(`Attempt ${attempt + 1} failed for ${url}, retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }

            break;
        }
    }

    const failureReason = (providerDiagnostics && providerDiagnostics.error) || (lastError && lastError.message) || 'Unknown extraction error';
    log.error(`Extraction failed for ${url}: ${failureReason}`);

    stats.failedCount++;

    if (jobsCsvPath) {
        const newRetryCount = currentRetryCount + 1;
        updateJobStatus(jobsCsvPath, url, 'failed', failureReason, '', newRetryCount);
    }

    if (detailReport && reportPath) {
        if (!detailReport.detail_extraction_report[companyName]) {
            detailReport.detail_extraction_report[companyName] = {
                passedUrls: [],
                failedUrls: []
            };
        }

        detailReport.detail_extraction_report[companyName].failedUrls.push({
            url,
            provider: resolvedProviderId,
            reason: failureReason,
            diagnostics: providerDiagnostics || undefined
        });

        saveDetailReport(reportPath, detailReport);
    }
};

module.exports = processJobURL;