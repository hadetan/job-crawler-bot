const tryAcceptCookies = async (page) => {
    try {
        const commonSelectors = [
            // OneTrust
            '#onetrust-accept-btn-handler',
            'button#onetrust-accept-btn-handler',
            // Cookiebot
            '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
            '#CybotCookiebotDialogBodyButtonAccept',
            '#CybotCookiebotDialogBodyLevelButtonAccept',
            // CookieYes
            '#cky-consent-accept',
            '.cky-consent-container .cky-btn-accept',
            // Complianz
            '.cmplz-accept',
            '.cmplz-btn.cmplz-accept',
            // Cookie Consent older libs
            '.cc-allow',
            '.cc-accept',
            // HubSpot cookie banner
            '#hs-eu-confirmation-button',
            // Generic aria-labels
            'button[aria-label*="Accept" i][aria-label*="cookie" i]',
            'button[aria-label*="Accept all" i]',
            'button[aria-label*="Allow all" i]'
        ];

        for (const sel of commonSelectors) {
            const btn = await page.$(sel);
            if (btn) {
                await btn.click({ delay: 10 });
                await page.waitForTimeout(500);
            }
        }
    } catch (_) { /* ignore cookie accept errors */ }
};


module.exports = tryAcceptCookies;