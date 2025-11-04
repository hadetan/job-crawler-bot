# 📋 Stage 2 Implementation Story

**Epic**: Job Link Extractor with Checkpoint and Resume System

**Goal**: Implement a robust job link extraction crawler that reads job board URLs from Stage 1, extracts individual job posting links, and tracks progress with resume capability.

---

## **Feature 1: Update Stage 1 Path Structure** 🔧

**As a** developer  
**I want** Stage 1 output to be organized under `/output/job_boards/{requestId}/`  
**So that** the project structure is clearer and Stage 1/Stage 2 outputs are separated

### Acceptance Criteria:
- [ ] Update `src/utils/request-helpers.js` to create folders at `/output/job_boards/{requestId}/`
- [ ] Ensure `google-results.csv` is created at `/output/job_boards/{requestId}/google-results.csv`
- [ ] Ensure `report.json` is created at `/output/job_boards/{requestId}/report.json`
- [ ] Update `src/crawlers/stage1-search.js` if any hardcoded paths exist
- [ ] Test Stage 1 with new path structure
- [ ] Update README.md documentation with new paths

---

## **Feature 2: Command-Line Argument Parsing for Stage 2** ⚙️ ✅

**As a** user  
**I want** to specify `--run` and `--id` parameters for Stage 2  
**So that** I can control which Stage 1 run to process and where to save results

### Acceptance Criteria:
- [ ] Parse `--run={requestId}` parameter (required for Stage 2)
- [ ] Parse `--id={jobId}` parameter (optional, auto-generate if not provided)
- [ ] Parse `--clean` flag (optional, resets job board URLs to pending)
- [ ] Command format: `npm start -- --stage=2 --run=nov_03_gh --id=nov_03_crawl`
- [ ] If `--id` not provided, auto-generate 6-digit numeric jobId using `generateRequestId()`
- [ ] Validate that `--run` parameter exists in `/output/job_boards/{requestId}/`
- [ ] Display error if `--run` parameter missing or folder doesn't exist

---

## **Feature 3: Job Links Folder Structure** 📁

**As a** developer  
**I want** Stage 2 to create dedicated folders for each job extraction run  
**So that** multiple extraction runs can coexist independently

### Acceptance Criteria:
- [ ] Create folder `/output/job_links/{jobId}/` on Stage 2 startup
- [ ] Create `jobs.csv` file with headers: `URL,STATUS,REMARKS,FILENAME`
- [ ] Create `report.json` file with structure:
```json
{
  "link_extraction_report": {}
}
```
- [ ] If jobId folder already exists, load existing files for resume
- [ ] Display message: `"Starting Stage 2 with jobId: {jobId}, reading from requestId: {requestId}"`

---

## **Feature 4: Read Stage 1 Google Results** 📖

**As a** Stage 2 crawler  
**I want** to read job board URLs from Stage 1's google-results.csv  
**So that** I know which job board pages to visit for extraction

### Acceptance Criteria:
- [ ] Read `google-results.csv` from `/output/job_boards/{requestId}/`
- [ ] Parse all columns: URL, STATUS, JOB_COUNT, SNIPPET, LOGO_URL, REMARKS
- [ ] Use custom CSV parser (following Stage 1 pattern, not csv-parse library)
- [ ] Filter URLs by STATUS field:
  - [ ] Include URLs with STATUS = `"pending"`
  - [ ] Include URLs with STATUS = `"failed"`
  - [ ] Skip URLs with STATUS = `"completed"` or `"done"`
- [ ] Display: `"Found {count} job board URLs to process (pending/failed)"`
- [ ] Handle case where no URLs need processing: `"All job board URLs already completed"`

---

## **Feature 5: Job Link Extraction with Progress Tracking** 🔍

**As a** crawler  
**I want** to extract job links from each job board page and track progress  
**So that** I can resume from failures and monitor extraction success

### Acceptance Criteria:
- [ ] Visit each job board URL from google-results.csv
- [ ] Use existing extraction logic in Stage 2 (don't modify extraction code)
- [ ] For each job board URL processed:
  - [ ] Extract all job posting links
  - [ ] Count number of links found
  - [ ] Track success/failure status
- [ ] After processing each job board URL:
  - [ ] Update `report.json` with extraction results:
```json
{
  "link_extraction_report": {
    "https://boards.greenhouse.io/company": {
      "status": true,
      "jobLinksFound": 15,
      "error": null
    }
  }
}
```
- [ ] Append extracted job links to `jobs.csv` with default values:
  - [ ] URL = extracted job posting URL
  - [ ] STATUS = `"pending"`
  - [ ] REMARKS = `""`
  - [ ] FILENAME = `""`
- [ ] Skip duplicate job URLs (don't add if already exists in jobs.csv)

---

## **Feature 6: Update Stage 1 Google Results Status** ✅

**As a** Stage 2 crawler  
**I want** to update the STATUS field in Stage 1's google-results.csv after processing  
**So that** I know which job board pages have been successfully processed

### Acceptance Criteria:
- [ ] After successfully extracting links from a job board URL:
  - [ ] Update STATUS to `"completed"` in google-results.csv
  - [ ] Update JOB_COUNT to number of job links found
- [ ] After failed extraction from a job board URL:
  - [ ] Update STATUS to `"failed"` in google-results.csv
  - [ ] Update REMARKS with error message (first 100 chars)
- [ ] Preserve all other fields (URL, SNIPPET, LOGO_URL)
- [ ] Use CSV-safe escaping for error messages

---

## **Feature 7: Checkpoint & Resume Logic** 🔄

**As a** user  
**I want** Stage 2 to automatically resume from where it left off  
**So that** I don't waste time re-processing successful extractions

### Acceptance Criteria:
- [ ] On startup, check if `report.json` exists for the given jobId
- [ ] Load existing `link_extraction_report` from report.json
- [ ] Cross-reference with google-results.csv to determine:
  - [ ] Which URLs have been processed (exist in report)
  - [ ] Which URLs are pending/failed (need processing)
- [ ] Only process URLs that are:
  - [ ] Not in `link_extraction_report`, OR
  - [ ] In `link_extraction_report` with `status: false`
- [ ] Display: `"Resuming Stage 2: {X} URLs already processed, {Y} URLs remaining"`
- [ ] If all URLs processed successfully:
  - [ ] Display: `"All job board URLs completed for jobId {id}. Use --clean to reset."`
  - [ ] Exit without processing

---

## **Feature 8: Clean Flag Functionality** 🧹

**As a** user  
**I want** to reset job board URL statuses to pending with --clean flag  
**So that** I can re-extract job links from all pages in the future

### Acceptance Criteria:
- [ ] Command: `npm start -- --stage=2 --run=nov_03_gh --id=nov_03_crawl --clean`
- [ ] When `--clean` flag provided:
  - [ ] Read `/output/job_boards/{requestId}/google-results.csv`
  - [ ] Update all non-pending STATUS values to `"pending"`
  - [ ] Reset JOB_COUNT to `0` for those rows
  - [ ] Clear REMARKS field
  - [ ] Save updated CSV back
  - [ ] Reset `link_extraction_report` to `{}` in jobId's report.json
  - [ ] Display: `"Clean flag detected. Reset {count} job board URLs to pending"`
- [ ] Do NOT delete jobs.csv (preserve extracted job links)
- [ ] Start processing from beginning

---

## **Feature 9: Duplicate Job Link Handling** 🔍

**As a** crawler  
**I want** to skip duplicate job URLs across different job board pages  
**So that** jobs.csv doesn't contain redundant entries

### Acceptance Criteria:
- [ ] Maintain a Set/Map of all job URLs added to jobs.csv in current session
- [ ] Load existing URLs from jobs.csv on startup
- [ ] Before adding job URL to jobs.csv, check if already exists
- [ ] If duplicate: skip and increment duplicate counter
- [ ] Log summary at end: `"Total job links found: {total}, New: {new}, Duplicates skipped: {count}"`

---

## **Feature 10: Error Handling & Reporting** ⚠️

**As a** developer  
**I want** comprehensive error handling and reporting  
**So that** I can diagnose and fix extraction issues

### Acceptance Criteria:
- [ ] Catch and handle errors during job board page processing:
  - [ ] Network timeouts
  - [ ] Page load failures
  - [ ] Selector/extraction errors
  - [ ] Puppeteer crashes
- [ ] Store error details in `link_extraction_report`:
```json
{
  "https://boards.greenhouse.io/company": {
    "status": false,
    "jobLinksFound": 0,
    "error": "Error message from crawler"
  }
}
```
- [ ] Update google-results.csv with failure status and remarks
- [ ] Continue processing remaining URLs (don't stop on first error)
- [ ] Display summary of failures at end

---

## **Feature 11: Meaningful User Feedback** 💬

**As a** user  
**I want** clear messages about what's happening  
**So that** I understand the crawler's state and actions

### Acceptance Criteria:
- [ ] Display on startup:
  - [ ] `"Starting Stage 2 with jobId: {jobId}"`
  - [ ] `"Reading job board URLs from requestId: {requestId}"`
  - [ ] If auto-generated: `"No jobId provided. Generated jobId: {id}"`
- [ ] Display during processing:
  - [ ] `"Processing job board {X} of {total}: {url}"`
  - [ ] `"Found {count} job links from {url}"`
  - [ ] On error: `"Failed to extract from {url}: {error}"`
- [ ] Display final summary:
```
✅ Stage 2 complete for jobId: {jobId}
Job board URLs processed: {count}
Total job links extracted: {count}
New job links added: {count}
Duplicates skipped: {count}
Failed extractions: {count}
Results saved to: /output/job_links/{jobId}/jobs.csv
```

---

## **Feature 12: Environment Configuration** 🔧

**As a** developer  
**I want** configurable settings for Stage 2 behavior  
**So that** I can adjust extraction without code changes

### Acceptance Criteria:
- [ ] Use existing `CONCURRENCY` setting for parallel processing
- [ ] Use existing `PAGE_TIMEOUT` for page load timeouts
- [ ] Use existing retry settings from config
- [ ] No new environment variables needed (reuse existing)

---

## **Testing Checklist** ✅

- [ ] **Test 1**: Fresh Stage 2 run with custom jobId and existing requestId
- [ ] **Test 2**: Fresh Stage 2 run with auto-generated jobId
- [ ] **Test 3**: Resume Stage 2 after partial completion
- [ ] **Test 4**: Resume Stage 2 after failures (re-process failed URLs)
- [ ] **Test 5**: `--clean` flag resets job board URLs to pending
- [ ] **Test 6**: Duplicate job links are skipped
- [ ] **Test 7**: Error handling for failed job board pages
- [ ] **Test 8**: Multiple jobIds can coexist for same requestId
- [ ] **Test 9**: Stage 1 google-results.csv is properly updated with STATUS/JOB_COUNT
- [ ] **Test 10**: Invalid `--run` parameter shows error

---

## 🎯 Implementation Notes

### Key Technical Details:
- **Folder structure**: `/output/job_boards/{requestId}/` for Stage 1, `/output/job_links/{jobId}/` for Stage 2
- **CSV format**: Standard RFC 4180 with proper escaping
- **jobId generation**: Use existing `generateRequestId()` from `src/utils/request-helpers.js`
- **Extraction logic**: Reuse existing Stage 2 extraction code, don't modify
- **Progress tracking**: Per job board URL in `link_extraction_report`

### Dependencies:
- **Existing**: Puppeteer, CSV utils, logger, request-helpers
- **New**: Update command parser for `--run` and `--id` parameters

### File Structure:
```
/output/
  ├── job_boards/
  │   ├── nov_03_gh/
  │   │   ├── google-results.csv     (Stage 1 output)
  │   │   └── report.json            (Stage 1 progress)
  │   └── another_request/
  │       ├── google-results.csv
  │       └── report.json
  └── job_links/
      ├── nov_03_crawl/
      │   ├── jobs.csv               (Stage 2 output - job URLs)
      │   └── report.json            (Stage 2 progress)
      └── another_job_run/
          ├── jobs.csv
          └── report.json
```

### Example Commands:
```bash
# Stage 1 (now saves to job_boards folder)
npm start -- --stage=1 --id=nov_03_gh

# Stage 2 with custom jobId
npm start -- --stage=2 --run=nov_03_gh --id=nov_03_crawl

# Stage 2 with auto-generated jobId
npm start -- --stage=2 --run=nov_03_gh

# Resume existing Stage 2 run
npm start -- --stage=2 --run=nov_03_gh --id=nov_03_crawl

# Clean and restart Stage 2 (resets job board URLs)
npm start -- --stage=2 --run=nov_03_gh --id=nov_03_crawl --clean
```

### Data Flow:
1. **Stage 1** → Saves job board URLs to `/output/job_boards/{requestId}/google-results.csv`
2. **Stage 2** → Reads from google-results.csv, extracts job links, saves to `/output/job_links/{jobId}/jobs.csv`
3. **Stage 2** → Updates google-results.csv STATUS/JOB_COUNT after processing each URL
4. **Stage 3** → Reads from jobs.csv (to be implemented later)

---

## 📦 Deliverables

1. [ ] Updated `src/utils/request-helpers.js` with Stage 1 path change
2. [ ] Updated `src/crawlers/stage1-search.js` with new paths
3. [ ] Updated `src/index.js` with `--run` and `--id` parameter parsing
4. [ ] Refactored `src/crawlers/stage2-links.js` with all features
5. [ ] All tests passing
6. [ ] Documentation updated (README.md)

---

**Ready to implement!** 🚀
