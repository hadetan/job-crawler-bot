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

    if (hostname.includes('greenhouse.io')) {
      const pathParts = urlObj.pathname.split('/').filter(Boolean);
      if (pathParts.length > 0) {
        return pathParts[0];
      }
    }

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

const tryExtractText = async (page, selectors) => {
  for (const selector of selectors) {
    try {
      const element = await page.$(selector);
      if (element) {
        const text = await page.evaluate(el => el.textContent || el.innerText, element);
        if (text && text.trim()) {
          return text.trim();
        }
      }
    } catch (error) {
      // Continue to next selector
    }
  }
  return '';
};

const tryExtractHTML = async (page, selectors) => {
  for (const selector of selectors) {
    try {
      const element = await page.$(selector);
      if (element) {
        const html = await page.evaluate(el => el.innerHTML, element);
        if (html && html.trim()) {
          const text = convert(html, {
            wordwrap: 130,
            preserveNewlines: true,
            selectors: [
              { selector: 'a', options: { ignoreHref: true } },
              { selector: 'img', format: 'skip' }
            ]
          });
          return text.trim();
        }
      }
    } catch (error) {
      // Continue to next selector
    }
  }
  return '';
};

const tryExtractList = async (page, selectors) => {
  for (const selector of selectors) {
    try {
      const elements = await page.$$(selector);
      if (elements.length > 0) {
        const items = [];
        for (const element of elements) {
          const text = await page.evaluate(el => el.textContent || el.innerText, element);
          if (text && text.trim() && text.length > 10 && text.length < 300) {
            items.push(text.trim());
          }
        }
        if (items.length > 0) {
          return items;
        }
      }
    } catch (error) {
      // Continue to next selector
    }
  }
  return [];
};

// Greenhouse-specific extraction (most common)
const extractGreenhouseJob = async (page) => {
  const titleSelectors = [
    '.app-title',
    'h1.app-title',
    '[data-qa="job-title"]',
    'h1'
  ];

  const descriptionSelectors = [
    '#content',
    '.content',
    '#app-body',
    '.app-body',
    '[data-qa="job-description"]'
  ];

  const locationSelectors = [
    '.location',
    '.app-location',
    '[data-qa="job-location"]',
    '.posting-categories .location'
  ];

  const requirementsSelectors = [
    '#content ul li',
    '.content ul li',
    '#app-body ul li',
    '[data-qa="job-description"] ul li'
  ];

  const title = await tryExtractText(page, titleSelectors);
  const description = await tryExtractHTML(page, descriptionSelectors);
  const location = await tryExtractText(page, locationSelectors);
  const skills = await tryExtractList(page, requirementsSelectors);

  return {
    title: title || 'N/A',
    description: description || 'No description found',
    location: location || 'Not specified',
    skills
  };
};

// Lever-specific extraction
const extractLeverJob = async (page) => {
  const titleSelectors = [
    '.posting-headline h2',
    'h2[data-qa="posting-name"]',
    '.posting-header h2',
    'h2'
  ];

  const descriptionSelectors = [
    '.posting-description .content',
    '.section-wrapper .content',
    '.posting-description',
    '.content.description'
  ];

  const locationSelectors = [
    '.posting-categories .location',
    '.posting-categories .sort-by-location',
    '[data-qa="posting-location"]',
    '.location'
  ];

  const requirementsSelectors = [
    '.posting-description ul li',
    '.content.description ul li',
    '.section-wrapper ul li'
  ];

  const title = await tryExtractText(page, titleSelectors);
  const description = await tryExtractHTML(page, descriptionSelectors);
  const location = await tryExtractText(page, locationSelectors);
  const skills = await tryExtractList(page, requirementsSelectors);

  return {
    title: title || 'N/A',
    description: description || 'No description found',
    location: location || 'Not specified',
    skills
  };
};

// EyeCareCenter-specific extraction (uses CSS Modules)
const extractEyeCareCenterJob = async (page) => {
  const titleSelectors = [
    'h1',
    '[class*="job"] h1',
    '[class*="title"]'
  ];

  const descriptionSelectors = [
    '[class*="job_detail_content"]',
    '[class*="job_content"]',
    '[class*="description"]',
    'main',
    'article'
  ];

  const locationSelectors = [
    '[class*="location"]',
    '.location'
  ];

  const requirementsSelectors = [
    '[class*="job_detail_content"] ul li',
    '[class*="job_content"] ul li',
    'main ul li',
    'article ul li'
  ];

  const title = await tryExtractText(page, titleSelectors);
  const description = await tryExtractHTML(page, descriptionSelectors);
  let location = await tryExtractText(page, locationSelectors);

  // EyeCareCenter embeds location in title, extract it
  if (!location && title) {
    const locationMatch = title.match(/in (.+?)$/);
    if (locationMatch) {
      location = locationMatch[1];
    }
  }

  const skills = await tryExtractList(page, requirementsSelectors);

  return {
    title: title || 'N/A',
    description: description || 'No description found',
    location: location || 'Not specified',
    skills
  };
};

// BigID-specific extraction (Greenhouse embed, needs extra wait time)
const extractBigIDJob = async (page) => {
  // Wait longer for Greenhouse embed to load
  await page.waitForTimeout(4000);

  const titleSelectors = [
    '#grnhse_app .app-title',
    '#grnhse_app h1',
    '.app-title',
    'h1',
    'h2' // Last resort fallback
  ];

  const descriptionSelectors = [
    '#grnhse_app #content',
    '#grnhse_app .content',
    '#content',
    '.content',
    'main'
  ];

  const locationSelectors = [
    '#grnhse_app .location',
    '.location',
    '[class*="location"]'
  ];

  const requirementsSelectors = [
    '#grnhse_app #content ul li',
    '#grnhse_app .content ul li',
    '#content ul li',
    'main ul li'
  ];

  const title = await tryExtractText(page, titleSelectors);
  const description = await tryExtractHTML(page, descriptionSelectors);
  const location = await tryExtractText(page, locationSelectors);
  const skills = await tryExtractList(page, requirementsSelectors);

  return {
    title: title || 'N/A',
    description: description || 'No description found',
    location: location || 'Not specified',
    skills
  };
};

// Lob-specific extraction (custom Lever implementation)
const extractLobJob = async (page) => {
  const titleSelectors = [
    'h1',
    '.job-title',
    '[class*="title"]'
  ];

  const descriptionSelectors = [
    '[class*="description"]',
    '[class*="content"]',
    'main',
    'article'
  ];

  const locationSelectors = [
    '[class*="location"]',
    '.location'
  ];

  const requirementsSelectors = [
    'main ul li',
    'article ul li',
    '[class*="description"] ul li'
  ];

  const title = await tryExtractText(page, titleSelectors);
  const description = await tryExtractHTML(page, descriptionSelectors);
  const location = await tryExtractText(page, locationSelectors);
  const skills = await tryExtractList(page, requirementsSelectors);

  return {
    title: title || 'N/A',
    description: description || 'No description found',
    location: location || 'Not specified',
    skills
  };
};

// Generic fallback extraction
const extractGenericJob = async (page) => {
  const titleSelectors = [
    'h1',
    '[class*="title"]',
    '[class*="job"]'
  ];

  const descriptionSelectors = [
    'main',
    'article',
    '[role="main"]',
    '.content'
  ];

  const locationSelectors = [
    '.location',
    '[class*="location"]'
  ];

  const requirementsSelectors = [
    'main ul li',
    'article ul li',
    '.content ul li'
  ];

  const title = await tryExtractText(page, titleSelectors);
  const description = await tryExtractHTML(page, descriptionSelectors);
  const location = await tryExtractText(page, locationSelectors);
  const skills = await tryExtractList(page, requirementsSelectors);

  return {
    title: title || 'N/A',
    description: description || 'No description found',
    location: location || 'Not specified',
    skills
  };
};

const extractJobDetails = async (page, url, retryCount = 0) => {
  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: config.crawler.pageTimeout
    });

    await page.waitForTimeout(2000);

    // Prioritize company-specific extraction
    const company = detectCompany(url);
    let jobData;

    switch (company) {
      case 'bigid':
        jobData = await extractBigIDJob(page);
        break;
      case 'eyecarecenter':
        jobData = await extractEyeCareCenterJob(page);
        break;
      case 'lob':
        jobData = await extractLobJob(page);
        break;
      case 'elixirr':
        // Elixirr uses standard Greenhouse
        jobData = await extractGreenhouseJob(page);
        break;
      default:
        // Fall back to board type detection
        const jobBoardType = detectJobBoardType(url);
        switch (jobBoardType) {
          case 'greenhouse':
            jobData = await extractGreenhouseJob(page);
            break;
          case 'lever':
            jobData = await extractLeverJob(page);
            break;
          default:
            jobData = await extractGenericJob(page);
        }
    }

    return {
      url,
      ...jobData
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

  lines.push(`TITLE: ${jobData.title}`);
  lines.push('');

  lines.push(`LOCATION: ${jobData.location}`);
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
  lines.push(jobData.description);
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
  const boardTypeStats = { greenhouse: 0, lever: 0, generic: 0 };

  const processJobURL = async (url, index) => {
    const boardType = detectJobBoardType(url);
    log.progress(`Processing job ${index + 1}/${urlsToProcess.length} [${boardType}]: ${url}`);

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
      boardTypeStats[boardType]++;
      successCount++;

      log.info(`Saved: ${companyName}/${fileName} - "${jobData.title}"`);
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
  log.info(`Board types - Greenhouse: ${boardTypeStats.greenhouse}, Lever: ${boardTypeStats.lever}, Generic: ${boardTypeStats.generic}`);

  if (Object.keys(companyJobCounts).length > 0) {
    log.info('Jobs saved by company:');
    Object.entries(companyJobCounts).sort().forEach(([company, count]) => {
      log.info(`  ${company}: ${count} jobs`);
    });
  }
};

module.exports = runStage3;
