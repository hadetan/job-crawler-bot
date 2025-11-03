const fs = require('fs');
const path = require('path');

/**
 * Generate a random 6-digit numeric ID
 * @returns {string} 6-digit numeric ID
 */
const generateRequestId = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

/**
 * Setup request folder structure and initialize files
 * @param {string} outputDir - Base output directory
 * @param {string} requestId - Request ID for this run
 * @returns {object} Object containing paths to CSV and JSON files
 */
const setupJobBoardsFolder = (outputDir, requestId) => {
    const requestDir = path.join(outputDir, 'job_boards', requestId);
    const csvPath = path.join(requestDir, 'google-results.csv');
    const reportPath = path.join(requestDir, 'report.json');

    if (!fs.existsSync(requestDir)) {
        fs.mkdirSync(requestDir, { recursive: true });
    }

    if (!fs.existsSync(reportPath)) {
        const initialReport = {
            google_report: []
        };
        fs.writeFileSync(reportPath, JSON.stringify(initialReport, null, 2), 'utf-8');
    }

    if (!fs.existsSync(csvPath)) {
        const csvHeaders = 'URL,STATUS,JOB_COUNT,SNIPPET,LOGO_URL,REMARKS\n';
        fs.writeFileSync(csvPath, csvHeaders, 'utf-8');
    }

    return {
        requestDir,
        csvPath,
        reportPath
    };
};

/**
 * Load report.json for a given request ID
 * @param {string} reportPath - Path to report.json
 * @returns {object} Report object
 */
const loadReport = (reportPath) => {
    if (!fs.existsSync(reportPath)) {
        return { google_report: [] };
    }

    try {
        const content = fs.readFileSync(reportPath, 'utf-8');
        return JSON.parse(content);
    } catch (error) {
        return { google_report: [] };
    }
};

/**
 * Save report.json for a given request ID
 * @param {string} reportPath - Path to report.json
 * @param {object} report - Report object to save
 */
const saveReport = (reportPath, report) => {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
};

/**
 * Check if a request ID folder exists
 * @param {string} outputDir - Base output directory
 * @param {string} requestId - Request ID to check
 * @returns {boolean} True if folder exists
 */
const requestIdExists = (outputDir, requestId) => {
    const requestDir = path.join(outputDir, 'job_boards', requestId);
    return fs.existsSync(requestDir);
};


/**
 * Append rows to google-results.csv
 * @param {string} csvPath - Path to CSV file
 * @param {Array} rows - Array of row objects with URL, STATUS, JOB_COUNT, SNIPPET, LOGO_URL, REMARKS
*/
const appendToGoogleResultsCsv = (csvPath, rows) => {
    const escapeCsvField = (field) => {
        if (field === null || field === undefined) return '';
        const str = String(field);
        if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) return `"${str.replace(/"/g, '""')}"`;

        return str;
    };
    const csvLines = rows.map(row => {
        return [
            escapeCsvField(row.URL),
            escapeCsvField(row.STATUS),
            escapeCsvField(row.JOB_COUNT),
            escapeCsvField(row.SNIPPET),
            escapeCsvField(row.LOGO_URL),
            escapeCsvField(row.REMARKS)
        ].join(',');
    });

    fs.appendFileSync(csvPath, csvLines.join('\n') + '\n', 'utf-8');
};

/**
 * Read existing URLs from google-results.csv
 * @param {string} csvPath - Path to CSV file
 * @returns {Set} Set of normalized URLs already in CSV
 */
const getExistingUrlsFromCsv = (csvPath) => {
    if (!fs.existsSync(csvPath)) {
        return new Set();
    }

    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.split('\n').slice(1); // Skip header
    const urls = new Set();

    for (const line of lines) {
        if (!line.trim()) continue;

        let url = '';
        if (line.startsWith('"')) {
            const endQuote = line.indexOf('"', 1);
            url = line.substring(1, endQuote).replace(/""/g, '"');
        } else {
            const comma = line.indexOf(',');
            url = comma > -1 ? line.substring(0, comma) : line;
        }

        if (url) {
            urls.add(url);
        }
    }

    return urls;
};

/**
 * Setup job links folder structure for Stage 2 and initialize files
 * @param {string} outputDir - Base output directory
 * @param {string} jobId - Job ID for this Stage 2 run
 * @returns {object} Object containing paths to jobs CSV and report JSON
 */
const setupJobLinksFolder = (outputDir, jobId) => {
    const jobLinksDir = path.join(outputDir, 'job_links', jobId);
    const jobsCsvPath = path.join(jobLinksDir, 'jobs.csv');
    const reportPath = path.join(jobLinksDir, 'report.json');

    if (!fs.existsSync(jobLinksDir)) {
        fs.mkdirSync(jobLinksDir, { recursive: true });
    }

    if (!fs.existsSync(reportPath)) {
        const initialReport = {
            link_extraction_report: {}
        };
        fs.writeFileSync(reportPath, JSON.stringify(initialReport, null, 2), 'utf-8');
    }

    if (!fs.existsSync(jobsCsvPath)) {
        const csvHeaders = 'URL,STATUS,REMARKS,FILENAME\n';
        fs.writeFileSync(jobsCsvPath, csvHeaders, 'utf-8');
    }

    return {
        jobLinksDir,
        jobsCsvPath,
        reportPath
    };
};

/**
 * Check if a job ID folder exists
 * @param {string} outputDir - Base output directory
 * @param {string} jobId - Job ID to check
 * @returns {boolean} True if folder exists
 */
const jobIdExists = (outputDir, jobId) => {
    const jobLinksDir = path.join(outputDir, 'job_links', jobId);
    return fs.existsSync(jobLinksDir);
};

module.exports = {
    generateRequestId,
    setupJobBoardsFolder,
    loadReport,
    saveReport,
    requestIdExists,
    appendToGoogleResultsCsv,
    getExistingUrlsFromCsv,
    setupJobLinksFolder,
    jobIdExists
};
