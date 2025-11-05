const puppeteer = require('puppeteer');
const config = require('../config');

module.exports = async () => {
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
