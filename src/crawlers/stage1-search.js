const axios = require('axios');
const path = require('path');
const config = require('../config');
const { readCSV, writeCSV, normalizeURL } = require('../utils/csv-handler');
const log = require('../utils/logger');
const {
    generateRequestId,
    setupRequestFolder,
    loadReport,
    saveReport,
    requestIdExists
} = require('../utils/request-helpers');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const fetchGoogleSearchResults = async (startIndex, retryCount = 0) => {
    try {
        const url = 'https://www.googleapis.com/customsearch/v1';
        const params = {
            key: config.google.apiKey,
            cx: config.google.searchEngineId,
            q: config.google.searchQuery,
            start: startIndex,
            num: 10
        };

        const response = await axios.get(url, { params, timeout: 10000 });
        return response.data;
    } catch (error) {
        if (error.response?.status === 403) {
            log.error('Google API quota exceeded or invalid credentials');
            throw error;
        }

        if (error.response?.status === 400) {
            log.error('Invalid API key or Search Engine ID');
            throw error;
        }

        if (retryCount < config.retry.maxRetries) {
            const delay = config.retry.retryDelay * (retryCount + 1);
            log.progress(`Network error, retrying in ${delay}ms... (Attempt ${retryCount + 1}/${config.retry.maxRetries})`);
            await sleep(delay);
            return fetchGoogleSearchResults(startIndex, retryCount + 1);
        }

        throw error;
    }
};

const runStage1 = async (options = {}) => {
    log.info('Starting Stage 1: Google Custom Search...');

    let requestId = options.requestId;
    if (!requestId) {
        requestId = generateRequestId();
        log.info(`No ID provided. Generated request ID: ${requestId}`);
    } else {
        if (requestIdExists(config.output.dir, requestId)) {
            log.info(`Using existing request ID: ${requestId}`);
        } else {
            log.info(`Starting new Stage 1 run with request ID: ${requestId}`);
        }
    }

    const { requestDir, csvPath, reportPath } = setupRequestFolder(config.output.dir, requestId);
    log.info(`Request folder: ${requestDir}`);

    const outputFile = path.join(config.output.dir, 'urls.csv');
    const existingURLs = readCSV(outputFile, 'url').map(normalizeURL);
    const existingSet = new Set(existingURLs);

    const newURLs = [];
    let totalFound = 0;
    let duplicatesSkipped = 0;

    for (let page = 1; page <= config.crawler.maxPages; page++) {
        const startIndex = (page - 1) * 10 + 1;
        log.progress(`Fetching page ${page} of ${config.crawler.maxPages}...`);

        try {
            const data = await fetchGoogleSearchResults(startIndex);

            if (!data.items || data.items.length === 0) {
                log.info('No more results found, stopping pagination');
                break;
            }

            data.items.forEach(item => {
                const url = item.link;
                const normalizedURL = normalizeURL(url);

                if (existingSet.has(normalizedURL)) {
                    duplicatesSkipped++;
                } else {
                    existingSet.add(normalizedURL);
                    newURLs.push({ url });
                }
                totalFound++;
            });
        } catch (error) {
            log.error(`Failed to fetch page ${page}: ${error.message}`);
            if (error.response?.status === 403 || error.response?.status === 400) {
                break;
            }
        }
    }

    if (newURLs.length > 0) {
        writeCSV(outputFile, newURLs, ['url']);
        log.success(`Stage 1 complete: ${newURLs.length} new URLs saved to ${outputFile}`);
    } else {
        log.info('Stage 1 complete: No new URLs found');
    }

    log.info(`Summary - Total found: ${totalFound}, New: ${newURLs.length}, Duplicates skipped: ${duplicatesSkipped}`);
};

module.exports = runStage1;
