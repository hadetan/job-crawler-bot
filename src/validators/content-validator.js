/**
 * Validate extracted job content to ensure quality
 * @param {Object} jobData - The extracted job data object
 * @returns {Object} Validation result with { valid: boolean, reason: string|null }
 */
const validateExtractedContent = (jobData) => {
    if (!jobData) {
        return { valid: false, reason: 'No data extracted' };
    }

    const title = jobData.title || '';

    if (!title || title === 'N/A' || title.trim().length === 0) {
        return { valid: false, reason: 'Title is empty or N/A' };
    }

    if (title.length < 5) {
        return { valid: false, reason: 'Title too short (< 5 characters)' };
    }

    if (title.length > 300) {
        return { valid: false, reason: 'Title too long (> 300 characters)' };
    }

    const titleErrorPatterns = [
        /404/i,
        /not found/i,
        /error/i,
        /current openings/i,
        /open roles/i
    ];

    for (const pattern of titleErrorPatterns) {
        if (pattern.test(title)) {
            return { valid: false, reason: 'Title contains error message or page heading' };
        }
    }

    const commonPageHeadings = [
        'home',
        'careers',
        'jobs',
        'current openings',
        'open roles',
        'join us'
    ];

    if (commonPageHeadings.includes(title.toLowerCase())) {
        return { valid: false, reason: 'Title is a common page heading, not a job title' };
    }

    const description = jobData.description || '';

    if (!description || description === 'No description found' || description.trim().length === 0) {
        return { valid: false, reason: 'Description is empty or placeholder' };
    }

    if (description.length < 100) {
        return { valid: false, reason: 'Description too short (< 100 characters)' };
    }

    const descErrorPatterns = [
        /couldn't find/i,
        /page not found/i,
        /posting.*closed/i,
        /removed/i,
        /sorry.*nothing/i
    ];

    for (const pattern of descErrorPatterns) {
        if (pattern.test(description)) {
            return { valid: false, reason: 'Description contains 404 or error message' };
        }
    }

    const jobKeywords = [
        'experience',
        'responsibilities',
        'requirements',
        'qualifications',
        'skills',
        'role',
        'position',
        'you will',
        'you have',
        'we are looking',
        'team',
        'opportunity'
    ];

    const lowerDesc = description.toLowerCase();
    const keywordCount = jobKeywords.filter(kw => lowerDesc.includes(kw)).length;

    if (keywordCount < 1) {
        return { valid: false, reason: 'Description does not contain job-related keywords' };
    }

    return { valid: true, reason: null };
};

module.exports = validateExtractedContent;
