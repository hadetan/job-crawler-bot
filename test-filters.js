/**
 * Test script to verify URL filtering logic
 * Tests extractJobId() and isJobDetailPage() with problematic URLs from user's query
 */

// Import the functions we need to test
const { normalizeURL } = require('./src/utils/csv-handler');

// Copy the extractJobId function (since it's not exported)
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

// Copy isJobDetailPage function (since it's not exported)
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

console.log('\n=== Testing URL Filtering Logic ===\n');

// Test cases from user's problematic output
const testCases = [
  // Should PASS (valid job detail pages with job IDs)
  { url: 'https://careers.roblox.com/jobs/7179133', shouldPass: true, type: 'Job detail with ID at end' },
  { url: 'https://stripe.com/us/jobs/listing/software-engineering-new-grad/7176975', shouldPass: true, type: 'Job detail with locale and ID' },
  { url: 'https://www.betterment.com/careers/current-openings/job?gh_jid=7220394', shouldPass: true, type: 'Job detail with query param ID' },
  { url: 'https://asana.com/jobs/apply/7106554', shouldPass: true, type: 'Job detail with ID in path' },

  // Should FAIL (non-job pages without job IDs)
  { url: 'https://stripe.com/jobs/life-at-stripe', shouldPass: false, type: 'Generic life-at page' },
  { url: 'https://stripe.com/jobs/benefits', shouldPass: false, type: 'Generic benefits page' },
  { url: 'https://www.pinterestcareers.com/jobs/saved-jobs/', shouldPass: false, type: 'Saved jobs feature page' },
  { url: 'https://www.databricks.com/company/careers/culture', shouldPass: false, type: 'Generic culture page' },
  { url: 'https://www.databricks.com/company/careers/benefits', shouldPass: false, type: 'Generic benefits page' },
  { url: 'https://www.samsara.com/company/careers/locations', shouldPass: false, type: 'Generic locations page' },
];

let passed = 0;
let failed = 0;

console.log('TEST 1: extractJobId() function\n');
testCases.forEach(test => {
  const jobId = extractJobId(test.url);
  const expectedResult = test.shouldPass ? 'should extract job ID' : 'should return null';
  const actualResult = jobId ? `extracted: ${jobId}` : 'returned null';
  const status = test.shouldPass ? (jobId !== null) : (jobId === null);

  console.log(`${status ? '✓' : '✗'} ${test.type}`);
  console.log(`  URL: ${test.url}`);
  console.log(`  Expected: ${expectedResult}, Actual: ${actualResult}\n`);

  if (status) passed++;
  else failed++;
});

console.log('\nTEST 2: isJobDetailPage() function\n');
testCases.forEach(test => {
  const result = isJobDetailPage(test.url);
  const expectedResult = test.shouldPass ? 'should pass' : 'should fail';
  const actualResult = result ? 'passed' : 'failed';
  const status = result === test.shouldPass;

  console.log(`${status ? '✓' : '✗'} ${test.type}`);
  console.log(`  URL: ${test.url}`);
  console.log(`  Expected: ${expectedResult}, Actual: ${actualResult}\n`);

  if (status) passed++;
  else failed++;
});

console.log('\nTEST 3: normalizeURL() deduplication\n');

// Test deduplication of locale variants (same job ID)
const localeVariants = [
  'https://stripe.com/us/jobs/listing/software-engineering-new-grad/7176975',
  'https://stripe.com/gb/jobs/listing/software-engineering-new-grad/7176975',
  'https://stripe.com/au/jobs/listing/software-engineering-new-grad/7176975',
  'https://stripe.com/en-at/jobs/listing/software-engineering-new-grad/7176975',
];

console.log('Testing locale variant deduplication (should all normalize to same ID):');
const normalizedIds = localeVariants.map(url => normalizeURL(url));
const allSame = normalizedIds.every(id => id === normalizedIds[0]);

localeVariants.forEach((url, i) => {
  console.log(`  ${url} → ${normalizedIds[i]}`);
});

console.log(`\n${allSame ? '✓' : '✗'} All locale variants normalize to same ID: ${normalizedIds[0]}`);
if (allSame) passed++;
else failed++;

// Test different job IDs normalize differently
const differentJobs = [
  'https://stripe.com/us/jobs/listing/software-engineering-new-grad/7176975',
  'https://stripe.com/us/jobs/listing/software-engineer-production-engineering/7182617',
];

console.log('\nTesting different job IDs (should normalize to different IDs):');
const differentNormalized = differentJobs.map(url => normalizeURL(url));
const areDifferent = differentNormalized[0] !== differentNormalized[1];

differentJobs.forEach((url, i) => {
  console.log(`  ${url} → ${differentNormalized[i]}`);
});

console.log(`\n${areDifferent ? '✓' : '✗'} Different jobs normalize to different IDs`);
if (areDifferent) passed++;
else failed++;

console.log('\n=== Test Results ===');
console.log(`Total: ${passed + failed} tests`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Success rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%\n`);

if (failed === 0) {
  console.log('✓ All tests passed! Filtering logic is working correctly.\n');
  process.exit(0);
} else {
  console.log('✗ Some tests failed. Please review the filtering logic.\n');
  process.exit(1);
}
