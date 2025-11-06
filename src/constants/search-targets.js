const SEARCH_TARGETS = Object.freeze({
    greenhouse: 'site:"boards.greenhouse.io"',
    lever: 'site:"jobs.lever.co"'
});

const getSearchQuery = (key) => {
    if (!key) {
        return null;
    }

    const normalizedKey = key.toLowerCase();
    return SEARCH_TARGETS[normalizedKey] || null;
};

const listSearchTargets = () => Object.keys(SEARCH_TARGETS);

module.exports = {
    getSearchQuery,
    listSearchTargets
};
