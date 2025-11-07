const { registerProvider } = require('../registry');
const leverProvider = require('./lever');
const greenhouseProvider = require('./greenhouse');

registerProvider(leverProvider);
registerProvider(greenhouseProvider);

module.exports = {
    leverProvider,
    greenhouseProvider
};
