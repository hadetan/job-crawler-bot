const axios = require('axios');
const { convert } = require('html-to-text');
const config = require('../config');
const cleanDescription = require('../utils/description-cleaner');

const DEFAULT_JSON_HEADERS = {
    Accept: 'application/json',
    'Accept-Language': 'en-US,en;q=0.9'
};

const createProviderHttpClient = (options = {}) => {
    const headers = {
        ...DEFAULT_JSON_HEADERS,
        ...(options.headers || {})
    };

    const timeout = typeof options.timeout === 'number' ? options.timeout : config.crawler.pageTimeout;

    return axios.create({ timeout, headers, ...options });
};

const normalizeWhitespace = (value) => {
    if (!value && value !== 0) {
        return '';
    }

    return String(value)
        .replace(/\r\n?|\n/g, '\n')
        .replace(/\s+/g, ' ')
        .replace(/\s?\n\s?/g, '\n')
        .trim();
};

const stripHtml = (value) => {
    if (!value) {
        return '';
    }

    return value
        .replace(/<\/?(script|style)[^>]*>.*?<\/\1>/gis, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ');
};

const HTML_TO_TEXT_OPTIONS = {
    wordwrap: 130,
    preserveNewlines: true,
    selectors: [
        { selector: 'a', options: { ignoreHref: true } },
        { selector: 'img', format: 'skip' }
    ]
};

const normalizeLineBreaks = (value) => {
    if (!value) {
        return '';
    }

    const normalized = value
        .replace(/\r\n?/g, '\n')
        .replace(/\\n/g, '\n')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return normalized.replace(/[ \t]{3,}/g, ' ');
};

const resolveDescription = ({ plainText = '', html = '' }) => {
    const normalizedHtml = typeof html === 'string' ? html.trim() : '';
    if (normalizedHtml) {
        try {
            const converted = convert(normalizedHtml, HTML_TO_TEXT_OPTIONS).trim();
            const cleaned = cleanDescription(normalizeLineBreaks(converted));
            if (cleaned && cleaned.length >= 50) {
                return cleaned;
            }
        } catch (_) {
            // Ignore conversion failures and fall back to alternate representations.
        }
    }

    const normalizedPlain = typeof plainText === 'string'
        ? plainText.replace(/\r\n?/g, '\n')
        : '';

    if (normalizedPlain) {
        const cleanedPlain = cleanDescription(normalizeLineBreaks(normalizedPlain));
        if (cleanedPlain && cleanedPlain.length >= 50) {
            return cleanedPlain;
        }
    }

    const stripped = stripHtml(normalizedHtml);
    const fallback = normalizeLineBreaks(stripped || normalizedPlain);
    return fallback || '';
};

const collectListText = (lists = []) => {
    const items = [];

    lists.forEach((list) => {
        if (!list || !Array.isArray(list.content)) {
            return;
        }

        list.content.forEach((entry) => {
            const text = normalizeWhitespace(entry && (entry.text || entry));
            if (text) {
                items.push(text);
            }
        });
    });

    return Array.from(new Set(items));
};

module.exports = {
    createProviderHttpClient,
    normalizeWhitespace,
    stripHtml,
    resolveDescription,
    collectListText
};
