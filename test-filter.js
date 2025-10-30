const isJobDetailPage = (url) => {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname.toLowerCase();
    const search = urlObj.search.toLowerCase();

    // Exclude generic pages (careers home, listings, FAQ, etc.)
    const excludePatterns = [
      /\/careers\/?$/,
      /\/jobs\/?$/,
      /\/career\/?$/,
      /\/(faq|about|team|benefits|culture|life|perks|diversity|contact)[\/?]/,
      /#job-board/,
      /open-positions\/?$/,
      /\/[a-z]{2}\/.*careers\/?$/
    ];

    for (const pattern of excludePatterns) {
      if (pattern.test(pathname) || pattern.test(search)) {
        return false;
      }
    }

    const hasJobId = /\d{7,}/.test(pathname + search) ||
                     /gh_jid=/.test(search) ||
                     /\/jobs?\/[a-zA-Z0-9-]+/.test(pathname) ||
                     /job[-_]?id=/i.test(search);

    const pathSegments = pathname.split('/').filter(Boolean);
    const isDeepPath = pathSegments.length >= 3;

    return hasJobId || isDeepPath;
  } catch {
    return false;
  }
};

// Test URLs from the previous output
const testURLs = [
  'https://matic.com/careers/',
  'https://bigid.com/company/careers/',
  'https://bigid.com/company/careers/#job-board',
  'https://bigid.com/company/careers/job-details/?gh_jid=8138428002',
  'https://bigid.com/pt/company/careers/',
  'https://auterion.com/company/careers/faq/',
  'https://www.brightcove.com/company/careers/',
  'https://www.eyecarecenter.com/careers/charlotte+nc/comprehensive+ophthalmologist+charlotte+nc-eyecarecenter-7501934002?gh_jid=7501934002',
  'https://boards.greenhouse.io/bigid/jobs/8138428002'
];

console.log('Testing URL filter:\n');
testURLs.forEach(url => {
  const result = isJobDetailPage(url);
  console.log(`${result ? '✓' : '✗'} ${url}`);
});
