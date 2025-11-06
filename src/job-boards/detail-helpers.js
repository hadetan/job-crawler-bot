const axios = require('axios');
const config = require('../config');

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

const resolveDescription = ({ plainText = '', html = '' }) => {
    const normalizedPlain = normalizeWhitespace(plainText);
    if (normalizedPlain && normalizedPlain.length >= 50) {
        return normalizedPlain;
    }

    const fromHtml = stripHtml(html);
    return normalizeWhitespace(fromHtml || normalizedPlain);
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
