const { convert } = require('html-to-text');

/**
 * Try to extract text content from page using multiple selectors
 * @param {Page} page - Puppeteer page object
 * @param {string[]} selectors - Array of CSS selectors to try
 * @returns {Promise<string>} Extracted text or empty string
 */
const tryExtractText = async (page, selectors) => {
    for (const selector of selectors) {
        try {
            const element = await page.$(selector);
            if (element) {
                const text = await page.evaluate(el => el.textContent || el.innerText, element);
                if (text && text.trim()) {
                    return text.trim();
                }
            }
        } catch (error) {
            // Continue to next selector
        }
    }
    return '';
};

/**
 * Try to extract HTML content and convert to text using multiple selectors
 * @param {Page} page - Puppeteer page object
 * @param {string[]} selectors - Array of CSS selectors to try
 * @returns {Promise<string>} Converted text or empty string
 */
const tryExtractHTML = async (page, selectors) => {
    for (const selector of selectors) {
        try {
            const element = await page.$(selector);
            if (element) {
                const html = await page.evaluate(el => el.innerHTML, element);
                if (html && html.trim()) {
                    const text = convert(html, {
                        wordwrap: 130,
                        preserveNewlines: true,
                        selectors: [
                            { selector: 'a', options: { ignoreHref: true } },
                            { selector: 'img', format: 'skip' }
                        ]
                    });
                    return text.trim();
                }
            }
        } catch (error) { }
    }
    return '';
};

module.exports = {
    tryExtractText,
    tryExtractHTML
};
