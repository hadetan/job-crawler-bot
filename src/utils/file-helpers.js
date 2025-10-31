const fs = require('fs');
const path = require('path');
const { normalizeURL } = require('./csv-handler');

/**
 * Extract company name from job posting URL
 * @param {string} url - The job posting URL
 * @returns {string} Company name or 'unknown'
 */
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

/**
 * Get set of already processed job URLs
 * @param {string} jobsDir - Directory where jobs are stored
 * @returns {Set<string>} Set of normalized processed URLs
 */
const getProcessedJobs = (jobsDir) => {
    const trackingFile = path.join(jobsDir, '.processed_urls.txt');
    if (!fs.existsSync(trackingFile)) {
        return new Set();
    }
    const content = fs.readFileSync(trackingFile, 'utf-8');
    return new Set(content.split('\n').filter(Boolean).map(normalizeURL));
};

/**
 * Mark a job URL as processed
 * @param {string} jobsDir - Directory where jobs are stored
 * @param {string} url - URL to mark as processed
 */
const markJobAsProcessed = (jobsDir, url) => {
    const trackingFile = path.join(jobsDir, '.processed_urls.txt');
    fs.appendFileSync(trackingFile, url + '\n', 'utf-8');
};

/**
 * Get the next available job number for a company directory
 * @param {string} companyDir - Company-specific directory
 * @returns {number} Next available job number
 */
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

module.exports = {
    extractCompanyName,
    getProcessedJobs,
    markJobAsProcessed,
    getNextJobNumber
};
