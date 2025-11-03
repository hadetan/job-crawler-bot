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
const setupRequestFolder = (outputDir, requestId) => {
    const requestDir = path.join(outputDir, requestId);
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
    const requestDir = path.join(outputDir, requestId);
    return fs.existsSync(requestDir);
};

module.exports = {
    generateRequestId,
    setupRequestFolder,
    loadReport,
    saveReport,
    requestIdExists
};
