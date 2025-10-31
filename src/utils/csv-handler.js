const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const readCSV = (filePath, columnName) => {
    try {
        if (!fs.existsSync(filePath)) {
            return [];
        }

        const content = fs.readFileSync(filePath, 'utf-8');
        if (!content.trim()) {
            return [];
        }

        const records = parse(content, {
            columns: true,
            skip_empty_lines: true
        });

        return records.map(record => record[columnName]).filter(Boolean);
    } catch (error) {
        console.error(`Error reading CSV file ${filePath}:`, error.message);
        return [];
    }
};

const writeCSV = (filePath, data, columns) => {
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const fileExists = fs.existsSync(filePath);
        const csvContent = stringify(data, {
            header: !fileExists,
            columns: columns
        });

        fs.appendFileSync(filePath, csvContent, 'utf-8');
    } catch (error) {
        console.error(`Error writing CSV file ${filePath}:`, error.message);
        throw error;
    }
};

/**
 * Normalize URL for deduplication by including domain + job ID
 * @param {string} url - The URL to normalize
 * @returns {string} - Normalized form (domain+jobID if found, else lowercased URL)
 *
 * URLs without job IDs fall back to standard normalization.
 */
const normalizeURL = (url) => {
    if (!url) return '';

    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname.replace(/^www\./, '').toLowerCase();

        const matches = url.match(/\d{4,}/g);

        if (matches && matches.length > 0) {
            const longestMatch = matches.reduce((longest, current) => {
                if (current.length > longest.length) {
                    return current;
                } else if (current.length === longest.length) {
                    return current;
                }
                return longest;
            });

            return `${hostname}:${longestMatch}`;
        }
    } catch { }

    // Fallback: standard normalization
    let normalized = url.toLowerCase().trim();

    if (normalized.endsWith('/')) {
        normalized = normalized.slice(0, -1);
    }

    return normalized;
};

module.exports = {
    readCSV,
    writeCSV,
    normalizeURL
};
