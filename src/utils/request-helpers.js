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

/**
 * Parse CSV field (handles quoted fields with commas and escaped quotes)
 * @param {string} line - CSV line to parse
 * @returns {Array<string>} Array of field values
 */
const parseCSVLine = (line) => {
    const fields = [];
    let currentField = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        const nextChar = line[i + 1];

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
};

/**
 * Read google-results.csv and return array of row objects
 * @param {string} csvPath - Path to google-results.csv
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
 * Write entire google-results.csv file (replaces existing)
 * @param {string} csvPath - Path to google-results.csv
 * @param {Array<Object>} rows - Array of row objects with URL, STATUS, JOB_COUNT, SNIPPET, LOGO_URL, REMARKS
 */
const writeGoogleResultsCsv = (csvPath, rows) => {
    const escapeCsvField = (field) => {
        if (field === null || field === undefined) return '';
        const str = String(field);
        if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    };

    const header = 'URL,STATUS,JOB_COUNT,SNIPPET,LOGO_URL,REMARKS\n';
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

    fs.writeFileSync(csvPath, header + csvLines.join('\n') + '\n', 'utf-8');
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
 * @param {Array<string>} jobUrls - Array of job URLs to append
 */
const appendToJobsCsv = (csvPath, jobUrls) => {
    const escapeCsvField = (field) => {
        if (field === null || field === undefined) return '';
        const str = String(field);
        if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    };

    const csvLines = jobUrls.map(url => {
        return [
            escapeCsvField(url),
            'pending',
            '',
            ''
        ].join(',');
    });

    fs.appendFileSync(csvPath, csvLines.join('\n') + '\n', 'utf-8');
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
    jobIdExists,
    readGoogleResultsCsv,
    writeGoogleResultsCsv,
    getExistingJobUrls,
    appendToJobsCsv
};
