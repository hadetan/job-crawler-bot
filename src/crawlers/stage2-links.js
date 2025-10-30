const puppeteer = require('puppeteer');
const path = require('path');
const pLimit = require('p-limit');
const config = require('../config');
const { readCSV, writeCSV, normalizeURL } = require('../utils/csv-handler');
const log = require('../utils/logger');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const isValidJobURL = (url) => {
  if (!url) return false;
  if (url.startsWith('#') || url.startsWith('mailto:') || url.startsWith('tel:')) {
    return false;
  }
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};

const extractJobLinks = async (page, url, retryCount = 0) => {
  try {
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: config.crawler.pageTimeout
    });

    const links = [];

    for (const selector of config.selectors.jobLinks) {
      try {
        const hrefs = await page.$$eval(selector, anchors =>
          anchors.map(a => a.href).filter(Boolean)
        );
        links.push(...hrefs);
      } catch (error) {
        // Selector not found, try next one
      }
    }

    const validLinks = links
      .filter(isValidJobURL)
      .map(link => {
        try {
          const absoluteURL = new URL(link, url).href;
          return absoluteURL;
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    return validLinks;
  } catch (error) {
    if (retryCount < config.retry.maxRetries) {
      const delay = config.retry.retryDelay * (retryCount + 1);
      log.progress(`Failed to load ${url}, retrying in ${delay}ms... (Attempt ${retryCount + 1}/${config.retry.maxRetries})`);
      await sleep(delay);
      return extractJobLinks(page, url, retryCount + 1);
    }

    throw error;
  }
};

const runStage2 = async () => {
  log.info('Starting Stage 2: Job Listing Page Crawler...');

  const inputFile = path.join(config.output.dir, 'urls.csv');
  const outputFile = path.join(config.output.dir, 'job_links.csv');

  const urls = readCSV(inputFile, 'url');
  if (urls.length === 0) {
    log.error('No URLs found in urls.csv. Run Stage 1 first.');
    return;
  }

  const existingJobLinks = readCSV(outputFile, 'url').map(normalizeURL);
  const existingSet = new Set(existingJobLinks);

  const browser = await puppeteer.launch({
    headless: config.crawler.headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
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
