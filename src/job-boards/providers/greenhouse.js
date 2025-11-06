const { extractJobLinks } = require('../../utils/job-links');
const extractJobDetails = require('../../utils/extract-job-details');

const GREENHOUSE_HOSTS = [
    'greenhouse.io',
    'job-boards.greenhouse.io',
    'boards.greenhouse.io'
];

const GREENHOUSE_PROVIDER_ID = 'greenhouse';

const hasGreenhouseHost = (hostname) => {
    if (!hostname) {
        return false;
    }

    const value = hostname.toLowerCase();
    return GREENHOUSE_HOSTS.some((host) => value === host || value.endsWith(`.${host}`));
};

const matchesUrl = (url) => {
    if (!url) {
        return false;
    }

    try {
        const parsed = new URL(url);
        if (hasGreenhouseHost(parsed.hostname)) {
            return true;
        }

        if (parsed.searchParams.has('gh_jid')) {
            return true;
        }

        return parsed.pathname.includes('/greenhouse');
    } catch (_) {
        return url.toLowerCase().includes('greenhouse');
    }
};

const normalizeJobUrl = (url) => {
    if (!url) {
        return url;
    }

    try {
        const parsed = new URL(url);
        if (!hasGreenhouseHost(parsed.hostname)) {
            return url;
        }

        parsed.searchParams.delete('gh_src');
        parsed.searchParams.delete('utm_source');
        parsed.searchParams.delete('utm_medium');
        parsed.searchParams.delete('utm_campaign');
        parsed.hash = '';

        return parsed.toString();
    } catch (_) {
        return url;
    }
};

const collectJobLinks = async ({ page, url }) => {
    const jobUrls = await extractJobLinks(page, url);

    return {
        providerId: GREENHOUSE_PROVIDER_ID,
        jobUrls: jobUrls.map(normalizeJobUrl),
        strategy: 'greenhouse-extractor'
    };
};

const fetchJobDetail = async ({ page, url }) => {
    const result = await extractJobDetails(page, url);
    return result;
};

module.exports = {
    id: GREENHOUSE_PROVIDER_ID,
    matchesUrl,
    normalizeJobUrl,
    collectJobLinks,
    fetchJobDetail
};
