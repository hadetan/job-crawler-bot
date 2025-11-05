# Job Crawler Bot

A 3-stage job crawler system that discovers job listing pages via multiple search providers, extracts direct job links from those pages, and scrapes detailed job information. Built with Node.js and Puppeteer.

> **🆕 New in v2.0**: Multi-provider search architecture! Now supports Google Custom Search API and SerpAPI with multiple search engines (Google, Bing, Yahoo, DuckDuckGo, etc.). Results are organized by provider for better tracking. See [MULTI_PROVIDER_GUIDE.md](MULTI_PROVIDER_GUIDE.md) for details.

## Features

- **Stage 1**: Multi-provider search architecture supporting:d - Complete usage guide
✅ ARCHITECTURE.md - Visual architecture diagrams
🧪 Test Results
  - **Google Custom Search API** - Traditional Google search with up to 100 results
  - **SerpAPI** - Multi-engine support (Google, Bing, Yahoo, DuckDuckGo, etc.)
  - Provider-specific folder organization
- **Stage 2**: Visits job listing pages with Puppeteer and extracts direct job posting links
- **Stage 3**: Scrapes detailed job information (title, description, location, skills) from job pages
- Full control via environment variables (concurrency, headless mode, timeouts, selectors)
- Automatic deduplication across multiple runs
- Retry logic with exponential backoff
- CSV output for all stages
- Checkpoint and resume functionality for all stages

## Prerequisites

- Node.js 18.x or higher
- At least one search provider configured:
  - **Option 1**: Google Custom Search API credentials
    - API Key ([Get one here](https://developers.google.com/custom-search/v1/overview))
    - Search Engine ID ([Create one here](https://programmablesearchengine.google.com/))
  - **Option 2**: SerpAPI credentials
    - API Key ([Sign up here](https://serpapi.com/))
    - Supports multiple search engines (Google, Bing, Yahoo, DuckDuckGo, Baidu, Yandex)

## Installation

```bash
npm install
cp .env.example .env
# Edit .env with your API credentials and settings
```

## Quick Start

### With Google Custom Search

```bash
# 1. Add to .env:
#    GOOGLE_API_KEY=your_key
#    GOOGLE_SEARCH_ENGINE_ID=your_id
#    SEARCH_QUERY=site:boards.greenhouse.io

# 2. Run search
npm start -- --stage=1 --id=my-search --use=google

# 3. Extract job links
npm start -- --stage=2 --run=my-search --id=my-jobs

# 4. Get job details
npm start -- --stage=3 --run=my-jobs
```

### With SerpAPI (Multi-Engine)

```bash
# 1. Add to .env:
#    SERP_API_KEY=your_key
#    SEARCH_QUERY=site:boards.greenhouse.io

# 2. Run search with your preferred engine
npm start -- --stage=1 --id=my-search --use=serp --engine=bing

# 3. Extract job links (same as above)
npm start -- --stage=2 --run=my-search --id=my-jobs

# 4. Get job details (same as above)
npm start -- --stage=3 --run=my-jobs
```

## Usage

### Run All Stages Sequentially

```bash
npm start
```

**Note**: You can also run the stages separately:

```bash
# Recommended workflow:
npm start -- --stage=1 --id=my_run
npm start -- --stage=2 --run=my_run --id=my_crawl
npm start -- --stage=3 --run=my_crawl --id=my_extraction
```

### Run Individual Stages

#### Stage 1: Search (Multi-Provider Support)

Stage 1 supports multiple search providers with request IDs, checkpointing, and resume functionality:

**Available Providers:**
- `google` - Google Custom Search API (default, max 10 pages/100 results)
- `serp` - SerpAPI with multi-engine support (Google, Bing, Yahoo, DuckDuckGo, etc.)

```bash
# Use default provider (Google Custom Search)
npm start -- --stage=1

# Use Google Custom Search explicitly
npm start -- --stage=1 --use=google

# Use SerpAPI with Google engine
npm start -- --stage=1 --use=serp

# Use SerpAPI with Bing engine
npm start -- --stage=1 --use=serp --engine=bing

# Use SerpAPI with Yahoo engine
npm start -- --stage=1 --use=serp --engine=yahoo

# With custom request ID
npm start -- --stage=1 --id=my-run --use=serp --engine=bing

# Resume from failed page (automatically detects and resumes)
npm start -- --stage=1 --id=my-run --use=google

# Reset progress and start fresh (keeps CSV data)
npm start -- --stage=1 --id=my-run --use=serp --clean
```

**Provider-Specific Folder Structure:**
Results are now organized by provider:
- Google Custom Search: `/output/job_boards/google/{requestId}/`
- SerpAPI (Google): `/output/job_boards/serp/{requestId}/`
- SerpAPI (Bing): `/output/job_boards/serp/{requestId}/`

Each folder contains:
- `google-results.csv` - Search results with URLs and metadata
- `report.json` - Progress tracking with provider information

**Stage 1 Features:**
- **Multi-Provider Support**: Choose between Google Custom Search or SerpAPI
- **Multi-Engine Support**: SerpAPI supports Google, Bing, Yahoo, DuckDuckGo, Baidu, Yandex
- **Provider-Specific Organization**: Results organized in `/output/job_boards/{provider}/{requestId}/`
- **Request ID System**: Each run gets a unique ID (auto-generated 6-digit or custom via `--id`)
- **Checkpoint & Resume**: Automatically resumes from failed pages without re-fetching successful pages
- **Max Retry Limit**: Stops after 3 failed attempts (configurable via `MAX_RETRY_COUNT`)
- **Clean Flag**: Reset progress with `--clean` while preserving collected URLs
- **Duplicate Handling**: Automatically skips duplicate URLs across pages
- **Provider Metadata**: Stores provider and engine information in report.json

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

#### Stage 3: Job Details Extraction

Stage 3 reads job URLs from Stage 2 and extracts detailed information with retry logic, resume capability, and force mode:

```bash
# Run with custom runId and extractionId
npm start -- --stage=3 --run=nov_03_crawl --id=nov_03_extraction

# Run with auto-generated extractionId
npm start -- --stage=3 --run=nov_03_crawl

# Resume from checkpoint (automatically detects)
npm start -- --stage=3 --run=nov_03_crawl --id=nov_03_extraction

# Force mode: retry only failed URLs (ignores retry count)
npm start -- --stage=3 --run=nov_03_crawl --id=nov_03_extraction --force
```

**Stage 3 Features:**
- **Extraction ID System**: Each run gets a unique ID (auto-generated 6-digit or custom via `--id`)
- **Run ID Required**: Must specify `--run={jobId}` to indicate which Stage 2 output to read
- **Dedicated Folders**: Results saved in `/output/jobs/{extractionId}/` with company-based organization
- **Retry Logic**: Automatically retries failed extractions up to 3 times (configurable via `MAX_RETRY_COUNT`)
- **Resume Capability**: Skips completed jobs and continues from pending/failed URLs
- **Force Mode**: Use `--force` to retry only failed URLs, ignoring retry count limits
- **CSV Status Updates**: Updates Stage 2's jobs.csv with extraction status and file paths
- **Company Organization**: Jobs saved as `{companyName}/{number}.txt` for easy browsing
- **Detail Reports**: Tracks passed/failed URLs per company in report.json
- **Comprehensive Logging**: Shows extraction methods, success rates, and company-wise job counts

## Environment Variables

All settings are configured via the `.env` file. Copy `.env.example` to `.env` and customize:

### Required Variables

| Variable | Description | Example | Required For |
|----------|-------------|---------|--------------|
| `GOOGLE_API_KEY` | Your Google Custom Search API key | `AIzaSyD...` | Google provider |
| `GOOGLE_SEARCH_ENGINE_ID` | Your search engine ID | `a1b2c3d4e5...` | Google provider |
| `SERP_API_KEY` | Your SerpAPI key | `abc123...` | SerpAPI provider |
| `SEARCH_QUERY` | Search query to use | `site:boards.greenhouse.io` | All providers |

**Note**: You need at least one provider configured (either Google Custom Search OR SerpAPI).

### Crawler Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `CONCURRENCY` | `5` | Number of concurrent pages to process in Stages 2 & 3 |
| `MAX_PAGES` | `10` | Number of pages to fetch from search provider |
| `HEADLESS` | `true` | Run browser in headless mode (`true`/`false`) |
| `PAGE_TIMEOUT` | `30000` | Page load timeout in milliseconds |
| `USER_AGENT` | Mozilla string | User agent for Puppeteer |

### Search Provider Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `DEFAULT_SEARCH_PROVIDER` | `google` | Default provider if `--use` not specified (`google` or `serp`) |

**Provider Limits:**
- Google Custom Search: Maximum 10 pages (100 results) per query
- SerpAPI: No hard page limit (depends on your plan)

### Retry Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_RETRIES` | `3` | Maximum retry attempts for failed operations (internal retry within processJobURL) |
| `RETRY_DELAY` | `2000` | Base delay between retries in milliseconds (exponential backoff) |
| `MAX_RETRY_COUNT` | `3` | Maximum retry attempts for Stage 1 page failures and Stage 3 job extraction failures (checkpoint system) |

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

### Stage 1: Multi-Provider Search with Checkpointing

Stage 1 supports multiple search providers and implements a robust checkpoint system:

**Provider Selection:**
- Use `--use=google` for Google Custom Search API (default)
- Use `--use=serp` for SerpAPI with `--engine` parameter (google, bing, yahoo, etc.)

**Flow:**
1. **Provider Validation**: Checks if selected provider is configured (API keys present)
2. **Request ID Assignment**: Each run gets a unique ID (auto-generated or custom)
3. **Folder Creation**: Creates `/output/job_boards/{provider}/{requestId}/`
4. **Provider Initialization**: Creates appropriate provider instance with configuration
5. **Page-by-Page Fetching**: Fetches up to MAX_PAGES from selected search engine
6. **Progress Tracking**: Records success/failure of each page in `report.json` with provider info
7. **Data Extraction**: Normalizes results to standard format (URL, snippet, logo, metadata)
8. **Duplicate Detection**: Skips URLs already found in previous pages
9. **Error Handling**: Saves error details for failed pages and supports resume

**Provider Metadata in report.json:**
```json
{
  "provider_info": {
    "name": "serp",
    "displayName": "SerpAPI (Bing)",
    "searchEngine": "bing"
  },
  "google_report": [...]
}
```

**Checkpoint/Resume Flow:**
- If a page fails, the next run with the same `--id` automatically resumes from that page
- Retry counter increments on each attempt (max 3 attempts by default)
- Use `--clean` flag to reset progress and start from page 1

**Provider-Specific Features:**
- **Google Custom Search**: Hard limit of 100 results (10 pages), faster response
- **SerpAPI**: No hard page limit, supports multiple engines, slower but more flexible

### Stage 2 & 3

2. **Stage 2** reads job board URLs from Stage 1's output, visits each URL using Puppeteer, and extracts all job posting links with checkpoint support
3. **Stage 3** reads job URLs from Stage 2's output, visits each URL, extracts detailed job information

All stages support:
- **Deduplication**: Running multiple times won't create duplicate entries
- **Retry logic**: Failed requests are retried with exponential backoff
- **Concurrency control**: Stages 2 & 3 process multiple pages in parallel
- **Error handling**: Individual failures don't stop the entire process
- **Checkpoint/Resume**: Automatically resume from failures or incomplete runs

## Troubleshooting

### Stage 1 Issues

#### No Search Providers Configured

**Message**: `❌ No search providers are configured!`

**Solution**:
- Add at least one API key to your `.env` file:
  - For Google: `GOOGLE_API_KEY` and `GOOGLE_SEARCH_ENGINE_ID`
  - For SerpAPI: `SERP_API_KEY`

#### Unknown or Unavailable Provider

**Message**: `❌ Search provider 'xyz' is not configured or unavailable.`

**Solution**:
- Check available providers in the error message
- Valid providers: `google` (Google Custom Search) or `serp` (SerpAPI)
- Verify you have the required API keys in `.env`
- Example: `npm start -- --stage=1 --use=google` or `npm start -- --stage=1 --use=serp`

#### Invalid --engine Parameter

**Warning**: `⚠️  Warning: --engine parameter is only supported with --use=serp. Ignoring.`

**Solution**:
- The `--engine` parameter only works with SerpAPI provider
- Use: `npm start -- --stage=1 --use=serp --engine=bing`
- Don't use `--engine` with Google Custom Search

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

### Stage 3 Issues

#### Missing --run Parameter

**Error**: `Stage 3 requires --run parameter. Usage: npm start -- --stage=3 --run={jobId} [--id={extractionId}] [--force]`

**Solution**:
- Stage 3 requires a `--run` parameter to specify which Stage 2 output to read
- Example: `npm start -- --stage=3 --run=nov_03_crawl`

#### Job ID Not Found

**Error**: `Job ID 'xyz' not found at output/job_links/xyz`

**Solution**:
- Verify the jobId exists by checking `output/job_links/` folder
- Run Stage 2 first: `npm start -- --stage=2 --run=some_request --id=xyz`
- Check for typos in the --run parameter

#### No Jobs in jobs.csv

**Message**: `No jobs found in jobs.csv`

**Solution**:
- Stage 2 may not have extracted any job URLs
- Check `output/job_links/{jobId}/jobs.csv` to verify it has content
- Re-run Stage 2 if needed

#### Max Retry Limit Reached for Jobs

**Message**: `Skipped {count} URLs that reached max retry count (3)`

**Info**: Jobs that failed 3 times are automatically skipped to prevent infinite loops.

**Solution**:
- Check `output/jobs/{extractionId}/report.json` for error details
- Use `--force` flag to retry all failed URLs: `npm start -- --stage=3 --run=xyz --id=abc --force`
- Common causes: invalid URLs, page structure changes, anti-bot protection, navigation timeouts
- Consider updating selectors in `.env` if extraction logic fails consistently

#### Extraction Validation Failures

**Error**: `Validation failed for {url}: Failed to extract valid content`

**Info**: Extraction succeeded but validation failed (e.g., title is empty or "N/A").

**Solution**:
- Check if the page structure has changed
- Update selectors in `.env` (JOB_TITLE_SELECTORS, JOB_DESCRIPTION_SELECTORS, etc.)
- Some URLs may be listing pages or invalid job pages
- Review failed URLs in `output/jobs/{extractionId}/report.json`

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
# Edit .env with your API credentials (Google Custom Search OR SerpAPI)

# 2. Run Stage 1 to find job listing pages (using default provider)
npm start -- --stage=1 --id=nov_04_gh
# Output: output/job_boards/google/nov_04_gh/google-results.csv
#         output/job_boards/google/nov_04_gh/report.json

# 2a. Or use SerpAPI with Bing
npm start -- --stage=1 --id=nov_04_bing --use=serp --engine=bing
# Output: output/job_boards/serp/nov_04_bing/google-results.csv
#         output/job_boards/serp/nov_04_bing/report.json

# 3. Run Stage 2 to extract job links
npm start -- --stage=2 --run=nov_04_gh --id=nov_04_crawl
# Output: output/job_links/nov_04_crawl/jobs.csv
#         output/job_links/nov_04_crawl/report.json

# 4. Run Stage 3 to get job details
npm start -- --stage=3 --run=nov_04_crawl --id=nov_04_extraction
# Output: output/jobs/nov_04_extraction/{companyName}/{number}.txt
#         output/jobs/nov_04_extraction/report.json
```

### Multi-Provider Examples

```bash
# Compare results from different providers
npm start -- --stage=1 --id=google-run --use=google
npm start -- --stage=1 --id=serp-google-run --use=serp --engine=google
npm start -- --stage=1 --id=serp-bing-run --use=serp --engine=bing
npm start -- --stage=1 --id=serp-yahoo-run --use=serp --engine=yahoo

# Results are organized separately:
# output/job_boards/google/google-run/
# output/job_boards/serp/serp-google-run/
# output/job_boards/serp/serp-bing-run/
# output/job_boards/serp/serp-yahoo-run/

# Use different engines for different searches
npm start -- --stage=1 --id=tech-jobs --use=serp --engine=google
npm start -- --stage=1 --id=marketing-jobs --use=serp --engine=bing
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

### Advanced Stage 3 Usage

```bash
# Run Stage 3 with custom extractionId and jobId
npm start -- --stage=3 --run=nov_03_crawl --id=nov_03_extraction

# Run Stage 3 with auto-generated extractionId
npm start -- --stage=3 --run=nov_03_crawl
# Output: "No extractionId provided. Generated extractionId: 789012"

# Resume after partial completion (automatic)
npm start -- --stage=3 --run=nov_03_crawl --id=nov_03_extraction
# Output: "Jobs to process: 150, Already completed: 50"

# Force mode: retry only failed URLs (ignore retry count)
npm start -- --stage=3 --run=nov_03_crawl --id=nov_03_extraction --force
# Output: "Force mode: Processing only failed URLs (ignoring retry count)"

# Multiple extractions can coexist for same jobId
npm start -- --stage=3 --run=nov_03_crawl --id=first_run
npm start -- --stage=3 --run=nov_03_crawl --id=second_run
# Each has its own folder: output/jobs/first_run/ and output/jobs/second_run/
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

### Handling Stage 3 Failures

**Scenario 1: Some Job Extractions Fail**
```bash
# Run Stage 3, some URLs fail during extraction
npm start -- --stage=3 --run=nov_03_crawl --id=my_extraction
# Output: "Validation failed for https://example.com/job/123: No structured data found"
#         "✅ Stage 3 complete: 45 jobs saved"
#         "Summary - Total processed: 50, Successful: 45, Failed: 5"
#         jobs.csv shows failed URLs with STATUS='failed' and RETRY=1

# Resume to retry failed URLs (automatic)
npm start -- --stage=3 --run=nov_03_crawl --id=my_extraction
# Only processes the 5 failed URLs, increments RETRY to 2
```

**Scenario 2: Max Retry Limit Reached**
```bash
# After 3 failed attempts, URLs are skipped
npm start -- --stage=3 --run=nov_03_crawl --id=my_extraction
# Output: "Skipped 2 URLs that reached max retry count (3)"
#         Only processes URLs with RETRY < 3

# Use force mode to retry all failed URLs
npm start -- --stage=3 --run=nov_03_crawl --id=my_extraction --force
# Output: "Force mode: Processing only failed URLs (ignoring retry count)"
#         Retries all failed URLs regardless of retry count
```

**Scenario 3: Check Extraction Results**
```bash
# View organized job files
ls output/jobs/my_extraction/
# Output: affirm/  google/  stripe/  report.json

# View jobs for specific company
ls output/jobs/my_extraction/affirm/
# Output: 1.txt  2.txt  3.txt  4.txt  5.txt

# Check detail extraction report
cat output/jobs/my_extraction/report.json
# Shows passed/failed URLs organized by company
```

## Project Structure

```
job-crawler-bot/
├── src/
│   ├── index.js                      # Main entry point
│   ├── config.js                     # Environment variable loader
│   ├── crawlers/
│   │   ├── stage1-search.js          # Multi-provider search crawler
│   │   ├── stage2-links.js           # Job listing page crawler
│   │   └── stage3-details.js         # Job details extractor
│   ├── search-providers/             # Search provider implementations
│   │   ├── base-provider.js          # Abstract provider interface
│   │   ├── google-custom-search.js   # Google Custom Search provider
│   │   ├── serp-api.js               # SerpAPI provider
│   │   ├── provider-factory.js       # Provider factory
│   │   └── index.js                  # Provider exports
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
│   │   ├── process-job-url.js        # URL processing with retry logic
│   │   └── request-helpers.js        # Request/Job/Extraction ID and checkpoint management
│   └── validators/
│       ├── content-validator.js      # Content validation
│       └── index.js                  # Validators index
├── output/                           # CSV output files (gitignored)
│   ├── job_boards/                   # Stage 1 results (organized by provider)
│   │   ├── google/                   # Google Custom Search results
│   │   │   └── {requestId}/          # Per request ID folder
│   │   │       ├── google-results.csv    # Search results with STATUS tracking
│   │   │       └── report.json           # Progress tracking with provider info
│   │   └── serp/                     # SerpAPI results
│   │       └── {requestId}/          # Per request ID folder
│   │           ├── google-results.csv    # Search results with STATUS tracking
│   │           └── report.json           # Progress tracking with provider & engine info
│   ├── job_links/                    # Stage 2 results
│   │   └── {jobId}/                  # Per job ID folder
│   │       ├── jobs.csv              # Extracted job URLs
│   │       └── report.json           # Link extraction progress tracking
│   └── jobs/                         # Stage 3 results
│       └── {extractionId}/           # Per extraction ID folder
│           ├── {companyName}/        # Company-specific folders
│           │   ├── 1.txt             # Job details (formatted text)
│           │   ├── 2.txt
│           │   └── ...
│           └── report.json            # Detail extraction report per company
├── .env                               # Your environment variables (gitignored)
├── .env.example                       # Environment variable template
├── package.json
└── README.md
```

## License

ISC
