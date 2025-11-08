const fs = require('fs');
const path = require('path');

/**
 * Format job data as readable text
 * @param {Object} jobData - Job data object
 * @returns {string} Formatted text content
 */
const formatJobToText = (jobData) => {
    const lines = [];

    lines.push('='.repeat(80));
    lines.push('JOB DETAILS');
    lines.push('='.repeat(80));
    lines.push('');

    lines.push(`TITLE: ${jobData.title}`);
    lines.push('');

    if (jobData.rawMeta && Array.isArray(jobData.rawMeta.departments) && jobData.rawMeta.departments.length > 0) {
        const dept = jobData.rawMeta.departments.join('; ');
        lines.push(`DEPARTMENTS: ${dept}`);
        lines.push('');
    }

    lines.push(`LOCATION: ${jobData.location}`);
    lines.push('');

    lines.push(`URL: ${jobData.url}`);
    lines.push('');

    if (jobData.skills && jobData.skills.length > 0) {
        lines.push('SKILLS/REQUIREMENTS:');
        jobData.skills.forEach(skill => {
            lines.push(`  - ${skill}`);
        });
        lines.push('');
    }

    lines.push('-'.repeat(80));
    lines.push('DESCRIPTION:');
    lines.push('-'.repeat(80));
    lines.push('');
    lines.push(jobData.description);
    lines.push('');

    if (Array.isArray(jobData.sections) && jobData.sections.length > 0) {
        lines.push('-'.repeat(80));
        lines.push('ADDITIONAL DETAILS:');
        lines.push('-'.repeat(80));
        lines.push('');

        jobData.sections.forEach((section, index) => {
            if (!section) {
                return;
            }

            const heading = section.title || `Section ${index + 1}`;
            lines.push(heading);
            lines.push('-'.repeat(Math.min(heading.length, 80)));

            if (section.content) {
                lines.push(section.content);
            }

            lines.push('');
        });
    }

    lines.push('='.repeat(80));

    return lines.join('\n');
};

/**
 * Save job data to file
 * @param {Object} jobData - Job data object
 * @param {string} companyDir - Company directory path
 * @param {number} jobNumber - Job number for filename
 * @returns {string} Filename of saved file
 */
const saveJobToFile = (jobData, companyDir, jobNumber) => {
    const fileName = `${jobNumber}.txt`;
    const filePath = path.join(companyDir, fileName);
    const content = formatJobToText(jobData);

    fs.writeFileSync(filePath, content, 'utf-8');
    return fileName;
};

module.exports = {
    formatJobToText,
    saveJobToFile
};
