const { readCSV, normalizeURL } = require('./csv-handler');
const log = require('./logger');
const { extractCompanyName, getProcessedJobs, markJobAsProcessed, getNextJobNumber } = require('./file-helpers');
const { tryExtractText, tryExtractHTML } = require('./dom-helpers');
const { formatJobToText, saveJobToFile } = require('./format-helpers');

module.exports = {
    readCSV,
    normalizeURL,

    log,

    extractCompanyName,
    getProcessedJobs,
    markJobAsProcessed,
    getNextJobNumber,

    tryExtractText,
    tryExtractHTML,

    formatJobToText,
    saveJobToFile
};
