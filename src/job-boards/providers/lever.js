const config = require('../../config');
const { normalizeURL } = require('../../utils');
const { createProviderHttpClient, resolveDescription, collectListText, normalizeWhitespace } = require('../detail-helpers');

const LEVER_PROVIDER_ID = 'lever';
const LEVER_API_BASE = 'https://jobs.lever.co/v0/postings';
const SUPPORTED_FILTER_KEYS = new Set(['team', 'department', 'location', 'commitment', 'worktype', 'worktypev2']);
const httpClient = createProviderHttpClient();

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

    if (lower === 'jobs.lever.co' || lower === 'apply.lever.co') {
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

async function discoverSlugFromPage(page, url) {
    await ensurePageLoaded(page, url);

    return page.evaluate((filterKeys) => {
        const slugCandidates = new Set();
        const filters = {};

        const applyFilters = (searchParams) => {
            if (!searchParams) {
                return;
            }
            const params = new URLSearchParams(searchParams);
            params.forEach((value, key) => {
                if (filterKeys.includes(key)) {
                    filters[key] = value;
                }
            });
        };

        document.querySelectorAll('script[src]').forEach((script) => {
            const src = script.getAttribute('src');
            if (!src || !src.includes('lever.co')) {
                return;
            }

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
            } catch (_) {
                // ignore resolution errors
            }
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

    let skip = 0;
    let safetyCounter = 0;
    const jobUrls = [];
    const dedupeKeys = new Set();
    const diagnostics = { pages: 0, totalPostings: 0, companySlug, filters };

    while (safetyCounter < 20) {
        const apiUrl = `${LEVER_API_BASE}/${companySlug}`;
        const query = new URLSearchParams(params.toString());
        if (skip > 0) {
            query.set('skip', String(skip));
        }

        const response = await httpClient.get(apiUrl, {
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

async function collectJobLinks({ page, url, logger }) {
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
    usesBrowser: true
};
