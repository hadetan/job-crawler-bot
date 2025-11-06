const { registerProvider } = require('../registry');
const greenhouseProvider = require('./greenhouse');
const leverProvider = require('./lever');

registerProvider(greenhouseProvider);
registerProvider(leverProvider);

module.exports = {
    greenhouseProvider,
    leverProvider
};
