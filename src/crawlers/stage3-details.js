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

// Intelligent content scoring system
const scoreContent = (text, context = 'description') => {
  if (!text || typeof text !== 'string') return 0;

  const length = text.trim().length;
  let score = 0;

  // Length scoring
  if (context === 'title') {
    if (length > 10 && length < 100) score += 50;
    if (length > 20 && length < 80) score += 30;
  } else if (context === 'description') {
    if (length > 200) score += 50;
    if (length > 500) score += 30;
    if (length > 1000) score += 20;
  } else if (context === 'location') {
    if (length > 3 && length < 100) score += 50;
  }

  // Job-specific keywords
  const jobKeywords = {
    title: ['engineer', 'developer', 'manager', 'analyst', 'designer', 'specialist', 'director', 'senior', 'junior', 'lead'],
    description: ['responsibilities', 'requirements', 'qualifications', 'experience', 'skills', 'job', 'role', 'position', 'we are looking', 'you will'],
    location: ['remote', 'hybrid', 'office', 'city', 'state', 'country', 'usa', 'uk', 'ca', 'ny', 'sf']
  };

  const lowerText = text.toLowerCase();
  const relevantKeywords = jobKeywords[context] || [];

  relevantKeywords.forEach(keyword => {
    if (lowerText.includes(keyword)) score += 10;
  });

  // Penalize navigation-like content
  const navIndicators = ['sign in', 'log in', 'menu', 'navigation', 'cookie', 'privacy policy', 'terms of service', 'all rights reserved'];
  navIndicators.forEach(indicator => {
    if (lowerText.includes(indicator)) score -= 50;
  });

  // Penalize repeated short words (likely navigation)
  const words = text.split(/\s+/);
  const uniqueWords = new Set(words);
  if (words.length > 20 && uniqueWords.size < words.length * 0.3) {
    score -= 30;
  }

  return Math.max(0, score);
};

const intelligentTitleExtraction = async (page) => {
  const strategies = [
    // Strategy 1: Common title classes/IDs
    { selector: '.app-title, h1.app-title', name: 'app-title class' },
    { selector: '[class*="job-title"]', name: 'job-title class' },
    { selector: '[class*="position-title"]', name: 'position-title class' },
    { selector: '#job-title', name: 'job-title id' },

    // Strategy 2: Main h1 that's not navigation
    { selector: 'main h1, article h1, .content h1', name: 'main content h1' },

    // Strategy 3: First h1 on page
    { selector: 'h1', name: 'first h1' },

    // Strategy 4: Look for job-specific meta tags
    { selector: '[property="og:title"]', attribute: 'content', name: 'og:title meta' }
  ];

  const candidates = [];

  for (const strategy of strategies) {
    try {
      const elements = await page.$$(strategy.selector);

      for (const element of elements) {
        let text;
        if (strategy.attribute) {
          text = await page.evaluate((el, attr) => el.getAttribute(attr), element, strategy.attribute);
        } else {
          text = await page.evaluate(el => el.textContent || el.innerText, element);
        }

        if (text && text.trim()) {
          const score = scoreContent(text.trim(), 'title');
          candidates.push({ text: text.trim(), score, strategy: strategy.name });
        }
      }
    } catch (error) {
      // Strategy failed, continue
    }
  }

  // Return highest scoring candidate
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].text;
  }

  return '';
};

const intelligentDescriptionExtraction = async (page) => {
  const strategies = [
    // Strategy 1: Common job description containers
    { selector: '.job-description, [class*="job-description"]', name: 'job-description class' },
    { selector: '#job-description, [id*="job-description"]', name: 'job-description id' },
    { selector: '.description, [class*="description"]', name: 'description class' },

    // Strategy 2: Main content areas
    { selector: 'main .content, article .content', name: 'main content' },
    { selector: '#content, .main-content', name: 'content id' },

    // Strategy 3: Largest text block (usually the description)
    { selector: 'main, article, [role="main"]', name: 'main element' },

    // Strategy 4: Job-specific sections
    { selector: '[class*="posting"], [class*="job-post"]', name: 'posting class' }
  ];

  const candidates = [];

  for (const strategy of strategies) {
    try {
      const elements = await page.$$(strategy.selector);

      for (const element of elements) {
        const html = await page.evaluate(el => el.innerHTML, element);

        if (html && html.trim()) {
          // Remove script and style tags
          const cleanHtml = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                               .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');

          const text = convert(cleanHtml, {
            wordwrap: 130,
            preserveNewlines: true,
            selectors: [
              { selector: 'a', options: { ignoreHref: true } },
              { selector: 'img', format: 'skip' }
            ]
          });

          if (text && text.trim()) {
            const score = scoreContent(text.trim(), 'description');
            candidates.push({ text: text.trim(), score, strategy: strategy.name });
          }
        }
      }
    } catch (error) {
      // Strategy failed, continue
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].text;
  }

  return '';
};

const intelligentLocationExtraction = async (page) => {
  const strategies = [
    // Strategy 1: Common location classes/IDs
    { selector: '.location, .job-location', name: 'location class' },
    { selector: '[class*="location"]', name: 'location-like class' },
    { selector: '#location', name: 'location id' },

    // Strategy 2: Look for location meta tags
    { selector: '[property="og:location"]', attribute: 'content', name: 'og:location meta' },

    // Strategy 3: Text containing location patterns
    { selector: '[class*="info"] span, [class*="detail"] span, [class*="meta"] span', name: 'info spans' }
  ];

  const candidates = [];
  const locationPatterns = /\b(remote|hybrid|onsite|office|\w+,\s*\w+|usa|canada|uk|new york|san francisco|london|berlin|toronto)\b/i;

  for (const strategy of strategies) {
    try {
      const elements = await page.$$(strategy.selector);

      for (const element of elements) {
        let text;
        if (strategy.attribute) {
          text = await page.evaluate((el, attr) => el.getAttribute(attr), element, strategy.attribute);
        } else {
          text = await page.evaluate(el => el.textContent || el.innerText, element);
        }

        if (text && text.trim() && locationPatterns.test(text)) {
          const score = scoreContent(text.trim(), 'location');
          candidates.push({ text: text.trim(), score, strategy: strategy.name });
        }
      }
    } catch (error) {
      // Strategy failed, continue
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].text;
  }

  return '';
};

const intelligentSkillsExtraction = async (page) => {
  const strategies = [
    // Strategy 1: Specific skills/requirements sections
    { selector: '[class*="requirement"] li, [class*="qualification"] li', name: 'requirements list' },
    { selector: '[class*="skill"] li, [class*="skills"] li', name: 'skills list' },

    // Strategy 2: Lists in job description that look like requirements
    { selector: '.job-description ul li, [class*="description"] ul li', name: 'description lists' },

    // Strategy 3: Any lists in main content
    { selector: 'main ul li, article ul li', name: 'main content lists' }
  ];

  const allSkills = [];
  const skillKeywords = ['experience', 'knowledge', 'proficiency', 'ability', 'years', 'bachelor', 'degree', 'certification'];

  for (const strategy of strategies) {
    try {
      const elements = await page.$$(strategy.selector);

      for (const element of elements) {
        const text = await page.evaluate(el => el.textContent || el.innerText, element);

        if (text && text.trim()) {
          const cleanText = text.trim();
          const lowerText = cleanText.toLowerCase();

          // Score this item as a potential skill/requirement
          let isRelevant = false;

          // Check if it contains skill-related keywords
          if (skillKeywords.some(kw => lowerText.includes(kw))) {
            isRelevant = true;
          }

          // Check if it's a reasonable length for a requirement (not too short, not too long)
          if (cleanText.length > 15 && cleanText.length < 300) {
            isRelevant = true;
          }

          // Exclude navigation-like items
          if (lowerText.includes('sign in') || lowerText.includes('menu') || lowerText.includes('cookie')) {
            isRelevant = false;
          }

          if (isRelevant) {
            allSkills.push(cleanText);
          }
        }
      }

      // If we found good skills with this strategy, return them
      if (allSkills.length >= 3) {
        break;
      }
    } catch (error) {
      // Strategy failed, continue
    }
  }

  // Deduplicate and limit
  const uniqueSkills = [...new Set(allSkills)];
  return uniqueSkills.slice(0, 20); // Limit to 20 skills
};

const extractJobDetails = async (page, url, retryCount = 0) => {
  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: config.crawler.pageTimeout
    });

    await page.waitForTimeout(2000);

    // Use intelligent extraction algorithms
    const title = await intelligentTitleExtraction(page);
    const description = await intelligentDescriptionExtraction(page);
    const location = await intelligentLocationExtraction(page);
    const skills = await intelligentSkillsExtraction(page);

    return {
      url,
      title: title || 'N/A',
      description: description || 'No description found',
      location: location || 'Not specified',
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

  if (Object.keys(companyJobCounts).length > 0) {
    log.info('Jobs saved by company:');
    Object.entries(companyJobCounts).sort().forEach(([company, count]) => {
      log.info(`  ${company}: ${count} jobs`);
    });
  }
};

module.exports = runStage3;
