const log = require('../utils/logger');
const config = require('../config');
const BaseProvider = require('./base-provider');

/**
 * Provider Factory
 * 
 * Factory pattern implementation for creating search provider instances.
 * Handles provider instantiation, validation, and error handling.
 */
class ProviderFactory {
    /**
     * Create a search provider instance
     * @param {string} providerName - Name of the provider (e.g., 'google', 'serp')
     * @param {Object} options - Provider-specific options
     * @param {string} options.engine - Search engine (for SerpAPI)
     * @returns {BaseProvider} Provider instance
     * @throws {Error} If provider is unknown or not configured
     */
    static create(providerName, options = {}) {
        const normalizedName = providerName.toLowerCase().trim();

        const providerConfig = config.searchProviders[normalizedName];
        if (!providerConfig) {
            throw new Error(
                `Unknown search provider '${providerName}'.\n` +
                `Available providers: ${this.getAvailableProviders().join(', ')}`
            );
        }

        if (!providerConfig.available) {
            throw new Error(
                `Provider '${providerName}' is not configured.\n` +
                `Missing required API key(s). Check your .env file.`
            );
        }

        let provider;
        switch (normalizedName) {
            case 'google':
                const { GoogleCustomSearchProvider } = require('./');
                provider = new GoogleCustomSearchProvider(providerConfig);
                break;

            case 'serp':
                const { SerpApiProvider } = require('./');
                const engine = options.engine || providerConfig.defaultEngine;
                provider = new SerpApiProvider(providerConfig, engine);
                break;

            default:
                throw new Error(`Provider '${providerName}' is not implemented yet`);
        }

        const validation = provider.validateConfig();
        if (!validation.valid) {
            throw new Error(
                `Provider '${providerName}' validation failed: ${validation.error}`
            );
        }

        log.info(`Using search provider: ${provider.getDisplayName()}`);
        return provider;
    }

    /**
     * Get list of available provider names
     * @returns {Array<string>} Array of provider names
     */
    static getAvailableProviders() {
        return Object.keys(config.searchProviders);
    }

    /**
     * Get list of configured (available) providers
     * @returns {Array<string>} Array of configured provider names
     */
    static getConfiguredProviders() {
        return Object.keys(config.searchProviders)
            .filter(name => config.searchProviders[name].available);
    }

    /**
     * Check if a provider is available
     * @param {string} providerName - Provider name
     * @returns {boolean}
     */
    static isAvailable(providerName) {
        const normalizedName = providerName.toLowerCase().trim();
        const providerConfig = config.searchProviders[normalizedName];
        return providerConfig && providerConfig.available;
    }

    /**
     * Get provider information
     * @param {string} providerName - Provider name
     * @returns {Object|null} Provider configuration or null
     */
    static getProviderInfo(providerName) {
        const normalizedName = providerName.toLowerCase().trim();
        return config.searchProviders[normalizedName] || null;
    }
}

module.exports = ProviderFactory;
