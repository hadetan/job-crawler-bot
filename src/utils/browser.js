const puppeteer = require('puppeteer');
const config = require('../config');

const configurePage = async (page) => {
	await page.setUserAgent(config.crawler.userAgent);
	await page.setExtraHTTPHeaders({
		'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
		'Accept-Language': 'en-US,en;q=0.9',
		'Accept-Encoding': 'gzip, deflate',
		'Connection': 'keep-alive',
		'Upgrade-Insecure-Requests': '1'
	});
	await page.setViewport({ width: 1920, height: 1080 });
};

const createPageController = (browserInstance) => {
	let pageInstance = null;

	return {
		ensurePage: async () => {
			if (!pageInstance) {
				pageInstance = await browserInstance.newPage();
				await configurePage(pageInstance);
			}
			return pageInstance;
		},
		release: async () => {
			if (pageInstance) {
				try {
					await pageInstance.close();
				} catch (_) {
					// Ignore close errors to avoid masking upstream failures.
				}
				pageInstance = null;
			}
		}
	};
};

const launchBrowser = async () => {
	return await puppeteer.launch({
		headless: config.crawler.headless,
		args: [
			'--no-sandbox',
			'--disable-setuid-sandbox',
			'--disable-dev-shm-usage',
			'--disable-http2',
			'--disable-blink-features=AutomationControlled' /* Hide automation */,
			'--disable-web-security',
			'--disable-features=IsolateOrigins,site-per-process',
			'--lang=en-US,en',
			'--accept-lang=en-US,en;q=0.9'
		],
		ignoreHTTPSErrors: true,
	});
};

launchBrowser.configurePage = configurePage;
launchBrowser.createPageController = createPageController;

module.exports = launchBrowser;
