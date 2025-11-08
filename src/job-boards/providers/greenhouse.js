const { normalizeURL, extractCompanyName } = require('../../utils');
const { createProviderHttpClient, normalizeWhitespace, convertHtmlToText, normalizeLineBreaks, stripHtml, validateRequiredFields } = require('../detail-helpers');
const { runApiCollector } = require('./api-collector');

const GREENHOUSE_PROVIDER_ID = 'greenhouse';
const GREENHOUSE_API_BASE = 'https://boards-api.greenhouse.io/v1/boards';
const GREENHOUSE_API_TIMEOUT_MS = 45000;
const JOBS_PER_PAGE = 50;
const MAX_API_PAGES = 40;
const httpClient = createProviderHttpClient({ timeout: GREENHOUSE_API_TIMEOUT_MS });
const htmlHttpClient = createProviderHttpClient({
    timeout: GREENHOUSE_API_TIMEOUT_MS,
    headers: { Accept: 'text/html,application/xhtml+xml;q=0.9' }
});
const boardTokenCache = new Map();

function getCacheKey(url) {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        if (host === 'boards.greenhouse.io') {
            return null;
        }

        return host;
    } catch (_) {
        return null;
    }
}

function getCachedBoardToken(url) {
    const key = getCacheKey(url);
    if (!key) {
        return null;
    }

    return boardTokenCache.get(key) || null;
}

function cacheBoardToken(url, boardToken) {
    if (!boardToken) {
        return;
    }

    const key = getCacheKey(url);
    if (!key) {
        return;
    }

    boardTokenCache.set(key, boardToken);
}

function parseGreenhouseContextFromUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        const hostname = parsed.hostname.toLowerCase();
        const pathSegments = parsed.pathname.split('/').filter(Boolean);
        let boardToken = null;
        let jobId = null;

        parsed.searchParams.forEach((value, key) => {
            if (!value) {
                return;
            }

            const lowered = key.toLowerCase();
            if (lowered === 'gh_jid' || lowered === 'token') {
                if (!jobId) {
                    jobId = String(value).trim();
                }
            } else if (lowered === 'for' && !boardToken) {
                boardToken = String(value).trim();
            }
        });

        if (hostname === 'boards.greenhouse.io') {
            if (!boardToken && pathSegments.length > 0) {
                boardToken = decodeURIComponent(pathSegments[0] || '').trim() || null;
            }

            const jobsIndex = pathSegments.indexOf('jobs');
            if (jobsIndex >= 0 && pathSegments.length > jobsIndex + 1 && !jobId) {
                jobId = decodeURIComponent(pathSegments[jobsIndex + 1] || '').trim() || null;
            }

            if (pathSegments.includes('embed')) {
                if (!boardToken && parsed.searchParams.has('for')) {
                    boardToken = parsed.searchParams.get('for');
                }
                if (!jobId && parsed.searchParams.has('token')) {
                    jobId = parsed.searchParams.get('token');
                }
            }
        }

        return { boardToken, jobId };
    } catch (_) {
        return { boardToken: null, jobId: null };
    }
}

function parseGreenhouseHintsFromHtml(html, baseUrl) {
    if (!html || typeof html !== 'string') {
        return { boardToken: null };
    }

    const boardCandidates = new Set();

    const registerBoardCandidate = (value) => {
        if (!value) {
            return;
        }

        const trimmed = String(value).trim();
        if (trimmed) {
            boardCandidates.add(trimmed);
        }
    };

    const scriptRegex = /<script[^>]+src=["']([^"']+)["'][^>]*>/gi;
    let match;

    while ((match = scriptRegex.exec(html)) !== null) {
        const rawSrc = match[1];
        if (!rawSrc || !rawSrc.includes('greenhouse.io')) {
            continue;
        }

        try {
            const resolved = new URL(rawSrc, baseUrl);
            const { searchParams, pathname } = resolved;

            if (searchParams.has('for')) {
                registerBoardCandidate(searchParams.get('for'));
            }

            const apiMatch = pathname.match(/boards-api\.greenhouse\.io\/v1\/boards\/([\w-]+)/i);
            if (apiMatch && apiMatch[1]) {
                registerBoardCandidate(apiMatch[1]);
            }
        } catch (_) {
            // ignore resolution failures
        }
    }

    const embedRegex = /greenhouse\.io\/embed\/(?:job_board|job_app)[^"'>]*for=([\w-]+)/gi;
    while ((match = embedRegex.exec(html)) !== null) {
        if (match[1]) {
            registerBoardCandidate(match[1]);
        }
    }

    const apiRegex = /boards-api\.greenhouse\.io\/v1\/boards\/([\w-]+)/gi;
    while ((match = apiRegex.exec(html)) !== null) {
        if (match[1]) {
            registerBoardCandidate(match[1]);
        }
    }

    const tokenRegex = /boardToken\s*[:=]\s*['"]([\w-]+)['"]/gi;
    while ((match = tokenRegex.exec(html)) !== null) {
        if (match[1]) {
            registerBoardCandidate(match[1]);
        }
    }

    const dataAttrRegex = /data-gh-board=["']([\w-]+)["']/gi;
    while ((match = dataAttrRegex.exec(html)) !== null) {
        if (match[1]) {
            registerBoardCandidate(match[1]);
        }
    }

    const boardToken = boardCandidates.values().next().value || null;
    return { boardToken };
}

async function discoverBoardTokenFromHtml({ url, logger }) {
    const cached = getCachedBoardToken(url);
    if (cached) {
        return { boardToken: cached };
    }

    try {
        const response = await htmlHttpClient.get(url, { responseType: 'text' });
        const html = typeof response.data === 'string' ? response.data : '';
        const { boardToken } = parseGreenhouseHintsFromHtml(html, url);

        if (boardToken) {
            cacheBoardToken(url, boardToken);
        }

        return { boardToken };
    } catch (error) {
        if (logger) {
            if (typeof logger.debug === 'function') {
                logger.debug(`Greenhouse board token discovery failed for ${url}: ${error.message}`);
            } else if (typeof logger.warn === 'function') {
                logger.warn(`Greenhouse board token discovery failed for ${url}: ${error.message}`);
            }
        }
        return { boardToken: null };
    }
}

function normalizeJobUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        const host = parsed.hostname.toLowerCase();
        if (!host.includes('greenhouse.io') && !host.includes('grnh.se')) {
            return rawUrl;
        }

        ['gh_src', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'source', 'tmsrc'].forEach((param) => {
            parsed.searchParams.delete(param);
        });

        parsed.hash = '';
        return parsed.toString();
    } catch (_) {
        return rawUrl;
    }
}

function matchesUrl(url) {
    if (!url) {
        return false;
    }

    try {
        const parsed = new URL(url);
        const hostname = parsed.hostname.toLowerCase();
        return hostname.includes('greenhouse.io') || hostname.includes('grnh.se');
    } catch (_) {
        return url.includes('greenhouse.io') || url.includes('grnh.se');
    }
}

function decodeHtmlEntities(value) {
    if (!value) {
        return '';
    }

    return String(value)
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function buildDescription(data) {
    if (!data) {
        return '';
    }

    const rawHtmlSource = (() => {
        if (typeof data.content === 'string' && data.content.trim()) {
            return decodeHtmlEntities(data.content);
        }
        if (typeof data.content_html === 'string' && data.content_html.trim()) {
            return decodeHtmlEntities(data.content_html);
        }
        return '';
    })();

    let description = convertHtmlToText(rawHtmlSource);

    if (!description && rawHtmlSource) {
        description = normalizeLineBreaks(stripHtml(rawHtmlSource));
    }

    if (!description) {
        const plain = typeof data.content_plain === 'string'
            ? data.content_plain
            : (typeof data.content_plain_text === 'string' ? data.content_plain_text : '');
        if (plain) {
            description = normalizeLineBreaks(plain);
        }
    }

    return description || '';
}

async function fetchListingsFromApi({ boardToken }) {
    if (!boardToken) {
        return { jobUrls: [], jobEntries: [], diagnostics: { error: 'missing-board-token' } };
    }

    const dedupe = new Set();
    const jobUrls = [];
    const jobEntries = [];
    const diagnostics = { boardToken, pages: 0, totalJobs: 0 };
    let page = 1;

    const baseApiUrl = `${GREENHOUSE_API_BASE}/${boardToken}/jobs`;

    while (page <= MAX_API_PAGES) {
        const params = new URLSearchParams();
        params.set('page', String(page));
        params.set('per_page', String(JOBS_PER_PAGE));
        params.set('content', 'false');

        let response;
        try {
            response = await httpClient.get(baseApiUrl, {
                params: Object.fromEntries(params.entries())
            });
        } catch (error) {
            error.greenhouseContext = {
                boardToken,
                params: Object.fromEntries(params.entries())
            };
            throw error;
        }

        const payload = response && response.data ? response.data : {};
        const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];

        diagnostics.pages += 1;
        diagnostics.totalJobs += jobs.length;

        jobs.forEach((job) => {
            if (!job || typeof job !== 'object') {
                return;
            }

            const candidateUrls = [
                job.absolute_url,
                job.hosted_url,
                job.application_url,
                `https://boards.greenhouse.io/${boardToken}/jobs/${job.id}`
            ];

            for (const candidate of candidateUrls) {
                if (!candidate) {
                    continue;
                }

                const canonical = normalizeJobUrl(candidate);
                const dedupeKey = normalizeURL(canonical);
                if (!dedupe.has(dedupeKey)) {
                    dedupe.add(dedupeKey);
                    jobUrls.push(canonical);

                    const entryMetadata = {};
                    if (boardToken) {
                        entryMetadata.boardToken = boardToken;
                    }

                    if (job.id !== undefined && job.id !== null) {
                        entryMetadata.jobId = String(job.id);
                    }

                    jobEntries.push(Object.keys(entryMetadata).length > 0
                        ? { url: canonical, metadata: entryMetadata }
                        : { url: canonical });
                    break;
                }
            }
        });

        const meta = payload.meta || {};
        const total = typeof meta.total === 'number' ? meta.total : null;
        if (jobs.length < JOBS_PER_PAGE || (total && page * JOBS_PER_PAGE >= total)) {
            break;
        }

        page += 1;
    }

    return { jobUrls, jobEntries, diagnostics, api: baseApiUrl };
}

function extractBoardTokenFromApiUrl(apiUrl) {
    if (typeof apiUrl !== 'string') {
        return null;
    }

    const match = apiUrl.match(/boards\/([^/]+)\/(?:jobs|job)/i);
    return match && match[1] ? match[1] : null;
}

function extractBoardTokenFromBoardUrl(boardUrl) {
    if (typeof boardUrl !== 'string') {
        return null;
    }

    try {
        const parsed = new URL(boardUrl);
        const segments = parsed.pathname.split('/').filter(Boolean);
        if (segments.length > 0) {
            return segments[segments.length - 1];
        }
    } catch (_) {
        // Fall through to regex attempt
    }

    const regexMatch = boardUrl.match(/boards(?:-api)?\.greenhouse\.io\/[^/]*\/([^/?#]+)/i);
    return regexMatch && regexMatch[1] ? regexMatch[1] : null;
}

function resolveBoardContextFromLinkReport({ url, linkReport }) {
    if (!linkReport || typeof linkReport !== 'object') {
        return { boardToken: null };
    }

    const reportEntries = linkReport.link_extraction_report && typeof linkReport.link_extraction_report === 'object'
        ? linkReport.link_extraction_report
        : (typeof linkReport === 'object' ? linkReport : null);

    if (!reportEntries) {
        return { boardToken: null };
    }

    const normalizedTargetUrl = normalizeJobUrl(url);
    const candidateSlug = (() => {
        try {
            const extracted = extractCompanyName(url);
            return extracted ? extracted.toLowerCase() : null;
        } catch (_) {
            return null;
        }
    })();

    const contexts = [];
    const seenTokens = new Set();

    const findMetadataMatch = (metadata) => {
        if (!metadata || typeof metadata !== 'object') {
            return null;
        }

        if (metadata[url]) {
            return { jobUrl: url, metadata: metadata[url] };
        }

        if (normalizedTargetUrl && normalizedTargetUrl !== url && metadata[normalizedTargetUrl]) {
            return { jobUrl: normalizedTargetUrl, metadata: metadata[normalizedTargetUrl] };
        }

        if (normalizedTargetUrl) {
            for (const [candidateUrl, entry] of Object.entries(metadata)) {
                if (!entry || typeof entry !== 'object') {
                    continue;
                }

                const normalizedCandidate = normalizeJobUrl(candidateUrl);
                if (normalizedCandidate === normalizedTargetUrl) {
                    return { jobUrl: candidateUrl, metadata: entry };
                }
            }
        }

        return null;
    };

    for (const [entryKey, entryValue] of Object.entries(reportEntries)) {
        if (!entryValue || typeof entryValue !== 'object') {
            continue;
        }

        const diagnostics = entryValue.diagnostics && typeof entryValue.diagnostics === 'object'
            ? entryValue.diagnostics
            : {};

        const jobMetadata = entryValue.jobMetadata && typeof entryValue.jobMetadata === 'object'
            ? entryValue.jobMetadata
            : null;

        const metadataMatch = findMetadataMatch(jobMetadata);
        if (metadataMatch) {
            const metadataToken = metadataMatch.metadata.boardToken
                || diagnostics.boardToken
                || (entryValue.api ? extractBoardTokenFromApiUrl(entryValue.api) : null)
                || extractBoardTokenFromBoardUrl(entryKey);

            const normalizedToken = typeof metadataToken === 'string'
                ? metadataToken.trim()
                : (metadataToken ? String(metadataToken).trim() : '');

            if (normalizedToken) {
                const resolved = { boardToken: normalizedToken };
                if (metadataMatch.metadata.jobId !== undefined && metadataMatch.metadata.jobId !== null) {
                    resolved.jobId = String(metadataMatch.metadata.jobId);
                }
                return resolved;
            }
        }

        let boardToken = diagnostics.boardToken || null;

        if (!boardToken && entryValue.api) {
            boardToken = extractBoardTokenFromApiUrl(entryValue.api);
        }

        if (!boardToken && typeof entryKey === 'string') {
            boardToken = extractBoardTokenFromBoardUrl(entryKey);
        }

        if (!boardToken) {
            continue;
        }

        const boardTokenString = typeof boardToken === 'string' ? boardToken.trim() : String(boardToken).trim();
        if (!boardTokenString) {
            continue;
        }

        const normalizedToken = boardTokenString.toLowerCase();
        if (seenTokens.has(normalizedToken)) {
            continue;
        }

        const score = (() => {
            if (candidateSlug && normalizedToken === candidateSlug) {
                return 30;
            }
            if (candidateSlug && normalizedToken.includes(candidateSlug)) {
                return 20;
            }
            if (candidateSlug && typeof entryKey === 'string' && entryKey.toLowerCase().includes(candidateSlug)) {
                return 10;
            }
            return 1;
        })();

        contexts.push({ boardToken: boardTokenString, score });
        seenTokens.add(normalizedToken);
    }

    if (contexts.length === 0) {
        return { boardToken: null };
    }

    contexts.sort((a, b) => b.score - a.score);
    const best = contexts[0];

    if (best && best.score > 1) {
        return { boardToken: best.boardToken };
    }

    if (contexts.length === 1 && best) {
        return { boardToken: best.boardToken };
    }

    return { boardToken: null };
}

function resolveBoardContextFromDetailReport({ url, detailReport }) {
    if (!detailReport || typeof detailReport !== 'object') {
        return { boardToken: null };
    }

    const reportEntries = detailReport.detail_extraction_report && typeof detailReport.detail_extraction_report === 'object'
        ? detailReport.detail_extraction_report
        : null;

    if (!reportEntries) {
        return { boardToken: null };
    }

    const companyKey = (() => {
        try {
            const extracted = extractCompanyName(url);
            return extracted || null;
        } catch (_) {
            return null;
        }
    })();

    if (!companyKey || !reportEntries[companyKey]) {
        return { boardToken: null };
    }

    const companyReport = reportEntries[companyKey];
    const pools = [];

    if (Array.isArray(companyReport.passedUrls)) {
        pools.push(companyReport.passedUrls);
    }

    if (Array.isArray(companyReport.failedUrls)) {
        pools.push(companyReport.failedUrls);
    }

    for (const pool of pools) {
        for (const entry of pool) {
            if (!entry || typeof entry !== 'object') {
                continue;
            }

            const diagnostics = entry.diagnostics;
            if (!diagnostics || typeof diagnostics !== 'object') {
                continue;
            }

            if (diagnostics.boardToken) {
                return { boardToken: diagnostics.boardToken };
            }
        }
    }

    return { boardToken: null };
}

async function collectJobLinks({ url, logger }) {
    const contextFromUrl = parseGreenhouseContextFromUrl(url);

    const getInitialContexts = async () => {
        const contexts = [];

        if (contextFromUrl.boardToken) {
            contexts.push({
                boardToken: contextFromUrl.boardToken,
                source: 'url-path',
                diagnostics: {
                    boardToken: contextFromUrl.boardToken,
                    tokenSource: 'url-path'
                }
            });
        } else {
            const discovery = await discoverBoardTokenFromHtml({ url, logger });
            if (discovery.boardToken) {
                contexts.push({
                    boardToken: discovery.boardToken,
                    source: 'html-discovery',
                    diagnostics: {
                        boardToken: discovery.boardToken,
                        tokenSource: 'html'
                    }
                });
            }
        }

        return contexts;
    };

    const fetchListings = async (attempt) => {
        const { boardToken } = attempt;
        const result = await fetchListingsFromApi({ boardToken });
        return {
            jobUrls: result.jobUrls,
            jobEntries: result.jobEntries,
            diagnostics: result.diagnostics,
            api: result.api
        };
    };

    const handleRetry = async ({ attempt, error }) => {
        const status = error.response && error.response.status ? error.response.status : undefined;
        if (status === 404 || status === 410) {
            const discovery = await discoverBoardTokenFromHtml({ url, logger });
            if (discovery.boardToken && discovery.boardToken !== attempt.boardToken) {
                return [{
                    boardToken: discovery.boardToken,
                    source: 'html-refresh',
                    diagnostics: {
                        boardToken: discovery.boardToken,
                        tokenSource: 'html-refresh'
                    }
                }];
            }
        }

        return [];
    };

    const result = await runApiCollector({
        url,
        logger,
        providerId: GREENHOUSE_PROVIDER_ID,
        getInitialContexts,
        fetchListings,
        handleRetry,
        normalizeUrl: normalizeJobUrl,
        contextKey: 'boardToken'
    });

    if (result.success) {
        return {
            providerId: GREENHOUSE_PROVIDER_ID,
            jobUrls: result.jobUrls,
            jobEntries: result.jobEntries,
            diagnostics: result.diagnostics,
            api: result.api
        };
    }

    const message = (result.diagnostics && result.diagnostics.error) || 'greenhouse-api-collection-failed';
    if (logger && typeof logger.warn === 'function') {
        const status = result.diagnostics && result.diagnostics.status ? ` (status ${result.diagnostics.status})` : '';
        logger.warn(`Greenhouse API failed for ${url}${status}: ${message}`);
    }

    const error = new Error(message);
    error.code = 'greenhouse-api-failed';
    error.diagnostics = result.diagnostics;
    throw error;
}

function prepareJobDetail({ url, jobRecord, logger, detailReport, linkReport }) {
    const contextFromUrl = parseGreenhouseContextFromUrl(url);
    const context = {
        boardToken: contextFromUrl.boardToken || null,
        jobId: contextFromUrl.jobId || null,
        url
    };

    if (context.boardToken && context.jobId) {
        context.endpoint = `${GREENHOUSE_API_BASE}/${context.boardToken}/jobs/${context.jobId}`;
    } else if (logger && typeof logger.debug === 'function') {
        logger.debug(`Greenhouse prepareJobDetail missing board/job context for ${url}`);
    }

    if (jobRecord && jobRecord.REMARKS) {
        const trimmed = jobRecord.REMARKS.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (parsed && typeof parsed === 'object') {
                    if (parsed.boardToken && !context.boardToken) {
                        context.boardToken = parsed.boardToken;
                    }
                    if (parsed.jobId && !context.jobId) {
                        context.jobId = parsed.jobId;
                    }
                }
            } catch (_) {
                // ignore malformed remarks metadata
            }
        }
    }

    if (!context.boardToken || !context.jobId) {
        const linkReportContext = resolveBoardContextFromLinkReport({ url, linkReport });
        if (linkReportContext.boardToken && !context.boardToken) {
            context.boardToken = linkReportContext.boardToken;
        }
        if (linkReportContext.jobId && !context.jobId) {
            context.jobId = linkReportContext.jobId;
        }
    }

    if (!context.boardToken) {
        const detailReportContext = resolveBoardContextFromDetailReport({ url, detailReport });
        if (detailReportContext.boardToken) {
            context.boardToken = detailReportContext.boardToken;
        }
    }

    if (!context.endpoint && context.boardToken && context.jobId) {
        context.endpoint = `${GREENHOUSE_API_BASE}/${context.boardToken}/jobs/${context.jobId}`;
    }

    if (context.boardToken) {
        cacheBoardToken(url, context.boardToken);
    }

    return context;
}

async function fetchJobDetail({ url, logger, context }) {
    const derivedContext = context && (context.boardToken || context.jobId)
        ? context
        : parseGreenhouseContextFromUrl(url);

    let boardToken = derivedContext ? derivedContext.boardToken : null;
    const jobId = derivedContext ? derivedContext.jobId : null;
    let endpoint = derivedContext && derivedContext.endpoint
        ? derivedContext.endpoint
        : (boardToken && jobId ? `${GREENHOUSE_API_BASE}/${boardToken}/jobs/${jobId}` : null);

    const diagnostics = {
        boardToken: boardToken || null,
        jobId: jobId || null,
        endpoint: endpoint || undefined
    };

    const startedHr = process.hrtime.bigint();
    const computeDuration = () => {
        const elapsedNs = process.hrtime.bigint() - startedHr;
        const elapsedMs = Number(elapsedNs) / 1e6;
        if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
            return 0;
        }
        if (elapsedMs >= 1) {
            return Math.round(elapsedMs);
        }
        return Number(elapsedMs.toFixed(3));
    };

    const ensureEndpoint = async () => {
        if (endpoint) {
            return endpoint;
        }

        if (!jobId) {
            return null;
        }

        if (!boardToken) {
            const discovery = await discoverBoardTokenFromHtml({ url, logger });
            if (discovery.boardToken) {
                boardToken = discovery.boardToken;
                diagnostics.boardToken = boardToken;

                if (derivedContext) {
                    derivedContext.boardToken = boardToken;
                }
            }
        }

        if (boardToken && jobId) {
            endpoint = `${GREENHOUSE_API_BASE}/${boardToken}/jobs/${jobId}`;
            diagnostics.endpoint = endpoint;
            if (derivedContext) {
                derivedContext.endpoint = endpoint;
            }
        }

        return endpoint;
    };

    endpoint = await ensureEndpoint();
    diagnostics.endpoint = endpoint || diagnostics.endpoint;
    diagnostics.boardToken = boardToken || diagnostics.boardToken;

    let job = null;

    if (!endpoint) {
        diagnostics.error = 'missing-context';
    } else {
        try {
            const response = await httpClient.get(endpoint);
            diagnostics.status = response.status;
            diagnostics.durationMs = computeDuration();

            const data = response.data || {};
            const title = normalizeWhitespace(data.title || data.name || '');
            const location = normalizeWhitespace((data.location && data.location.name) || data.location || 'Remote / Multiple') || 'Remote / Multiple';
            const description = buildDescription(data);

            const jobCandidate = {
                url,
                title,
                location,
                description,
                source: 'greenhouse-api',
                rawMeta: {
                    absoluteUrl: data.absolute_url || null,
                    hostedUrl: data.hosted_url || null,
                    internalJobId: data.internal_job_id || null,
                    employmentType: data.employment_type || null,
                    departments: Array.isArray(data.departments) ? data.departments.map((dept) => dept && dept.name).filter(Boolean) : undefined,
                    offices: Array.isArray(data.offices) ? data.offices.map((office) => office && office.name).filter(Boolean) : undefined
                }
            };

            const validation = validateRequiredFields(jobCandidate, ['title', 'location', 'description']);

            if (!validation.isValid) {
                diagnostics.error = 'fields-empty';
                diagnostics.missingFields = validation.missing;
            } else {
                job = jobCandidate;
                diagnostics.descriptionLength = job.description.length;
            }
        } catch (error) {
            diagnostics.error = error.message;
            diagnostics.status = error.response && error.response.status ? error.response.status : undefined;
            diagnostics.durationMs = computeDuration();
            if (!diagnostics.endpoint) {
                const attemptedUrl = (() => {
                    if (!error || !error.config) {
                        return null;
                    }

                    const { baseURL, url: requestUrl } = error.config;
                    if (requestUrl && /^https?:\/\//i.test(requestUrl)) {
                        return requestUrl;
                    }

                    if (baseURL) {
                        try {
                            if (requestUrl) {
                                return new URL(requestUrl, baseURL).toString();
                            }
                            return baseURL;
                        } catch (_) {
                            return null;
                        }
                    }

                    return requestUrl || null;
                })();

                if (attemptedUrl) {
                    diagnostics.endpoint = attemptedUrl;
                }
            }

            if (logger && typeof logger.warn === 'function') {
                logger.warn(`Greenhouse job detail API failed for ${url}: ${error.message}`);
            }
        }
    }

    if (diagnostics.durationMs === undefined) {
        diagnostics.durationMs = computeDuration();
    }

    if (!diagnostics.endpoint && endpoint) {
        diagnostics.endpoint = endpoint;
    }

    return { job, diagnostics };
}

module.exports = {
    id: GREENHOUSE_PROVIDER_ID,
    matchesUrl,
    normalizeJobUrl,
    collectJobLinks,
    prepareJobDetail,
    fetchJobDetail,
    usesBrowser: false,
    collectsLinksWithBrowser: false
};
