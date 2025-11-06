const providers = new Map();

/**
 * Register a provider implementation.
 * @param {{ id: string, matchesUrl?: (url: string) => boolean }} provider
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
