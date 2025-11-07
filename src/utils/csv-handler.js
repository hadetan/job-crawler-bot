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
    normalizeURL
};
