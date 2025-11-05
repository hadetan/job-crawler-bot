/**
 * Search Providers Module
 * 
 * Export all search provider classes and the factory.
 */
const BaseProvider = require('./base-provider');
const GoogleCustomSearchProvider = require('./google-custom-search');
const SerpApiProvider = require('./serp-api');
const ProviderFactory = require('./provider-factory');

module.exports = {
    BaseProvider,
    GoogleCustomSearchProvider,
    SerpApiProvider,
    ProviderFactory
};
