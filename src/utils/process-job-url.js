const path = require('path');
const fs = require('fs');
const config = require('../config');
const { normalizeURL, log, extractCompanyName, getProcessedJobs, getNextJobNumber, saveJobToFile } = require('../utils');
const { extractJobLinks } = require('../utils/job-links');
const extractJobDetails = require('../utils/extract-job-details');
const { updateJobStatus, saveDetailReport } = require('./request-helpers');
const { findProviderByUrl, getProviderById, DEFAULT_PROVIDER_ID } = require('../job-boards');
const { createPageController, configurePage } = require('../utils/browser');

/**
 * Process a single job URL with retry logic
 * @param {Browser} browser - Puppeteer browser instance
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
 * @param {number} opts.depth - Recursion depth for listing pages
 * @returns {Promise<void>}
 */
const processJobURL = async (browser, url, index, total, jobsDir, stats, opts = {}) => {
    const {
        jobsCsvPath,
        detailReport,
        reportPath,
        currentRetryCount = 0,
        depth = 0,
        providerId: providerIdHint = DEFAULT_PROVIDER_ID,
        jobRecord = null
    } = opts;

    const providerFromRecord = providerIdHint ? getProviderById(providerIdHint) : null;
    const providerFromUrl = findProviderByUrl(url);
    const provider = providerFromRecord || providerFromUrl || null;
    const resolvedProviderId = provider ? provider.id : (providerIdHint || DEFAULT_PROVIDER_ID);
    const providerSupportsDetail = provider && typeof provider.fetchJobDetail === 'function';
    const providerUsesBrowser = providerSupportsDetail ? provider.usesBrowser !== false : true;

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

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const pageController = createPageController(browser);
        let detailStrategy = 'unknown';
        let usedProviderExtractor = false;

        try {
            let jobData = null;
            let pageForProvider = null;

            if (providerSupportsDetail) {
                try {
                    pageForProvider = providerUsesBrowser ? await pageController.ensurePage() : null;
                    const providerResult = await provider.fetchJobDetail({
                        page: pageForProvider,
                        url,
                        providerId: resolvedProviderId,
                        attempt,
                        logger: log,
                        context: providerContext || undefined
                    });

                    if (providerResult) {
                        jobData = providerResult;
                        usedProviderExtractor = true;
                        detailStrategy = providerResult.strategy || `${resolvedProviderId}-provider`;
                    }
                } catch (providerError) {
                    log.warn(`Provider ${resolvedProviderId} fetchJobDetail failed for ${url}: ${providerError.message}`);
                }
            }

            if (!jobData) {
                if (providerSupportsDetail) {
                    log.info(`Provider ${resolvedProviderId} did not return job details for ${url}. Falling back to generic extractor.`);
                }
                const fallbackPage = await pageController.ensurePage();
                jobData = await extractJobDetails(fallbackPage, url);
                detailStrategy = jobData && jobData.source ? jobData.source : 'generic';
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
            stats.detailStrategyCounts[detailStrategy] = (stats.detailStrategyCounts[detailStrategy] || 0) + 1;

            const extractionTag = jobData.source ? `${jobData.source}${usedProviderExtractor ? ' (provider)' : ''}` : (usedProviderExtractor ? 'provider' : 'unknown');
            log.info(`Extracted via ${extractionTag} [strategy: ${detailStrategy}]`);
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
                    strategy: detailStrategy
                });

                saveDetailReport(reportPath, detailReport);
            }

            await pageController.release();
            return; // Success - exit retry loop

        } catch (error) {
            await pageController.release();
            lastError = error;

            const isRetryable =
                error.message.includes('ERR_HTTP2_PROTOCOL_ERROR') ||
                error.message.includes('ERR_CONNECTION') ||
                error.message.includes('timeout') ||
                error.message.includes('Navigation');

            if (isRetryable && attempt < maxRetries - 1) {
                const delay = 2000 * Math.pow(2, attempt);
                log.info(`Attempt ${attempt + 1} failed for ${url}, retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }

            break;
        }
    }

    // Fallback: if extraction failed, check if this is (or behaves like) a listing page
    if (lastError) {
        let handledViaListing = false;
        let listingFound = 0;
        let listingSuccesses = 0;
        let newLinksCount = 0;

        try {
            if (depth < 1) {
                const page = await browser.newPage();
                try {
                    await configurePage(page);
                    const isActualListingPage = await page.evaluate(() => {
                        const title = document.title.toLowerCase();
                        const h1 = document.querySelector('h1');
                        const h1Text = h1 ? h1.textContent.toLowerCase() : '';
                        const bodyText = document.body.textContent.toLowerCase();

                        const listingIndicators = [
                            title.includes('careers'),
                            title.includes('jobs'),
                            title.includes('openings'),
                            title.includes('opportunities'),
                            h1Text.includes('open positions'),
                            h1Text.includes('job openings'),
                            h1Text.includes('careers'),
                            h1Text.includes('all jobs'),
                            h1Text.includes('current openings'),
                            (bodyText.match(/view job/gi) || []).length >= 3,
                            (bodyText.match(/apply now/gi) || []).length >= 3,
                            bodyText.includes('filter by') && bodyText.includes('location'),
                            bodyText.includes('showing') && bodyText.includes('results') && bodyText.includes('jobs')
                        ];

                        const indicatorCount = listingIndicators.filter(Boolean).length;

                        return indicatorCount >= 2;
                    });

                    if (!isActualListingPage) {
                        await page.close();
                        listingFound = 0;
                    } else {
                        const links = await extractJobLinks(page, url, { waitUntil: 'networkidle2' });
                        listingFound = Array.isArray(links) ? links.length : 0;
                        await page.close();

                        if (listingFound > 0) {
                            const processedSet = getProcessedJobs(jobsDir);
                            const uniqueLinks = Array.from(new Set(links.map(normalizeURL)))
                                .filter(nu => !processedSet.has(nu));
                            const cap = config.crawler.listingFollowLimit || 30;
                            const toFollow = uniqueLinks.slice(0, cap).map(nu => links.find(l => normalizeURL(l) === nu));
                            newLinksCount = toFollow.length;

                            if (newLinksCount === 0) {
                                log.info(`Detected listing page but no new job links. Skipping.`);
                                return;
                            }

                            log.info(`Detected listing page. Following ${newLinksCount} new job links (depth 1).`);
                            const before = stats.successCount;
                            for (const link of toFollow) {
                                const nestedProvider = findProviderByUrl(link);
                                const nestedProviderId = nestedProvider ? nestedProvider.id : resolvedProviderId;
                                await processJobURL(browser, link, 0, toFollow.length, jobsDir, stats, {
                                    ...opts,
                                    depth: depth + 1,
                                    currentRetryCount: 0,
                                    providerId: nestedProviderId
                                });
                            }
                            listingSuccesses = stats.successCount - before;
                            handledViaListing = listingSuccesses > 0;
                        }
                    }
                } catch (e) {
                    try { await page.close(); } catch (_) { }
                }
            }
        } catch (_) { }

        if (handledViaListing) {
            return;
        }

        if (listingFound > 0 && newLinksCount === 0) {
            return;
        }

        const reason = lastError.message || 'Unknown extraction error';

        if (listingFound > 0 && listingSuccesses === 0) {
            log.error(`Listing detected at ${url} but no job details extracted from its new links.`);
        } else if (listingFound === 0) {
            if (reason.includes('Failed to extract valid content')) {
                log.error(`Validation failed for ${url}: ${reason}`);
            } else if (reason.includes('Navigation') || reason.includes('Timeout')) {
                log.error(`Navigation timeout for ${url}: ${reason}`);
            } else if (reason.includes('ERR_HTTP2_PROTOCOL_ERROR')) {
                log.error(`HTTP/2 protocol error for ${url} (likely anti-bot protection)`);
            } else {
                log.error(`Extraction failed for ${url}: ${reason}`);
            }
        }

        stats.failedCount++;

        if (jobsCsvPath) {
            const newRetryCount = currentRetryCount + 1;
            updateJobStatus(jobsCsvPath, url, 'failed', reason, '', newRetryCount);
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
                reason: reason
            });

            saveDetailReport(reportPath, detailReport);
        }
    }
};

module.exports = processJobURL;