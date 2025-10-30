const chalk = require('chalk');

const getTimestamp = () => {
  const now = new Date();
  return now.toISOString().replace('T', ' ').substring(0, 19);
};

const log = {
  info: (message) => {
    console.log(`[${getTimestamp()}] [INFO] ${message}`);
  },

  success: (message) => {
    console.log(chalk.green(`[${getTimestamp()}] [SUCCESS] ${message}`));
  },

  error: (message) => {
    console.error(chalk.red(`[${getTimestamp()}] [ERROR] ${message}`));
  },

  progress: (message) => {
    console.log(chalk.blue(`[${getTimestamp()}] [PROGRESS] ${message}`));
  }
};

module.exports = log;
