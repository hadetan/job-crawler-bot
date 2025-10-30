const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const pLimit = require('p-limit');
const { convert } = require('html-to-text');
const config = require('../config');
const { readCSV, normalizeURL } = require('../utils/csv-handler');
const log = require('../utils/logger');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const extractCompanyName = (url) => {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.replace(/^www\./, '');

    // For greenhouse boards: boards.greenhouse.io/company-name
    if (hostname.includes('greenhouse.io')) {
      const pathParts = urlObj.pathname.split('/').filter(Boolean);
      if (pathParts.length > 0) {
        return pathParts[0];
      }
    }

    // For other domains, use the main domain name
    const domainParts = hostname.split('.');
    if (domainParts.length >= 2) {
      return domainParts[domainParts.length - 2];
    }

    return hostname.replace(/\./g, '_');
  } catch {
    return 'unknown';
  }
};

const getProcessedJobs = (jobsDir) => {
  const trackingFile = path.join(jobsDir, '.processed_urls.txt');
  if (!fs.existsSync(trackingFile)) {
    return new Set();
  }
  const content = fs.readFileSync(trackingFile, 'utf-8');
  return new Set(content.split('\n').filter(Boolean).map(normalizeURL));
};

const markJobAsProcessed = (jobsDir, url) => {
  const trackingFile = path.join(jobsDir, '.processed_urls.txt');
  fs.appendFileSync(trackingFile, url + '\n', 'utf-8');
};

const getNextJobNumber = (companyDir) => {
  if (!fs.existsSync(companyDir)) {
    return 1;
  }

  const files = fs.readdirSync(companyDir)
    .filter(f => f.match(/^\d+\.txt$/))
    .map(f => parseInt(f.replace('.txt', '')))
    .filter(n => !isNaN(n));

  if (files.length === 0) {
    return 1;
  }

  return Math.max(...files) + 1;
};

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
          wordwrap: 130,
          preserveNewlines: true
        });
        return plainText.trim();
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
        return items.map(item => item.trim());
      }
    } catch (error) {
      // Selector not found, try next one
    }
  }
  return [];
};

const extractJobDetails = async (page, url, retryCount = 0) => {
  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: config.crawler.pageTimeout
    });

    await page.waitForTimeout(1000);

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

const formatJobToText = (jobData) => {
  const lines = [];

  lines.push('='.repeat(80));
  lines.push('JOB DETAILS');
  lines.push('='.repeat(80));
  lines.push('');

  lines.push(`TITLE: ${jobData.title || 'N/A'}`);
  lines.push('');

  lines.push(`LOCATION: ${jobData.location || 'N/A'}`);
  lines.push('');

  lines.push(`URL: ${jobData.url}`);
  lines.push('');

  if (jobData.skills && jobData.skills.length > 0) {
    lines.push('SKILLS/REQUIREMENTS:');
    jobData.skills.forEach(skill => {
      lines.push(`  - ${skill}`);
    });
    lines.push('');
  }

  lines.push('-'.repeat(80));
  lines.push('DESCRIPTION:');
  lines.push('-'.repeat(80));
  lines.push('');
  lines.push(jobData.description || 'N/A');
  lines.push('');

  lines.push('='.repeat(80));

  return lines.join('\n');
};

const saveJobToFile = (jobData, companyDir, jobNumber) => {
  const fileName = `${jobNumber}.txt`;
  const filePath = path.join(companyDir, fileName);
  const content = formatJobToText(jobData);

  fs.writeFileSync(filePath, content, 'utf-8');
  return fileName;
};

const runStage3 = async () => {
  log.info('Starting Stage 3: Job Details Extractor...');

  const inputFile = path.join(config.output.dir, 'job_links_test.csv');
  const jobsDir = path.join(config.output.dir, 'jobs_test');

  const jobURLs = readCSV(inputFile, 'url');
  if (jobURLs.length === 0) {
    log.error('No job URLs found in job_links.csv. Run Stage 2 first.');
    return;
  }

  if (!fs.existsSync(jobsDir)) {
    fs.mkdirSync(jobsDir, { recursive: true });
  }

  const processedJobs = getProcessedJobs(jobsDir);
  const urlsToProcess = jobURLs.filter(url => !processedJobs.has(normalizeURL(url)));

  if (urlsToProcess.length === 0) {
    log.info('Stage 3 complete: All jobs already processed');
    return;
  }

  log.info(`Found ${urlsToProcess.length} new jobs to process`);

  const browser = await puppeteer.launch({
    headless: config.crawler.headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const limit = pLimit(config.crawler.concurrency);
  let successCount = 0;
  let failedCount = 0;
  const companyJobCounts = {};

  const processJobURL = async (url, index) => {
    log.progress(`Processing job ${index + 1}/${urlsToProcess.length}: ${url}`);
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

      companyJobCounts[companyName] = (companyJobCounts[companyName] || 0) + 1;
      successCount++;

      log.info(`Saved: ${companyName}/${fileName}`);
    } catch (error) {
      log.error(`Failed to extract job details from ${url}: ${error.message}`);
      failedCount++;
    } finally {
      await page.close();
    }
  };

  await Promise.all(urlsToProcess.map((url, index) => limit(() => processJobURL(url, index))));

  await browser.close();

  log.success(`Stage 3 complete: ${successCount} jobs saved to ${jobsDir}`);
  log.info(`Summary - Total processed: ${urlsToProcess.length}, Successful: ${successCount}, Failed: ${failedCount}`);

  if (Object.keys(companyJobCounts).length > 0) {
    log.info('Jobs saved by company:');
    Object.entries(companyJobCounts).sort().forEach(([company, count]) => {
      log.info(`  ${company}: ${count} jobs`);
    });
  }
};

module.exports = runStage3;
