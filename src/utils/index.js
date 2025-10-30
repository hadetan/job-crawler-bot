const { readCSV, normalizeURL } = require('./csv-handler');
const log = require('./logger');
const { extractCompanyName, getProcessedJobs, markJobAsProcessed, getNextJobNumber } = require('./file-helpers');
const { tryExtractText, tryExtractHTML } = require('./dom-helpers');
const { formatJobToText, saveJobToFile } = require('./format-helpers');

module.exports = {
  // CSV utilities
  readCSV,
  normalizeURL,

  // Logger
  log,

  // File utilities
  extractCompanyName,
  getProcessedJobs,
  markJobAsProcessed,
  getNextJobNumber,

  // DOM utilities
  tryExtractText,
  tryExtractHTML,

  // Format utilities
  formatJobToText,
  saveJobToFile
};
