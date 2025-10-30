# Job Crawler Bot

A 3-stage job crawler system that discovers job listing pages via Google Custom Search API, extracts direct job links from those pages, and scrapes detailed job information. Built with Node.js and Puppeteer.

## Features

- **Stage 1**: Uses Google Custom Search API to find job listing page URLs based on custom queries
- **Stage 2**: Visits job listing pages with Puppeteer and extracts direct job posting links
- **Stage 3**: Scrapes detailed job information (title, description, location, skills) from job pages
- Full control via environment variables (concurrency, headless mode, timeouts, selectors)
- Automatic deduplication across multiple runs
- Retry logic with exponential backoff
- CSV output for all stages

## Prerequisites

- Node.js 18.x or higher
- Google Custom Search API credentials:
  - API Key ([Get one here](https://developers.google.com/custom-search/v1/overview))
  - Search Engine ID ([Create one here](https://programmablesearchengine.google.com/))

## Installation

```bash
npm install
cp .env.example .env
# Edit .env with your API credentials and settings
```

## Usage

### Run All Stages Sequentially

```bash
npm start
```

Runs Stage 1 → Stage 2 → Stage 3 in sequence.

### Run Individual Stages

```bash
npm start -- --stage=1    # Run only Stage 1 (Google API search)
npm start -- --stage=2    # Run only Stage 2 (extract job links)
npm start -- --stage=3    # Run only Stage 3 (extract job details)
```

## Environment Variables

All settings are configured via the `.env` file. Copy `.env.example` to `.env` and customize:

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `GOOGLE_API_KEY` | Your Google Custom Search API key | `AIzaSyD...` |
| `GOOGLE_SEARCH_ENGINE_ID` | Your search engine ID | `a1b2c3d4e5...` |
| `SEARCH_QUERY` | Search query to use | `site:boards.greenhouse.io` |

### Crawler Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `CONCURRENCY` | `5` | Number of concurrent pages to process in Stages 2 & 3 |
| `MAX_PAGES` | `10` | Number of pages to fetch from Google (10 results per page) |
| `HEADLESS` | `true` | Run browser in headless mode (`true`/`false`) |
| `PAGE_TIMEOUT` | `30000` | Page load timeout in milliseconds |
| `USER_AGENT` | Mozilla string | User agent for Puppeteer |

### Retry Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_RETRIES` | `3` | Maximum retry attempts for failed operations |
| `RETRY_DELAY` | `2000` | Base delay between retries in milliseconds |

### Output

| Variable | Default | Description |
|----------|---------|-------------|
| `OUTPUT_DIR` | `./output` | Directory for CSV output files |

### Selectors

Customize CSS selectors for extracting data. Multiple selectors are tried in order (comma-separated):

**Stage 2 - Job Links Extraction:**
- `JOB_LINK_SELECTORS`: Default `a[href*="/jobs/"],a[href*="/job/"],a[href*="/careers/"]`

**Stage 3 - Job Details Extraction:**
- `JOB_TITLE_SELECTORS`: Default `h1,.job-title,[class*="title"]`
- `JOB_DESCRIPTION_SELECTORS`: Default `.job-description,[class*="description"],.content`
- `JOB_LOCATION_SELECTORS`: Default `.location,[class*="location"],[data-location]`
- `JOB_SKILLS_SELECTORS`: Default `.skills,[class*="skill"],[class*="requirement"]`

## Output Files

All CSV files are saved to the `output/` directory:

### output/urls.csv (Stage 1)
```csv
url
https://boards.greenhouse.io/company1/jobs
https://boards.greenhouse.io/company2/jobs
```

Single column containing job listing page URLs from Google search.

### output/job_links.csv (Stage 2)
```csv
url
https://boards.greenhouse.io/company1/jobs/123456
https://boards.greenhouse.io/company1/jobs/789012
```

Single column containing direct job posting URLs extracted from listing pages.

### output/jobs_data.csv (Stage 3)
```csv
url,title,description,location,skills
https://boards.greenhouse.io/company1/jobs/123456,"Senior Software Engineer","We are looking for...","San Francisco","JavaScript; React; Node.js"
```

Multiple columns with complete job details:
- **url**: Direct link to job posting
- **title**: Job title
- **description**: Job description (HTML stripped, plain text)
- **location**: Job location
- **skills**: Skills/requirements (semicolon-separated)

## How It Works

1. **Stage 1** queries Google Custom Search API with your search query (e.g., `site:boards.greenhouse.io`)
2. **Stage 2** visits each URL from Stage 1 using Puppeteer and extracts all job posting links
3. **Stage 3** visits each job URL from Stage 2 and extracts detailed information

All stages support:
- **Deduplication**: Running multiple times won't create duplicate entries
- **Retry logic**: Failed requests are retried with exponential backoff
- **Concurrency control**: Stages 2 & 3 process multiple pages in parallel
- **Error handling**: Individual failures don't stop the entire process

## Troubleshooting

### Google API Quota Exceeded

**Error**: `Google API quota exceeded or invalid credentials`

**Solution**:
- Check your API key is correct
- Verify you haven't exceeded your daily quota (100 queries/day on free tier)
- Wait 24 hours for quota to reset or upgrade your plan

### Puppeteer Installation Issues

**Error**: `Failed to launch browser`

**Solution**:
```bash
# On Linux, install required dependencies:
sudo apt-get install -y chromium-browser
# Or install system libraries:
sudo apt-get install -y gconf-service libasound2 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgcc1 libgconf-2-4 libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-0 libnspr4 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 ca-certificates fonts-liberation libappindicator1 libnss3 lsb-release xdg-utils wget
```

### Selectors Not Finding Elements

**Error**: No data extracted, empty fields in output

**Solution**:
- Open a sample page manually and inspect the HTML structure
- Update selector environment variables in `.env` to match the actual page structure
- Try more generic selectors first, then refine
- Use browser DevTools to test selectors: `document.querySelectorAll('your-selector')`

### Rate Limiting / Too Many Requests

**Error**: Pages timing out or returning 429 errors

**Solution**:
- Reduce `CONCURRENCY` in `.env` (try `CONCURRENCY=2` or `CONCURRENCY=1`)
- Increase `PAGE_TIMEOUT` to give pages more time to load
- Add delays between requests (reduce concurrency further)

## Example Workflow

```bash
# 1. Set up environment
cp .env.example .env
# Edit .env with your Google API credentials

# 2. Run Stage 1 to find job listing pages
npm start -- --stage=1
# Output: output/urls.csv with job board URLs

# 3. Run Stage 2 to extract job links
npm start -- --stage=2
# Output: output/job_links.csv with direct job URLs

# 4. Run Stage 3 to get job details
npm start -- --stage=3
# Output: output/jobs_data.csv with complete job information

# Or run everything at once:
npm start
```

## Project Structure

```
job-crawler-bot/
├── src/
│   ├── index.js                 # Main entry point
│   ├── config.js                # Environment variable loader
│   ├── crawlers/
│   │   ├── stage1-search.js     # Google Custom Search API crawler
│   │   ├── stage2-links.js      # Job listing page crawler
│   │   └── stage3-details.js    # Job details extractor
│   └── utils/
│       ├── csv-handler.js       # CSV operations
│       └── logger.js            # Logging utility
├── output/                      # CSV output files (gitignored)
├── .env                         # Your environment variables (gitignored)
├── .env.example                 # Environment variable template
├── package.json
└── README.md
```

## License

ISC
