const config = require('../../config');
const { normalizeURL } = require('../../utils');
const { createProviderHttpClient, resolveDescription, collectListText, normalizeWhitespace } = require('../detail-helpers');
const { mergeFilters, runApiCollector } = require('./api-collector');

const LEVER_PROVIDER_ID = 'lever';
const LEVER_API_BASE = 'https://jobs.lever.co/v0/postings';
const SUPPORTED_FILTER_KEYS = new Set(['team', 'department', 'location', 'commitment', 'worktype', 'worktypev2']);
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
        const filters = {};

        parsed.searchParams.forEach((value, key) => {
            if (SUPPORTED_FILTER_KEYS.has(key)) {
                filters[key] = value;
            }
        });

        if (isSharedLeverHost(loweredHost)) {
            if (pathSegments.length > 0) {
                const slug = decodeURIComponent(pathSegments[0] || '').trim();
                return {
                    companySlug: slug || null,
                    postingId: derivePostingId(pathSegments.slice(1)),
                    filters
                };
            }
        }

        const hostSlug = getSlugFromHost(hostname);
        if (hostSlug) {
            return {
                companySlug: hostSlug,
                postingId: derivePostingId(pathSegments),
                filters
            };
        }

        return { companySlug: null, postingId: null, filters };
    } catch (_) {
        return { companySlug: null, postingId: null, filters: {} };
    }
}

function applyFilterValue(target, key, value) {
    if (!value) {
        return;
    }

    if (SUPPORTED_FILTER_KEYS.has(key)) {
        if (!target[key]) {
            target[key] = value;
        }
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

function parseLeverHintsFromHtml(html, baseUrl) {
    if (!html || typeof html !== 'string') {
        return { slug: null, filters: {} };
    }

    const slugCandidates = new Set();
    const filters = {};

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

            applyFiltersFromSearch(filters, resolved.search);
        } catch (_) {
            // ignore resolution failures
        }
    }

    const dataDomainRegex = /data-lever-(?:domain|job-board)=["']([^"']+)["']/gi;
    while ((match = dataDomainRegex.exec(html)) !== null) {
        addSlugCandidate(match[1]);
    }

    SUPPORTED_FILTER_KEYS.forEach((key) => {
        const attrRegex = new RegExp(`data-${key}=["']([^"']+)["']`, 'gi');
        let attrMatch;
        while ((attrMatch = attrRegex.exec(html)) !== null) {
            applyFilterValue(filters, key, attrMatch[1]);
        }
    });

    const inlineSlugRegex = /lever\.co\/v0\/postings\/(\w[\w-]+)/gi;
    while ((match = inlineSlugRegex.exec(html)) !== null) {
        addSlugCandidate(match[1]);
    }

    const accountNameRegex = /accountName\s*[:=]\s*['"](\w[\w-]+)['"]/gi;
    while ((match = accountNameRegex.exec(html)) !== null) {
        addSlugCandidate(match[1]);
    }

    const slug = slugCandidates.values().next().value || null;
    return { slug, filters };
}

async function discoverSlugFromHtml({ url, logger }) {
    const cached = getCachedSlug(url);
    if (cached) {
        return { slug: cached, filters: {} };
    }

    try {
        const response = await httpClient.get(url, { responseType: 'text' });
        const html = typeof response.data === 'string' ? response.data : '';
        const { slug, filters } = parseLeverHintsFromHtml(html, url);

        if (slug) {
            cacheSlug(url, slug);
        }

        return { slug, filters };
    } catch (error) {
        if (logger) {
            if (typeof logger.debug === 'function') {
                logger.debug(`Lever slug discovery failed for ${url}: ${error.message}`);
            } else if (typeof logger.warn === 'function') {
                logger.warn(`Lever slug discovery failed for ${url}: ${error.message}`);
            }
        }
        return { slug: null, filters: {} };
    }
}

function prepareJobDetail({ url, jobRecord, logger }) {
    const contextFromUrl = parseLeverContextFromUrl(url);
    const context = {
        companySlug: contextFromUrl.companySlug || null,
        postingId: contextFromUrl.postingId || null,
        filters: contextFromUrl.filters || {},
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
                if (parsed && typeof parsed === 'object' && parsed.filters) {
                    context.filters = { ...context.filters, ...parsed.filters };
                }
            } catch (_) {
                // Ignore malformed remarks metadata.
            }
        }
    }

    return context;
}

async function ensurePageLoaded(page, url) {
    await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: config.crawler.pageTimeout
    });
}

async function extractJobDataFromDom({ ensurePage, url, logger }) {
    if (typeof ensurePage !== 'function') {
        return null;
    }

    try {
        const page = await ensurePage();
        await ensurePageLoaded(page, url);

        return await page.evaluate(() => {
            const sanitize = (value) => {
                if (typeof value !== 'string') {
                    return '';
                }
                return value.replace(/\s+/g, ' ').trim();
            };

            const parsedPayloads = [];
            document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
                const raw = script.textContent || script.innerText || '';
                if (!raw.trim()) {
                    return;
                }

                try {
                    const json = JSON.parse(raw);
                    if (Array.isArray(json)) {
                        json.forEach((item) => parsedPayloads.push(item));
                    } else {
                        parsedPayloads.push(json);
                    }
                } catch (_) {
                    // Ignore badly formatted JSON payloads.
                }
            });

            const jobPosting = parsedPayloads.find((item) => {
                if (!item) {
                    return false;
                }

                const type = item['@type'];
                if (Array.isArray(type)) {
                    return type.some((entry) => String(entry).toLowerCase() === 'jobposting');
                }
                if (typeof type === 'string') {
                    return type.toLowerCase() === 'jobposting';
                }
                return false;
            });

            const descriptionHtmlFromJson = jobPosting && jobPosting.description ? String(jobPosting.description) : '';
            const descriptionPlainFromJson = sanitize(descriptionHtmlFromJson.replace(/<[^>]+>/g, ' '));

            const descriptionNode =
                document.querySelector('[data-qa="job-description"], [data-qa="description"]') ||
                document.querySelector('section.description, section.job-description, article');
            const descriptionHtmlFromDom = descriptionNode ? descriptionNode.innerHTML : '';
            const descriptionPlainFromDom = descriptionNode ? sanitize(descriptionNode.textContent || '') : '';

            const titleFromJson = sanitize(jobPosting && (jobPosting.title || jobPosting.name));
            const titleFromDom = sanitize(
                (document.querySelector('[data-qa="posting-name"]') || document.querySelector('h1'))?.textContent || ''
            );

            let location = '';
            const jobLocation = jobPosting && jobPosting.jobLocation;
            if (Array.isArray(jobLocation)) {
                location = sanitize(
                    jobLocation
                        .map((loc) => {
                            if (!loc) {
                                return '';
                            }
                            if (typeof loc === 'string') {
                                return loc;
                            }

                            const address = loc.address || loc;
                            if (typeof address === 'string') {
                                return address;
                            }

                            if (address && typeof address === 'object') {
                                const locality = address.addressLocality || '';
                                const region = address.addressRegion || '';
                                const country = address.addressCountry || '';
                                const remote =
                                    typeof address['@type'] === 'string' && address['@type'].toLowerCase().includes('virtual');
                                const summary = [locality, region, country].filter(Boolean).join(', ');
                                return summary || (remote ? 'Remote' : '');
                            }

                            return '';
                        })
                        .filter(Boolean)
                        .join(' / ')
                );
            } else if (jobLocation && typeof jobLocation === 'object') {
                const address = jobLocation.address || jobLocation;
                const locality = address.addressLocality || '';
                const region = address.addressRegion || '';
                const country = address.addressCountry || '';
                const remote = typeof address['@type'] === 'string' && address['@type'].toLowerCase().includes('virtual');
                location = sanitize([locality, region, country].filter(Boolean).join(', ')) || (remote ? 'Remote' : '');
            } else if (jobLocation && typeof jobLocation === 'string') {
                location = sanitize(jobLocation);
            }

            if (!location) {
                const domLocation =
                    document.querySelector('[data-qa="location"]') ||
                    document.querySelector('.location, .posting-address');
                location = sanitize(domLocation ? domLocation.textContent || '' : '');
            }

            const skillSelectors = [
                '[data-qa="job-description"] ul li',
                '[data-qa="description"] ul li',
                'section ul li',
                '.content ul li',
                'article ul li'
            ];
            const skills = new Set();
            skillSelectors.forEach((selector) => {
                document.querySelectorAll(selector).forEach((item) => {
                    const text = sanitize(item.textContent || '');
                    if (text && text.length <= 120) {
                        skills.add(text);
                    }
                });
            });

            return {
                title: titleFromJson || titleFromDom || '',
                descriptionHtml: descriptionHtmlFromJson || descriptionHtmlFromDom || '',
                descriptionPlain: descriptionPlainFromJson || descriptionPlainFromDom || '',
                location: location || '',
                skills: Array.from(skills)
            };
        });
    } catch (error) {
        if (logger) {
            logger.warn(`Lever DOM extraction failed for ${url}: ${error.message}`);
        }
        return null;
    }
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

const fetchListingsFromApi = async ({ companySlug, filters }) => {
    if (!companySlug) {
        return { jobUrls: [], diagnostics: { error: 'missing-slug' } };
    }

    const params = new URLSearchParams({ mode: 'json', limit: '50' });
    Object.entries(filters || {}).forEach(([key, value]) => {
        if (value) {
            params.append(key, value);
        }
    });

    const baseApiUrl = `${LEVER_API_BASE}/${companySlug}`;

    let skip = 0;
    let safetyCounter = 0;
    const jobUrls = [];
    const dedupeKeys = new Set();
    const diagnostics = { pages: 0, totalPostings: 0, companySlug, filters };

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
                filters: { ...filters },
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
            const baseFilters = { ...(contextFromUrl.filters || {}) };
            contexts.push({
                companySlug: contextFromUrl.companySlug,
                postingId: contextFromUrl.postingId || null,
                filters: baseFilters,
                source: 'url-path',
                diagnostics: {
                    slug: contextFromUrl.companySlug,
                    slugSource: 'url-path',
                    filters: baseFilters
                }
            });
        } else {
            const discovery = await discoverSlugFromHtml({ url, logger });
            if (discovery.slug) {
                const mergedFilters = mergeFilters(contextFromUrl.filters, discovery.filters);
                contexts.push({
                    companySlug: discovery.slug,
                    postingId: contextFromUrl.postingId || null,
                    filters: mergedFilters,
                    source: 'html-initial',
                    diagnostics: {
                        slug: discovery.slug,
                        slugSource: 'html',
                        filters: mergedFilters
                    }
                });
            }
        }

        return contexts;
    };

    const fetchListings = async (attempt) => {
        const { companySlug, filters } = attempt;
        const response = await fetchListingsFromApi({
            companySlug,
            filters
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
                const mergedFilters = mergeFilters(attempt.filters, discovery.filters);
                return [{
                    companySlug: discovery.slug,
                    postingId: attempt.postingId || null,
                    filters: mergedFilters,
                    source: 'html-refresh',
                    diagnostics: {
                        slug: discovery.slug,
                        slugSource: 'html-refresh',
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
            strategy: 'lever-api',
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

async function fetchJobDetail({ url, logger, context, ensurePage }) {
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
        endpoint: endpoint || undefined,
        filters: derivedContext && derivedContext.filters ? derivedContext.filters : undefined
    };

    const startedAt = Date.now();
    let job = null;
    let strategy = 'lever-api';

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

                const description = resolveDescription({
                    plainText: data.descriptionPlain || data.descriptionText || '',
                    html: data.description || ''
                });

                const title = normalizeWhitespace(data.text || data.title || '');

                if (title && title.length >= 3 && description && description.length >= 50) {
                    const skills = collectListText(Array.isArray(data.lists) ? data.lists : []);

                    job = {
                        url,
                        title,
                        location,
                        description,
                        skills,
                        source: 'lever-api',
                        rawMeta: {
                            commitment: categories.commitment || (data.additional && data.additional.commitment) || null,
                            team: categories.team || (data.additional && data.additional.team) || null,
                            department: categories.department || null,
                            level: categories.levels || null,
                            workplaceType: categories.workType || null
                        }
                    };

                    diagnostics.skillCount = job.skills.length;
                    diagnostics.descriptionLength = job.description.length;
                } else {
                    diagnostics.error = 'insufficient-content';
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

    if (!job) {
        const domPayload = await extractJobDataFromDom({ ensurePage, url, logger });

        if (domPayload) {
            const fallbackTitle = normalizeWhitespace(domPayload.title || '');
            const fallbackDescription = resolveDescription({
                plainText: domPayload.descriptionPlain || '',
                html: domPayload.descriptionHtml || ''
            });
            const fallbackLocation = normalizeWhitespace(domPayload.location || '') || 'Remote / Multiple';
            const fallbackSkills = Array.from(
                new Set((domPayload.skills || []).map(normalizeWhitespace).filter(Boolean))
            );

            if (fallbackTitle && fallbackDescription && fallbackDescription.length >= 30) {
                job = {
                    url,
                    title: fallbackTitle,
                    location: fallbackLocation,
                    description: fallbackDescription,
                    skills: fallbackSkills,
                    source: 'lever-dom',
                    rawMeta: {
                        fallback: 'dom-jsonld'
                    }
                };

                strategy = 'lever-dom';
                diagnostics.fallback = 'dom-jsonld';
                diagnostics.descriptionLength = fallbackDescription.length;
                diagnostics.skillCount = fallbackSkills.length;
            } else if (!diagnostics.error) {
                diagnostics.error = 'fallback-insufficient';
            }
        } else if (!diagnostics.error) {
            diagnostics.error = 'fallback-missing';
        }
    }

    diagnostics.durationMs = diagnostics.durationMs || (Date.now() - startedAt);

    return { job, strategy, diagnostics };
}

module.exports = {
    id: LEVER_PROVIDER_ID,
    matchesUrl,
    normalizeJobUrl,
    collectJobLinks,
    prepareJobDetail,
    fetchJobDetail,
    usesBrowser: true,
    collectsLinksWithBrowser: false
};
