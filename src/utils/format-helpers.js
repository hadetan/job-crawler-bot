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
