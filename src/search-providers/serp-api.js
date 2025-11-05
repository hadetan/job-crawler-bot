/**
 * SerpAPI Provider
 * 
 * Implementation of search provider for SerpAPI.
 * Supports multiple search engines (Google, Bing, Yahoo, DuckDuckGo, etc.)
 */

const { getJson } = require('serpapi');
const BaseProvider = require('./base-provider');
const log = require('../utils/logger');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class SerpApiProvider extends BaseProvider {
    constructor(config, searchEngine = 'google') {
        super(config);
        this.apiKey = config.apiKey;
        this.searchEngine = searchEngine.toLowerCase();
        this.maxRetries = config.maxRetries || 3;
        this.retryDelay = config.retryDelay || 2000;

        // Validate search engine
        const supportedEngines = config.supportedEngines || [
            'google', 'bing', 'yahoo', 'duckduckgo', 'baidu', 'yandex'
        ];

        if (!supportedEngines.includes(this.searchEngine)) {
            log.warn(
                `Search engine '${this.searchEngine}' may not be supported. ` +
                `Supported engines: ${supportedEngines.join(', ')}`
            );
        }
    }

    getName() {
        return 'serp';
    }

    getDisplayName() {
        return `SerpAPI (${this.searchEngine.charAt(0).toUpperCase() + this.searchEngine.slice(1)})`;
    }

    validateConfig() {
        if (!this.apiKey) {
            return {
                valid: false,
                error: 'SERP_API_KEY is missing from environment variables'
            };
        }

        return { valid: true };
    }

    getMaxPages() {
        return Infinity;
    }

    supportsFeature(feature) {
        const supportedFeatures = [
            'pagination',
            'engine-selection',
            'language-filter',
            'location-filter',
            'date-filter'
        ];
        return supportedFeatures.includes(feature);
    }

    /**
     * Get the current search engine
     * @returns {string} Search engine name
     */
    getSearchEngine() {
        return this.searchEngine;
    }

    /**
     * Execute SerpAPI search request
     * @param {string} query - Search query
     * @param {number} page - Page number (1-indexed)
     * @param {Object} options - Additional options
     * @returns {Promise<Array>} Normalized search results
     */
    async search(query, page, options = {}) {
        try {
            const rawData = await this.fetchResults(query, page, options);
            return this.normalizeResults(rawData);
        } catch (error) {
            log.error(`SerpAPI search failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Fetch results from SerpAPI with retry logic
     * @private
     */
    async fetchResults(query, page, options = {}, retryCount = 0) {
        try {
            const start = (page - 1) * 10;

            const params = {
                engine: this.searchEngine,
                q: query,
                api_key: this.apiKey,
                num: 10,
                hl: 'en',
                lr: 'lang_en'
            };

            if (this.searchEngine === 'google') {
                params.start = start;
            } else if (this.searchEngine === 'bing') {
                params.first = start + 1;
            } else if (this.searchEngine === 'yahoo') {
                params.b = start + 1;
            } else {
                params.start = start;
            }

            if (options.location) {
                params.location = options.location;
            }

            if (options.country) {
                params.cc = options.country;
            }

            return new Promise((resolve, reject) => {
                getJson(params, (json) => {
                    if (json.error) {
                        reject(new Error(json.error));
                    } else {
                        resolve(json);
                    }
                });
            });
        } catch (error) {
            if (retryCount < this.maxRetries) {
                const delay = this.retryDelay * (retryCount + 1);
                log.progress(`SerpAPI error, retrying in ${delay}ms... (Attempt ${retryCount + 1}/${this.maxRetries})`);
                await sleep(delay);
                return this.fetchResults(query, page, options, retryCount + 1);
            }

            throw error;
        }
    }

    /**
     * Normalize SerpAPI results to standard format
     * Handles different response formats from different search engines
     * @param {Object} rawData - Raw SerpAPI response
     * @returns {Array} Normalized results
     */
    normalizeResults(rawData) {
        let results = [];

        if (rawData.organic_results) {
            results = rawData.organic_results;
        } else if (rawData.results) {
            results = rawData.results;
        } else if (rawData.organic) {
            results = rawData.organic;
        }

        if (!results || results.length === 0) {
            return [];
        }

        return results.map(item => {
            const url = item.link || item.url || item.href || '';

            const snippet = item.snippet || item.description || item.displayed_link || '';

            const logoUrl = item.thumbnail ||
                item.favicon ||
                item.image ||
                item.icon ||
                '';

            const title = item.title || item.name || '';

            return {
                url: url,
                snippet: snippet,
                logoUrl: logoUrl,
                metadata: {
                    title: title,
                    source: `serp-${this.searchEngine}`,
                    position: item.position || null,
                    displayLink: item.displayed_link || item.display_link || ''
                }
            };
        });
    }
}

module.exports = SerpApiProvider;
