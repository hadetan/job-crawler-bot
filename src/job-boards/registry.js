/**
 * @typedef {object} JobBoardDetailContext
 * @property {string} [companySlug] - Canonical slug for the job board/company.
 * @property {string} [postingId] - Provider-specific identifier for the job posting.
 * @property {Record<string, any>} [meta] - Additional metadata captured during Stage 2.
 */

/**
 * @typedef {object} JobBoardProvider
 * @property {string} id - Stable identifier for the provider (e.g. "lever", "greenhouse").
 * @property {(url: string) => boolean} [matchesUrl] - Returns true when the provider owns the supplied URL.
 * @property {(url: string) => string} [normalizeJobUrl] - Normalizes a job link URL for dedupe/comparison.
 * @property {(args: object) => Promise<object>|object} [collectJobLinks] - Stage 2 hook for job link harvesting.
 * @property {(args: { url: string, jobRecord?: object, logger?: import('../utils/logger'), context?: JobBoardDetailContext }) => Promise<JobBoardDetailContext>|JobBoardDetailContext} [prepareJobDetail]
 *   Optional hook to derive reusable detail context prior to Stage 3 extraction.
 * @property {(args: { url: string, page?: import('puppeteer').Page|null, providerId: string, attempt: number, logger?: import('../utils/logger'), context?: JobBoardDetailContext }) => Promise<object|null>} [fetchJobDetail]
 *   Stage 3 hook returning normalized job detail payloads. Should return null to signal fallback to generic extractor.
 * @property {(args: { jobData: object, context?: JobBoardDetailContext }) => object} [postProcessJobDetail]
 *   Optional hook for provider-specific normalization after extraction.
 * @property {boolean} [usesBrowser] - True when the provider requires a Puppeteer page for detail extraction. Defaults to true.
 */

const providers = new Map();

/**
 * Register a provider implementation.
 * @param {JobBoardProvider} provider
 */
const registerProvider = (provider) => {
    if (!provider || typeof provider !== 'object') {
        throw new Error('Provider registration requires an object.');
    }

    if (!provider.id || typeof provider.id !== 'string') {
        throw new Error('Provider registration requires a string id.');
    }

    providers.set(provider.id, provider);
};

/**
 * Retrieve all registered providers.
 * @returns {Array<object>}
 */
const getProviders = () => Array.from(providers.values());

/**
 * Get a provider by its identifier.
 * @param {string} providerId
 * @returns {object|null}
 */
const getProviderById = (providerId) => {
    if (!providerId) {
        return null;
    }

    return providers.get(providerId) || null;
};

/**
 * Attempt to find a provider that recognizes the given URL.
 * @param {string} url
 * @returns {object|null}
 */
const findProviderByUrl = (url) => {
    if (!url) {
        return null;
    }

    for (const provider of providers.values()) {
        if (typeof provider.matchesUrl !== 'function') {
            continue;
        }

        try {
            if (provider.matchesUrl(url)) {
                return provider;
            }
        } catch (_) {
            // Ignore individual provider errors to avoid blocking other matches.
        }
    }

    return null;
};

module.exports = {
    registerProvider,
    getProviders,
    getProviderById,
    findProviderByUrl
};
