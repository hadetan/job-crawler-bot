const { convert } = require('html-to-text');

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

                // Skip if matches exclusion patterns
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

                // Calculate prominence score
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

        // Step 3: Extract description intelligently
        const description = await page.evaluate(() => {
            const removeSelectors = [
                'nav',
                'header',
                'footer',
                '[role="navigation"]',
                '[class*="nav"]',
                '[class*="menu"]',
                '[class*="header"]',
                '[class*="footer"]',
                '[class*="sidebar"]',
                '[aria-label*="navigation"]',
                '[aria-label*="menu"]'
            ];

            const workingBody = document.body.cloneNode(true);

            removeSelectors.forEach(selector => {
                workingBody.querySelectorAll(selector).forEach(el => el.remove());
            });

            const containers = Array.from(workingBody.querySelectorAll('article, main, [role="main"], section, div'));

            const jobKeywords = [
                'responsibilities', 'requirements', 'qualifications', 'description',
                'about the role', 'what you', 'your responsibilities', 'key qualifications',
                'you will', 'you have', 'your role', 'about you', 'we are looking',
                'ideal candidate', 'join', 'team', 'position', 'opportunity', 'experience'
            ];

            let bestContainers = [];
            let maxScore = 0;

            for (const container of containers) {
                const text = container.textContent || '';
                const textLength = text.trim().length;

                if (textLength < 300) continue;

                const listItems = container.querySelectorAll('li');
                if (listItems.length > 20) continue;

                const childCount = container.querySelectorAll('*').length || 1;
                const textDensity = textLength / childCount;

                if (textDensity < 5) continue;

                const links = container.querySelectorAll('a');
                const linkCount = links.length;
                const linkText = Array.from(links).reduce((sum, link) => sum + (link.textContent || '').length, 0);
                const linkRatio = textLength > 0 ? linkText / textLength : 0;

                if (linkRatio > 0.3 || linkCount > 10) continue;

                const lowerText = text.toLowerCase();
                const keywordCount = jobKeywords.filter(kw => lowerText.includes(kw)).length;

                // Calculate quality score - no longer require keywords since other filters are strong
                const score = textDensity * (1 + keywordCount * 0.5);

                if (score > maxScore * 0.7) {
                    if (score > maxScore) {
                        maxScore = score;
                    }
                    bestContainers.push({ container, score });
                }
            }

            bestContainers.sort((a, b) => b.score - a.score);

            const uniqueContainers = [];
            for (const candidate of bestContainers) {
                let isNested = false;
                for (const existing of uniqueContainers) {
                    if (existing.container.contains(candidate.container)) {
                        isNested = true;
                        break;
                    }
                    if (candidate.container.contains(existing.container)) {
                        const index = uniqueContainers.indexOf(existing);
                        uniqueContainers.splice(index, 1);
                        break;
                    }
                }
                if (!isNested) {
                    uniqueContainers.push(candidate);
                }
            }

            const topContainer = uniqueContainers.length > 0 ? uniqueContainers[0].container : null;

            return topContainer ? topContainer.innerHTML : '';
        });

        const descriptionText = description ? convert(description, {
            wordwrap: 130,
            preserveNewlines: true,
            selectors: [
                { selector: 'a', options: { ignoreHref: true } },
                { selector: 'img', format: 'skip' }
            ]
        }).trim() : '';

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
            description: descriptionText,
            location: location.trim(),
            skills
        };
    } catch (error) {
        return null;
    }
};

module.exports = extractWithIntelligentAnalysis;
