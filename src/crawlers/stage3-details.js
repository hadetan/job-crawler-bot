const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const pLimit = require('p-limit');
const config = require('../config');
const {
  readCSV,
  normalizeURL,
  log,
  extractCompanyName,
  getProcessedJobs,
  markJobAsProcessed,
  getNextJobNumber,
  saveJobToFile
} = require('../utils');
const {
  extractFromStructuredData,
  extractWithIntelligentAnalysis
} = require('../extractors');
const { validateExtractedContent } = require('../validators');

/**
 * Extract job details from a single URL using multi-layer extraction approach
 * @param {Page} page - Puppeteer page object
 * @param {string} url - Job posting URL
 * @returns {Promise<Object>} Extracted job data with source information
 */
const extractJobDetails = async (page, url) => {
  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: config.crawler.pageTimeout
    });

    // Wait longer for dynamic content to load
    await page.waitForTimeout(3000);

    const failureReasons = [];

    // Layer 1: Try structured data extraction (JSON-LD Schema.org)
    const structuredData = await extractFromStructuredData(page);
    if (structuredData) {
      const validation = validateExtractedContent(structuredData);
      if (validation.valid) {
        return {
          url,
          ...structuredData,
          source: 'structured-data'
        };
      } else {
        failureReasons.push(`Structured data validation failed: ${validation.reason}`);
      }
    } else {
      failureReasons.push('No structured data found');
    }

    // Layer 2: Try intelligent DOM analysis
    const intelligentData = await extractWithIntelligentAnalysis(page);
    if (intelligentData) {
      const validation = validateExtractedContent(intelligentData);

      if (validation.valid) {
        return {
          url,
          ...intelligentData,
          source: 'intelligent-analysis'
        };
      } else {
        failureReasons.push(`Intelligent analysis validation failed: ${validation.reason}`);
      }
    } else {
      failureReasons.push('Intelligent analysis returned no data (likely error page)');
    }

    // Both layers failed
    throw new Error(`Failed to extract valid content: ${failureReasons.join('; ')}`);
  } catch (error) {
    // Re-throw with original message for navigation/timeout errors
    throw error;
  }
};

/**
 * Process a single job URL
 * @param {Browser} browser - Puppeteer browser instance
 * @param {string} url - Job URL to process
 * @param {number} index - Index in processing queue
 * @param {number} total - Total URLs to process
 * @param {string} jobsDir - Output directory for jobs
 * @param {Object} stats - Statistics object to update
 * @returns {Promise<void>}
 */
const processJobURL = async (browser, url, index, total, jobsDir, stats) => {
  log.progress(`Processing job ${index + 1}/${total}: ${url}`);

  const page = await browser.newPage();

  try {
    await page.setUserAgent(config.crawler.userAgent);
    await page.setViewport({ width: 1920, height: 1080 });

    const jobData = await extractJobDetails(page, url);
    const companyName = extractCompanyName(url);
    const companyDir = path.join(jobsDir, companyName);

    if (!fs.existsSync(companyDir)) {
      fs.mkdirSync(companyDir, { recursive: true });
    }

    const jobNumber = getNextJobNumber(companyDir);
    const fileName = saveJobToFile(jobData, companyDir, jobNumber);

    markJobAsProcessed(jobsDir, url);

    stats.companyJobCounts[companyName] = (stats.companyJobCounts[companyName] || 0) + 1;
    stats.successCount++;

    // Track extraction method
    if (jobData.source === 'structured-data') stats.structuredCount++;
    if (jobData.source === 'intelligent-analysis') stats.intelligentCount++;

    log.info(`Extracted via ${jobData.source}`);
    log.info(`Saved: ${companyName}/${fileName} - "${jobData.title}"`);
  } catch (error) {
    // Detailed error logging
    if (error.message.includes('Failed to extract valid content')) {
      log.error(`Validation failed for ${url}: ${error.message}`);
    } else if (error.message.includes('Navigation') || error.message.includes('Timeout')) {
      log.error(`Navigation timeout for ${url}: ${error.message}`);
    } else {
      log.error(`Extraction failed for ${url}: ${error.message}`);
    }

    // Save failed URL for analysis
    const failedLogPath = path.join(jobsDir, 'failed_extractions.txt');
    fs.appendFileSync(failedLogPath, `${url}\t${error.message}\n`, 'utf-8');

    stats.failedCount++;
  } finally {
    await page.close();
  }
};

/**
 * Main function to run Stage 3: Job Details Extraction
 * @returns {Promise<void>}
 */
const runStage3 = async () => {
  log.info('Starting Stage 3: Job Details Extractor...');

  const inputFile = path.join(config.output.dir, 'job_links.csv');
  const jobsDir = path.join(config.output.dir, 'jobs');

  // Load job URLs from CSV
  const jobURLs = readCSV(inputFile, 'url');
  if (jobURLs.length === 0) {
    log.error('No job URLs found in job_links.csv. Run Stage 2 first.');
    return;
  }

  // Ensure output directory exists
  if (!fs.existsSync(jobsDir)) {
    fs.mkdirSync(jobsDir, { recursive: true });
  }

  // Filter out already processed jobs
  const processedJobs = getProcessedJobs(jobsDir);
  let urlsToProcess = jobURLs.filter(url => !processedJobs.has(normalizeURL(url)));

  if (urlsToProcess.length === 0) {
    log.info('Stage 3 complete: All jobs already processed');
    return;
  }

  // Limit to 20 jobs for testing
  const PROCESSING_LIMIT = 20;
  if (urlsToProcess.length > PROCESSING_LIMIT) {
    log.info(`Limiting to ${PROCESSING_LIMIT} jobs (found ${urlsToProcess.length} total)`);
    urlsToProcess = urlsToProcess.slice(0, PROCESSING_LIMIT);
  }

  log.info(`Found ${urlsToProcess.length} new jobs to process`);

  // Launch browser
  const browser = await puppeteer.launch({
    headless: config.crawler.headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  // Initialize statistics
  const stats = {
    successCount: 0,
    failedCount: 0,
    structuredCount: 0,
    intelligentCount: 0,
    companyJobCounts: {}
  };

  // Process URLs with concurrency limit
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
