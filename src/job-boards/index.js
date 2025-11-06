const registry = require('./registry');
const providers = require('./providers');

const DEFAULT_PROVIDER_ID = 'generic';

module.exports = {
    ...registry,
    providers,
    DEFAULT_PROVIDER_ID
};
