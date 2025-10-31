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
 * Job URLs with same ID but different locales are deduplicated:
 * - stripe.com/us/jobs/listing/.../7176975 → "stripe.com:7176975"
 * - stripe.com/gb/jobs/listing/.../7176975 → "stripe.com:7176975"
 * - Both map to same normalized form → deduplicated
 *
 * But different domains with same ID are NOT deduplicated:
 * - roblox.com/jobs/6209414 → "roblox.com:6209414"
 * - betterment.com/...?gh_jid=6209414 → "betterment.com:6209414"
 * - Different normalized forms → kept separate
 *
 * URLs without job IDs fall back to standard normalization.
 */
const normalizeURL = (url) => {
  if (!url) return '';

  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.replace(/^www\./, '').toLowerCase();
    
    // Extract job ID (4+ consecutive digits) from entire URL
    const matches = url.match(/\d{4,}/g);

    if (matches && matches.length > 0) {
      // Return longest match (most likely the job ID)
      // If same length, return the last one (typically appears later in URL)
      const longestMatch = matches.reduce((longest, current) => {
        if (current.length > longest.length) {
          return current;
        } else if (current.length === longest.length) {
          // Same length: prefer the later one
          return current;
        }
        return longest;
      });

      // Include domain to prevent collisions across different companies
      return `${hostname}:${longestMatch}`;
    }
  } catch {
    // Fall through to standard normalization
  }

  // Fallback: standard normalization (no job ID found)
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
