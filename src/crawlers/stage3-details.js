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
      waitUntil: 'networkidle2',
      timeout: config.crawler.pageTimeout
    });

    // Wait for dynamic content to load
    await page.waitForTimeout(5000);

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
 * Process a single job URL with retry logic
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

  const maxRetries = 3;
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const page = await browser.newPage();

    try {
      await page.setUserAgent(config.crawler.userAgent);
      await page.setViewport({ width: 1920, height: 1080 });
      
      // Disable HTTP/2 for problematic sites
      await page.setExtraHTTPHeaders({
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      });

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
      
      await page.close();
      return; // Success - exit retry loop
      
    } catch (error) {
      await page.close();
      lastError = error;
      
      // Check if this is a retryable error
      const isRetryable = 
        error.message.includes('ERR_HTTP2_PROTOCOL_ERROR') ||
        error.message.includes('ERR_CONNECTION') ||
        error.message.includes('timeout') ||
        error.message.includes('Navigation');
      
      if (isRetryable && attempt < maxRetries - 1) {
        const delay = 2000 * Math.pow(2, attempt); // Exponential backoff
        log.warning(`Attempt ${attempt + 1} failed for ${url}, retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      // Non-retryable error or final attempt
      break;
    }
  }
  
  // All retries failed
  if (lastError) {
    // Detailed error logging
    if (lastError.message.includes('Failed to extract valid content')) {
      log.error(`Validation failed for ${url}: ${lastError.message}`);
    } else if (lastError.message.includes('Navigation') || lastError.message.includes('Timeout')) {
      log.error(`Navigation timeout for ${url}: ${lastError.message}`);
    } else if (lastError.message.includes('ERR_HTTP2_PROTOCOL_ERROR')) {
      log.error(`HTTP/2 protocol error for ${url} (likely anti-bot protection)`);
    } else {
      log.error(`Extraction failed for ${url}: ${lastError.message}`);
    }

    // Save failed URL for analysis
    const failedLogPath = path.join(jobsDir, 'failed_extractions.txt');
    fs.appendFileSync(failedLogPath, `${url}\t${lastError.message}\n`, 'utf-8');

    stats.failedCount++;
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

  log.info(`Total jobs in CSV: ${jobURLs.length}`);
  log.info(`Already processed: ${processedJobs.size}`);
  log.info(`New jobs to process: ${urlsToProcess.length}`);
  
  // Debug: show sample of filtered URLs
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

  // Launch browser with additional args to handle HTTP/2 protocol issues
  const browser = await puppeteer.launch({
    headless: config.crawler.headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-http2',  // Disable HTTP/2 to prevent ERR_HTTP2_PROTOCOL_ERROR
      '--disable-blink-features=AutomationControlled',  // Hide automation
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process'
    ],
    ignoreHTTPSErrors: true
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
