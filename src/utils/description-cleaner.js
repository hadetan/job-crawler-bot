/**
 * Clean job description by removing content after common ending markers
 * @param {string} description - The raw description text
 * @returns {string} Cleaned description
 */
const cleanDescription = (description) => {
    if (!description || description.trim().length === 0) {
        return description;
    }

    // Common patterns that indicate end of job description
    const endingMarkers = [
        // Legal/compliance text
        { pattern: /equal opportunity employer/i, minPosition: 800 },
        { pattern: /we (do not|don't) discriminate/i, minPosition: 800 },

        // Privacy/legal
        { pattern: /by entering your email/i, minPosition: 500 },
        { pattern: /message and data rates/i, minPosition: 500 },
        { pattern: /cookie settings/i, minPosition: 800 },

        // Related content sections
        { pattern: /related jobs?:/i, minPosition: 500 },
        { pattern: /similar (positions|roles|jobs):/i, minPosition: 500 },
        { pattern: /other opportunities:/i, minPosition: 500 },

        // Footer content
        { pattern: /copyright ©/i, minPosition: 800 },
        { pattern: /all rights reserved/i, minPosition: 800 },
        { pattern: /want to learn more about (us|our company)/i, minPosition: 800 },

        // Closing questions (only near end)
        { pattern: /have (we )?piqued your curiosity\?/i, minPosition: 1000 }
    ];

    let earliestCutoff = description.length;

    for (const marker of endingMarkers) {
        const match = description.match(marker.pattern);
        if (match && match.index >= marker.minPosition && match.index < earliestCutoff) {
            earliestCutoff = match.index;
        }
    }

    if (earliestCutoff < description.length) {
        description = description.substring(0, earliestCutoff).trim();
    }

    return description;
};

module.exports = cleanDescription;
