/**
 * Base Search Provider
 * 
 * Abstract base class that defines the interface contract for all search providers.
 * All search providers must extend this class and implement the required methods.
 */
class BaseProvider {
    /**
     * @param {Object} config - Provider-specific configuration
     */
    constructor(config) {
        if (new.target === BaseProvider) {
            throw new Error('BaseProvider is abstract and cannot be instantiated directly');
        }
        this.config = config;
    }

    /**
     * Get the provider name
     * @returns {string} Provider name (e.g., 'google-custom', 'serp-api')
     */
    getName() {
        throw new Error('getName() must be implemented by provider');
    }

    /**
     * Get a human-readable display name
     * @returns {string} Display name (e.g., 'Google Custom Search API', 'SerpAPI')
     */
    getDisplayName() {
        throw new Error('getDisplayName() must be implemented by provider');
    }

    /**
     * Validate that the provider is properly configured
     * @returns {Object} { valid: boolean, error?: string }
     */
    validateConfig() {
        throw new Error('validateConfig() must be implemented by provider');
    }

    /**
     * Execute a search query
     * @param {string} query - The search query
     * @param {number} page - The page number (1-indexed)
     * @param {Object} options - Additional search options
     * @returns {Promise<Array>} Array of normalized search results
     */
    async search(query, page, options = {}) {
        throw new Error('search() must be implemented by provider');
    }

    /**
     * Normalize raw API results to a standard format
     * @param {Object} rawData - Raw API response
     * @returns {Array} Array of normalized results
     * 
     * Standard format:
     * {
     *   url: string,
     *   snippet: string,
     *   logoUrl: string,
     *   metadata: {
     *     title: string,
     *     source: string
     *   }
     * }
     */
    normalizeResults(rawData) {
        throw new Error('normalizeResults() must be implemented by provider');
    }

    /**
     * Get the maximum number of pages this provider supports
     * @returns {number} Maximum pages (or Infinity if unlimited)
     */
    getMaxPages() {
        return Infinity;
    }

    /**
     * Get the number of results per page
     * @returns {number} Results per page
     */
    getResultsPerPage() {
        return 10;
    }

    /**
     * Check if the provider supports a specific feature
     * @param {string} feature - Feature name (e.g., 'engine-selection', 'location-filter')
     * @returns {boolean}
     */
    supportsFeature(feature) {
        return false;
    }
}

module.exports = BaseProvider;
