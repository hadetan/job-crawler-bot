const fs = require('fs');
const path = require('path');
const { DEFAULT_PROVIDER_ID } = require('../job-boards');

const escapeCsvField = (field) => {
    if (field === null || field === undefined) return '';
    const str = String(field);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
};

const formatCsvLine = (fields) => fields.map(escapeCsvField).join(',');

const JOBS_CSV_HEADER = ['URL', 'PROVIDER', 'STATUS', 'REMARKS', 'FILENAME', 'DETAIL_STRATEGY', 'RETRY'];
const JOBS_CSV_HEADER_LINE = JOBS_CSV_HEADER.join(',');
const ensureJobsCsvHasProviderColumn = (csvPath) => {
    if (!fs.existsSync(csvPath)) {
        return false;
    }

    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.split('\n');
    if (lines.length === 0 || !lines[0]) {
        return false;
    }

    const headerFields = parseCSVLine(lines[0]);
    const normalizedHeader = headerFields.map(field => field.trim().toUpperCase());
    const headerMap = normalizedHeader.reduce((acc, field, index) => {
        acc[field] = index;
        return acc;
    }, {});

    const needsRewrite = JOBS_CSV_HEADER.some(column => !(column in headerMap));

    if (!needsRewrite && headerFields.length === JOBS_CSV_HEADER.length) {
        return false;
    }

    const upgradedLines = [];

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line || !line.trim()) {
            continue;
        }

        const fields = parseCSVLine(line);
        const upgraded = [
            fields[headerMap.URL] || '',
            fields[headerMap.PROVIDER] || '',
            fields[headerMap.STATUS] || '',
            fields[headerMap.REMARKS] || '',
            fields[headerMap.FILENAME] || '',
            fields[headerMap.DETAIL_STRATEGY] || '',
            fields[headerMap.RETRY] || ''
        ];

        upgradedLines.push(formatCsvLine(upgraded));
    }

    const body = upgradedLines.length ? `${upgradedLines.join('\n')}\n` : '';
    fs.writeFileSync(csvPath, `${JOBS_CSV_HEADER_LINE}\n${body}`, 'utf-8');
    return true;
};

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
    const csvPath = path.join(requestDir, 'search-results.csv');
    const reportPath = path.join(requestDir, 'report.json');

    if (!fs.existsSync(requestDir)) {
        fs.mkdirSync(requestDir, { recursive: true });
    }

    if (!fs.existsSync(reportPath)) {
        const initialReport = {
            google_report: [],
            serp_report: {}
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
 * Load report.json for Stage 1
 * @param {string} reportPath - Path to report.json
 * @returns {object} Report object
 */
const loadReport = (reportPath) => {
    if (!fs.existsSync(reportPath)) {
        return { google_report: [], serp_report: {} };
    }

    try {
        const content = fs.readFileSync(reportPath, 'utf-8');
        const report = JSON.parse(content);

        if (!report.google_report) report.google_report = [];

        if (!report.serp_report) {
            report.serp_report = {};
        } else if (Array.isArray(report.serp_report)) {
            report.serp_report = {
                google: report.serp_report
            };
        }

        return report;
    } catch (error) {
        return { google_report: [], serp_report: {} };
    }
};

/**
 * Load report.json for Stage 2
 * @param {string} reportPath - Path to report.json
 * @returns {object} Report object
 */
const loadLinkReport = (reportPath) => {
    if (!fs.existsSync(reportPath)) {
        return { link_extraction_report: {} };
    }

    try {
        const content = fs.readFileSync(reportPath, 'utf-8');
        const report = JSON.parse(content);

        if (!report.link_extraction_report) {
            report.link_extraction_report = {};
        }

        return report;
    } catch (error) {
        return { link_extraction_report: {} };
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
 * Save report.json for Stage 2 - only saves link_extraction_report
 * @param {string} reportPath - Path to report.json
 * @param {object} report - Report object to save
 */
const saveLinkReport = (reportPath, report) => {
    const cleanReport = {
        link_extraction_report: report.link_extraction_report || {}
    };
    fs.writeFileSync(reportPath, JSON.stringify(cleanReport, null, 2), 'utf-8');
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
 * Append rows to search-results.csv
 * @param {string} csvPath - Path to CSV file
 * @param {Array} rows - Array of row objects with URL, STATUS, JOB_COUNT, SNIPPET, LOGO_URL, REMARKS
*/
const appendToGoogleResultsCsv = (csvPath, rows) => {
    const csvLines = rows.map(row => formatCsvLine([
        row.URL,
        row.STATUS,
        row.JOB_COUNT,
        row.SNIPPET,
        row.LOGO_URL,
        row.REMARKS
    ]));

    fs.appendFileSync(csvPath, csvLines.join('\n') + '\n', 'utf-8');
};

/**
 * Read existing URLs from search-results.csv
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
        fs.writeFileSync(jobsCsvPath, `${JOBS_CSV_HEADER_LINE}\n`, 'utf-8');
    } else {
        ensureJobsCsvHasProviderColumn(jobsCsvPath);
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

/**
 * Parse CSV field (handles quoted fields with commas and escaped quotes)
 * @param {string} line - CSV line to parse
 * @returns {Array<string>} Array of field values
 */
function parseCSVLine(line) {
    const sanitizedLine = line.endsWith('\r') ? line.slice(0, -1) : line;
    const fields = [];
    let currentField = '';
    let inQuotes = false;

    for (let i = 0; i < sanitizedLine.length; i++) {
        const char = sanitizedLine[i];
        const nextChar = sanitizedLine[i + 1];

        if (char === '"') {
            if (inQuotes && nextChar === '"') {
                currentField += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            fields.push(currentField);
            currentField = '';
        } else {
            currentField += char;
        }
    }

    fields.push(currentField);

    return fields;
}

/**
 * Read search-results.csv and return array of row objects
 * @param {string} csvPath - Path to search-results.csv
 * @returns {Array<Object>} Array of row objects with URL, STATUS, JOB_COUNT, SNIPPET, LOGO_URL, REMARKS
 */
const readGoogleResultsCsv = (csvPath) => {
    if (!fs.existsSync(csvPath)) {
        return [];
    }

    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.split('\n');

    if (lines.length < 2) {
        return [];
    }

    const rows = [];

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const fields = parseCSVLine(line);

        if (fields.length >= 6) {
            rows.push({
                URL: fields[0],
                STATUS: fields[1],
                JOB_COUNT: fields[2],
                SNIPPET: fields[3],
                LOGO_URL: fields[4],
                REMARKS: fields[5]
            });
        }
    }

    return rows;
};

/**
 * Write entire search-results.csv file (replaces existing)
 * @param {string} csvPath - Path to search-results.csv
 * @param {Array<Object>} rows - Array of row objects with URL, STATUS, JOB_COUNT, SNIPPET, LOGO_URL, REMARKS
 */
const writeGoogleResultsCsv = (csvPath, rows) => {
    const header = 'URL,STATUS,JOB_COUNT,SNIPPET,LOGO_URL,REMARKS\n';
    const csvLines = rows.map(row => formatCsvLine([
        row.URL,
        row.STATUS,
        row.JOB_COUNT,
        row.SNIPPET,
        row.LOGO_URL,
        row.REMARKS
    ]));

    const body = csvLines.length ? `${csvLines.join('\n')}\n` : '';
    fs.writeFileSync(csvPath, header + body, 'utf-8');
};

/**
 * Read existing job URLs from jobs.csv
 * @param {string} csvPath - Path to jobs.csv
 * @returns {Set<string>} Set of job URLs
 */
const getExistingJobUrls = (csvPath) => {
    if (!fs.existsSync(csvPath)) {
        return new Set();
    }

    ensureJobsCsvHasProviderColumn(csvPath);

    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.split('\n').slice(1);
    const urls = new Set();

    for (const line of lines) {
        if (!line.trim()) continue;

        const fields = parseCSVLine(line);
        if (fields.length > 0 && fields[0]) {
            urls.add(fields[0]);
        }
    }

    return urls;
};

/**
 * Append job links to jobs.csv
 * @param {string} csvPath - Path to jobs.csv
 * @param {Array<string|{url: string, providerId?: string}>} jobEntries - Links or objects to append
 * @param {string} [defaultProviderId]
 */
const appendToJobsCsv = (csvPath, jobEntries, defaultProviderId = DEFAULT_PROVIDER_ID) => {
    if (!fs.existsSync(csvPath)) {
        fs.writeFileSync(csvPath, `${JOBS_CSV_HEADER_LINE}\n`, 'utf-8');
    }

    ensureJobsCsvHasProviderColumn(csvPath);

    const entriesArray = Array.isArray(jobEntries) ? jobEntries : [jobEntries];
    const csvLines = entriesArray
        .map((entry) => {
            if (!entry && entry !== 0) return null;

            let url = entry;
            let providerId = defaultProviderId;
            let detailStrategy = '';

            if (typeof entry === 'object') {
                url = entry.url || entry.URL || entry.href || '';
                providerId = entry.providerId || entry.provider || entry.PROVIDER || defaultProviderId;
                detailStrategy = entry.detailStrategy || entry.DETAIL_STRATEGY || '';
            }

            if (!url) {
                return null;
            }

            return formatCsvLine([
                url,
                providerId || defaultProviderId,
                'pending',
                '',
                '',
                detailStrategy || '',
                '0'
            ]);
        })
        .filter(Boolean);

    if (csvLines.length > 0) {
        fs.appendFileSync(csvPath, csvLines.join('\n') + '\n', 'utf-8');
    }
};

/**
 * Read jobs.csv and return array of job objects
 * @param {string} csvPath - Path to jobs.csv
 * @returns {Array<Object>} Array of job objects with URL, PROVIDER, STATUS, REMARKS, FILENAME, RETRY
 */
const readJobsCsv = (csvPath) => {
    if (!fs.existsSync(csvPath)) {
        return [];
    }

    ensureJobsCsvHasProviderColumn(csvPath);

    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.split('\n');

    if (lines.length < 1) {
        return [];
    }

    const headerFields = parseCSVLine(lines[0]);
    const headerMap = headerFields.reduce((acc, field, index) => {
        acc[field.trim().toUpperCase()] = index;
        return acc;
    }, {});

    const jobs = [];

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const fields = parseCSVLine(line);

        const job = {
            URL: fields[headerMap.URL] || '',
            PROVIDER: fields[headerMap.PROVIDER] || DEFAULT_PROVIDER_ID,
            STATUS: fields[headerMap.STATUS] || '',
            REMARKS: fields[headerMap.REMARKS] || '',
            FILENAME: fields[headerMap.FILENAME] || '',
            DETAIL_STRATEGY: fields[headerMap.DETAIL_STRATEGY] || '',
            RETRY: fields[headerMap.RETRY] || ''
        };

        if (job.URL) {
            jobs.push(job);
        }
    }

    return jobs;
};

/**
 * Write entire jobs.csv file (replaces existing)
 * @param {string} csvPath - Path to jobs.csv
 * @param {Array<Object>} jobs - Array of job objects with URL, PROVIDER, STATUS, REMARKS, FILENAME, RETRY
 */
const writeJobsCsv = (csvPath, jobs) => {
    const csvLines = jobs.map(job => formatCsvLine([
        job.URL,
        job.PROVIDER || DEFAULT_PROVIDER_ID,
        job.STATUS,
        job.REMARKS,
        job.FILENAME,
        job.DETAIL_STRATEGY || '',
        job.RETRY
    ]));

    const body = csvLines.length ? `${csvLines.join('\n')}\n` : '';
    fs.writeFileSync(csvPath, `${JOBS_CSV_HEADER_LINE}\n${body}`, 'utf-8');
};

/**
 * Update a single job's status in jobs.csv
 * @param {string} csvPath - Path to jobs.csv
 * @param {string} url - Job URL to update
 * @param {string} status - New status (pending/done/failed)
 * @param {string} remarks - Remarks/error message
 * @param {string} filename - Filename where job was saved (e.g., "elixirr/1.txt")
 * @param {string|number} retry - Retry count
 */
const updateJobStatus = (csvPath, url, status, remarks, filename, retry, detailStrategy) => {
    const jobs = readJobsCsv(csvPath);

    const jobIndex = jobs.findIndex(job => job.URL === url);
    if (jobIndex !== -1) {
        jobs[jobIndex].STATUS = status;
        jobs[jobIndex].REMARKS = remarks;
        jobs[jobIndex].FILENAME = filename;
        jobs[jobIndex].RETRY = String(retry);
        if (detailStrategy !== undefined) {
            jobs[jobIndex].DETAIL_STRATEGY = detailStrategy;
        }
    }

    writeJobsCsv(csvPath, jobs);
};

/**
 * Load detail extraction report.json for Stage 3
 * @param {string} reportPath - Path to report.json
 * @returns {object} Report object
 */
const loadDetailReport = (reportPath) => {
    if (!fs.existsSync(reportPath)) {
        return { detail_extraction_report: {} };
    }

    try {
        const content = fs.readFileSync(reportPath, 'utf-8');
        const report = JSON.parse(content);

        if (!report.detail_extraction_report) {
            report.detail_extraction_report = {};
        }

        return report;
    } catch (error) {
        return { detail_extraction_report: {} };
    }
};

/**
 * Save detail extraction report.json for Stage 3 - only saves detail_extraction_report
 * @param {string} reportPath - Path to report.json
 * @param {object} report - Report object to save
 */
const saveDetailReport = (reportPath, report) => {
    const cleanReport = {
        detail_extraction_report: report.detail_extraction_report || {}
    };
    fs.writeFileSync(reportPath, JSON.stringify(cleanReport, null, 2), 'utf-8');
};

/**
 * Setup jobs folder structure for Stage 3 and initialize files
 * @param {string} outputDir - Base output directory
 * @param {string} extractionId - Extraction ID for this Stage 3 run
 * @returns {object} Object containing paths to jobs directory and report JSON
 */
const setupJobsFolder = (outputDir, extractionId) => {
    const jobsDir = path.join(outputDir, 'jobs', extractionId);
    const reportPath = path.join(jobsDir, 'report.json');

    if (!fs.existsSync(jobsDir)) {
        fs.mkdirSync(jobsDir, { recursive: true });
    }

    if (!fs.existsSync(reportPath)) {
        const initialReport = {
            detail_extraction_report: {}
        };
        fs.writeFileSync(reportPath, JSON.stringify(initialReport, null, 2), 'utf-8');
    }

    return {
        jobsDir,
        reportPath
    };
};

module.exports = {
    generateRequestId,
    setupJobBoardsFolder,
    loadReport,
    loadLinkReport,
    saveReport,
    saveLinkReport,
    requestIdExists,
    appendToGoogleResultsCsv,
    getExistingUrlsFromCsv,
    setupJobLinksFolder,
    jobIdExists,
    readGoogleResultsCsv,
    writeGoogleResultsCsv,
    getExistingJobUrls,
    appendToJobsCsv,
    readJobsCsv,
    writeJobsCsv,
    updateJobStatus,
    setupJobsFolder,
    loadDetailReport,
    saveDetailReport
};
