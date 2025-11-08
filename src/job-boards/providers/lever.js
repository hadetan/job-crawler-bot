const { normalizeURL } = require('../../utils');
const { createProviderHttpClient, normalizeWhitespace, convertHtmlToText, normalizeLineBreaks, stripHtml, validateRequiredFields } = require('../detail-helpers');
const { runApiCollector } = require('./api-collector');

const LEVER_PROVIDER_ID = 'lever';
const LEVER_API_BASE = 'https://jobs.lever.co/v0/postings';
const LEVER_API_TIMEOUT_MS = 45000;
const httpClient = createProviderHttpClient({ timeout: LEVER_API_TIMEOUT_MS });
const slugCache = new Map();

const isSharedLeverHost = (hostname = '') => {
    const lower = hostname.toLowerCase();
    return lower === 'jobs.lever.co' || lower === 'apply.lever.co';
};

function getCacheKey(url) {
    try {
        const parsed = new URL(url);
        if (isSharedLeverHost(parsed.hostname)) {
            return null;
        }
        return parsed.hostname.toLowerCase();
    } catch (_) {
        return null;
    }
}

function getCachedSlug(url) {
    const key = getCacheKey(url);
    if (!key) {
        return null;
    }
    return slugCache.get(key) || null;
}

function cacheSlug(url, slug) {
    if (!slug) {
        return;
    }

    const key = getCacheKey(url);
    if (!key) {
        return;
    }

    slugCache.set(key, slug);
}

function derivePostingId(segments = []) {
    for (let i = segments.length - 1; i >= 0; i -= 1) {
        const value = segments[i];
        if (!value) {
            continue;
        }

        const lower = value.toLowerCase();
        if (lower === 'apply' || lower === 'jobs' || lower === 'job' || lower === 'opportunities') {
            continue;
        }

        return value;
    }

    return null;
}

function getSlugFromHost(hostname = '') {
    if (!hostname) {
        return null;
    }

    const lower = hostname.toLowerCase();

    if (isSharedLeverHost(lower)) {
        return null;
    }

    const directMatch = lower.match(/^([a-z0-9-]+)\.lever\.co$/i);
    if (directMatch && directMatch[1]) {
        return directMatch[1];
    }

    const parts = lower.split('.');
    if (parts.length >= 3 && parts[parts.length - 2] === 'lever' && parts[parts.length - 1] === 'co') {
        return parts[0];
    }

    return null;
}

function parseLeverContextFromUrl(url) {
    try {
        const parsed = new URL(url);
        const hostname = parsed.hostname;
        const loweredHost = hostname.toLowerCase();
        const pathSegments = parsed.pathname.split('/').filter(Boolean);

        if (isSharedLeverHost(loweredHost)) {
            if (pathSegments.length > 0) {
                const slug = decodeURIComponent(pathSegments[0] || '').trim();
                return {
                    companySlug: slug || null,
                    postingId: derivePostingId(pathSegments.slice(1))
                };
            }
        }

        const hostSlug = getSlugFromHost(hostname);
        if (hostSlug) {
            return {
                companySlug: hostSlug,
                postingId: derivePostingId(pathSegments)
            };
        }

        return { companySlug: null, postingId: null };
    } catch (_) {
        return { companySlug: null, postingId: null };
    }
}

function parseLeverHintsFromHtml(html, baseUrl) {
    if (!html || typeof html !== 'string') {
        return { slug: null };
    }

    const slugCandidates = new Set();

    const addSlugCandidate = (value) => {
        if (!value) {
            return;
        }

        const trimmed = String(value).trim();
        if (trimmed) {
            slugCandidates.add(trimmed);
        }
    };

    const scriptRegex = /<script[^>]+src=["']([^"']+)["'][^>]*>/gi;
    let match;

    while ((match = scriptRegex.exec(html)) !== null) {
        const rawSrc = match[1];
        if (!rawSrc || !rawSrc.includes('lever.co')) {
            continue;
        }

        try {
            const resolved = new URL(rawSrc, baseUrl);
            const host = resolved.hostname;
            const hostLower = host.toLowerCase();

            if (isSharedLeverHost(hostLower)) {
                const parts = resolved.pathname.split('/').filter(Boolean);
                if (parts.length > 0) {
                    addSlugCandidate(parts[0]);
                }
            } else if (hostLower.endsWith('.lever.co')) {
                const segments = host.split('.');
                if (segments.length >= 3) {
                    addSlugCandidate(segments[0]);
                }
            }

            const pathMatch = resolved.pathname.match(/postings\/(\w[\w-]+)/i);
            if (pathMatch && pathMatch[1]) {
                addSlugCandidate(pathMatch[1]);
            }
        } catch (_) {
            // ignore resolution failures
        }
    }

    const dataDomainRegex = /data-lever-(?:domain|job-board)=["']([^"']+)["']/gi;
    while ((match = dataDomainRegex.exec(html)) !== null) {
        addSlugCandidate(match[1]);
    }

    const inlineSlugRegex = /lever\.co\/v0\/postings\/(\w[\w-]+)/gi;
    while ((match = inlineSlugRegex.exec(html)) !== null) {
        addSlugCandidate(match[1]);
    }

    const accountNameRegex = /accountName\s*[:=]\s*['"](\w[\w-]+)['"]/gi;
    while ((match = accountNameRegex.exec(html)) !== null) {
        addSlugCandidate(match[1]);
    }

    const slug = slugCandidates.values().next().value || null;
    return { slug };
}

async function discoverSlugFromHtml({ url, logger }) {
    const cached = getCachedSlug(url);
    if (cached) {
        return { slug: cached };
    }

    try {
        const response = await httpClient.get(url, { responseType: 'text' });
        const html = typeof response.data === 'string' ? response.data : '';
        const { slug } = parseLeverHintsFromHtml(html, url);

        if (slug) {
            cacheSlug(url, slug);
        }

        return { slug };
    } catch (error) {
        if (logger) {
            if (typeof logger.debug === 'function') {
                logger.debug(`Lever slug discovery failed for ${url}: ${error.message}`);
            } else if (typeof logger.warn === 'function') {
                logger.warn(`Lever slug discovery failed for ${url}: ${error.message}`);
            }
        }
        return { slug: null };
    }
}

function prepareJobDetail({ url, jobRecord, logger }) {
    const contextFromUrl = parseLeverContextFromUrl(url);
    const context = {
        companySlug: contextFromUrl.companySlug || null,
        postingId: contextFromUrl.postingId || null,
        url
    };

    if (context.companySlug && context.postingId) {
        context.endpoint = `${LEVER_API_BASE}/${context.companySlug}/${context.postingId}`;
    } else if (logger && typeof logger.debug === 'function') {
        logger.debug(`Lever prepareJobDetail could not derive slug/posting for ${url}`);
    }

    if (jobRecord && jobRecord.REMARKS) {
        const trimmed = jobRecord.REMARKS.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (parsed && typeof parsed === 'object') {
                    if (parsed.companySlug && !context.companySlug) {
                        context.companySlug = parsed.companySlug;
                    }
                    if (parsed.postingId && !context.postingId) {
                        context.postingId = parsed.postingId;
                    }
                }
            } catch (_) {
                // Ignore malformed remarks metadata.
            }
        }
    }

    return context;
}

const matchesUrl = (url) => {
    if (!url) {
        return false;
    }

    try {
        const parsed = new URL(url);
        const hostname = parsed.hostname.toLowerCase();
        return hostname.includes('lever.co');
    } catch (_) {
        return url.includes('lever.co');
    }
};

const normalizeJobUrl = (url) => {
    try {
        const parsed = new URL(url);
        if (!parsed.hostname.toLowerCase().includes('lever.co')) {
            return url;
        }

        parsed.searchParams.delete('lever-source');
        parsed.searchParams.delete('utm_source');
        parsed.searchParams.delete('utm_medium');
        parsed.searchParams.delete('utm_campaign');
        parsed.hash = '';
        return parsed.toString();
    } catch (_) {
        return url;
    }
};

const fetchListingsFromApi = async ({ companySlug }) => {
    if (!companySlug) {
        return { jobUrls: [], diagnostics: { error: 'missing-slug' } };
    }

    const params = new URLSearchParams({ mode: 'json', limit: '50' });

    const baseApiUrl = `${LEVER_API_BASE}/${companySlug}`;

    let skip = 0;
    let safetyCounter = 0;
    const jobUrls = [];
    const dedupeKeys = new Set();
    const diagnostics = { pages: 0, totalPostings: 0, companySlug };

    while (safetyCounter < 20) {
        const query = new URLSearchParams(params.toString());
        if (skip > 0) {
            query.set('skip', String(skip));
        }

        let response;
        try {
            response = await httpClient.get(baseApiUrl, {
                params: Object.fromEntries(query.entries()),
            });
        } catch (error) {
            error.leverContext = {
                companySlug,
                params: Object.fromEntries(query.entries())
            };
            throw error;
        }

        if (!Array.isArray(response.data) || response.data.length === 0) {
            break;
        }

        diagnostics.pages += 1;
        diagnostics.totalPostings += response.data.length;

        response.data.forEach((posting) => {
            const hostedUrl = posting.hostedUrl || posting.applyUrl || `https://jobs.lever.co/${companySlug}/${posting.id}`;
            if (!hostedUrl) {
                return;
            }

            const canonical = normalizeJobUrl(hostedUrl);
            const dedupeKey = normalizeURL(canonical);

            if (!dedupeKeys.has(dedupeKey)) {
                dedupeKeys.add(dedupeKey);
                jobUrls.push(canonical);
            }
        });

        if (response.data.length < Number(params.get('limit'))) {
            break;
        }

        skip += response.data.length;
        safetyCounter += 1;
    }

    return {
        jobUrls,
        diagnostics,
        api: baseApiUrl
    };
};

async function collectJobLinks({ url, logger }) {
    const contextFromUrl = parseLeverContextFromUrl(url);

    const getInitialContexts = async () => {
        const contexts = [];

        if (contextFromUrl.companySlug) {
            contexts.push({
                companySlug: contextFromUrl.companySlug,
                postingId: contextFromUrl.postingId || null,
                source: 'url-path',
                diagnostics: {
                    slug: contextFromUrl.companySlug,
                    slugSource: 'url-path'
                }
            });
        } else {
            const discovery = await discoverSlugFromHtml({ url, logger });
            if (discovery.slug) {
                contexts.push({
                    companySlug: discovery.slug,
                    postingId: contextFromUrl.postingId || null,
                    source: 'html-initial',
                    diagnostics: {
                        slug: discovery.slug,
                        slugSource: 'html'
                    }
                });
            }
        }

        return contexts;
    };

    const fetchListings = async (attempt) => {
        const { companySlug } = attempt;
        const response = await fetchListingsFromApi({
            companySlug
        });

        return {
            jobUrls: response.jobUrls,
            diagnostics: response.diagnostics,
            api: response.api
        };
    };

    const handleRetry = async ({ attempt, error }) => {
        const status = error.response && error.response.status ? error.response.status : undefined;

        if (status === 404) {
            const discovery = await discoverSlugFromHtml({ url, logger });
            if (discovery.slug && discovery.slug !== attempt.companySlug) {
                return [{
                    companySlug: discovery.slug,
                    postingId: attempt.postingId || null,
                    source: 'html-refresh',
                    diagnostics: {
                        slug: discovery.slug,
                        slugSource: 'html-refresh'
                    }
                }];
            }
        }

        return [];
    };

    const result = await runApiCollector({
        url,
        logger,
        providerId: LEVER_PROVIDER_ID,
        contextKey: 'companySlug',
        getInitialContexts,
        fetchListings,
        handleRetry,
        normalizeUrl: normalizeJobUrl
    });

    if (result.success) {
        return {
            providerId: LEVER_PROVIDER_ID,
            jobUrls: result.jobUrls,
            diagnostics: result.diagnostics,
            api: result.api
        };
    }

    let failureMessage = (result.diagnostics && result.diagnostics.error) || 'lever-api-collection-failed';
    if (failureMessage === 'no-initial-context') {
        failureMessage = 'Unable to derive Lever company slug from URL';
    }
    if (logger && typeof logger.warn === 'function') {
        const statusNote = result.diagnostics && result.diagnostics.status ? ` (status ${result.diagnostics.status})` : '';
        logger.warn(`Lever API failed for ${url}${statusNote}: ${failureMessage}`);
    }

    const error = new Error(failureMessage);
    error.code = 'lever-api-failed';
    error.diagnostics = result.diagnostics;
    throw error;
}

const buildDescription = (data) => {
    if (!data) {
        return '';
    }

    const html = typeof data.description === 'string' ? data.description : '';
    const plainFallback = typeof data.descriptionPlain === 'string'
        ? data.descriptionPlain
        : (typeof data.descriptionText === 'string' ? data.descriptionText : '');

    let description = convertHtmlToText(html);

    if (!description && plainFallback) {
        description = normalizeLineBreaks(plainFallback);
    }

    if (!description && html) {
        description = normalizeLineBreaks(stripHtml(html));
    }

    return description || '';
};

const buildSections = (data, primaryDescription = '') => {
    if (!data) {
        return [];
    }

    const sections = [];

    const appendSection = (title, htmlValue) => {
        if (!htmlValue) {
            return;
        }

        const raw = typeof htmlValue === 'string' ? htmlValue.trim() : '';
        if (!raw) {
            return;
        }

        let content = convertHtmlToText(raw);
        if (!content) {
            content = normalizeLineBreaks(stripHtml(raw));
        }

        if (!content) {
            return;
        }

        const normalizedPrimary = typeof primaryDescription === 'string' ? primaryDescription.trim() : '';
        const normalizedContent = content.trim();

        if (normalizedPrimary && normalizedContent === normalizedPrimary) {
            return;
        }

        sections.push({
            title: title || 'Additional Details',
            content: normalizedContent
        });
    };

    appendSection('Opening', data.opening || data.openingBody || data.openingHtml);
    appendSection('Description Body', data.descriptionBody || data.descriptionBodyHtml);

    if (Array.isArray(data.lists)) {
        data.lists.forEach((entry, index) => {
            if (!entry) {
                return;
            }

            const heading = typeof entry.text === 'string' && entry.text.trim()
                ? entry.text.trim()
                : `Section ${index + 1}`;

            appendSection(heading, entry.content || entry.html || entry.body);
        });
    }

    return sections;
};

async function fetchJobDetail({ url, logger, context }) {
    const derivedContext = context && (context.companySlug || context.postingId)
        ? context
        : parseLeverContextFromUrl(url);

    const companySlug = derivedContext ? derivedContext.companySlug : null;
    const postingId = derivedContext ? derivedContext.postingId : null;
    const endpoint = derivedContext && derivedContext.endpoint
        ? derivedContext.endpoint
        : (companySlug && postingId ? `${LEVER_API_BASE}/${companySlug}/${postingId}` : null);

    const diagnostics = {
        companySlug: companySlug || null,
        postingId: postingId || null,
        endpoint: endpoint || undefined
    };

    const startedAt = Date.now();
    let job = null;

    if (!endpoint) {
        diagnostics.error = 'missing-context';
    } else {
        try {
            const response = await httpClient.get(endpoint, { params: { mode: 'json' } });
            diagnostics.status = response.status;
            diagnostics.durationMs = Date.now() - startedAt;

            const data = response.data;
            if (data) {
                const categories = data.categories || {};
                const location = normalizeWhitespace(
                    categories.location ||
                    categories.workLocation ||
                    (data.additional && (data.additional.location || data.additional.workLocation)) ||
                    'Remote / Multiple'
                ) || 'Remote / Multiple';

                const description = buildDescription(data);
                const title = normalizeWhitespace(data.text || data.title || '');

                const sections = buildSections(data, description);
                const hasSections = Array.isArray(sections) && sections.length > 0;

                const jobCandidate = {
                    url,
                    title,
                    location,
                    description,
                    source: 'lever-api',
                    rawMeta: {
                        commitment: categories.commitment || (data.additional && data.additional.commitment) || null,
                        team: categories.team || (data.additional && data.additional.team) || null,
                        department: categories.department || null,
                        level: categories.levels || null,
                        workplaceType: categories.workType || null
                    }
                };

                if (hasSections) {
                    jobCandidate.sections = sections;
                }

                const validation = validateRequiredFields(jobCandidate, ['title']);

                if (!validation.isValid) {
                    diagnostics.error = 'fields-empty';
                    diagnostics.missingFields = validation.missing;
                } else {
                    job = jobCandidate;
                    diagnostics.descriptionLength = job.description.length;
                    if (hasSections) {
                        diagnostics.sectionCount = sections.length;
                    }
                }
            } else {
                diagnostics.error = 'empty-response';
            }
        } catch (error) {
            diagnostics.error = error.message;
            diagnostics.status = error.response && error.response.status ? error.response.status : undefined;
            diagnostics.durationMs = Date.now() - startedAt;

            if (logger) {
                logger.warn(`Lever job detail API failed for ${url}: ${error.message}`);
            }
        }
    }

    diagnostics.durationMs = diagnostics.durationMs || (Date.now() - startedAt);

    return { job, diagnostics };
}

module.exports = {
    id: LEVER_PROVIDER_ID,
    matchesUrl,
    normalizeJobUrl,
    collectJobLinks,
    prepareJobDetail,
    fetchJobDetail,
};
