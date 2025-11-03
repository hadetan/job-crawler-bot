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

#### Stage 1: Google Search with Checkpointing

Stage 1 now supports request IDs, checkpointing, and resume functionality:

```bash
# Run with auto-generated request ID
npm start -- --stage=1

# Run with custom request ID
npm start -- --stage=1 --id=nov_03_gh

# Resume from failed page (automatically detects and resumes)
npm start -- --stage=1 --id=nov_03_gh

# Reset progress and start fresh (keeps CSV data)
npm start -- --stage=1 --id=nov_03_gh --clean
```

**Stage 1 Features:**
- **Request ID System**: Each run gets a unique ID (auto-generated 6-digit or custom via `--id`)
- **Dedicated Folders**: Results saved in `/output/{requestId}/` with separate CSV and progress tracking
- **Checkpoint & Resume**: Automatically resumes from failed pages without re-fetching successful pages
- **Max Retry Limit**: Stops after 3 failed attempts (configurable via `MAX_RETRY_COUNT`)
- **Clean Flag**: Reset progress with `--clean` while preserving collected URLs
- **Duplicate Handling**: Automatically skips duplicate URLs across pages
- **API Limit Detection**: Gracefully handles Google's 100-result (10-page) limit

#### Stage 2 & 3

```bash
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
| `MAX_RETRY_COUNT` | `3` | Maximum retry attempts for Stage 1 page failures (checkpoint system) |

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

## How It Works

### Stage 1: Google Search with Checkpointing

Stage 1 queries Google Custom Search API with your search query (e.g., `site:boards.greenhouse.io`) and implements a robust checkpoint system:

1. **Request ID Assignment**: Each run gets a unique ID (auto-generated or custom)
2. **Folder Creation**: Creates `/output/{requestId}/` with `google-results.csv` and `report.json`
3. **Page-by-Page Fetching**: Fetches up to 10 pages (100 results) from Google API
4. **Progress Tracking**: Records success/failure of each page in `report.json`
5. **Data Extraction**: Extracts URL, snippet, and logo from search results
6. **Duplicate Detection**: Skips URLs already found in previous pages
7. **Error Handling**: Saves error details for failed pages and supports resume

**Checkpoint/Resume Flow:**
- If a page fails, the next run with the same `--id` automatically resumes from that page
- Retry counter increments on each attempt (max 3 attempts by default)
- Use `--clean` flag to reset progress and start from page 1

**API Limit Handling:**
- Google Custom Search API has a hard limit of 100 results (10 pages)
- Crawler detects this limit and stops gracefully with a clear message

### Stage 2 & 3

2. **Stage 2** visits each URL from Stage 1 using Puppeteer and extracts all job posting links
3. **Stage 3** visits each job URL from Stage 2 and extracts detailed information

All stages support:
- **Deduplication**: Running multiple times won't create duplicate entries
- **Retry logic**: Failed requests are retried with exponential backoff
- **Concurrency control**: Stages 2 & 3 process multiple pages in parallel
- **Error handling**: Individual failures don't stop the entire process

## Troubleshooting

### Stage 1 Issues

#### Request Already Completed

**Message**: `All pages already completed successfully for request ID {id}. Use --clean to start fresh.`

**Solution**:
- Use `--clean` flag to reset and start over: `npm start -- --stage=1 --id=your_id --clean`
- Or use a new request ID: `npm start -- --stage=1 --id=new_id`

#### Max Retry Limit Reached

**Message**: `⚠️  Max retry limit (3) reached for page {X}`

**Solution**:
- Check the error in `output/{requestId}/report.json` for details
- Common causes: network issues, API quota exceeded, rate limiting
- Fix the underlying issue, then use `--clean` to restart
- Or increase `MAX_RETRY_COUNT` in `.env` (not recommended without fixing root cause)

#### Duplicate URLs Skipped

**Message**: `Duplicates skipped: {count}`

**Info**: This is normal behavior. Google search results may contain the same URL on different pages. The crawler automatically deduplicates to prevent redundant processing in later stages.

### Google API Issues

#### Google API Quota Exceeded

**Error**: `Google API quota exceeded or invalid credentials`

**Solution**:
- Check your API key is correct in `.env`
- Verify you haven't exceeded your daily quota (100 queries/day on free tier)
- Each page counts as 1 query, so 10 pages = 10 queries
- Wait 24 hours for quota to reset or upgrade your plan
- Check quota usage: [Google Cloud Console](https://console.cloud.google.com/apis/dashboard)

#### API Result Limit Reached

**Message**: `Reached Google API result limit (100 results/10 pages). Stopping pagination.`

**Info**: This is expected behavior. Google Custom Search API has a hard limit of 100 results per query. If you need more results:
- Use more specific search queries
- Run multiple searches with different queries
- Use different request IDs for different query variations

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

### Basic Usage

```bash
# 1. Set up environment
cp .env.example .env
# Edit .env with your Google API credentials

# 2. Run Stage 1 to find job listing pages (with auto-generated ID)
npm start -- --stage=1
# Output: output/123456/google-results.csv with job board URLs
#         output/123456/report.json with progress tracking

# 3. Run Stage 2 to extract job links
npm start -- --stage=2
# Output: output/job_links.csv with direct job URLs

# 4. Run Stage 3 to get job details
npm start -- --stage=3
# Output: output/jobs_data.csv with complete job information

# Or run everything at once:
npm start
```

### Advanced Stage 1 Usage

```bash
# Custom request ID for tracking
npm start -- --stage=1 --id=nov_03_greenhouse

# Resume after a failure (continues from failed page)
npm start -- --stage=1 --id=nov_03_greenhouse
# Output: "Resuming from page 7 where previous run failed"

# Check if already complete
npm start -- --stage=1 --id=nov_03_greenhouse
# Output: "All pages already completed successfully. Use --clean to start fresh."

# Reset and start over (keeps existing CSV data)
npm start -- --stage=1 --id=nov_03_greenhouse --clean
# Output: "Clean flag detected. Resetting progress for request ID nov_03_greenhouse"

# Multiple request IDs can coexist
npm start -- --stage=1 --id=company_A
npm start -- --stage=1 --id=company_B
# Each has its own folder: output/company_A/ and output/company_B/
```

### Handling Stage 1 Failures

**Scenario 1: Network Error on Page 5**
```bash
# Run fails on page 5 due to network timeout
npm start -- --stage=1 --id=my_run
# Output: "Failed to fetch page 5: Network timeout"
#         report.json shows: page 5 status=false, retryCount=1

# Resume automatically
npm start -- --stage=1 --id=my_run
# Output: "Resuming from page 5 where previous run failed"
#         Continues from page 5, increments retryCount to 2
```

**Scenario 2: Max Retries Reached**
```bash
# After 3 failed attempts on page 5
npm start -- --stage=1 --id=my_run
# Output: "⚠️  Max retry limit (3) reached for page 5"
#         "Error: Network timeout"
#         "This page will be skipped. Review full error in report.json"
#         "Exiting..."

# Fix the issue (check network, API quota, etc.)
# Then use --clean to restart
npm start -- --stage=1 --id=my_run --clean
```

**Scenario 3: Google API 100-Result Limit**
```bash
npm start -- --stage=1 --id=large_search
# Output: "Reached Google API result limit (100 results/10 pages). Stopping pagination."
# This is normal - Google limits Custom Search to 100 results per query
```

## Project Structure

```
job-crawler-bot/
├── src/
│   ├── index.js                      # Main entry point
│   ├── config.js                     # Environment variable loader
│   ├── crawlers/
│   │   ├── stage1-search.js          # Google Custom Search API crawler
│   │   ├── stage2-links.js           # Job listing page crawler
│   │   └── stage3-details.js         # Job details extractor
│   ├── extractors/
│   │   ├── index.js                  # Extractor utilities
│   │   ├── intelligent-analysis.js   # AI-based job data extraction
│   │   └── structured-data.js        # Structured data extraction
│   ├── utils/
│   │   ├── cookie-handler.js         # Cookie management
│   │   ├── csv-handler.js            # CSV operations
│   │   ├── description-cleaner.js    # Clean and format job descriptions
│   │   ├── dom-helpers.js            # DOM manipulation utilities
│   │   ├── extract-job-details.js    # Job detail extraction logic
│   │   ├── file-helpers.js           # File system operations
│   │   ├── format-helpers.js         # Data formatting utilities
│   │   ├── index.js                  # Utils index
│   │   ├── job-links.js              # Job link processing
│   │   ├── logger.js                 # Logging utility
│   │   ├── process-job-url.js        # URL processing
│   │   └── request-helpers.js        # Request ID and checkpoint management (Stage 1)
│   └── validators/
│       ├── content-validator.js      # Content validation
│       └── index.js                  # Validators index
├── output/                           # CSV output files (gitignored)
│   ├── {requestId}/                  # Stage 1 results per request ID
│   │   ├── google-results.csv        # Search results with metadata
│   │   └── report.json               # Progress tracking for checkpoint/resume
│   ├── job_links.csv                 # Stage 2 results
│   └── jobs_data.csv                 # Stage 3 results
├── .env                              # Your environment variables (gitignored)
├── .env.example                      # Environment variable template
├── STAGE1_STORY.md                   # Stage 1 implementation documentation
├── package.json
└── README.md
```

## License

ISC
