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

// Extract job data from JSON-LD structured data (Schema.org JobPosting)
const extractFromStructuredData = async (page) => {
  try {
    const structuredData = await page.evaluate(() => {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      const jsonData = [];

      scripts.forEach(script => {
        try {
          const data = JSON.parse(script.textContent);
          jsonData.push(data);
        } catch (e) {
          // Skip invalid JSON
        }
      });

      return jsonData;
    });

    // Find JobPosting object(s)
    for (const data of structuredData) {
      const isJobPosting =
        data['@type'] === 'JobPosting' ||
        (Array.isArray(data['@type']) && data['@type'].includes('JobPosting'));

      if (isJobPosting) {
        // Extract fields
        const title = data.title || data.name || '';

        // Description might be HTML with encoded entities, need to decode and convert to text
        let description = data.description || '';
        if (description && description.length > 0) {
          // Decode HTML entities AND extract text in browser (one step)
          description = await page.evaluate((desc) => {
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = desc; // Decodes entities and parses HTML

            // Get text content, which strips ALL HTML tags
            let text = tempDiv.textContent || tempDiv.innerText || '';

            // Clean up whitespace
            text = text.replace(/\s+/g, ' ').trim();

            return text;
          }, description);
        }

        // Extract location (can be nested)
        let location = 'Not specified';
        if (data.jobLocation) {
          if (typeof data.jobLocation === 'string') {
            location = data.jobLocation;
          } else if (data.jobLocation.address) {
            const addr = data.jobLocation.address;
            location = addr.addressLocality || addr.addressRegion || data.jobLocation.name || 'Not specified';
          } else if (data.jobLocation.name) {
            location = data.jobLocation.name;
          }
        }

        // Extract skills (if available)
        let skills = [];
        if (data.skills) {
          if (Array.isArray(data.skills)) {
            skills = data.skills.map(s => typeof s === 'string' ? s : s.name || '').filter(Boolean);
          }
        }
        if (data.relevantOccupation && Array.isArray(data.relevantOccupation)) {
          skills = [...skills, ...data.relevantOccupation.map(o => o.name || o).filter(Boolean)];
        }

        return {
          title: title.trim(),
          description: description.trim(),
          location: location.trim(),
          skills
        };
      }
    }

    return null;
  } catch (error) {
    return null;
  }
};

// Extract job data using intelligent DOM analysis
const extractWithIntelligentAnalysis = async (page) => {
  try {
    // Step 1: Detect error pages
    const isErrorPage = await page.evaluate(() => {
      const pageTitle = document.title.toLowerCase();
      const bodyText = document.body.textContent.toLowerCase();

      // Check for 404 patterns
      if (pageTitle.includes('404') || pageTitle.includes('not found') || pageTitle.includes('error')) {
        return true;
      }

      // Check for error messages in content
      const errorPatterns = [
        "couldn't find",
        "page not found",
        "job posting.*closed",
        "posting.*removed",
        "sorry.*nothing"
      ];

      for (const pattern of errorPatterns) {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(bodyText)) {
          return true;
        }
      }

      return false;
    });

    if (isErrorPage) {
      return null;
    }

    // Step 2: Extract title intelligently
    const title = await page.evaluate(() => {
      // Priority 1: Check page metadata (most reliable)
      const ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle && ogTitle.content) {
        const text = ogTitle.content.trim();
        // Remove common suffixes like "- Company Name"
        const cleaned = text.split(' - ')[0].split(' | ')[0].trim();
        if (cleaned.length >= 5 && cleaned.length <= 200) {
          return cleaned;
        }
      }

      // Priority 2: Check document.title
      const docTitle = document.title.trim();
      if (docTitle && !docTitle.toLowerCase().includes('careers') && !docTitle.toLowerCase().includes('jobs')) {
        const cleaned = docTitle.split(' - ')[0].split(' | ')[0].trim();
        if (cleaned.length >= 5 && cleaned.length <= 200) {
          return cleaned;
        }
      }

      // Priority 3: Look for headings with specific job title indicators
      const headings = Array.from(document.querySelectorAll('h1, h2, h3'));

      // Exclusion patterns for section headings (NOT job titles)
      const exclusionPatterns = [
        /current openings/i,
        /open roles/i,
        /careers at/i,
        /^join/i,
        /^about/i,
        /^home$/i,
        /^careers$/i,
        /^jobs$/i,
        /what we're looking for/i,
        /what you'll do/i,
        /who you are/i,
        /your role/i,
        /responsibilities/i,
        /requirements/i,
        /qualifications/i
      ];

      let bestHeading = null;
      let bestScore = 0;

      for (const heading of headings) {
        const text = heading.textContent.trim();

        // Skip if too short or too long
        if (text.length < 5 || text.length > 200) continue;

        // Skip if matches exclusion patterns (section headings)
        if (exclusionPatterns.some(pattern => pattern.test(text))) continue;

        // Skip if in navigation
        let parent = heading.parentElement;
        let inNav = false;
        for (let i = 0; i < 5 && parent; i++) {
          if (parent.tagName === 'NAV' || parent.getAttribute('role') === 'navigation') {
            inNav = true;
            break;
          }
          parent = parent.parentElement;
        }
        if (inNav) continue;

        // Calculate prominence score
        const rect = heading.getBoundingClientRect();
        const fontSize = parseInt(window.getComputedStyle(heading).fontSize) || 16;
        const position = rect.top;
        const positionWeight = Math.max(1, 3 - (position / 500)); // Higher weight for top positions

        // Boost score if h1 (most likely job title)
        const tagBoost = heading.tagName === 'H1' ? 1.5 : 1.0;

        const score = fontSize * positionWeight * tagBoost;

        if (score > bestScore) {
          bestScore = score;
          bestHeading = text;
        }
      }

      // Fallback: Look for semantic attributes
      if (!bestHeading) {
        const semanticElements = document.querySelectorAll('[data-qa*="job-title"], [data-qa*="position"], [aria-label*="job title"]');
        for (const el of semanticElements) {
          const text = el.textContent.trim();
          if (text.length >= 5 && text.length <= 200) {
            bestHeading = text;
            break;
          }
        }
      }

      return bestHeading || '';
    });

    // Step 3: Extract description intelligently
    const description = await page.evaluate(() => {
      // First, remove navigation and footer elements from consideration
      const removeSelectors = [
        'nav',
        'header',
        'footer',
        '[role="navigation"]',
        '[class*="nav"]',
        '[class*="menu"]',
        '[class*="header"]',
        '[class*="footer"]',
        '[class*="sidebar"]',
        '[aria-label*="navigation"]',
        '[aria-label*="menu"]'
      ];

      // Clone the body to work with
      const workingBody = document.body.cloneNode(true);

      // Remove navigation/footer elements
      removeSelectors.forEach(selector => {
        workingBody.querySelectorAll(selector).forEach(el => el.remove());
      });

      // Now find content containers
      const containers = Array.from(workingBody.querySelectorAll('article, main, [role="main"], section, div'));

      // Job-related keywords to boost score
      const jobKeywords = ['responsibilities', 'requirements', 'qualifications', 'description', 'about the role', 'what you', 'your responsibilities', 'key qualifications'];

      let bestContainers = [];
      let maxScore = 0;

      for (const container of containers) {
        // Get text content
        const text = container.textContent || '';
        const textLength = text.trim().length;

        // Skip if too short (less than 300 chars for job description)
        if (textLength < 300) continue;

        // Skip if contains too many list items (likely navigation)
        const listItems = container.querySelectorAll('li');
        if (listItems.length > 20) continue;

        // Calculate text density (text per element)
        const childCount = container.querySelectorAll('*').length || 1;
        const textDensity = textLength / childCount;

        // Skip low density (likely has lots of nested divs)
        if (textDensity < 5) continue;

        // Calculate link ratio (high link ratio = navigation, skip)
        const links = container.querySelectorAll('a');
        const linkCount = links.length;
        const linkText = Array.from(links).reduce((sum, link) => sum + (link.textContent || '').length, 0);
        const linkRatio = textLength > 0 ? linkText / textLength : 0;

        // Skip if too many links
        if (linkRatio > 0.3 || linkCount > 10) continue;

        // Check for job-related keywords
        const lowerText = text.toLowerCase();
        const keywordCount = jobKeywords.filter(kw => lowerText.includes(kw)).length;

        // Must have at least 1 job keyword to be considered
        if (keywordCount === 0) continue;

        // Calculate quality score
        const score = textDensity * (1 + keywordCount * 2); // Higher weight on keywords

        if (score > maxScore * 0.7) {
          if (score > maxScore) {
            maxScore = score;
          }
          bestContainers.push({ container, score });
        }
      }

      // Sort by score
      bestContainers.sort((a, b) => b.score - a.score);

      // Remove nested containers to avoid duplication
      const uniqueContainers = [];
      for (const candidate of bestContainers) {
        let isNested = false;
        for (const existing of uniqueContainers) {
          if (existing.container.contains(candidate.container)) {
            isNested = true;
            break;
          }
          if (candidate.container.contains(existing.container)) {
            const index = uniqueContainers.indexOf(existing);
            uniqueContainers.splice(index, 1);
            break;
          }
        }
        if (!isNested) {
          uniqueContainers.push(candidate);
        }
      }

      // Take only the best unique container
      const topContainer = uniqueContainers.length > 0 ? uniqueContainers[0].container : null;

      return topContainer ? topContainer.innerHTML : '';
    });

    // Convert HTML to text
    const descriptionText = description ? convert(description, {
      wordwrap: 130,
      preserveNewlines: true,
      selectors: [
        { selector: 'a', options: { ignoreHref: true } },
        { selector: 'img', format: 'skip' }
      ]
    }).trim() : '';

    // Step 4: Extract location
    const location = await page.evaluate(() => {
      // Look for location patterns
      const patterns = [
        /location:\s*([^<\n]+)/i,
        /based in:\s*([^<\n]+)/i,
        /office:\s*([^<\n]+)/i
      ];

      const bodyText = document.body.textContent;

      for (const pattern of patterns) {
        const match = bodyText.match(pattern);
        if (match && match[1]) {
          const loc = match[1].trim();
          if (loc.length >= 2 && loc.length <= 100) {
            return loc;
          }
        }
      }

      // Look for semantic elements
      const locationElements = document.querySelectorAll('[itemprop="jobLocation"], [data-location], .location, [class*="location"]');
      for (const el of locationElements) {
        const text = el.textContent.trim();
        if (text.length >= 2 && text.length <= 100) {
          return text;
        }
      }

      return 'Not specified';
    });

    // Step 5: Extract skills/requirements
    const skills = await page.evaluate(() => {
      // Find all lists in the main content area
      const lists = Array.from(document.querySelectorAll('ul, ol'));
      const skillItems = [];

      // Navigation keywords to exclude
      const navKeywords = [
        'working at',
        'how to apply',
        'life in',
        'athletics',
        'business and finance',
        'human resources',
        'login',
        'sign in',
        'register',
        'home',
        'about',
        'contact',
        'careers',
        'jobs',
        'english',
        'language'
      ];

      for (const list of lists) {
        // Check position - skip if in top 200px (header/navigation area)
        const rect = list.getBoundingClientRect();
        if (rect.top < 200) continue;

        // Check if list is in navigation/footer
        let parent = list.parentElement;
        let inNavOrFooter = false;
        for (let i = 0; i < 5 && parent; i++) {
          const role = parent.getAttribute('role');
          const className = parent.className || '';
          if (parent.tagName === 'NAV' ||
              role === 'navigation' ||
              parent.tagName === 'FOOTER' ||
              className.includes('nav') ||
              className.includes('menu') ||
              className.includes('header')) {
            inNavOrFooter = true;
            break;
          }
          parent = parent.parentElement;
        }
        if (inNavOrFooter) continue;

        // Get list items
        const items = Array.from(list.querySelectorAll('li'));

        // Check if this looks like a navigation list (many short items)
        const shortItems = items.filter(item => item.textContent.trim().length < 30);
        if (shortItems.length > 5 && shortItems.length > items.length * 0.7) {
          continue; // Probably navigation
        }

        // Extract items
        for (const item of items) {
          const text = item.textContent.trim();

          // Skip if too short or too long
          if (text.length < 15 || text.length > 500) continue;

          // Skip if matches navigation keywords
          const lowerText = text.toLowerCase();
          if (navKeywords.some(kw => lowerText.includes(kw))) continue;

          // Skip if contains links (navigation item)
          const links = item.querySelectorAll('a');
          if (links.length > 0 && text.length < 50) continue;

          skillItems.push(text);
        }

        // If we found good items, we can stop (found the requirements section)
        if (skillItems.length > 3) break;
      }

      return skillItems;
    });

    return {
      title: title.trim(),
      description: descriptionText,
      location: location.trim(),
      skills
    };
  } catch (error) {
    return null;
  }
};

// Validate extracted content to ensure quality
const validateExtractedContent = (jobData) => {
  if (!jobData) {
    return { valid: false, reason: 'No data extracted' };
  }

  // Validate title
  const title = jobData.title || '';

  if (!title || title === 'N/A' || title.trim().length === 0) {
    return { valid: false, reason: 'Title is empty or N/A' };
  }

  if (title.length < 5) {
    return { valid: false, reason: 'Title too short (< 5 characters)' };
  }

  if (title.length > 300) {
    return { valid: false, reason: 'Title too long (> 300 characters)' };
  }

  // Check for error patterns in title
  const titleErrorPatterns = [
    /404/i,
    /not found/i,
    /error/i,
    /current openings/i,
    /open roles/i
  ];

  for (const pattern of titleErrorPatterns) {
    if (pattern.test(title)) {
      return { valid: false, reason: 'Title contains error message or page heading' };
    }
  }

  // Check if title is common page heading
  const commonPageHeadings = [
    'home',
    'careers',
    'jobs',
    'current openings',
    'open roles',
    'join us'
  ];

  if (commonPageHeadings.includes(title.toLowerCase())) {
    return { valid: false, reason: 'Title is a common page heading, not a job title' };
  }

  // Validate description
  const description = jobData.description || '';

  if (!description || description === 'No description found' || description.trim().length === 0) {
    return { valid: false, reason: 'Description is empty or placeholder' };
  }

  if (description.length < 200) {
    return { valid: false, reason: 'Description too short (< 200 characters)' };
  }

  // Check for 404 error text in description
  const descErrorPatterns = [
    /couldn't find/i,
    /page not found/i,
    /posting.*closed/i,
    /removed/i,
    /sorry.*nothing/i
  ];

  for (const pattern of descErrorPatterns) {
    if (pattern.test(description)) {
      return { valid: false, reason: 'Description contains 404 or error message' };
    }
  }

  // Check for job-related keywords (must have at least 2)
  const jobKeywords = [
    'experience',
    'responsibilities',
    'requirements',
    'qualifications',
    'skills',
    'role',
    'position'
  ];

  const lowerDesc = description.toLowerCase();
  const keywordCount = jobKeywords.filter(kw => lowerDesc.includes(kw)).length;

  if (keywordCount < 2) {
    return { valid: false, reason: 'Description does not contain enough job-related keywords' };
  }

  return { valid: true, reason: null };
};

const extractJobDetails = async (page, url) => {
  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: config.crawler.pageTimeout
    });

    // Wait longer for dynamic content to load (increased from 2000ms)
    await page.waitForTimeout(3000);

    const failureReasons = [];

    // Layer 1: Try structured data extraction
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
        console.log('[DEBUG] Structured data extracted but failed validation:', validation.reason);
        console.log('[DEBUG] Title:', structuredData.title?.substring(0, 50));
        console.log('[DEBUG] Description length:', structuredData.description?.length);
      }
    } else {
      failureReasons.push('No structured data found');
    }

    // Layer 2: Try intelligent analysis
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
  let structuredCount = 0;
  let intelligentCount = 0;
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

      // Track extraction method
      if (jobData.source === 'structured-data') structuredCount++;
      if (jobData.source === 'intelligent-analysis') intelligentCount++;

      log.info(`Extracted via ${jobData.source}`);
      log.info(`Saved: ${companyName}/${fileName} - "${jobData.title}"`);
    } catch (error) {
      // More detailed error logging
      if (error.message.includes('Failed to extract valid content')) {
        log.error(`Validation failed for ${url}: ${error.message}`);
      } else if (error.message.includes('Navigation') || error.message.includes('Timeout')) {
        log.error(`Navigation timeout for ${url}: ${error.message}`);
      } else {
        log.error(`Extraction failed for ${url}: ${error.message}`);
      }

      // Save failed URL to separate file for analysis
      const failedLogPath = path.join(jobsDir, 'failed_extractions.txt');
      fs.appendFileSync(failedLogPath, `${url}\t${error.message}\n`, 'utf-8');

      failedCount++;
    } finally {
      await page.close();
    }
  };

  await Promise.all(urlsToProcess.map((url, index) => limit(() => processJobURL(url, index))));

  await browser.close();

  log.success(`Stage 3 complete: ${successCount} jobs saved to ${jobsDir}`);
  log.info(`Summary - Total processed: ${urlsToProcess.length}, Successful: ${successCount}, Failed: ${failedCount}`);
  log.info(`Extraction methods - Structured Data: ${structuredCount}, Intelligent Analysis: ${intelligentCount}`);

  if (Object.keys(companyJobCounts).length > 0) {
    log.info('Jobs saved by company:');
    Object.entries(companyJobCounts).sort().forEach(([company, count]) => {
      log.info(`  ${company}: ${count} jobs`);
    });
  }
};

module.exports = runStage3;
