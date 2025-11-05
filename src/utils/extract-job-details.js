const config = require('../config');
const { log } = require('../utils');
const { extractFromStructuredData, extractWithIntelligentAnalysis } = require('../extractors');
const { validateExtractedContent } = require('../validators');
const tryAcceptCookies = require('../utils/cookie-handler');

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

        await tryAcceptCookies(page);

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
                const allowedHosts = [
                    'job-boards.greenhouse.io',
                    'boards.greenhouse.io',
                    'lever.co',
                    'jobs.lever.co',
                    'ashbyhq.com',
                    'workday.com',
                    'myworkdayjobs.com'
                ];

                const matchesAllowedHost = (src) => {
                    try {
                        const u = new URL(src, document.baseURI);
                        const host = u.hostname.toLowerCase();
                        return allowedHosts.some(h => host === h || host.endsWith('.' + h));
                    } catch (_) {
                        return false;
                    }
                };

                const iframes = Array.from(document.querySelectorAll('iframe'));
                for (const iframe of iframes) {
                    const src = iframe.getAttribute('src') || '';
                    if (src && matchesAllowedHost(src)) {
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
            const isJobBoardListing = iframeUrl.includes('embed/job_board');
            const isJobApp = iframeUrl.includes('embed/job_app');

            if (isJobBoardListing || isJobApp) {
                const ghJidMatch = url.match(/[?&]gh_jid=(\d+)/i);
                const positionIdMatch = url.match(/positions?[\/:](\d+)/i) || url.match(/jobs?[\/:](\d+)/i);
                const fallbackIdMatch = url.match(/(\d{7,})/);

                const jobId = ghJidMatch ? ghJidMatch[1] : (positionIdMatch ? positionIdMatch[1] : (fallbackIdMatch ? fallbackIdMatch[1] : null));
                const companyMatch = iframeUrl.match(/for=([^&]+)/);

                if (jobId && companyMatch) {
                    const company = companyMatch[1];
                    const constructedUrl = `https://job-boards.greenhouse.io/${company}/jobs/${jobId}`;

                    log.info(`Detected ${isJobBoardListing ? 'job_board' : 'job_app'} iframe, trying constructed URL: ${constructedUrl}`);

                    try {
                        await page.goto(constructedUrl, {
                            waitUntil: 'networkidle2',
                            timeout: Math.max(45000, config.crawler.pageTimeout)
                        });
                        await tryAcceptCookies(page);
                        await page.waitForTimeout(2000);

                        const isActuallyListingPage = await page.evaluate(() => {
                            const title = document.title.toLowerCase();
                            const h1 = document.querySelector('h1');
                            const h1Text = h1 ? h1.textContent.toLowerCase() : '';
                            const bodyText = document.body.textContent.toLowerCase();

                            const listingIndicators = [
                                title.includes('positions archive'),
                                title.includes('all jobs'),
                                h1Text.includes('all jobs'),
                                h1Text.includes('positions archive'),
                                h1Text.includes('open roles'),
                                h1Text.includes('current openings'),
                                (bodyText.match(/open roles/g) || []).length > 0 && bodyText.includes('showing') && bodyText.includes('results')
                            ];

                            return listingIndicators.some(indicator => indicator);
                        });

                        if (isActuallyListingPage) {
                            log.info(`Constructed URL leads to listing page, extracting from original page instead`);
                            await page.goto(url, {
                                waitUntil: 'networkidle2',
                                timeout: Math.max(45000, config.crawler.pageTimeout)
                            });
                            await tryAcceptCookies(page);
                            await page.waitForTimeout(3000);
                            iframeUrl = null;
                        } else {
                            log.info(`Constructed URL is valid, using it for extraction`);
                            iframeUrl = constructedUrl;
                        }
                    } catch (e) {
                        log.info(`Could not navigate to constructed URL: ${e.message}`);
                        log.info(`Extracting from original page instead`);
                        await page.goto(url, {
                            waitUntil: 'networkidle2',
                            timeout: Math.max(45000, config.crawler.pageTimeout)
                        });
                        await tryAcceptCookies(page);
                        await page.waitForTimeout(3000);
                        iframeUrl = null;
                    }
                } else {
                    log.info(`Detected iframe but couldn't extract job ID from URL, extracting from original page`);
                    iframeUrl = null;
                }
            } else {
                log.info(`Detected iframe job board: ${iframeUrl.substring(0, 80)}...`);
                await page.goto(iframeUrl, {
                    waitUntil: 'networkidle2',
                    timeout: Math.max(45000, config.crawler.pageTimeout)
                });
                await tryAcceptCookies(page);
                await page.waitForTimeout(3000);
            }
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

module.exports = extractJobDetails;