const axios = require('axios');
const config = require('../config');
const log = require('../utils/logger');
const { generateRequestId, setupJobBoardsFolder, loadReport, saveReport, requestIdExists, appendToGoogleResultsCsv, getExistingUrlsFromCsv } = require('../utils/request-helpers');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const fetchGoogleSearchResults = async (startIndex, retryCount = 0) => {
    try {
        const url = 'https://www.googleapis.com/customsearch/v1';
        const params = {
            key: config.google.apiKey,
            cx: config.google.searchEngineId,
            q: config.google.searchQuery,
            start: startIndex,
            num: 10,
            lr: 'lang_en',
            hl: 'en'
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

    const { requestDir, csvPath, reportPath } = setupJobBoardsFolder(config.output.dir, requestId);
    log.info(`Request folder: ${requestDir}`);

    const report = loadReport(reportPath);

    // --clean flag: reset google_report array in {requestId}/report.json
    if (options.clean) {
        log.info(`Clean flag detected. Resetting progress for request ID ${requestId}`);
        report.google_report = [];
        saveReport(reportPath, report);
    }

    let startPage = 1;
    const firstFailedPage = report.google_report.find(p => p.status === false);

    if (firstFailedPage) {
        startPage = firstFailedPage.page;
        log.info(`Resuming from page ${startPage} where previous run failed`);
    } else if (report.google_report.length > 0) {
        const lastSuccessfulPage = Math.max(...report.google_report.map(p => p.page));
        if (lastSuccessfulPage >= config.crawler.maxPages) {
            log.info(`All pages already completed successfully for request ID ${requestId}. Use --clean to start fresh.`);
            return;
        }
        startPage = lastSuccessfulPage + 1;
    }

    const existingUrlsInCsv = getExistingUrlsFromCsv(csvPath);

    const newRows = [];
    let totalFound = 0;
    let duplicatesSkipped = 0;

    for (let page = startPage; page <= config.crawler.maxPages; page++) {
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
        } else if (isRetry) {
            if (pageReport.retryCount >= config.retry.maxRetryCount) {
                const errorMsg = pageReport.error?.message ||
                    pageReport.error?.statusText ||
                    'Unknown error';

                log.error(`⚠️  Max retry limit (${config.retry.maxRetryCount}) reached for page ${page}.`);
                log.error(`Error: ${errorMsg}`);
                log.error(`This page will be skipped. You can review the full error in report.json.`);
                log.error(`Exiting...`);

                saveReport(reportPath, report);
                return;
            }

            // Increment retry count
            pageReport.retryCount += 1;
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

            // Check if we hit the Google API 100-result limit
            if (error.response?.status === 400) {
                const errorMessage = error.response?.data?.error?.message || '';
                const errorDetails = JSON.stringify(error.response?.data?.error?.errors || []);

                if (startIndex > 91 || errorMessage.toLowerCase().includes('invalid value') ||
                    errorDetails.toLowerCase().includes('start')) {
                    log.info(`Reached Google API result limit (100 results/10 pages). Stopping pagination.`);
                    break;
                }

                log.error(`Failed to fetch page ${page}: ${error.message}`);
                break;
            }

            if (error.response?.status === 403) {
                log.error(`Failed to fetch page ${page}: ${error.message}`);
                break;
            }

            log.error(`Failed to fetch page ${page}: ${error.message}`);
        }
    }

    if (newRows.length > 0) {
        appendToGoogleResultsCsv(csvPath, newRows);
        log.success(`Stage 1 complete: ${newRows.length} new URLs saved to ${csvPath}`);
    } else {
        log.info('Stage 1 complete: No new URLs found');
    }

    log.info(`Summary - Total found: ${totalFound}, New: ${newRows.length}, Duplicates skipped: ${duplicatesSkipped}`);

    return requestId;
};

module.exports = runStage1;
