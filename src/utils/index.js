const log = require('./logger');
const { extractCompanyName, getProcessedJobs, markJobAsProcessed, getNextJobNumber } = require('./file-helpers');
const { formatJobToText, saveJobToFile } = require('./format-helpers');
const { normalizeURL } = require('./csv-handler');

module.exports = {
    normalizeURL,
    
    log,

    extractCompanyName,
    getProcessedJobs,
    markJobAsProcessed,
    getNextJobNumber,

    formatJobToText,
    saveJobToFile
};
