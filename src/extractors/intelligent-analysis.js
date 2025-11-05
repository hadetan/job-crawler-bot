const { convert } = require('html-to-text');
const cleanDescription = require('../utils/description-cleaner');

/**
 * Extract job data using intelligent DOM analysis
 * @param {Page} page - Puppeteer page object
 * @returns {Promise<Object|null>} Extracted job data or null if error page detected
 */
const extractWithIntelligentAnalysis = async (page) => {
    try {
        // Step 1: Detect error pages
        const isErrorPage = await page.evaluate(() => {
            const pageTitle = document.title.toLowerCase();
            const bodyText = document.body.textContent.toLowerCase();

            if (pageTitle.includes('404') || pageTitle.includes('not found') || pageTitle.includes('error')) {
                return true;
            }

            const errorPatterns = [
                "couldn't find",
                "page not found",
                "job posting.*closed",
                "posting.*removed",
                "sorry.*nothing"
            ];

            for (const pattern of errorPatterns) {
                const regex = new RegExp(pattern, 'i');
                if (regex.test(bodyText)) {
                    return true;
                }
            }

            return false;
        });

        if (isErrorPage) {
            return null;
        }

        // Step 2: Extract title intelligently
        const title = await page.evaluate(() => {
            // Priority 1: Check page metadata
            const ogTitle = document.querySelector('meta[property="og:title"]');
            if (ogTitle && ogTitle.content) {
                const text = ogTitle.content.trim();
                const cleaned = text.split(' - ')[0].split(' | ')[0].trim();
                if (cleaned.length >= 5 && cleaned.length <= 200) {
                    return cleaned;
                }
            }

            // Priority 2: Check document.title
            const docTitle = document.title.trim();
            if (docTitle && !docTitle.toLowerCase().includes('careers') && !docTitle.toLowerCase().includes('jobs')) {
                const cleaned = docTitle.split(' - ')[0].split(' | ')[0].trim();
                if (cleaned.length >= 5 && cleaned.length <= 200) {
                    return cleaned;
                }
            }

            // Priority 3: Look for headings with specific job title indicators
            const headings = Array.from(document.querySelectorAll('h1, h2, h3'));

            const exclusionPatterns = [
                /current openings/i,
                /open roles/i,
                /careers at/i,
                /^join/i,
                /^about/i,
                /^home$/i,
                /^careers$/i,
                /^jobs$/i,
                /what we're looking for/i,
                /what you'll do/i,
                /who you are/i,
                /your role/i,
                /responsibilities/i,
                /requirements/i,
                /qualifications/i
            ];

            let bestHeading = null;
            let bestScore = 0;

            for (const heading of headings) {
                const text = heading.textContent.trim();

                if (text.length < 5 || text.length > 200) continue;

                if (exclusionPatterns.some(pattern => pattern.test(text))) continue;

                let parent = heading.parentElement;
                let inNav = false;
                for (let i = 0; i < 5 && parent; i++) {
                    if (parent.tagName === 'NAV' || parent.getAttribute('role') === 'navigation') {
                        inNav = true;
                        break;
                    }
                    parent = parent.parentElement;
                }
                if (inNav) continue;

                const rect = heading.getBoundingClientRect();
                const fontSize = parseInt(window.getComputedStyle(heading).fontSize) || 16;
                const position = rect.top;
                const positionWeight = Math.max(1, 3 - (position / 500));

                // Boost score if h1
                const tagBoost = heading.tagName === 'H1' ? 1.5 : 1.0;

                const score = fontSize * positionWeight * tagBoost;

                if (score > bestScore) {
                    bestScore = score;
                    bestHeading = text;
                }
            }

            if (!bestHeading) {
                const semanticElements = document.querySelectorAll('[data-qa*="job-title"], [data-qa*="position"], [aria-label*="job title"]');
                for (const el of semanticElements) {
                    const text = el.textContent.trim();
                    if (text.length >= 5 && text.length <= 200) {
                        bestHeading = text;
                        break;
                    }
                }
            }

            return bestHeading || '';
        });

        // Step 3: Extract description intelligently using hybrid algorithm
        const description = await page.evaluate(() => {
            const getTextLength = (element) => {
                return (element.textContent || '').trim().length;
            };

            const hasBoundaryMarker = (element) => {
                const text = (element.textContent || '').toLowerCase();
                const boundaryPatterns = [
                    'equal opportunity employer',
                    'we do not discriminate',
                    'privacy policy',
                    'cookie policy',
                    'apply now',
                    'submit application',
                    'have questions',
                    'want to learn more',
                    'by entering your email',
                    'message and data rates',
                    'your privacy choices',
                    'terms of use',
                    'cookie settings'
                ];

                return boundaryPatterns.some(pattern => text.includes(pattern));
            };

            const looksLikeJobListing = (element) => {
                const text = element.textContent || '';
                const textLength = text.trim().length;

                const viewJobCount = (text.match(/view job/gi) || []).length;

                if (viewJobCount >= 3 && textLength / viewJobCount < 400) return true;

                const lowerText = text.toLowerCase();
                if ((lowerText.includes('related jobs') || lowerText.includes('similar jobs') ||
                    lowerText.includes('other opportunities')) && textLength < 1500) {
                    return true;
                }

                return false;
            };

            // Step 1: Clone body and remove noise elements
            const workingBody = document.body.cloneNode(true);

            const noiseSelectors = [
                'nav',
                'header',
                'footer',
                'iframe',
                '[role="navigation"]',
                '[role="banner"]',
                '[role="contentinfo"]',
                '[class*="nav"]',
                '[class*="menu"]',
                '[class*="header"]',
                '[class*="footer"]',
                '[class*="sidebar"]',
                '[class*="cookie"]',
                '[class*="consent"]',
                '[aria-label*="navigation"]',
                '[aria-label*="menu"]',
                'script',
                'style',
                'noscript'
            ];

            noiseSelectors.forEach(selector => {
                workingBody.querySelectorAll(selector).forEach(el => el.remove());
            });

            // Step 2: Find the main content container
            let mainContainer = workingBody.querySelector('main, article, [role="main"]');

            if (!mainContainer) {
                mainContainer = workingBody;
            }

            // Step 3: Find all semantic containers and evaluate them
            const SEMANTIC_TAGS = ['section', 'article', 'div'];
            const allContainers = Array.from(mainContainer.querySelectorAll(SEMANTIC_TAGS.join(', ')));

            allContainers.push(mainContainer);

            const scoredContainers = [];
            for (const container of allContainers) {
                const textLength = getTextLength(container);

                if (textLength < 300) continue;

                let penalty = 0;

                if (looksLikeJobListing(container)) {
                    penalty += 10000;
                }

                if (hasBoundaryMarker(container)) {
                    penalty += 5000;
                }

                const links = container.querySelectorAll('a');
                const linkRatio = links.length / Math.max(1, textLength / 100);
                if (linkRatio > 2) {
                    penalty += 2000;
                }

                let isNested = false;
                for (const other of allContainers) {
                    if (other !== container && other.contains(container)) {
                        isNested = true;
                        break;
                    }
                }

                const score = textLength - penalty;

                if (score > 0 && !isNested) {
                    scoredContainers.push({ container, score, textLength, penalty });
                }
            }

            const topLevelContainers = [];
            for (const candidate of scoredContainers) {
                let hasParentInList = false;
                for (const other of scoredContainers) {
                    if (other.container !== candidate.container &&
                        other.container.contains(candidate.container)) {
                        hasParentInList = true;
                        break;
                    }
                }

                if (!hasParentInList) {
                    topLevelContainers.push(candidate);
                }
            }

            topLevelContainers.sort((a, b) => b.score - a.score);

            const best = topLevelContainers[0];
            const bestContainer = best ? best.container : mainContainer;

            return bestContainer.innerHTML || '';
        });

        const descriptionText = description ? convert(description, {
            wordwrap: 130,
            preserveNewlines: true,
            selectors: [
                { selector: 'a', options: { ignoreHref: true } },
                { selector: 'img', format: 'skip' }
            ]
        }).trim() : '';

        const cleanedDescription = cleanDescription(descriptionText);

        // Step 4: Extract location
        const location = await page.evaluate(() => {
            const patterns = [
                /location:\s*([^<\n]+)/i,
                /based in:\s*([^<\n]+)/i,
                /office:\s*([^<\n]+)/i
            ];

            const bodyText = document.body.textContent;

            for (const pattern of patterns) {
                const match = bodyText.match(pattern);
                if (match && match[1]) {
                    const loc = match[1].trim();
                    if (loc.length >= 2 && loc.length <= 100) {
                        return loc;
                    }
                }
            }

            const locationElements = document.querySelectorAll('[itemprop="jobLocation"], [data-location], .location, [class*="location"]');
            for (const el of locationElements) {
                const text = el.textContent.trim();
                if (text.length >= 2 && text.length <= 100) {
                    return text;
                }
            }

            return 'Not specified';
        });

        // Step 5: Extract skills/requirements
        const skills = await page.evaluate(() => {
            const lists = Array.from(document.querySelectorAll('ul, ol'));
            const skillItems = [];

            const navKeywords = [
                'working at',
                'how to apply',
                'life in',
                'athletics',
                'business and finance',
                'human resources',
                'login',
                'sign in',
                'register',
                'home',
                'about',
                'contact',
                'careers',
                'jobs',
                'english',
                'language'
            ];

            for (const list of lists) {
                const rect = list.getBoundingClientRect();
                if (rect.top < 200) continue;

                let parent = list.parentElement;
                let inNavOrFooter = false;
                for (let i = 0; i < 5 && parent; i++) {
                    const role = parent.getAttribute('role');
                    const className = parent.className || '';
                    if (parent.tagName === 'NAV' ||
                        role === 'navigation' ||
                        parent.tagName === 'FOOTER' ||
                        className.includes('nav') ||
                        className.includes('menu') ||
                        className.includes('header')) {
                        inNavOrFooter = true;
                        break;
                    }
                    parent = parent.parentElement;
                }
                if (inNavOrFooter) continue;

                const items = Array.from(list.querySelectorAll('li'));

                const shortItems = items.filter(item => item.textContent.trim().length < 30);
                if (shortItems.length > 5 && shortItems.length > items.length * 0.7) {
                    continue;
                }

                for (const item of items) {
                    const text = item.textContent.trim();

                    if (text.length < 15 || text.length > 500) continue;

                    const lowerText = text.toLowerCase();
                    if (navKeywords.some(kw => lowerText.includes(kw))) continue;

                    const links = item.querySelectorAll('a');
                    if (links.length > 0 && text.length < 50) continue;

                    skillItems.push(text);
                }

                if (skillItems.length > 3) break;
            }

            return skillItems;
        });

        return {
            title: title.trim(),
            description: cleanedDescription,
            location: location.trim(),
            skills
        };
    } catch (error) {
        return null;
    }
};

module.exports = extractWithIntelligentAnalysis;
