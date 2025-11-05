require('dotenv').config();

const requiredEnvVars = ['GOOGLE_API_KEY', 'GOOGLE_SEARCH_ENGINE_ID', 'SEARCH_QUERY'];

requiredEnvVars.forEach(varName => {
    if (!process.env[varName]) {
        throw new Error(`Required environment variable ${varName} not found. Check .env file.`);
    }
});

const parseBoolean = (value, defaultValue) => {
    if (value === undefined) return defaultValue;
    return value.toLowerCase() === 'true';
};

const parseNumber = (value, defaultValue) => {
    if (value === undefined) return defaultValue;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? defaultValue : parsed;
};

const parseSelectors = (value, defaultValue = []) => {
    if (!value) return defaultValue;
    return value.split(',').map(s => s.trim()).filter(Boolean);
};

const config = {
    searchProviders: {
        google: {
            apiKey: process.env.GOOGLE_API_KEY,
            searchEngineId: process.env.GOOGLE_SEARCH_ENGINE_ID,
            available: !!(process.env.GOOGLE_API_KEY && process.env.GOOGLE_SEARCH_ENGINE_ID),
            supportsEngineParam: false,
            displayName: 'Google Custom Search API',
            maxRetries: parseNumber(process.env.MAX_RETRIES, 3),
            retryDelay: parseNumber(process.env.RETRY_DELAY, 2000)
        },
        serp: {
            apiKey: process.env.SERP_API_KEY,
            available: !!process.env.SERP_API_KEY,
            supportsEngineParam: true,
            defaultEngine: 'google',
            supportedEngines: ['google', 'bing', 'yahoo', 'duckduckgo', 'baidu', 'yandex'],
            displayName: 'SerpAPI',
            maxRetries: parseNumber(process.env.MAX_RETRIES, 3),
            retryDelay: parseNumber(process.env.RETRY_DELAY, 2000)
        }
    },
    defaultSearchProvider: process.env.DEFAULT_SEARCH_PROVIDER || 'google',
    searchQuery: process.env.SEARCH_QUERY,
    crawler: {
        concurrency: parseNumber(process.env.CONCURRENCY, 5),
        maxPages: parseNumber(process.env.MAX_PAGES, 10),
        headless: parseBoolean(process.env.HEADLESS, true),
        pageTimeout: parseNumber(process.env.PAGE_TIMEOUT, 30000),
        userAgent: process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    retry: {
        maxRetries: parseNumber(process.env.MAX_RETRIES, 3),
        retryDelay: parseNumber(process.env.RETRY_DELAY, 2000),
        maxRetryCount: parseNumber(process.env.MAX_RETRY_COUNT, 3)
    },
    output: {
        dir: process.env.OUTPUT_DIR || './output'
    },
    selectors: {
        jobLinks: parseSelectors(process.env.JOB_LINK_SELECTORS, ['a[href*="/jobs/"]', 'a[href*="/job/"]', 'a[href*="/careers/"]'])
    }
};

module.exports = config;
