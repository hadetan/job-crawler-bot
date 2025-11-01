const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const pLimit = require('p-limit');
const config = require('../config');
const {
    readCSV,
    normalizeURL,
    log,
    extractCompanyName,
    getProcessedJobs,
    markJobAsProcessed,
    getNextJobNumber,
    saveJobToFile
} = require('../utils');
const {
    extractFromStructuredData,
    extractWithIntelligentAnalysis
} = require('../extractors');
const { validateExtractedContent } = require('../validators');
const { extractJobLinks, isJobDetailPage } = require('../utils/job-links');

/**
 * Extract job details from a single URL using multi-layer extraction approach
 * @param {Page} page - Puppeteer page object
 * @param {string} url - Job posting URL
 * @returns {Promise<Object>} Extracted job data with source information
 */
const extractJobDetails = async (page, url) => {
    try {
        page.setDefaultNavigationTimeout(Math.max(45000, config.crawler.pageTimeout));
        page.setDefaultTimeout(Math.max(45000, config.crawler.pageTimeout));

        try {
            await page.setRequestInterception(true);
            const blockedResourceTypes = new Set(['image', 'media', 'font']);
            const blockedHosts = [
                'googletagmanager.com', 'google-analytics.com', 'doubleclick.net', 'hotjar.com',
                'facebook.net', 'facebook.com', 'optimizely.com', 'segment.com'
            ];
            page.on('request', req => {
                const urlHost = new URL(req.url()).hostname;
                if (blockedResourceTypes.has(req.resourceType()) || blockedHosts.some(h => urlHost.endsWith(h))) {
                    return req.abort();
                }
                return req.continue();
            });
        } catch (_) { /* noop if interception fails */ }

        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: Math.max(45000, config.crawler.pageTimeout)
        });

        await page.waitForTimeout(5000);

        const hasLowContent = await page.evaluate(() => {
            const main = document.querySelector('main, [role="main"]');
            const mainLength = main ? main.textContent.trim().length : 0;
            return mainLength < 500;
        });

        const maxIframeAttempts = hasLowContent ? 30 : 20;

        let iframeUrl = null;
        for (let i = 0; i < maxIframeAttempts && !iframeUrl; i++) {
            iframeUrl = await page.evaluate(() => {
                const iframes = Array.from(document.querySelectorAll('iframe'));
                for (const iframe of iframes) {
                    const src = iframe.src;
                    if (src && (src.includes('job-boards.greenhouse.io') || src.includes('boards.greenhouse.io') ||
                        src.includes('lever.co') || src.includes('ashbyhq.com') ||
                        src.includes('workday.com') || src.includes('myworkdayjobs.com'))) {
                        return src;
                    }
                }
                return null;
            });
            if (!iframeUrl && i < maxIframeAttempts - 1) {
                await page.waitForTimeout(1000);
            }
        }

        if (iframeUrl) {
            log.info(`Detected iframe job board: ${iframeUrl.substring(0, 80)}...`);
            await page.goto(iframeUrl, {
                waitUntil: 'networkidle2',
                timeout: Math.max(45000, config.crawler.pageTimeout)
            });
            await page.waitForTimeout(3000);
        }

        const failureReasons = [];

        // Layer 1: Try structured data extraction
        const structuredData = await extractFromStructuredData(page);
        if (structuredData) {
            const validation = validateExtractedContent(structuredData);
            if (validation.valid) {
                return {
                    url,
                    ...structuredData,
                    source: 'structured-data'
                };
            } else {
                failureReasons.push(`Structured data validation failed: ${validation.reason}`);
            }
        } else {
            failureReasons.push('No structured data found');
        }

        // Layer 2: Try intelligent DOM analysis
        const intelligentData = await extractWithIntelligentAnalysis(page);
        if (intelligentData) {
            const validation = validateExtractedContent(intelligentData);

            if (validation.valid) {
                return {
                    url,
                    ...intelligentData,
                    source: 'intelligent-analysis'
                };
            } else {
                failureReasons.push(`Intelligent analysis validation failed: ${validation.reason}`);
            }
        } else {
            failureReasons.push('Intelligent analysis returned no data (likely error page)');
        }

        throw new Error(`Failed to extract valid content: ${failureReasons.join('; ')}`);
    } catch (error) {
        throw error;
    }
};

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

            // Disable HTTP/2 for problematic sites
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

            // Non-retryable error or final attempt
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
                            return; // No new work to do; don't record as failure
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
                    try { await page.close(); } catch (_) {}
                }
            }
        } catch (_) {}

        if (handledViaListing) {
            return; // Do not record original URL as failed if we extracted from its listing
        }

        // If listing was detected but there were no new links, we already skipped above
        if (listingFound > 0 && newLinksCount === 0) {
            return;
        }

        // Otherwise, record failure with context
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

/**
 * Main function to run Stage 3: Job Details Extraction
 * @returns {Promise<void>}
 */
const runStage3 = async () => {
    log.info('Starting Stage 3: Job Details Extractor...');

    const inputFile = path.join(config.output.dir, 'job_links.csv');
    const jobsDir = path.join(config.output.dir, 'jobs');

    const jobURLs = readCSV(inputFile, 'url');
    if (jobURLs.length === 0) {
        log.error('No job URLs found in job_links.csv. Run Stage 2 first.');
        return;
    }

    if (!fs.existsSync(jobsDir)) {
        fs.mkdirSync(jobsDir, { recursive: true });
    }

    const processedJobs = getProcessedJobs(jobsDir);
    let urlsToProcess = jobURLs.filter(url => !processedJobs.has(normalizeURL(url)));

    log.info(`Total jobs in CSV: ${jobURLs.length}`);
    log.info(`Already processed: ${processedJobs.size}`);
    log.info(`New jobs to process: ${urlsToProcess.length}`);

    if (jobURLs.length > urlsToProcess.length) {
        const skippedCount = jobURLs.length - urlsToProcess.length;
        log.info(`Skipping ${skippedCount} already-processed URLs (showing first 5):`);
        const skipped = jobURLs.filter(url => processedJobs.has(normalizeURL(url))).slice(0, 5);
        skipped.forEach(url => {
            log.info(`  ✓ ${url} [normalized: ${normalizeURL(url)}]`);
        });
    }

    if (urlsToProcess.length === 0) {
        log.info('Stage 3 complete: All jobs already processed');
        return;
    }

    const browser = await puppeteer.launch({
        headless: config.crawler.headless,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-http2',
            '--disable-blink-features=AutomationControlled',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process'
        ],
        ignoreHTTPSErrors: true
    });

    const stats = {
        successCount: 0,
        failedCount: 0,
        structuredCount: 0,
        intelligentCount: 0,
        companyJobCounts: {}
    };

    const limit = pLimit(config.crawler.concurrency);
await Promise.all(
        urlsToProcess.map((url, index) =>
            limit(() => processJobURL(browser, url, index, urlsToProcess.length, jobsDir, stats))
        )
    );

    await browser.close();

    // Log summary
    log.success(`Stage 3 complete: ${stats.successCount} jobs saved to ${jobsDir}`);
    log.info(`Summary - Total processed: ${urlsToProcess.length}, Successful: ${stats.successCount}, Failed: ${stats.failedCount}`);
    log.info(`Extraction methods - Structured Data: ${stats.structuredCount}, Intelligent Analysis: ${stats.intelligentCount}`);

    if (Object.keys(stats.companyJobCounts).length > 0) {
        log.info('Jobs saved by company:');
        Object.entries(stats.companyJobCounts).sort().forEach(([company, count]) => {
            log.info(`  ${company}: ${count} jobs`);
        });
    }
};

module.exports = runStage3;
