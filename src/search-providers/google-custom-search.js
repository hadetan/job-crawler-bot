const axios = require('axios');
const BaseProvider = require('./base-provider');
const log = require('../utils/logger');

/**
 * Google Custom Search Provider
 * 
 * Implementation of search provider for Google Custom Search API.
 * Extracts and wraps the existing Google Custom Search logic.
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class GoogleCustomSearchProvider extends BaseProvider {
    constructor(config) {
        super(config);
        this.apiKey = config.apiKey;
        this.searchEngineId = config.searchEngineId;
        this.maxRetries = config.maxRetries || 3;
        this.retryDelay = config.retryDelay || 2000;
    }

    getName() {
        return 'google';
    }

    getDisplayName() {
        return 'Google Custom Search API';
    }

    validateConfig() {
        if (!this.apiKey) {
            return {
                valid: false,
                error: 'GOOGLE_API_KEY is missing from environment variables'
            };
        }

        if (!this.searchEngineId) {
            return {
                valid: false,
                error: 'GOOGLE_SEARCH_ENGINE_ID is missing from environment variables'
            };
        }

        return { valid: true };
    }

    getMaxPages() {
        return 10;
    }

    supportsFeature(feature) {
        const supportedFeatures = ['pagination', 'language-filter'];
        return supportedFeatures.includes(feature);
    }

    /**
     * Execute Google Custom Search API request
     * @param {string} query - Search query
     * @param {number} page - Page number (1-indexed)
     * @param {Object} options - Additional options
     * @returns {Promise<Array>} Normalized search results
     */
    async search(query, page, options = {}) {
        const startIndex = (page - 1) * 10 + 1;

        if (startIndex > 91) {
            log.warn(`Page ${page} exceeds Google API limit (max 100 results)`);
            return [];
        }

        try {
            const rawData = await this.fetchResults(startIndex, query);
            return this.normalizeResults(rawData);
        } catch (error) {
            if (error.response?.status === 403) {
                throw new Error('Google API quota exceeded or invalid credentials');
            }

            if (error.response?.status === 400) {
                const errorMessage = error.response?.data?.error?.message || '';
                if (startIndex > 91 || errorMessage.toLowerCase().includes('invalid value')) {
                    log.info('Reached Google API result limit (100 results)');
                    return [];
                }
            }

            throw error;
        }
    }

    /**
     * Fetch results from Google Custom Search API with retry logic
     * @private
     */
    async fetchResults(startIndex, query, retryCount = 0) {
        try {
            const url = 'https://www.googleapis.com/customsearch/v1';
            const params = {
                key: this.apiKey,
                cx: this.searchEngineId,
                q: query,
                start: startIndex,
                num: 10,
                lr: 'lang_en',
                hl: 'en'
            };

            const response = await axios.get(url, { params, timeout: 10000 });
            return response.data;
        } catch (error) {
            if (error.response?.status === 403 || error.response?.status === 400) {
                throw error;
            }

            if (retryCount < this.maxRetries) {
                const delay = this.retryDelay * (retryCount + 1);
                log.progress(`Network error, retrying in ${delay}ms... (Attempt ${retryCount + 1}/${this.maxRetries})`);
                await sleep(delay);
                return this.fetchResults(startIndex, query, retryCount + 1);
            }

            throw error;
        }
    }

    /**
     * Normalize Google Custom Search results to standard format
     * @param {Object} rawData - Raw Google API response
     * @returns {Array} Normalized results
     */
    normalizeResults(rawData) {
        if (!rawData.items || rawData.items.length === 0) {
            return [];
        }

        return rawData.items.map(item => {
            let logoUrl = '';
            if (item?.pagemap?.metatags?.length > 0) {
                logoUrl = item.pagemap.metatags[0]['og:image'] ||
                    item?.pagemap?.cse_thumbnail?.[0]?.src || '';
            }

            return {
                url: item.link,
                snippet: item.snippet || '',
                logoUrl: logoUrl,
                metadata: {
                    title: item.title || '',
                    source: 'google-custom',
                    displayLink: item.displayLink || ''
                }
            };
        });
    }
}

module.exports = GoogleCustomSearchProvider;
