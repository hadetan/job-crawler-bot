const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const pLimit = require('p-limit');
const config = require('../config');
const { readCSV, writeCSV, normalizeURL } = require('../utils/csv-handler');
const log = require('../utils/logger');
const { extractJobLinks } = require('../utils/job-links');
const { generateRequestId } = require('../utils/request-helpers');

const runStage2 = async (options = {}) => {
    log.info('Starting Stage 2: Job Listing Page Crawler...');

    // Validate
    if (!options.runId) {
        log.error('Stage 2 requires --run parameter. Usage: npm start -- --stage=2 --run={requestId} [--id={jobId}] [--clean]');
        process.exit(1);
    }

    const requestDir = path.join(config.output.dir, 'job_boards', options.runId);
    if (!fs.existsSync(requestDir)) {
        log.error(`Stage 1 run '${options.runId}' not found at ${requestDir}`);
        log.error('Please run Stage 1 first with this requestId or use an existing one.');
        process.exit(1);
    }

    const googleResultsCsv = path.join(requestDir, 'google-results.csv');
    if (!fs.existsSync(googleResultsCsv)) {
        log.error(`google-results.csv not found in ${requestDir}`);
        process.exit(1);
    }

    let jobId = options.jobId;
    if (!jobId) {
        jobId = generateRequestId();
        log.info(`No jobId provided. Generated jobId: ${jobId}`);
    } else {
        log.info(`Starting Stage 2 with jobId: ${jobId}, reading from requestId: ${options.runId}`);
    }

    log.info(`Reading job board URLs from requestId: ${options.runId}`);

    const inputFile = path.join(config.output.dir, 'urls.csv');
    const outputFile = path.join(config.output.dir, 'jobs.csv');

    const urls = readCSV(inputFile, 'url');
    if (urls.length === 0) {
        log.error('No URLs found in urls.csv. Run Stage 1 first.');
        return;
    }

    const existingJobLinks = readCSV(outputFile, 'url').map(normalizeURL);
    const existingSet = new Set(existingJobLinks);

    const browser = await puppeteer.launch({
        headless: config.crawler.headless,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-http2',
            '--disable-blink-features=AutomationControlled',  /* Hide automation */
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process'
        ],
        ignoreHTTPSErrors: true
    });

    const limit = pLimit(config.crawler.concurrency);
    const newJobLinks = [];
    let totalLinksFound = 0;
    let duplicatesSkipped = 0;
    let failedPages = 0;

    const processURL = async (url, index) => {
        log.progress(`Processing page ${index + 1}/${urls.length}: ${url}`);
        const page = await browser.newPage();

        try {
            await page.setUserAgent(config.crawler.userAgent);
            await page.setViewport({ width: 1920, height: 1080 });

            const links = await extractJobLinks(page, url);
            totalLinksFound += links.length;

            links.forEach(link => {
                const normalized = normalizeURL(link);
                if (existingSet.has(normalized)) {
                    duplicatesSkipped++;
                } else {
                    existingSet.add(normalized);
                    newJobLinks.push({ url: link });
                }
            });
        } catch (error) {
            log.error(`Failed to process ${url}: ${error.message}`);
            failedPages++;
        } finally {
            await page.close();
        }
    };

    await Promise.all(urls.map((url, index) => limit(() => processURL(url, index))));

    await browser.close();

    if (newJobLinks.length > 0) {
        writeCSV(outputFile, newJobLinks, ['url']);
        log.success(`Stage 2 complete: ${newJobLinks.length} new job links saved to ${outputFile}`);
    } else {
        log.info('Stage 2 complete: No new job links found');
    }

    log.info(`Summary - Total links found: ${totalLinksFound}, New: ${newJobLinks.length}, Duplicates skipped: ${duplicatesSkipped}, Failed pages: ${failedPages}`);
};

module.exports = runStage2;
