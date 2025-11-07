const { registerProvider } = require('../registry');
const leverProvider = require('./lever');

registerProvider(leverProvider);

module.exports = {
    leverProvider
};
