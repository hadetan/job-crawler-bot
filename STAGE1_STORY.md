# 📋 Stage 1 Implementation Story

**Epic**: Resumable Google Search Crawler with Checkpointing

**Goal**: Implement a robust, resumable Google Custom Search crawler that saves progress per request ID and can recover from failures.

---

## **Feature 1: Request ID & Folder Structure** ✅

**As a** developer running the crawler  
**I want** each run to have a unique request ID and dedicated folder  
**So that** I can track, resume, and manage multiple crawler runs independently

### Acceptance Criteria:
- [x] Command accepts `--id` parameter: `npm start -- --stage=1 --id=nov_03_gh`
- [x] If no `--id` provided, auto-generate 6-digit numeric ID (e.g., `123456`)
- [x] Create folder `/output/{requestId}/` if it doesn't exist
- [x] Create two files in the folder:
  - `google-results.csv`
  - `report.json`

---

## **Feature 2: CSV Results Storage** 📊

**As a** crawler  
**I want** to save all discovered URLs with metadata in CSV format  
**So that** Stage 2 can process them later

### Acceptance Criteria:
- [x] CSV has headers: `URL`, `STATUS`, `JOB_COUNT`, `SNIPPET`, `LOGO_URL`, `REMARKS`
- [x] Extract `URL` from `items[index].link`
- [x] Extract `SNIPPET` from `items[index].snippet`
- [x] Extract `LOGO_URL` from `items[index].pagemap.metatags[0]["og:image"]`
  - [x] Leave empty if `og:image` doesn't exist
- [x] Set default values:
  - [x] `STATUS` = `"pending"`
  - [x] `JOB_COUNT` = `0`
  - [x] `REMARKS` = `""`
- [x] Skip duplicate URLs within the same run (across different pages)
- [x] Append to CSV after each page is processed successfully

---

## **Feature 3: JSON Progress Tracking** 📝

**As a** crawler  
**I want** to track the success/failure of each Google API page fetch  
**So that** I can resume from failures and monitor retry attempts

### Acceptance Criteria:
- [x] Create `report.json` with structure:
```json
{
  "google_report": [
    {
      "page": 1,
      "status": true,
      "error": null,
      "retryCount": 0
    }
  ]
}
```
- [x] After each page fetch:
  - [x] If **successful**: `status: true`, `error: null`, `retryCount: <current>`
  - [x] If **failed**: `status: false`, `error: <API error response only>`, `retryCount: <current>`
- [x] Store only API response error (no stack traces, no code errors)
- [x] Load existing `report.json` if resuming a previous run

---

## **Feature 4: Checkpoint & Resume Logic** 🔄

**As a** user  
**I want** the crawler to resume from the first failed page  
**So that** I don't waste API quota re-fetching successful pages

### Acceptance Criteria:
- [x] On startup, check if `report.json` exists for the given request ID
- [x] If exists and `--clean` NOT provided:
  - [x] Find first page with `status: false`
  - [x] Resume crawling from that page number
  - [x] Increment `retryCount` for that page on retry
  - [x] Display: `"Resuming from page {X} where previous run failed"`
- [x] If all pages have `status: true`:
  - [x] Display: `"All pages already completed successfully for request ID {id}. Use --clean to start fresh."`
  - [x] Exit without crawling

---

## **Feature 5: Max Retry Limit** 🚫

**As a** crawler  
**I want** to stop retrying a page after max attempts  
**So that** I don't get stuck in infinite retry loops

### Acceptance Criteria:
- [x] Add `MAX_RETRY_COUNT` environment variable (default: `3`)
- [x] Add to `config.js` reading from `process.env.MAX_RETRY_COUNT`
- [x] When `retryCount` reaches `MAX_RETRY_COUNT` for a page:
  - [x] Display informative message:
    ```
    ⚠️  Max retry limit (3) reached for page {pageNum}.
    Error: {brief error message}
    This page will be skipped. You can review the full error in report.json.
    Exiting...
    ```
  - [x] Keep `status: false` in report
  - [x] Exit without crawling

---

## **Feature 6: Clean Flag** 🧹

**As a** user  
**I want** to reset progress and start fresh without deleting CSV data  
**So that** I can retry all pages from beginning

### Acceptance Criteria:
- [x] Command accepts `--clean` flag: `npm start -- --stage=1 --id=nov_03_gh --clean`
- [x] When provided:
  - [x] Reset `google_report` array to `[]` in `report.json`
  - [x] Keep CSV file intact (do NOT delete or truncate)
  - [x] Start crawling from page 1
  - [x] Display: `"Clean flag detected. Resetting progress for request ID {id}"`

---

## **Feature 7: Duplicate Handling** 🔍

**As a** crawler  
**I want** to skip duplicate URLs found across different pages  
**So that** the CSV doesn't contain redundant entries

### Acceptance Criteria:
- [ ] Maintain a Set/Map of all URLs added during current run
- [ ] Before adding URL to CSV, check if already exists
- [ ] If duplicate: skip and don't add to CSV
- [ ] Log summary at end: `"Duplicates skipped: {count}"`

---

## **Feature 8: API Limit Handling** 🛑

**As a** crawler  
**I want** graceful handling when Google API 100-result limit is hit  
**So that** the crawler doesn't crash with unhandled errors

### Acceptance Criteria:
- [ ] Detect when API returns error for exceeding 100 results
- [ ] Log message: `"Reached Google API result limit (100 results/10 pages). Stopping pagination."`
- [ ] Mark last attempted page with error details in `report.json`
- [ ] Exit gracefully

---

## **Feature 9: Meaningful User Feedback** 💬

**As a** user  
**I want** clear messages about what's happening  
**So that** I understand the crawler's state and actions

### Acceptance Criteria:
- [x] Display on fresh run: `"Starting new Stage 1 run with request ID: {id}"`
- [x] Display on auto-ID: `"No ID provided. Generated request ID: {id}"`
- [x] Display progress: `"Fetching page {X} of {max}..."`
- [x] Display on success: `"Page {X} completed: {count} URLs found"`
- [x] Display final summary:
  ```
  ✅ Stage 1 complete for request ID: {id}
  Total pages processed: {count}
  Total URLs saved: {count}
  Duplicates skipped: {count}
  Failed pages: {count}
  Results saved to: /output/{id}/google-results.csv
  ```

---

## **Feature 10: Command Parsing & Integration** ⚙️

**As a** developer  
**I want** proper command-line argument parsing  
**So that** the crawler receives correct parameters

### Acceptance Criteria:
- [ ] Update `src/index.js` (or main entry) to parse:
  - [ ] `--stage=1`
  - [ ] `--id={requestId}` (optional)
  - [ ] `--clean` (optional flag)
- [ ] Pass parameters to `runStage1({ requestId, clean })`
- [ ] Validate `--stage=1` before executing Stage 1

---

## **Feature 11: Environment Configuration** 🔧

**As a** developer  
**I want** configurable retry limits via environment variables  
**So that** I can adjust behavior without code changes

### Acceptance Criteria:
- [x] Add to `.env.example`:
  ```
  MAX_RETRY_COUNT=3
  ```
- [x] Add to `config.js`:
  ```javascript
  retry: {
    maxRetries: parseInt(process.env.MAX_RETRY_COUNT) || 3,
    retryDelay: 2000
  }
  ```

---

## **Testing Checklist** ✅

- [ ] **Test 1**: Fresh run with custom ID
- [ ] **Test 2**: Fresh run without ID (auto-generate)
- [ ] **Test 3**: Resume after failure (same ID)
- [ ] **Test 4**: Max retry limit reached
- [ ] **Test 5**: `--clean` flag resets progress
- [ ] **Test 6**: Duplicate URLs skipped
- [ ] **Test 7**: API 100-result limit handling
- [ ] **Test 8**: Missing `og:image` in results
- [ ] **Test 9**: All pages successful (no resume needed)
- [ ] **Test 10**: Multiple request IDs can coexist

---

## 🎯 Implementation Notes

### Key Technical Details:
- **Pagination**: 10 results per page, `startIndex = (page - 1) * 10 + 1`
- **Error storage**: Only API response errors (e.g., `error.response.data`)
- **CSV format**: Standard RFC 4180 with proper escaping
- **Folder structure**: `/output/{requestId}/google-results.csv` and `report.json`
- **ID generation**: 6-digit numeric (e.g., `123456` to `999999`)

### Dependencies:
- **Existing**: `axios`, CSV utils, logger
- **New**: Command parser (e.g., `yargs` or manual parsing)

### File Structure:
```
/output/
  ├── nov_03_gh/
  │   ├── google-results.csv
  │   └── report.json
  ├── 123456/
  │   ├── google-results.csv
  │   └── report.json
  └── ...
```

### Example Commands:
```bash
# Fresh run with custom ID
npm start -- --stage=1 --id=nov_03_gh

# Fresh run with auto-generated ID
npm start -- --stage=1

# Resume existing run
npm start -- --stage=1 --id=nov_03_gh

# Clean and restart
npm start -- --stage=1 --id=nov_03_gh --clean
```

---

## 📦 Deliverables

1. ✅ Updated `src/crawlers/stage1-search.js` with all features
2. ✅ Updated `src/index.js` with command parsing
3. ✅ Updated `src/config.js` with MAX_RETRY_COUNT
4. ✅ Updated `.env.example` with new env vars
5. ✅ All tests passing
6. ✅ Documentation updated

---

**Ready to implement!** 🚀
