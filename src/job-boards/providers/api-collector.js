const mergeFilters = (base = {}, extra = {}) => {
    const result = { ...(base || {}) };

    Object.entries(extra || {}).forEach(([key, value]) => {
        if (!value) {
            return;
        }

        if (!result[key]) {
            result[key] = value;
        }
    });

    return result;
};

const buildAttemptDiagnostics = (attempts) => {
    const attemptTrace = attempts.map((entry) => ({
        key: entry.key,
        source: entry.source
    }));

    const diagnostics = {
        attemptTrace,
        attemptCount: attempts.length
    };

    const attemptedSlugs = attempts
        .map((entry) => entry.key)
        .filter(Boolean);

    if (attemptedSlugs.length > 0) {
        diagnostics.attemptedSlugs = attemptedSlugs;
    }

    return diagnostics;
};

const resolveAttemptKey = (attempt, contextKey) => {
    if (!attempt || typeof attempt !== 'object') {
        return null;
    }

    if (attempt.key) {
        return attempt.key;
    }

    if (contextKey && attempt[contextKey]) {
        return attempt[contextKey];
    }

    if (attempt.slug) {
        return attempt.slug;
    }

    if (attempt.companySlug) {
        return attempt.companySlug;
    }

    if (attempt.boardSlug) {
        return attempt.boardSlug;
    }

    return null;
};

const mergeDiagnostics = (attemptDiagnostics = {}, resultDiagnostics = {}, attempts = []) => ({
    ...attemptDiagnostics,
    ...resultDiagnostics,
    ...buildAttemptDiagnostics(attempts)
});

async function runApiCollector({
    url,
    logger,
    providerId,
    getInitialContexts,
    fetchListings,
    handleRetry,
    normalizeUrl = (value) => value,
    contextKey = 'slug'
}) {
    const initialContexts = await Promise.resolve(
        typeof getInitialContexts === 'function' ? getInitialContexts({ url, logger }) : getInitialContexts
    );

    const queue = Array.isArray(initialContexts) ? [...initialContexts] : [];

    if (queue.length === 0) {
        return {
            success: false,
            jobUrls: [],
            diagnostics: {
                error: 'no-initial-context'
            },
            error: new Error('No API collection context could be derived')
        };
    }

    const attempts = [];
    const attemptedKeys = new Set();
    let lastError = null;

    while (queue.length > 0) {
        const attempt = queue.shift();
        if (!attempt) {
            continue;
        }

        const key = resolveAttemptKey(attempt, contextKey);
        if (!key) {
            continue;
        }

        if (attemptedKeys.has(key)) {
            continue;
        }

        attemptedKeys.add(key);

        const attemptRecord = {
            key,
            source: attempt.source || 'unknown',
            diagnostics: attempt.diagnostics || {}
        };
        attempts.push(attemptRecord);

        try {
            const result = await fetchListings(attempt);
            const rawJobUrls = Array.isArray(result.jobUrls) ? result.jobUrls : [];
            const jobUrls = rawJobUrls.map((entry) => normalizeUrl(entry));

            const diagnostics = mergeDiagnostics(attemptRecord.diagnostics, result.diagnostics || {}, attempts);

            return {
                success: true,
                jobUrls,
                diagnostics
            };
        } catch (error) {
            lastError = error;

            if (handleRetry) {
                try {
                    const retryContexts = await handleRetry({ attempt, error, queue, attempts });
                    if (Array.isArray(retryContexts)) {
                        retryContexts.forEach((ctx) => {
                            if (ctx) {
                                queue.push(ctx);
                            }
                        });
                    }
                } catch (retryError) {
                    if (logger && typeof logger.warn === 'function') {
                        logger.warn(`API collector retry handler failed for ${providerId}: ${retryError.message}`);
                    }
                }
            }
        }
    }

    const diagnostics = mergeDiagnostics({}, {}, attempts);

    if (lastError) {
        diagnostics.error = lastError.message;

        if (lastError.response && lastError.response.status) {
            diagnostics.status = lastError.response.status;
        }

        if (lastError.code === 'ECONNABORTED') {
            diagnostics.timeout = true;
        }

        if (lastError.leverContext) {
            diagnostics.context = lastError.leverContext;
        }

        if (lastError.greenhouseContext) {
            diagnostics.context = lastError.greenhouseContext;
        }
    } else {
        diagnostics.error = 'api-collection-failed';
    }

    return {
        success: false,
        jobUrls: [],
        diagnostics,
        error: lastError
    };
}

module.exports = {
    mergeFilters,
    runApiCollector
};
