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

#### Stage 1: Google Search

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
- **Dedicated Folders**: Results saved in `/output/job_boards/{requestId}/` with separate CSV and progress tracking
- **Checkpoint & Resume**: Automatically resumes from failed pages without re-fetching successful pages
- **Max Retry Limit**: Stops after 3 failed attempts (configurable via `MAX_RETRY_COUNT`)
- **Clean Flag**: Reset progress with `--clean` while preserving collected URLs
- **Duplicate Handling**: Automatically skips duplicate URLs across pages
- **API Limit Detection**: Gracefully handles Google's 100-result (10-page) limit

#### Stage 2: Job Link Extraction

Stage 2 reads job board URLs from Stage 1 and extracts individual job posting links with checkpoint and resume functionality:

```bash
# Run with custom requestId and jobId
npm start -- --stage=2 --run=nov_03_gh --id=nov_03_crawl

# Run with auto-generated jobId
npm start -- --stage=2 --run=nov_03_gh

# Resume from checkpoint (automatically detects)
npm start -- --stage=2 --run=nov_03_gh --id=nov_03_crawl

# Reset job board URLs to pending and start fresh
npm start -- --stage=2 --run=nov_03_gh --id=nov_03_crawl --clean
```

**Stage 2 Features:**
- **Job ID System**: Each run gets a unique ID (auto-generated 6-digit or custom via `--id`)
- **Request ID Required**: Must specify `--run={requestId}` to indicate which Stage 1 output to read
- **Dedicated Folders**: Results saved in `/output/job_links/{jobId}/` with separate CSV and progress tracking
- **Checkpoint & Resume**: Automatically resumes from unprocessed or failed job board URLs
- **Clean Flag**: Reset job board URLs to pending with `--clean` (preserves extracted job links)
- **Duplicate Handling**: Automatically skips duplicate job URLs across different job boards
- **STATUS Updates**: Updates Stage 1's google-results.csv with completion status and job counts
- **Error Recovery**: Continues processing remaining URLs even if some fail

#### Stage 3

```bash
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
2. **Folder Creation**: Creates `/output/job_boards/{requestId}/` with `google-results.csv` and `report.json`
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

2. **Stage 2** reads job board URLs from Stage 1's output, visits each URL using Puppeteer, and extracts all job posting links with checkpoint support
3. **Stage 3** visits each job URL from Stage 2 and extracts detailed information

All stages support:
- **Deduplication**: Running multiple times won't create duplicate entries
- **Retry logic**: Failed requests are retried with exponential backoff
- **Concurrency control**: Stages 2 & 3 process multiple pages in parallel
- **Error handling**: Individual failures don't stop the entire process
- **Checkpoint/Resume**: Automatically resume from failures or incomplete runs

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
- Check the error in `output/job_boards/{requestId}/report.json` for details
- Common causes: network issues, API quota exceeded, rate limiting
- Fix the underlying issue, then use `--clean` to restart
- Or increase `MAX_RETRY_COUNT` in `.env` (not recommended without fixing root cause)

#### Duplicate URLs Skipped

**Message**: `Duplicates skipped: {count}`

**Info**: This is normal behavior. Google search results may contain the same URL on different pages. The crawler automatically deduplicates to prevent redundant processing in later stages.

### Stage 2 Issues

#### Missing --run Parameter

**Error**: `Stage 2 requires --run parameter. Usage: npm start -- --stage=2 --run={requestId} [--id={jobId}] [--clean]`

**Solution**:
- Stage 2 requires a `--run` parameter to specify which Stage 1 output to read
- Example: `npm start -- --stage=2 --run=nov_03_gh`

#### Stage 1 Run Not Found

**Error**: `Stage 1 run 'xyz' not found at output/job_boards/xyz`

**Solution**:
- Verify the requestId exists by checking `output/job_boards/` folder
- Run Stage 1 first: `npm start -- --stage=1 --id=xyz`
- Check for typos in the --run parameter

#### All Job Board URLs Already Completed

**Message**: `All job board URLs completed for jobId {id}. Use --clean to reset.`

**Solution**:
- All job board URLs have been successfully processed
- Use `--clean` to reset and re-extract: `npm start -- --stage=2 --run=xyz --id=abc --clean`
- Or use a new jobId to create a separate extraction run

#### Job Board Extraction Failures

**Message**: `Failed to extract from {url}: {error}`

**Info**: Stage 2 continues processing remaining URLs even if some fail. Check the final summary for failure count.

**Solution**:
- Check `output/job_links/{jobId}/report.json` for detailed error messages
- Failed URLs are marked with STATUS='failed' in google-results.csv
- Re-run Stage 2 with the same jobId to retry failed URLs
- Common causes: page load timeouts, changed page structure, rate limiting

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

# 2. Run Stage 1 to find job listing pages
npm start -- --stage=1 --id=nov_03_gh
# Output: output/job_boards/nov_03_gh/google-results.csv with job board URLs
#         output/job_boards/nov_03_gh/report.json with progress tracking

# 3. Run Stage 2 to extract job links
npm start -- --stage=2 --run=nov_03_gh --id=nov_03_crawl
# Output: output/job_links/nov_03_crawl/jobs.csv with direct job URLs
#         output/job_links/nov_03_crawl/report.json with extraction progress

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

### Advanced Stage 2 Usage

```bash
# Run Stage 2 with custom jobId and requestId
npm start -- --stage=2 --run=nov_03_gh --id=nov_03_crawl

# Run Stage 2 with auto-generated jobId
npm start -- --stage=2 --run=nov_03_gh
# Output: "No jobId provided. Generated jobId: 456789"

# Resume after partial completion (automatic)
npm start -- --stage=2 --run=nov_03_gh --id=nov_03_crawl
# Output: "Resuming Stage 2: 5 URLs already processed, 3 URLs remaining"

# Check if already complete
npm start -- --stage=2 --run=nov_03_gh --id=nov_03_crawl
# Output: "All job board URLs completed for jobId nov_03_crawl. Use --clean to reset."

# Reset job board URLs and re-extract
npm start -- --stage=2 --run=nov_03_gh --id=nov_03_crawl --clean
# Output: "Clean flag detected. Reset 8 job board URLs to pending"

# Multiple jobIds can coexist for same requestId
npm start -- --stage=2 --run=nov_03_gh --id=first_extraction
npm start -- --stage=2 --run=nov_03_gh --id=second_extraction
# Each has its own folder: output/job_links/first_extraction/ and output/job_links/second_extraction/
```

### Handling Stage 2 Failures

**Scenario 1: Some Job Boards Fail**
```bash
# Run Stage 2, some URLs fail during extraction
npm start -- --stage=2 --run=nov_03_gh --id=my_crawl
# Output: "Failed to extract from https://example.com/jobs: Navigation timeout"
#         "✅ Stage 2 complete for jobId: my_crawl"
#         "Failed extractions: 2"
#         google-results.csv shows failed URLs with STATUS='failed'

# Resume to retry failed URLs (automatic)
npm start -- --stage=2 --run=nov_03_gh --id=my_crawl
# Only processes the 2 failed URLs
```

**Scenario 2: Clean and Re-extract**
```bash
# You want to re-extract all job links from scratch
npm start -- --stage=2 --run=nov_03_gh --id=my_crawl --clean
# Output: "Clean flag detected. Reset 10 job board URLs to pending"
#         Processes all URLs again, adds new job links to existing jobs.csv
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
│   │   └── request-helpers.js        # Request/Job ID and checkpoint management
│   └── validators/
│       ├── content-validator.js      # Content validation
│       └── index.js                  # Validators index
├── output/                           # CSV output files (gitignored)
│   ├── job_boards/                   # Stage 1 results
│   │   └── {requestId}/              # Per request ID folder
│   │       ├── google-results.csv    # Search results with STATUS tracking
│   │       └── report.json           # Progress tracking for checkpoint/resume
│   ├── job_links/                    # Stage 2 results
│   │   └── {jobId}/                  # Per job ID folder
│   │       ├── jobs.csv              # Extracted job posting URLs
│   │       └── report.json           # Link extraction progress tracking
│   └── jobs_data.csv                 # Stage 3 results (job details)
│   └── jobs_data.csv                 # Stage 3 results
├── .env                              # Your environment variables (gitignored)
├── .env.example                      # Environment variable template
├── STAGE1_STORY.md                   # Stage 1 implementation documentation
├── STAGE2_STORY.md                   # Stage 2 implementation documentation
├── package.json
└── README.md
```

## License

ISC
