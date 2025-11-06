const registry = require('./registry');

const DEFAULT_PROVIDER_ID = 'generic';

module.exports = {
    ...registry,
    DEFAULT_PROVIDER_ID
};
