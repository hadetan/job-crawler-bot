const { normalizeURL } = require('../../utils');
const { createProviderHttpClient, resolveDescription, normalizeWhitespace, stripHtml } = require('../detail-helpers');
const { mergeFilters, runApiCollector } = require('./api-collector');

const GREENHOUSE_PROVIDER_ID = 'greenhouse';
const GREENHOUSE_API_BASE = 'https://boards-api.greenhouse.io/v1/boards';
const SUPPORTED_FILTER_KEYS = new Set(['department', 'departments', 'office', 'offices', 'location', 'job_type', 'employment_type']);
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

function applyFilterValue(target, key, value) {
    if (!value || !SUPPORTED_FILTER_KEYS.has(key)) {
        return;
    }

    if (!target[key]) {
        target[key] = value;
    }
}

function applyFiltersFromSearch(target, search) {
    if (!search) {
        return;
    }

    const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
    params.forEach((value, key) => {
        applyFilterValue(target, key, value);
    });
}

function parseGreenhouseContextFromUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        const hostname = parsed.hostname.toLowerCase();
        const pathSegments = parsed.pathname.split('/').filter(Boolean);
        const filters = {};
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

            applyFilterValue(filters, lowered, value);
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

        return { boardToken, jobId, filters };
    } catch (_) {
        return { boardToken: null, jobId: null, filters: {} };
    }
}

function parseGreenhouseHintsFromHtml(html, baseUrl) {
    if (!html || typeof html !== 'string') {
        return { boardToken: null, filters: {} };
    }

    const boardCandidates = new Set();
    const filters = {};

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

            applyFiltersFromSearch(filters, resolved.search);

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

    SUPPORTED_FILTER_KEYS.forEach((key) => {
        const attrRegex = new RegExp(`data-${key}=["']([^"']+)["']`, 'gi');
        let attrMatch;
        while ((attrMatch = attrRegex.exec(html)) !== null) {
            applyFilterValue(filters, key, attrMatch[1]);
        }
    });

    const boardToken = boardCandidates.values().next().value || null;
    return { boardToken, filters };
}

async function discoverBoardTokenFromHtml({ url, logger }) {
    const cached = getCachedBoardToken(url);
    if (cached) {
        return { boardToken: cached, filters: {} };
    }

    try {
        const response = await htmlHttpClient.get(url, { responseType: 'text' });
        const html = typeof response.data === 'string' ? response.data : '';
        const { boardToken, filters } = parseGreenhouseHintsFromHtml(html, url);

        if (boardToken) {
            cacheBoardToken(url, boardToken);
        }

        return { boardToken, filters };
    } catch (error) {
        if (logger) {
            if (typeof logger.debug === 'function') {
                logger.debug(`Greenhouse board token discovery failed for ${url}: ${error.message}`);
            } else if (typeof logger.warn === 'function') {
                logger.warn(`Greenhouse board token discovery failed for ${url}: ${error.message}`);
            }
        }
        return { boardToken: null, filters: {} };
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

function extractSkillsFromHtml(html) {
    if (!html) {
        return [];
    }

    const normalized = decodeHtmlEntities(html);
    const matches = normalized.match(/<li[^>]*>(.*?)<\/li>/gis) || [];
    const skills = new Set();

    matches.forEach((entry) => {
        const text = normalizeWhitespace(stripHtml(entry));
        if (text && text.length <= 160) {
            skills.add(text);
        }
    });

    return Array.from(skills);
}

async function fetchListingsFromApi({ boardToken, filters }) {
    if (!boardToken) {
        return { jobUrls: [], diagnostics: { error: 'missing-board-token' } };
    }

    const dedupe = new Set();
    const jobUrls = [];
    const diagnostics = { boardToken, filters: { ...(filters || {}) }, pages: 0, totalJobs: 0 };
    let page = 1;

    const baseApiUrl = `${GREENHOUSE_API_BASE}/${boardToken}/jobs`;

    while (page <= MAX_API_PAGES) {
        const params = new URLSearchParams();
        params.set('page', String(page));
        params.set('per_page', String(JOBS_PER_PAGE));
        params.set('content', 'false');

        Object.entries(filters || {}).forEach(([key, value]) => {
            if (value) {
                params.append(key, value);
            }
        });

        let response;
        try {
            response = await httpClient.get(baseApiUrl, {
                params: Object.fromEntries(params.entries())
            });
        } catch (error) {
            error.greenhouseContext = {
                boardToken,
                filters: { ...(filters || {}) },
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

    return { jobUrls, diagnostics, api: baseApiUrl };
}

async function collectJobLinks({ url, logger }) {
    const contextFromUrl = parseGreenhouseContextFromUrl(url);

    const getInitialContexts = async () => {
        const contexts = [];

        if (contextFromUrl.boardToken) {
            const baseFilters = { ...(contextFromUrl.filters || {}) };
            contexts.push({
                boardToken: contextFromUrl.boardToken,
                filters: baseFilters,
                source: 'url-path',
                diagnostics: {
                    boardToken: contextFromUrl.boardToken,
                    tokenSource: 'url-path',
                    filters: baseFilters
                }
            });
        } else {
            const discovery = await discoverBoardTokenFromHtml({ url, logger });
            if (discovery.boardToken) {
                const mergedFilters = mergeFilters(contextFromUrl.filters, discovery.filters);
                contexts.push({
                    boardToken: discovery.boardToken,
                    filters: mergedFilters,
                    source: 'html-discovery',
                    diagnostics: {
                        boardToken: discovery.boardToken,
                        tokenSource: 'html',
                        filters: mergedFilters
                    }
                });
            }
        }

        return contexts;
    };

    const fetchListings = async (attempt) => {
        const { boardToken, filters } = attempt;
        const result = await fetchListingsFromApi({ boardToken, filters });
        return {
            jobUrls: result.jobUrls,
            diagnostics: result.diagnostics,
            api: result.api
        };
    };

    const handleRetry = async ({ attempt, error }) => {
        const status = error.response && error.response.status ? error.response.status : undefined;
        if (status === 404 || status === 410) {
            const discovery = await discoverBoardTokenFromHtml({ url, logger });
            if (discovery.boardToken && discovery.boardToken !== attempt.boardToken) {
                const mergedFilters = mergeFilters(attempt.filters, discovery.filters);
                return [{
                    boardToken: discovery.boardToken,
                    filters: mergedFilters,
                    source: 'html-refresh',
                    diagnostics: {
                        boardToken: discovery.boardToken,
                        tokenSource: 'html-refresh',
                        filters: mergedFilters
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

function prepareJobDetail({ url, jobRecord, logger }) {
    const contextFromUrl = parseGreenhouseContextFromUrl(url);
    const context = {
        boardToken: contextFromUrl.boardToken || null,
        jobId: contextFromUrl.jobId || null,
        filters: contextFromUrl.filters || {},
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
                    if (parsed.filters && typeof parsed.filters === 'object') {
                        context.filters = { ...context.filters, ...parsed.filters };
                    }
                }
            } catch (_) {
                // ignore malformed remarks metadata
            }
        }
    }

    if (!context.endpoint && context.boardToken && context.jobId) {
        context.endpoint = `${GREENHOUSE_API_BASE}/${context.boardToken}/jobs/${context.jobId}`;
    }

    return context;
}

async function fetchJobDetail({ url, logger, context }) {
    const derivedContext = context && (context.boardToken || context.jobId)
        ? context
        : parseGreenhouseContextFromUrl(url);

    const boardToken = derivedContext ? derivedContext.boardToken : null;
    const jobId = derivedContext ? derivedContext.jobId : null;
    const endpoint = derivedContext && derivedContext.endpoint
        ? derivedContext.endpoint
        : (boardToken && jobId ? `${GREENHOUSE_API_BASE}/${boardToken}/jobs/${jobId}` : null);

    const diagnostics = {
        boardToken: boardToken || null,
        jobId: jobId || null,
        endpoint: endpoint || undefined,
        filters: derivedContext && derivedContext.filters ? derivedContext.filters : undefined
    };

    const startedAt = Date.now();
    let job = null;

    if (!endpoint) {
        diagnostics.error = 'missing-context';
    } else {
        try {
            const response = await httpClient.get(endpoint);
            diagnostics.status = response.status;
            diagnostics.durationMs = Date.now() - startedAt;

            const data = response.data || {};
            const rawHtml = decodeHtmlEntities(data.content || '');
            const title = normalizeWhitespace(data.title || data.name || '');
            const location = normalizeWhitespace((data.location && data.location.name) || data.location || 'Remote / Multiple') || 'Remote / Multiple';
            const description = resolveDescription({ html: rawHtml });
            const skills = extractSkillsFromHtml(data.content || '');

            if (title && description && description.length >= 50) {
                job = {
                    url,
                    title,
                    location,
                    description,
                    skills,
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

                diagnostics.descriptionLength = job.description.length;
                diagnostics.skillCount = job.skills.length;
            } else {
                diagnostics.error = 'insufficient-content';
            }
        } catch (error) {
            diagnostics.error = error.message;
            diagnostics.status = error.response && error.response.status ? error.response.status : undefined;
            diagnostics.durationMs = Date.now() - startedAt;

            if (logger && typeof logger.warn === 'function') {
                logger.warn(`Greenhouse job detail API failed for ${url}: ${error.message}`);
            }
        }
    }

    diagnostics.durationMs = diagnostics.durationMs || (Date.now() - startedAt);

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
