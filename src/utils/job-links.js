const config = require('../config');
const log = require('./logger');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const ATS_HOSTS = [
    'greenhouse.io',
    'job-boards.greenhouse.io',
    'boards.greenhouse.io',
    'lever.co',
    'ashbyhq.com',
    'workday.com',
    'myworkdayjobs.com',
    'workdayjobs.com'
];

const isATSHost = (hostname) => {
    if (!hostname) return false;
    return ATS_HOSTS.some(d => hostname === d || hostname.endsWith('.' + d));
};

/**
 * Extract actual job URL if the string contains multiple https://
 * @param {string} url - The URL that might contain an embedded job URL
 * @returns {string} - The extracted job URL or original URL
 */
const extractEmbeddedJobURL = (url) => {
    if (!url) return url;

    try {
        const httpsCount = (url.match(/https:\/\//g) || []).length;

        if (httpsCount > 1) {
            const firstIndex = url.indexOf('https://');
            const secondIndex = url.indexOf('https://', firstIndex + 1);

            if (secondIndex !== -1) {
                const extractedUrl = url.substring(secondIndex);

                try {
                    new URL(extractedUrl);
                    return extractedUrl;
                } catch {
                    return url;
                }
            }
        }

        return url;
    } catch {
        return url;
    }
};

const isValidJobURL = (url) => {
    if (!url) return false;
    if (url.startsWith('#') || url.startsWith('mailto:') || url.startsWith('tel:')) {
        return false;
    }
    try {
        new URL(url);
        return true;
    } catch {
        return false;
    }
};

/**
 * Extract numeric job ID (4+ digits) from URL
 * @param {string} url - The URL to extract job ID from
 * @returns {string|null} - Job ID as string, or null if not found
 */
const extractJobId = (url) => {
    if (!url) return null;

    try {
        const matches = url.match(/\d{4,}/g);

        if (!matches || matches.length === 0) {
            return null;
        }

        const longestMatch = matches.reduce((longest, current) => {
            if (current.length > longest.length) {
                return current;
            } else if (current.length === longest.length) {
                return current;
            }
            return longest;
        });

        return longestMatch;
    } catch {
        return null;
    }
};

/**
 * Check if URL is a job detail page
 * @param {string} url - The URL to check
 * @returns {boolean} - True if URL is a job detail page
 */
const isJobDetailPage = (url) => {
    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname.toLowerCase();
        const pathname = urlObj.pathname.toLowerCase();
        const search = urlObj.search.toLowerCase();
        const params = urlObj.searchParams;
        const fullUrl = url.toLowerCase();

        if (fullUrl.includes('gh_jid=')) {
            return true;
        }

        // Generic job-board signal: Greenhouse job id in query params
        if (params.has('gh_jid')) {
            return true;
        }

        if (isATSHost(hostname)) {
            if (pathname.includes('/jobs/') || pathname.includes('/job/') || pathname.includes('/job_app')) {
                return true;
            }
        }

        const excludePatterns = [
            /\/careers\/?$/,           // Ends with /careers/ or /careers
            /\/jobs\/?$/,              // Ends with /jobs/ or /jobs
            /\/career\/?$/,            // Ends with /career/ or /career
            /\/(faqs?|about|team|benefits|culture|life|perks|diversity|contact|early-careers)[\/?]/,
            /life-as/,                 // Blog/life stories pages
            /our-entrepreneurs/,       // Team/entrepreneur pages
            /episodes\//,              // Blog episodes
            /#job-board/,              // Hash fragments to job boards
            /open-positions\/?$/,      // Generic "open positions" page
            /\/[a-z]{2}\/.*careers\/?$/,  // Localized pages ending in careers (e.g., /pt/careers/)
            /\/apply\/?$/,             // Application forms (when /apply is at the end)
            /\/(search|all|university)\/?$/,  // Search, "view all", university pages
            /\/departments?\/?$/,      // Department listing pages
            /\/(chicago|dublin|tokyo|london|munich|new-york|san-francisco|paris|reykjavik|sydney|singapore|vancouver|warsaw|nyc|sf|la|boston|seattle|austin|denver|atlanta|miami|dallas|houston|phoenix|portland|philadelphia|berlin|amsterdam|barcelona|madrid|rome|milan|stockholm|oslo|copenhagen|helsinki|zurich|vienna|brussels|lisbon|prague|budapest|toronto|montreal|melbourne|bangalore|mumbai|delhi|shanghai|beijing|hong-kong|seoul|taipei)\/?$/i,
            /\/(business|engineering|product|internal|design|marketing|sales|support|operations|finance|legal|data|security|infrastructure|research|university-recruiting|internship)\/?$/i,  // Department/team filter pages
            /job-opening-list/,        // Job listing pages
            /job-openings/,            // Job listing pages
            /\.(jpg|jpeg|png|gif|svg|webp|pdf|doc|docx)$/i,  // File extensions (images, documents)
            /[\/?]page=/i,             // Pagination parameters
            /\/gallery/i,              // Gallery pages
            /\/photos?/i               // Photo pages
        ];

        for (const pattern of excludePatterns) {
            if (pattern.test(pathname) || pattern.test(search)) {
                return false;
            }
        }

        // Require a numeric job ID (4+ digits) and positive job signals in path/query
        const jobId = extractJobId(url);
        if (jobId !== null) {
            const positiveSignals = [
                /\bjob(s)?\b/,
                /\bcareer(s)?\b/,
                /open-positions/,
                /position(s)?/,
                /opportunit(y|ies)/
            ];
            const hay = pathname + ' ' + search;
            if (positiveSignals.some(r => r.test(hay))) {
                return true;
            }
        }
        return false;
    } catch {
        return false;
    }
};

const extractJobLinks = async (page, url, retryOrOpts = 0) => {
    const retryCount = typeof retryOrOpts === 'number' ? retryOrOpts : (retryOrOpts.retryCount || 0);
    const waitUntil = typeof retryOrOpts === 'object' && retryOrOpts.waitUntil ? retryOrOpts.waitUntil : 'domcontentloaded';

    try {
        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: config.crawler.pageTimeout
        });

        await page.waitForTimeout(2000);

        let links = [];
        let extractedFromIframe = false;

        let greenhouseIframe = null;
        for (let attempt = 0; attempt < 5; attempt++) {
            const iframes = await page.$$('iframe');

            for (const iframeElement of iframes) {
                const iframeSrc = await page.evaluate(el => el.src, iframeElement);

                if (iframeSrc && iframeSrc.includes('greenhouse.io/embed/job_board')) {
                    greenhouseIframe = iframeElement;
                    break;
                }
            }

            if (greenhouseIframe) break;

            await page.waitForTimeout(1000 + (attempt * 500));
        }

        if (greenhouseIframe) {
            try {
                await page.waitForTimeout(4000);

                const frame = await greenhouseIframe.contentFrame();
                if (frame) {
                    try {
                        await frame.waitForSelector('a', { timeout: 5000 });
                    } catch { }

                    for (const selector of config.selectors.jobLinks) {
                        try {
                            const hrefs = await frame.$$eval(selector, anchors =>
                                anchors.map(a => a.href).filter(Boolean)
                            );
                            links.push(...hrefs);
                        } catch (error) { }
                    }

                    if (links.length === 0) {
                        try {
                            const allHrefs = await frame.$$eval('a', anchors =>
                                anchors.map(a => a.href).filter(Boolean)
                            );
                            links.push(...allHrefs);
                        } catch (error) { }
                    }

                    if (links.length > 0) {
                        extractedFromIframe = true;
                    }
                }
            } catch (error) {
                log.progress(`Failed to extract from iframe: ${error.message}`);
            }
        }

        if (!extractedFromIframe) {
            await page.waitForTimeout(3000);

            try {
                const allHrefs = await page.$$eval('a', anchors => anchors.map(a => a.href).filter(Boolean));
                links.push(...allHrefs);
            } catch (error) {
                log.progress(`Failed to extract from main page: ${error.message}`);
            }
        }

        const normalized = links
            .filter(isValidJobURL)
            .map(link => {
                try {
                    // Extract embedded job URL if this is a social sharing link
                    const extractedUrl = extractEmbeddedJobURL(link);
                    return new URL(extractedUrl, url).href;
                } catch {
                    return null;
                }
            })
            .filter(Boolean);

        const validLinks = normalized.filter(isJobDetailPage);

        return Array.from(new Set(validLinks));
    } catch (error) {
        if ((typeof retryOrOpts === 'number' ? retryOrOpts : retryOrOpts.retryCount || 0) < config.retry.maxRetries) {
            const nextRetry = retryCount + 1;
            const delay = config.retry.retryDelay * nextRetry;
            log.progress(`Failed to load ${url}, retrying in ${delay}ms... (Attempt ${nextRetry}/${config.retry.maxRetries})`);
            await sleep(delay);
            return extractJobLinks(page, url, { retryCount: nextRetry, waitUntil });
        }

        throw error;
    }
};

module.exports = {
    isValidJobURL,
    extractJobId,
    isJobDetailPage,
    extractJobLinks,
    extractEmbeddedJobURL
};