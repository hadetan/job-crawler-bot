const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// Import the extraction functions from stage3-details.js
const stage3Module = require('./src/crawlers/stage3-details');

async function testExtraction() {
  const testURLs = [
    'https://boards.greenhouse.io/mozilla/jobs/6339190',
    'https://jobs.ashbyhq.com/OpenAI/2f1f29bf-89f5-47d6-b67f-c7b1adf4d95f'
  ];

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  for (const url of testURLs) {
    console.log('\n' + '='.repeat(80));
    console.log(`Testing URL: ${url}`);
    console.log('='.repeat(80));

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Test structured data
    console.log('\n--- Testing Structured Data Extraction ---');
    const structuredData = await page.evaluate(() => {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      console.log(`Found ${scripts.length} JSON-LD scripts`);
      const jsonData = [];
      scripts.forEach(script => {
        try {
          const data = JSON.parse(script.textContent);
          jsonData.push(data);
        } catch (e) {
          console.log('Failed to parse JSON-LD');
        }
      });
      return jsonData;
    });

    console.log('Structured data found:', JSON.stringify(structuredData, null, 2));

    // Test intelligent analysis - title
    console.log('\n--- Testing Title Extraction ---');
    const titleData = await page.evaluate(() => {
      const headings = Array.from(document.querySelectorAll('h1, h2'));
      console.log(`Found ${headings.length} headings`);

      const exclusionPatterns = [
        /current openings/i,
        /open roles/i,
        /careers at/i,
        /^join/i,
        /^about/i,
        /^home$/i,
        /^careers$/i,
        /^jobs$/i
      ];

      const results = [];
      for (const heading of headings.slice(0, 5)) {
        const text = heading.textContent.trim();
        const excluded = exclusionPatterns.some(p => p.test(text));
        const rect = heading.getBoundingClientRect();
        const fontSize = parseInt(window.getComputedStyle(heading).fontSize) || 16;

        results.push({
          tag: heading.tagName,
          text: text.substring(0, 100),
          length: text.length,
          excluded,
          fontSize,
          top: rect.top
        });
      }
      return results;
    });

    console.log('Title candidates:', JSON.stringify(titleData, null, 2));

    // Test description extraction
    console.log('\n--- Testing Description Extraction ---');
    const descData = await page.evaluate(() => {
      const containers = Array.from(document.querySelectorAll('article, main, [role="main"]'));
      console.log(`Found ${containers.length} main containers`);

      const results = [];
      for (const container of containers.slice(0, 3)) {
        const text = container.textContent || '';
        const textLength = text.trim().length;
        const rect = container.getBoundingClientRect();

        results.push({
          tag: container.tagName,
          className: container.className.substring(0, 50),
          textLength,
          top: rect.top,
          width: rect.width,
          height: rect.height
        });
      }
      return results;
    });

    console.log('Description containers:', JSON.stringify(descData, null, 2));

    await page.close();
  }

  await browser.close();
}

testExtraction().catch(console.error);
