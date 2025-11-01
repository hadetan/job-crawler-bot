const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const pLimit = require('p-limit');
const config = require('../config');
const {
    readCSV,
    normalizeURL,
    log,
    getProcessedJobs,
} = require('../utils');
const processJobURL = require('../utils/process-job-url');

const runStage3 = async () => {
    log.info('Starting Stage 3: Job Details Extractor...');

    const inputFile = path.join(config.output.dir, 'job_links.csv');
    const jobsDir = path.join(config.output.dir, 'jobs');

    const jobURLs = readCSV(inputFile, 'url');
    if (jobURLs.length === 0) {
        log.error('No job URLs found in job_links.csv. Run Stage 2 first.');
        return;
    }

    if (!fs.existsSync(jobsDir)) {
        fs.mkdirSync(jobsDir, { recursive: true });
    }

    const processedJobs = getProcessedJobs(jobsDir);
    let urlsToProcess = jobURLs.filter(url => !processedJobs.has(normalizeURL(url)));

    log.info(`Total jobs in CSV: ${jobURLs.length}`);
    log.info(`Already processed: ${processedJobs.size}`);
    log.info(`New jobs to process: ${urlsToProcess.length}`);

    if (jobURLs.length > urlsToProcess.length) {
        const skippedCount = jobURLs.length - urlsToProcess.length;
        log.info(`Skipping ${skippedCount} already-processed URLs (showing first 5):`);
        const skipped = jobURLs.filter(url => processedJobs.has(normalizeURL(url))).slice(0, 5);
        skipped.forEach(url => {
            log.info(`  ✓ ${url} [normalized: ${normalizeURL(url)}]`);
        });
    }

    if (urlsToProcess.length === 0) {
        log.info('Stage 3 complete: All jobs already processed');
        return;
    }

    const browser = await puppeteer.launch({
        headless: config.crawler.headless,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-http2',
            '--disable-blink-features=AutomationControlled',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process'
        ],
        ignoreHTTPSErrors: true
    });

    const stats = {
        successCount: 0,
        failedCount: 0,
        structuredCount: 0,
        intelligentCount: 0,
        companyJobCounts: {}
    };

    const limit = pLimit(config.crawler.concurrency);
    await Promise.all(
        urlsToProcess.map((url, index) =>
            limit(() => processJobURL(browser, url, index, urlsToProcess.length, jobsDir, stats))
        )
    );

    await browser.close();

    // Log summary
    log.success(`Stage 3 complete: ${stats.successCount} jobs saved to ${jobsDir}`);
    log.info(`Summary - Total processed: ${urlsToProcess.length}, Successful: ${stats.successCount}, Failed: ${stats.failedCount}`);
    log.info(`Extraction methods - Structured Data: ${stats.structuredCount}, Intelligent Analysis: ${stats.intelligentCount}`);

    if (Object.keys(stats.companyJobCounts).length > 0) {
        log.info('Jobs saved by company:');
        Object.entries(stats.companyJobCounts).sort().forEach(([company, count]) => {
            log.info(`  ${company}: ${count} jobs`);
        });
    }
};

module.exports = runStage3;
