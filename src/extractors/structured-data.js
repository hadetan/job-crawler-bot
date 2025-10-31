const { convert } = require('html-to-text');

/**
 * Extract job data from JSON-LD structured data (Schema.org JobPosting)
 * @param {Page} page - Puppeteer page object
 * @returns {Promise<Object|null>} Extracted job data or null if not found
 */
const extractFromStructuredData = async (page) => {
    try {
        const structuredData = await page.evaluate(() => {
            const scripts = document.querySelectorAll('script[type="application/ld+json"]');
            const jsonData = [];

            scripts.forEach(script => {
                try {
                    const data = JSON.parse(script.textContent);
                    jsonData.push(data);
                } catch (e) { }
            });

            return jsonData;
        });

        for (const data of structuredData) {
            const isJobPosting =
                data['@type'] === 'JobPosting' ||
                (Array.isArray(data['@type']) && data['@type'].includes('JobPosting'));

            if (isJobPosting) {
                const title = data.title || data.name || '';

                let description = data.description || '';
                if (description && description.length > 0) {
                    const decodedHtml = await page.evaluate((desc) => {
                        const textarea = document.createElement('textarea');
                        textarea.innerHTML = desc;
                        return textarea.value;
                    }, description);

                    // Then use html-to-text library to convert to clean text
                    description = convert(decodedHtml, {
                        wordwrap: 130,
                        preserveNewlines: true,
                        selectors: [
                            { selector: 'a', options: { ignoreHref: true } },
                            { selector: 'img', format: 'skip' }
                        ]
                    }).trim();
                }

                // Extract location
                let location = 'Not specified';
                if (data.jobLocation) {
                    if (typeof data.jobLocation === 'string') {
                        location = data.jobLocation;
                    } else if (data.jobLocation.address) {
                        const addr = data.jobLocation.address;
                        location = addr.addressLocality || addr.addressRegion || data.jobLocation.name || 'Not specified';
                    } else if (data.jobLocation.name) {
                        location = data.jobLocation.name;
                    }
                }

                // Extract skills - if available
                let skills = [];
                if (data.skills) {
                    if (Array.isArray(data.skills)) {
                        skills = data.skills.map(s => typeof s === 'string' ? s : s.name || '').filter(Boolean);
                    }
                }
                if (data.relevantOccupation && Array.isArray(data.relevantOccupation)) {
                    skills = [...skills, ...data.relevantOccupation.map(o => o.name || o).filter(Boolean)];
                }

                return {
                    title: title.trim(),
                    description: description.trim(),
                    location: location.trim(),
                    skills
                };
            }
        }

        return null;
    } catch (error) {
        return null;
    }
};

module.exports = extractFromStructuredData;
