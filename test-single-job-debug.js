/**
 * Debug script to see what intelligent analysis extracts (bypassing validation)
 */

const puppeteer = require('puppeteer');
const config = require('./src/config');
const { log } = require('./src/utils');
const { extractWithIntelligentAnalysis } = require('./src/extractors');

const testDebug = async (url) => {
    if (!url) {
        console.error('Usage: node test-single-job-debug.js <job-url>');
        process.exit(1);
    }

    log.info(`Debug extraction for: ${url}`);
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
        
        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: 45000
        });
        
        await page.waitForTimeout(5000);

        const jobData = await extractWithIntelligentAnalysis(page);

        if (!jobData) {
            log.error('Extraction returned null (likely error page)');
        } else {
            log.info(`Title: ${jobData.title}`);
            log.info(`Location: ${jobData.location}`);
            log.info(`Description length: ${jobData.description.length} characters`);
            log.info(`Skills: ${jobData.skills.length} items`);
            log.info('='.repeat(80));
            log.info('FULL DESCRIPTION:');
            log.info('='.repeat(80));
            console.log(jobData.description);
            log.info('='.repeat(80));
        }

        await page.close();
    } catch (error) {
        log.error(`Error: ${error.message}`);
        console.error(error);
    } finally {
        await browser.close();
    }
};

const url = process.argv[2];
testDebug(url);
