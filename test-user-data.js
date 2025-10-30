/**
 * Test script using actual user's problematic URLs
 * Demonstrates the fix working with real-world data
 */

const { normalizeURL } = require('./src/utils/csv-handler');

// Extract job ID function (copy from stage2-links.js)
const extractJobId = (url) => {
  if (!url) return null;
  try {
    const matches = url.match(/\d{4,}/g);
    if (!matches || matches.length === 0) {
      return null;
    }
    const longestMatch = matches.reduce((longest, current) => {
      if (current.length > longest.length) {
        return current;
      } else if (current.length === longest.length) {
        return current;
      }
      return longest;
    });
    return longestMatch;
  } catch {
    return null;
  }
};

// Check if URL is a job detail page (copy from stage2-links.js)
const isJobDetailPage = (url) => {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname.toLowerCase();
    const search = urlObj.search.toLowerCase();

    const excludePatterns = [
      /\/careers\/?$/,
      /\/jobs\/?$/,
      /\/career\/?$/,
      /\/(faqs?|about|team|benefits|culture|life|perks|diversity|contact|early-careers)[\/?]/,
      /life-as/,
      /our-entrepreneurs/,
      /episodes\//,
      /#job-board/,
      /open-positions\/?$/,
      /\/[a-z]{2}\/.*careers\/?$/,
      /\/apply\/?$/,
      /\/(search|all|university)\/?$/,
      /\/departments?\/?$/,
      /\/(chicago|dublin|tokyo|london|munich|new-york|san-francisco|paris|reykjavik|sydney|singapore|vancouver|warsaw|nyc|sf|la|boston|seattle|austin|denver|atlanta|miami|dallas|houston|phoenix|portland|philadelphia|berlin|amsterdam|barcelona|madrid|rome|milan|stockholm|oslo|copenhagen|helsinki|zurich|vienna|brussels|lisbon|prague|budapest|toronto|montreal|melbourne|bangalore|mumbai|delhi|shanghai|beijing|hong-kong|seoul|taipei)\/?$/i,
      /\/(business|engineering|product|internal|design|marketing|sales|support|operations|finance|legal|data|security|infrastructure|research|university-recruiting|internship)\/?$/i
    ];

    for (const pattern of excludePatterns) {
      if (pattern.test(pathname) || pattern.test(search)) {
        return false;
      }
    }

    const jobId = extractJobId(url);
    return jobId !== null;
  } catch {
    return false;
  }
};

// User's actual problematic URLs from the CSV
const userUrls = [
  'https://careers.roblox.com/jobs/7179133',
  'https://careers.roblox.com/jobs/7059504',
  'https://careers.roblox.com/jobs/6683296',
  'https://stripe.com/jobs/life-at-stripe',  // Should be FILTERED
  'https://stripe.com/jobs/benefits',  // Should be FILTERED
  'https://stripe.com/au/jobs/listing/software-engineering-new-grad/7176975',
  'https://stripe.com/at/jobs/listing/software-engineering-new-grad/7176975',  // DUPLICATE
  'https://stripe.com/en-at/jobs/listing/software-engineering-new-grad/7176975',  // DUPLICATE
  'https://stripe.com/en-be/jobs/listing/software-engineering-new-grad/7176975',  // DUPLICATE
  'https://stripe.com/br/jobs/listing/software-engineering-new-grad/7176975',  // DUPLICATE
  'https://stripe.com/us/jobs/listing/software-engineering-new-grad/7176975',  // DUPLICATE
  'https://stripe.com/gb/jobs/listing/software-engineering-new-grad/7176975',  // DUPLICATE
  'https://asana.com/jobs/apply/7106554',
  'https://www.databricks.com/company/careers/culture',  // Should be FILTERED
  'https://www.databricks.com/company/careers/benefits',  // Should be FILTERED
  'https://www.pinterestcareers.com/jobs/saved-jobs/',  // Should be FILTERED
  'https://careers.roblox.com/jobs/7079505',
  'https://careers.upstart.com/jobs/director-assistant-general-counsel-commercial',  // No numeric ID, should be FILTERED
  'https://www.betterment.com/careers/current-openings/job?gh_jid=7220394',
  'https://stripe.com/au/jobs/listing/software-engineer-production-engineering/7182617',
  'https://stripe.com/us/jobs/listing/software-engineer-production-engineering/7182617',  // DUPLICATE
  'https://stripe.com/gb/jobs/listing/software-engineer-production-engineering/7182617',  // DUPLICATE
  'https://www.samsara.com/company/careers/locations',  // Should be FILTERED
  'https://www.samsara.com/company/careers/benefits',  // Should be FILTERED
];

console.log('\n=== Processing User\'s Problematic URLs ===\n');
console.log(`Total URLs in input: ${userUrls.length}\n`);

// Step 1: Filter through isJobDetailPage
console.log('STEP 1: Filtering with isJobDetailPage()...\n');
const validJobPages = userUrls.filter(url => {
  const isValid = isJobDetailPage(url);
  if (!isValid) {
    console.log(`  ✗ FILTERED OUT: ${url}`);
    console.log(`    Reason: ${extractJobId(url) === null ? 'No 4+ digit job ID found' : 'Excluded by pattern'}\n`);
  }
  return isValid;
});

console.log(`\nURLs after filtering: ${validJobPages.length}\n`);

// Step 2: Deduplicate using normalizeURL
console.log('STEP 2: Deduplicating by job ID...\n');
const deduplicationMap = new Map();
const duplicates = [];

validJobPages.forEach(url => {
  const normalized = normalizeURL(url);
  if (deduplicationMap.has(normalized)) {
    console.log(`  ✗ DUPLICATE REMOVED: ${url}`);
    console.log(`    Job ID: ${normalized}, First seen: ${deduplicationMap.get(normalized)}\n`);
    duplicates.push(url);
  } else {
    deduplicationMap.set(normalized, url);
    console.log(`  ✓ KEPT: ${url}`);
    console.log(`    Job ID: ${normalized}\n`);
  }
});

const finalUrls = Array.from(deduplicationMap.values());

console.log('\n=== RESULTS ===\n');
console.log(`Original URLs: ${userUrls.length}`);
console.log(`After isJobDetailPage filter: ${validJobPages.length}`);
console.log(`After deduplication: ${finalUrls.length}`);
console.log(`\nFiltered out (non-job pages): ${userUrls.length - validJobPages.length}`);
console.log(`Duplicates removed: ${duplicates.length}`);
console.log(`\nFinal unique job URLs: ${finalUrls.length}\n`);

console.log('=== FINAL OUTPUT ===\n');
finalUrls.forEach((url, i) => {
  console.log(`${i + 1}. ${url} (Job ID: ${normalizeURL(url)})`);
});

console.log('\n=== VERIFICATION ===\n');

// Verify no non-job pages in output
const hasNonJobPages = finalUrls.some(url => !isJobDetailPage(url));
console.log(`${hasNonJobPages ? '✗' : '✓'} No non-job pages in output`);

// Verify all have job IDs
const allHaveJobIds = finalUrls.every(url => extractJobId(url) !== null);
console.log(`${allHaveJobIds ? '✓' : '✗'} All URLs contain 4+ digit job IDs`);

// Verify no duplicates
const jobIds = finalUrls.map(url => normalizeURL(url));
const uniqueJobIds = new Set(jobIds);
const noDuplicates = jobIds.length === uniqueJobIds.size;
console.log(`${noDuplicates ? '✓' : '✗'} No duplicate job IDs`);

// Check specific problematic patterns are filtered
const problemUrls = [
  'https://stripe.com/jobs/life-at-stripe',
  'https://stripe.com/jobs/benefits',
  'https://www.pinterestcareers.com/jobs/saved-jobs/',
  'https://www.databricks.com/company/careers/culture',
];
const problemsFiltered = problemUrls.every(url => !finalUrls.includes(url));
console.log(`${problemsFiltered ? '✓' : '✗'} Problem URLs (benefits, culture, etc.) filtered out`);

// Check Stripe job 7176975 appears only once
const stripe7176975Count = finalUrls.filter(url => url.includes('7176975')).length;
console.log(`${stripe7176975Count === 1 ? '✓' : '✗'} Stripe job 7176975 appears only once (found ${stripe7176975Count} times)`);

console.log('\n');

if (hasNonJobPages || !allHaveJobIds || !noDuplicates || !problemsFiltered || stripe7176975Count !== 1) {
  console.log('✗ Some verification checks failed!\n');
  process.exit(1);
} else {
  console.log('✓ All verification checks passed! Fix is working correctly.\n');
  process.exit(0);
}
