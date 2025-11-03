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
    requestIdExists,
    appendToGoogleResultsCsv,
    getExistingUrlsFromCsv
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

    const report = loadReport(reportPath);

    const existingUrlsInCsv = getExistingUrlsFromCsv(csvPath);

    const newRows = [];
    let totalFound = 0;
    let duplicatesSkipped = 0;

    for (let page = 1; page <= config.crawler.maxPages; page++) {
        const startIndex = (page - 1) * 10 + 1;
        log.progress(`Fetching page ${page} of ${config.crawler.maxPages}...`);

        let pageReport = report.google_report.find(p => p.page === page);
        const isRetry = pageReport !== undefined;

        if (!pageReport) {
            pageReport = {
                page: page,
                status: false,
                error: null,
                retryCount: 0
            };
            report.google_report.push(pageReport);
        }

        try {
            const data = await fetchGoogleSearchResults(startIndex);

            if (!data.items || data.items.length === 0) {
                log.info('No more results found, stopping pagination');

                pageReport.status = true;
                pageReport.error = null;
                saveReport(reportPath, report);
                break;
            }

            data.items.forEach(item => {
                const url = item.link;
                // Extract description (snippet)
                const snippet = item.snippet || '';

                // Extract logo
                let logoUrl = '';
                if (item?.pagemap?.metatags.length > 0) {
                    logoUrl = item.pagemap.metatags[0]['og:image'] || item?.pagemap?.cse_thumbnail?.[0].src;
                }

                if (existingUrlsInCsv.has(url)) {
                    duplicatesSkipped++;
                } else {
                    existingUrlsInCsv.add(url);
                    newRows.push({
                        URL: url,
                        STATUS: 'pending',
                        JOB_COUNT: 0,
                        SNIPPET: snippet,
                        LOGO_URL: logoUrl,
                        REMARKS: ''
                    });
                }
                totalFound++;
            });

            pageReport.status = true;
            pageReport.error = null;
            saveReport(reportPath, report);

        } catch (error) {
            pageReport.status = false;

            if (error.response) {
                pageReport.error = {
                    status: error.response.status,
                    statusText: error.response.statusText,
                    data: error.response.data
                };
            } else {
                pageReport.error = {
                    message: error.message
                };
            }

            saveReport(reportPath, report);

            log.error(`Failed to fetch page ${page}: ${error.message}`);

            if (error.response?.status === 403 || error.response?.status === 400) {
                break;
            }
        }
    }

    if (newRows.length > 0) {
        appendToGoogleResultsCsv(csvPath, newRows);
        log.success(`Stage 1 complete: ${newRows.length} new URLs saved to ${csvPath}`);
    } else {
        log.info('Stage 1 complete: No new URLs found');
    }

    log.info(`Summary - Total found: ${totalFound}, New: ${newRows.length}, Duplicates skipped: ${duplicatesSkipped}`);
};

module.exports = runStage1;
