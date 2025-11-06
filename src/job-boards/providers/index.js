const { registerProvider } = require('../registry');
const greenhouseProvider = require('./greenhouse');

registerProvider(greenhouseProvider);

module.exports = {
    greenhouseProvider
};
