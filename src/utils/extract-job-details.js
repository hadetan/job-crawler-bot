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
            log.info(`Detected iframe job board: ${iframeUrl.substring(0, 80)}...`);
            await page.goto(iframeUrl, {
                waitUntil: 'networkidle2',
                timeout: Math.max(45000, config.crawler.pageTimeout)
            });
            await tryAcceptCookies(page);
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

module.exports = extractJobDetails;