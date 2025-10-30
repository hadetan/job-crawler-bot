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

const isJobDetailPage = (url) => {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname.toLowerCase();
    const search = urlObj.search.toLowerCase();

    // Exclude generic pages (careers home, listings, FAQ, etc.)
    const excludePatterns = [
      /\/careers\/?$/,           // Ends with /careers/ or /careers
      /\/jobs\/?$/,              // Ends with /jobs/ or /jobs
      /\/career\/?$/,            // Ends with /career/ or /career
      /\/(faqs?|about|team|benefits|culture|life|perks|diversity|contact|early-careers)[\/?]/,
      /life-as/,                 // Blog/life stories pages
      /our-entrepreneurs/,       // Team/entrepreneur pages
      /episodes\//,              // Blog episodes
      /#job-board/,              // Hash fragments to job boards
      /open-positions\/?$/,      // Generic "open positions" page
      /\/[a-z]{2}\/.*careers\/?$/,  // Localized pages ending in careers (e.g., /pt/careers/)
      /\/apply\/?$/,             // Application forms (when /apply is at the end)
      /\/(search|all|university)\/?$/,  // Search, "view all", university pages
      /\/departments?\/?$/,      // Department listing pages
      /\/(chicago|dublin|tokyo|london|munich|new-york|san-francisco|paris|reykjavik|sydney|singapore|vancouver|warsaw|nyc|sf|la|boston|seattle|austin|denver|atlanta|miami|dallas|houston|phoenix|portland|philadelphia|berlin|amsterdam|barcelona|madrid|rome|milan|stockholm|oslo|copenhagen|helsinki|zurich|vienna|brussels|lisbon|prague|budapest|toronto|montreal|melbourne|bangalore|mumbai|delhi|shanghai|beijing|hong-kong|seoul|taipei)\/?$/i,
      /\/(business|engineering|product|internal|design|marketing|sales|support|operations|finance|legal|data|security|infrastructure|research|university-recruiting|internship)\/?$/i  // Department/team filter pages
    ];

    for (const pattern of excludePatterns) {
      if (pattern.test(pathname) || pattern.test(search)) {
        return false;
      }
    }

    // Job detail pages typically have job IDs (numbers/alphanumeric) in URL
    const hasJobId = /\d{7,}/.test(pathname + search) ||  // Long numbers (Greenhouse IDs)
                     /gh_jid=/.test(search) ||            // Greenhouse job ID param
                     /\/jobs?\/[a-zA-Z0-9-]+/.test(pathname) ||  // /job/some-job-title-123
                     /job[-_]?id=/i.test(search);         // job_id or jobId param

    // Must have job ID or be deep enough path (3+ segments after domain)
    const pathSegments = pathname.split('/').filter(Boolean);
    const isDeepPath = pathSegments.length >= 3;

    return hasJobId || isDeepPath;
  } catch {
    return false;
  }
};

const extractJobLinks = async (page, url, retryCount = 0) => {
  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: config.crawler.pageTimeout
    });

    await page.waitForTimeout(1000);

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
      .filter(Boolean)
      .filter(isJobDetailPage);

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
