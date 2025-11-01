const { convert } = require('html-to-text');
const cleanDescription = require('../utils/description-cleaner');

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
                    
                    // Clean the description
                    description = cleanDescription(description);
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

        // Fallback for Greenhouse job board pages that expose data via window.__remixContext
        try {
            const gh = await page.evaluate(() => {
                const ctx = window.__remixContext;
                if (!ctx || !ctx.state || !ctx.state.loaderData) return null;
                const data = ctx.state.loaderData;
                for (const key of Object.keys(data)) {
                    const node = data[key];
                    if (node && node.jobPost && node.jobPost.title) {
                        const jp = node.jobPost;
                        return {
                            title: jp.title || '',
                            introduction: jp.introduction || '',
                            content: jp.content || '',
                            conclusion: jp.conclusion || '',
                            location: jp.job_post_location || 'Not specified'
                        };
                    }
                }
                return null;
            });

            if (gh) {
                const htmlCombined = `${gh.introduction}\n${gh.content}\n${gh.conclusion}`;
                const description = convert(htmlCombined || '', {
                    wordwrap: 130,
                    preserveNewlines: true,
                    selectors: [
                        { selector: 'a', options: { ignoreHref: true } },
                        { selector: 'img', format: 'skip' }
                    ]
                }).trim();

                return {
                    title: (gh.title || '').trim(),
                    description: cleanDescription(description),
                    location: (gh.location || 'Not specified').trim(),
                    skills: []
                };
            }
        } catch (_) { /* ignore */ }

        return null;
    } catch (error) {
        return null;
    }
};

module.exports = extractFromStructuredData;
