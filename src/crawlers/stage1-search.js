const config = require('../config');
const log = require('../utils/logger');
const ProviderFactory = require('../search-providers/provider-factory');
const { getSearchQuery, listSearchTargets } = require('../constants/search-targets');
const { generateRequestId, setupJobBoardsFolder, loadReport, saveReport, requestIdExists, appendToGoogleResultsCsv, getExistingUrlsFromCsv } = require('../utils/request-helpers');

const runStage1 = async (options = {}) => {
    let providerName = options.provider || config.defaultSearchProvider;
    const searchEngine = options.searchEngine;
    const searchKey = options.search;

    if (!searchKey) {
        log.error('No search target provided. Please rerun with --search=<target>.');

        const availableTargets = listSearchTargets();
        if (availableTargets.length > 0) {
            log.error(`Available targets: ${availableTargets.join(', ')}`);
        }

        process.exit(1);
    }

    const searchQuery = getSearchQuery(searchKey);

    if (!searchQuery) {
        log.error(`Unknown search target '${searchKey}'.`);

        const availableTargets = listSearchTargets();
        if (availableTargets.length > 0) {
            log.error(`Available targets: ${availableTargets.join(', ')}`);
        }

        process.exit(1);
    }

    log.info(`Using search target '${searchKey}' -> ${searchQuery}`);

    let provider;
    try {
        // Validate --engine parameter usage
        if (searchEngine && providerName !== 'serp') {
            log.warn(`Warning: --engine parameter is only supported with --use=serp. Ignoring.`);
        }

        const configuredProviders = ProviderFactory.getConfiguredProviders();
        if (configuredProviders.length === 0) {
            log.error('No search providers are configured!\nPlease add at least one API key to your .env file:\n  - GOOGLE_API_KEY and GOOGLE_SEARCH_ENGINE_ID for Google Custom Search\n  - SERP_API_KEY for SerpAPI');
            process.exit(1);
        }

        if (!ProviderFactory.isAvailable(providerName)) {
            log.error(`Search provider '${providerName}' is not configured or unavailable.`);
            log.error('');
            log.error('Available providers:');

            const allProviders = ProviderFactory.getAvailableProviders();
            allProviders.forEach(name => {
                const providerInfo = ProviderFactory.getProviderInfo(name);
                const status = providerInfo.available ? '✓' : '✗';
                const extra = providerInfo.supportsEngineParam ? ' (supports --engine parameter)' : '';
                log.error(`  ${status} ${name} - ${providerInfo.displayName}${extra}`);
            });

            log.error('Configured providers you can use:');
            configuredProviders.forEach(name => {
                const providerInfo = ProviderFactory.getProviderInfo(name);
                const extra = providerInfo.supportsEngineParam ? ' (supports --engine parameter)' : '';
                log.error(`  • ${name} - ${providerInfo.displayName}${extra}`);
            });

            process.exit(1);
        }

        provider = ProviderFactory.create(providerName, { engine: searchEngine });

    } catch (error) {
        log.error(`Failed to initialize search provider: ${error.message}`);
        process.exit(1);
    }

    log.info(`Starting Stage 1: ${provider.getDisplayName()}...`);

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

    let reportArray;
    if (providerName === 'serp') {
        const engineKey = provider.getSearchEngine().toLowerCase();

        if (!report.serp_report[engineKey]) {
            report.serp_report[engineKey] = [];
        }

        reportArray = report.serp_report[engineKey];
    } else {
        reportArray = report.google_report;
    }

    // --clean flag: reset report progress
    if (options.clean) {
        log.info(`Clean flag detected. Resetting progress for request ID ${requestId}`);

        if (providerName === 'serp') {
            const engineKey = provider.getSearchEngine().toLowerCase();
            report.serp_report[engineKey] = [];
            reportArray = report.serp_report[engineKey];
        } else {
            report.google_report = [];
            reportArray = report.google_report;
        }

        saveReport(reportPath, report);
    }

    let startPage = 1;
    const firstFailedPage = reportArray.find(p => p.status === false);

    if (firstFailedPage) {
        startPage = firstFailedPage.page;
        log.info(`Resuming from page ${startPage} where previous run failed`);
    } else if (reportArray.length > 0) {
        const lastSuccessfulPage = Math.max(...reportArray.map(p => p.page));
        const maxPagesConfiguredCheck = (options.pages && Number.isInteger(options.pages) && options.pages > 0) ? options.pages : config.crawler.maxPages;
        if (lastSuccessfulPage >= maxPagesConfiguredCheck) {
            log.info(`All pages already completed successfully for request ID ${requestId}. Use --clean to start fresh.`);
            return requestId;
        }
        startPage = lastSuccessfulPage + 1;
    }

    const existingUrlsInCsv = getExistingUrlsFromCsv(csvPath);

    const newRows = [];
    let totalFound = 0;
    let duplicatesSkipped = 0;

    const maxPagesConfigured = (options.pages && Number.isInteger(options.pages) && options.pages > 0) ? options.pages : config.crawler.maxPages;

    const providerMaxPages = provider.getMaxPages();
    const effectiveMaxPages = Math.min(maxPagesConfigured, providerMaxPages);

    if (maxPagesConfigured > providerMaxPages) {
        log.warn(`⚠️  Provider ${provider.getName()} has a maximum of ${providerMaxPages} pages. Limiting to ${effectiveMaxPages} pages.`);
    }

    for (let page = startPage; page <= effectiveMaxPages; page++) {
        log.progress(`Fetching page ${page} of ${effectiveMaxPages}...`);

        let pageReport = reportArray.find(p => p.page === page);
        const isRetry = pageReport !== undefined;

        if (!pageReport) {
            pageReport = {
                page: page,
                status: false,
                error: null,
                retryCount: 0
            };
            reportArray.push(pageReport);
        } else if (isRetry) {
            if (pageReport.retryCount >= config.retry.maxRetryCount) {
                const errorMsg = pageReport.error?.message ||
                    pageReport.error?.statusText ||
                    'Unknown error';

                log.error(`Max retry limit (${config.retry.maxRetryCount}) reached for page ${page}.`);
                log.error(`Error: ${errorMsg}`);
                log.error(`This page will be skipped. You can review the full error in report.json.`);
                log.error(`Exiting...`);

                saveReport(reportPath, report);
                return requestId;
            }

            // Increment retry count
            pageReport.retryCount += 1;
        }

        try {
            const results = await provider.search(searchQuery, page);

            if (!results || results.length === 0) {
                log.info('No more results found, stopping pagination');

                pageReport.status = true;
                pageReport.error = null;
                saveReport(reportPath, report);
                break;
            }

            results.forEach(result => {
                const url = result.url;
                const snippet = result.snippet || '';
                const logoUrl = result.logoUrl || '';

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

            if (error.message.includes('quota exceeded') ||
                error.message.includes('invalid credentials') ||
                error.message.includes('API limit')) {
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

    return requestId;
};

module.exports = runStage1;
