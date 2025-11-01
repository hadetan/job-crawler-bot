/**
 * Test script to extract a single job posting
 * Usage: node test-single-job.js <job-url>
 */

const puppeteer = require('puppeteer');
const config = require('./src/config');
const extractJobDetails = require('./src/utils/extract-job-details');
const { log } = require('./src/utils');

const testSingleJob = async (url) => {
    if (!url) {
        console.error('Usage: node test-single-job.js <job-url>');
        console.error('\nExample URLs from your CSV:');
        console.error('  node test-single-job.js "https://www.playlist.com/careers/opportunities/4609980006"');
        console.error('  node test-single-job.js "https://careers.roblox.com/jobs/6595289"');
        console.error('  node test-single-job.js "https://stripe.com/jobs/listing/account-executive-enterprise/7336750"');
        process.exit(1);
    }

    log.info(`Testing job extraction for: ${url}`);
    log.info('='.repeat(80));

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

    try {
        const page = await browser.newPage();
        await page.setUserAgent(config.crawler.userAgent);
        await page.setViewport({ width: 1920, height: 1080 });

        const jobData = await extractJobDetails(page, url);

        log.success('\n✅ Extraction successful!');
        log.info('='.repeat(80));
        log.info(`Title: ${jobData.title}`);
        log.info(`Location: ${jobData.location}`);
        log.info(`Source: ${jobData.source}`);
        log.info(`Description length: ${jobData.description.length} characters`);
        log.info(`Skills found: ${jobData.skills ? jobData.skills.length : 0}`);
        log.info('='.repeat(80));
        log.info('\nFirst 500 characters of description:');
        log.info('-'.repeat(80));
        console.log(jobData.description.substring(0, 500));
        log.info('-'.repeat(80));
        log.info('\nLast 500 characters of description:');
        log.info('-'.repeat(80));
        console.log(jobData.description.substring(Math.max(0, jobData.description.length - 500)));
        log.info('-'.repeat(80));

        await page.close();
    } catch (error) {
        log.error(`\n❌ Extraction failed: ${error.message}`);
        console.error(error);
    } finally {
        await browser.close();
    }
};

const url = process.argv[2];
testSingleJob(url);
