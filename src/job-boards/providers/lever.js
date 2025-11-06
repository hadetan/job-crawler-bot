const config = require('../../config');
const { normalizeURL } = require('../../utils');
const { createProviderHttpClient, resolveDescription, collectListText, normalizeWhitespace } = require('../detail-helpers');

const LEVER_PROVIDER_ID = 'lever';
const LEVER_API_BASE = 'https://jobs.lever.co/v0/postings';
const SUPPORTED_FILTER_KEYS = new Set(['team', 'department', 'location', 'commitment', 'worktype', 'worktypev2']);
const httpClient = createProviderHttpClient();

const ensurePageLoaded = async (page, url) => {
    await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: config.crawler.pageTimeout
    });
};

const getSlugFromHost = (hostname) => {
    if (!hostname) {
        return null;
    }

    if (hostname === 'jobs.lever.co' || hostname === 'apply.lever.co') {
        return null;
    }

    const parts = hostname.split('.');
    if (parts.length >= 3 && parts[parts.length - 2] === 'lever' && parts[parts.length - 1] === 'co') {
        return parts[0];
    }

    return null;
};

const derivePostingId = (segments = []) => {
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
};

const parseLeverContextFromUrl = (url) => {
    try {
        const parsed = new URL(url);
        const hostname = parsed.hostname.toLowerCase();
        const pathSegments = parsed.pathname.split('/').filter(Boolean);
        const filters = {};

        parsed.searchParams.forEach((value, key) => {
            if (SUPPORTED_FILTER_KEYS.has(key)) {
                filters[key] = value;
            }
        });

        if (hostname === 'jobs.lever.co' || hostname === 'apply.lever.co') {
            if (pathSegments.length > 0) {
                return {
                    companySlug: pathSegments[0].toLowerCase(),
                    postingId: derivePostingId(pathSegments.slice(1)),
                    filters
                };
            }
        }

        const hostSlug = getSlugFromHost(hostname);
        if (hostSlug) {
            return {
                companySlug: hostSlug.toLowerCase(),
                postingId: derivePostingId(pathSegments),
                filters
            };
        }

        return { companySlug: null, postingId: null, filters };
    } catch (_) {
        return { companySlug: null, postingId: null, filters: {} };
    }
};

const discoverSlugFromPage = async (page, url) => {
    await ensurePageLoaded(page, url);

    return page.evaluate((filterKeys) => {
        const slugCandidates = new Set();
        const filters = {};

        const applyFilters = (searchParams) => {
            if (!searchParams) return;
            const params = new URLSearchParams(searchParams);
            params.forEach((value, key) => {
                if (filterKeys.includes(key)) {
                    filters[key] = value;
                }
            });
        };

        document.querySelectorAll('script[src]').forEach((script) => {
            const src = script.getAttribute('src');
            if (!src || !src.includes('lever.co')) return;

            try {
                const resolved = new URL(src, document.baseURI);
                const host = resolved.hostname.toLowerCase();

                if (host === 'jobs.lever.co' || host === 'apply.lever.co') {
                    const parts = resolved.pathname.split('/').filter(Boolean);
                    if (parts.length > 0) {
                        slugCandidates.add(parts[0].toLowerCase());
                    }
                } else if (host.endsWith('.lever.co')) {
                    const hostParts = host.split('.');
                    if (hostParts.length >= 3) {
                        slugCandidates.add(hostParts[0].toLowerCase());
                    }
                }

                const pathMatch = resolved.pathname.match(/postings\/(\w[\w-]+)/i);
                if (pathMatch && pathMatch[1]) {
                    slugCandidates.add(pathMatch[1].toLowerCase());
                }

                applyFilters(resolved.search);
            } catch (_) { }
        });

        document.querySelectorAll('[data-lever-domain], [data-lever-job-board]').forEach((element) => {
            const domain = element.getAttribute('data-lever-domain') || element.getAttribute('data-lever-job-board');
            if (domain) {
                slugCandidates.add(domain.toLowerCase());
            }

            filterKeys.forEach((key) => {
                const attrName = `data-${key}`;
                if (element.hasAttribute(attrName)) {
                    filters[key] = element.getAttribute(attrName);
                }
            });
        });

        Array.from(document.querySelectorAll('script')).forEach((script) => {
            const content = script.textContent || '';
            const inlineMatch = content.match(/lever\.co\/v0\/postings\/(\w[\w-]+)/i);
            if (inlineMatch && inlineMatch[1]) {
                slugCandidates.add(inlineMatch[1].toLowerCase());
            }

            const accountMatch = content.match(/accountName\s*[:=]\s*['"](\w[\w-]+)['"]/i);
            if (accountMatch && accountMatch[1]) {
                slugCandidates.add(accountMatch[1].toLowerCase());
            }
        });

        const [slug] = slugCandidates;

        return { companySlug: slug || null, filters };
    }, Array.from(SUPPORTED_FILTER_KEYS));
};

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

    let skip = 0;
    let safetyCounter = 0;
    const jobUrls = [];
    const dedupeKeys = new Set();
    const diagnostics = { pages: 0, totalPostings: 0, companySlug, filters };

    while (safetyCounter < 20) {
        const url = `${LEVER_API_BASE}/${companySlug}`;
        const query = new URLSearchParams(params.toString());
        if (skip > 0) {
            query.set('skip', String(skip));
        }

        const response = await httpClient.get(url, {
            params: Object.fromEntries(query.entries()),
        });

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
        diagnostics
    };
};

const collectJobLinks = async ({ page, url, logger }) => {
    const contextFromUrl = parseLeverContextFromUrl(url);
    let context = contextFromUrl;

    if (!context.companySlug) {
        try {
            const discovered = await discoverSlugFromPage(page, url);
            context = {
                companySlug: discovered.companySlug || context.companySlug,
                postingId: context.postingId,
                filters: { ...context.filters, ...discovered.filters }
            };
        } catch (error) {
            if (logger) {
                logger.warn(`Lever provider failed to discover slug from page: ${error.message}`);
            }
        }
    }

    try {
        const { jobUrls, diagnostics } = await fetchListingsFromApi(context);
        const normalizedUrls = jobUrls.map(normalizeJobUrl);
        return {
            providerId: LEVER_PROVIDER_ID,
            jobUrls: normalizedUrls,
            strategy: 'lever-api',
            diagnostics
        };
    } catch (apiError) {
        if (logger) {
            logger.warn(`Lever API failed for ${url}: ${apiError.message}`);
        }

        return {
            providerId: LEVER_PROVIDER_ID,
            jobUrls: [],
            strategy: 'lever-api-failed',
            diagnostics: { error: apiError.message }
        };
    }
};

const fetchJobDetail = async ({ url, logger, context }) => {
    const derivedContext = context && (context.companySlug || context.postingId) ? context : parseLeverContextFromUrl(url);
    const { companySlug, postingId } = derivedContext || {};

    if (!companySlug || !postingId) {
        if (logger) {
            logger.warn(`Lever provider could not parse slug/posting ID from ${url}`);
        }

        return {
            job: null,
            strategy: 'lever-api',
            diagnostics: {
                error: 'missing-context',
                companySlug: companySlug || null,
                postingId: postingId || null
            }
        };
    }

    const endpoint = `${LEVER_API_BASE}/${companySlug}/${postingId}`;
    const diagnostics = { companySlug, postingId, endpoint };

    const startedAt = Date.now();

    try {
        const response = await httpClient.get(endpoint, { params: { mode: 'json' } });

        diagnostics.status = response.status;
        diagnostics.durationMs = Date.now() - startedAt;

        const data = response.data;
        if (!data) {
            diagnostics.error = 'empty-response';
            return {
                job: null,
                strategy: 'lever-api',
                diagnostics
            };
        }

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

        if (!title || title.length < 3 || !description || description.length < 50) {
            diagnostics.error = 'insufficient-content';
            return {
                job: null,
                strategy: 'lever-api',
                diagnostics
            };
        }

        const skills = collectListText(Array.isArray(data.lists) ? data.lists : []);

        const job = {
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

        return { job, strategy: 'lever-api', diagnostics };
    } catch (error) {
        if (logger) {
            logger.warn(`Lever job detail API failed for ${url}: ${error.message}`);
        }

        return {
            job: null,
            strategy: 'lever-api',
            diagnostics: {
                ...diagnostics,
                durationMs: diagnostics.durationMs || (Date.now() - startedAt),
                error: error.message
            }
        };
    }
};

module.exports = {
    id: LEVER_PROVIDER_ID,
    matchesUrl,
    normalizeJobUrl,
    collectJobLinks,
    fetchJobDetail
};
