const puppeteer = require('puppeteer');
const path = require('path');
const pLimit = require('p-limit');
const { convert } = require('html-to-text');
const config = require('../config');
const { readCSV, writeCSV, normalizeURL } = require('../utils/csv-handler');
const log = require('../utils/logger');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const tryExtractField = async (page, selectors) => {
  for (const selector of selectors) {
    try {
      const text = await page.$eval(selector, el => el.textContent || el.innerText);
      if (text && text.trim()) {
        return text.trim();
      }
    } catch (error) {
      // Selector not found, try next one
    }
  }
  return '';
};

const tryExtractHTML = async (page, selectors) => {
  for (const selector of selectors) {
    try {
      const html = await page.$eval(selector, el => el.innerHTML);
      if (html && html.trim()) {
        const plainText = convert(html, {
          wordwrap: false,
          preserveNewlines: false
        });
        return plainText.replace(/\n+/g, ' ').trim();
      }
    } catch (error) {
      // Selector not found, try next one
    }
  }
  return '';
};

const tryExtractMultiple = async (page, selectors) => {
  for (const selector of selectors) {
    try {
      const items = await page.$$eval(selector, elements =>
        elements.map(el => el.textContent || el.innerText).filter(Boolean)
      );
      if (items.length > 0) {
        return items.map(item => item.trim()).join('; ');
      }
    } catch (error) {
      // Selector not found, try next one
    }
  }
  return '';
};

const extractJobDetails = async (page, url, retryCount = 0) => {
  try {
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: config.crawler.pageTimeout
    });

    const title = await tryExtractField(page, config.selectors.title);
    const description = await tryExtractHTML(page, config.selectors.description);
    const location = await tryExtractField(page, config.selectors.location);
    const skills = await tryExtractMultiple(page, config.selectors.skills);

    return {
      url,
      title,
      description,
      location,
      skills
    };
  } catch (error) {
    if (retryCount < config.retry.maxRetries) {
      const delay = config.retry.retryDelay * (retryCount + 1);
      log.progress(`Failed to load ${url}, retrying in ${delay}ms... (Attempt ${retryCount + 1}/${config.retry.maxRetries})`);
      await sleep(delay);
      return extractJobDetails(page, url, retryCount + 1);
    }

    throw error;
  }
};

const runStage3 = async () => {
  log.info('Starting Stage 3: Job Details Extractor...');

  const inputFile = path.join(config.output.dir, 'job_links_test.csv');
  const outputFile = path.join(config.output.dir, 'jobs_data_test.csv');

  const jobURLs = readCSV(inputFile, 'url');
  if (jobURLs.length === 0) {
    log.error('No job URLs found in job_links.csv. Run Stage 2 first.');
    return;
  }

  const existingJobURLs = readCSV(outputFile, 'url').map(normalizeURL);
  const existingSet = new Set(existingJobURLs);

  const urlsToProcess = jobURLs.filter(url => !existingSet.has(normalizeURL(url)));

  if (urlsToProcess.length === 0) {
    log.info('Stage 3 complete: All jobs already processed');
    return;
  }

  const browser = await puppeteer.launch({
    headless: config.crawler.headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const limit = pLimit(config.crawler.concurrency);
  const newJobs = [];
  let failedJobs = 0;

  const processJobURL = async (url, index) => {
    log.progress(`Processing job ${index + 1}/${urlsToProcess.length}: ${url}`);
    const page = await browser.newPage();

    try {
      await page.setUserAgent(config.crawler.userAgent);
      await page.setViewport({ width: 1920, height: 1080 });

      const jobData = await extractJobDetails(page, url);
      newJobs.push(jobData);
    } catch (error) {
      log.error(`Failed to extract job details from ${url}: ${error.message}`);
      failedJobs++;
    } finally {
      await page.close();
    }
  };

  await Promise.all(urlsToProcess.map((url, index) => limit(() => processJobURL(url, index))));

  await browser.close();

  if (newJobs.length > 0) {
    writeCSV(outputFile, newJobs, ['url', 'title', 'description', 'location', 'skills']);
    log.success(`Stage 3 complete: ${newJobs.length} new jobs saved to ${outputFile}`);
  } else {
    log.info('Stage 3 complete: No new jobs extracted');
  }

  log.info(`Summary - Total processed: ${urlsToProcess.length}, Successful: ${newJobs.length}, Failed: ${failedJobs}`);
};

module.exports = runStage3;
