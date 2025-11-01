const path = require('path');
const fs = require('fs');
const config = require('../config');
const {
    normalizeURL,
    log,
    extractCompanyName,
    getProcessedJobs,
    markJobAsProcessed,
    getNextJobNumber,
    saveJobToFile
} = require('../utils');
const { extractJobLinks } = require('../utils/job-links');
const extractJobDetails = require('../utils/extract-job-details');

/**
 * Process a single job URL with retry logic
 * @param {Browser} browser - Puppeteer browser instance
 * @param {string} url - Job URL to process
 * @param {number} index - Index in processing queue
 * @param {number} total - Total URLs to process
 * @param {string} jobsDir - Output directory for jobs
 * @param {Object} stats - Statistics object to update
 * @returns {Promise<void>}
 */
const processJobURL = async (browser, url, index, total, jobsDir, stats, opts = {}) => {
    log.progress(`Processing job ${index + 1}/${total}: ${url}`);

    const maxRetries = 3;
    let lastError = null;
    const depth = opts.depth || 0;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const page = await browser.newPage();

        try {
            await page.setUserAgent(config.crawler.userAgent);
            await page.setViewport({ width: 1920, height: 1080 });

            await page.setExtraHTTPHeaders({
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            });

            const jobData = await extractJobDetails(page, url);
            const companyName = extractCompanyName(url);
            const companyDir = path.join(jobsDir, companyName);

            if (!fs.existsSync(companyDir)) {
                fs.mkdirSync(companyDir, { recursive: true });
            }

            const jobNumber = getNextJobNumber(companyDir);
            const fileName = saveJobToFile(jobData, companyDir, jobNumber);

            markJobAsProcessed(jobsDir, url);

            stats.companyJobCounts[companyName] = (stats.companyJobCounts[companyName] || 0) + 1;
            stats.successCount++;

            if (jobData.source === 'structured-data') stats.structuredCount++;
            if (jobData.source === 'intelligent-analysis') stats.intelligentCount++;

            log.info(`Extracted via ${jobData.source}`);
            log.info(`Saved: ${companyName}/${fileName} - "${jobData.title}"`);

            await page.close();
            return; // Success - exit retry loop

        } catch (error) {
            await page.close();
            lastError = error;

            const isRetryable =
                error.message.includes('ERR_HTTP2_PROTOCOL_ERROR') ||
                error.message.includes('ERR_CONNECTION') ||
                error.message.includes('timeout') ||
                error.message.includes('Navigation');

            if (isRetryable && attempt < maxRetries - 1) {
                const delay = 2000 * Math.pow(2, attempt);
                log.warning(`Attempt ${attempt + 1} failed for ${url}, retrying in ${delay}ms...`);
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
                            await processJobURL(browser, link, 0, toFollow.length, jobsDir, stats, { depth: depth + 1 });
                        }
                        listingSuccesses = stats.successCount - before;
                        handledViaListing = listingSuccesses > 0;
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

        const failedLogPath = path.join(jobsDir, 'failed_extractions.txt');
        const contextMsg = listingFound > 0 ? `Listing page detected; new_links_found=${newLinksCount}, successes=${listingSuccesses}` : reason;
        fs.appendFileSync(failedLogPath, `${url}\t${contextMsg}\n`, 'utf-8');

        stats.failedCount++;
    }
};

module.exports = processJobURL;