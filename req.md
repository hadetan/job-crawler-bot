# Changes to make

## Stage 1 - Query search

-   File path: `/src/crawlers/stage1-search.js`

-   We will have a request id sort of run. For example `nov_01_gh`, this will be taken from params of the command like `npm start -- --stage=1 --id=myId` or else if not given then it will generate a 6 digit random id and generate a folder with that name under reports folder. In that request id folder we will have a `.csv` file and a `.json` file.

_note: When we run the command `npm start -- --stage=1 --id=nov_01_gh` then it will check if there were any error while getting the response from the google, if so then which page number was it? Let's say `page 11` got the error, so it will start the google search from that page as its starting index/page and save the progress as it goes. If it still encountered an error then do +1 on the errorCounter field, if the counter reaches to 3 (max error count should be configurable by env) then it when we run the same command again `npm start -- --stage=1 --id=nov_01_gh` then it will prompt as info that max error count reached and stuffs._

### CSV file content

We need to save these many headers:

-   URL
-   STATUS
-   JOB_COUNT
-   SNIPPET
-   LOGO_URL
-   REMARKS

Example:

```csv
    url, status, jobCount, snippet, logoUrl, remarks
    https://boards.greenhouse.io/bigid, pending, 0, "snippet", "", ""
    https://boards.greenhouse.io/zental, done, 12, ...
    https://boards.greenhouse.io/matic, failed, 0, ...,...,
```

_Here, the status will be pending by default while stage 1 is saving the content in the file, job count will be 0, snippet coming from the google response, logo url from the og:image, remarks empty for now._

### JSON file content

Basically our json is going to be our advanced reporter. It may have a structure like this:

```json
    {
        "google_report": [
            {
                "page": 1,
                "status": true,
                "error": null,
                "retryCount": 0
            },
            // ....
            {
                "page": 11,
                "status": false,
                "error": "", // Error received from google should be dumped here, the whole error and not just e.message.
                "retryCount": 3 // will not retry to parse again
            }
        ],
        "link_extraction_report": {
            "passeUrls": [
                { "url": "https://boards.greenhouse.io/bigid" },
                { "url": "https://boards.greenhouse.io/zental" },
                { "url": "https://boards.greenhouse.io/matic" },
            ],
            "failedUrls": [
                {
                    "url": "https://boards.greenhouse.io/brightcove",
                    "reason": "" // reason of the failure
                }
            ]
        },
        "detail_extraction_report": {
            "elixirr": {
                "passeUrls": [
                    { "url": "https://www.elixirr.com/en-gb/careers/job?gh_jid=99302", "foundFrom": "" /** url of the page from where it found this url from. It should be the exact page url from where it found it from. */ },
                    { "url": "https://www.elixirr.com/en-gb/careers/job?gh_jid=486741", "foundFrom": "" },
                    { "url": "https://www.elixirr.com/en-gb/careers/job?gh_jid=6666213", "foundFrom": "" },
                ],
                "failedUrls": [
                    {
                        "url": "https://www.elixirr.com/en-gb/careers/job?gh_jid=23563",
                        "foundFrom": "", /** url from where it found this url from. It should be the exact page url from where it found it from. */
                        "reason": "" // Actual reason got from our algos which we currently save in our failed_extractions.txt file.
                    }
                ]
            }
        }
    }
```

## Stage 2 - Job link hunter

-   File path: `/src/crawlers/stage2-links.js`

-   This will visit each links from the stage-1's .csv file and extract all job links (already implemented the logic). Now what really will happen is that, the `Stage 2` will always assume that we have gone through our `Stage 1` and on the command params we _HAVE TO_ send the request id of which we want to run, let's say we gave `nov_01_gh` to the first stage then for second stage we have to give this id or some other id we have given (we may have multiple and have to explicitly give one to it), using that the crawler will read the corresponding folders csv file and start its crawling on each links.

-   In the same .json file which is under this current request id folder, and save passed and failed urls accordingly (shown example on above snippet). Re-running the stage 2 with the same request id (e.g. `nov_01_gh`) will run all failed urls again and act accordingly. If the failed url passes now on run, then remove that url from failedUrls and put it in passedUrls.

-   All the passed urls that were found on the current request id run, should be saved in another .csv where we will save only the urls that were found by `Stage 2` crawler. Here's an example how it would look like:

```csv
    url, status, remarks, fileName
    https://www.houserx.com/career-details?gh_jid=4618152005, done, "", "houserx/1.txt"
    https://www.houserx.com/career-details?gh_jid=4609786005, pending, "", ""
    https://www.elixirr.com/en-gb/careers/job?gh_jid=6666213, failed, "" /* The remarks should tell us why it failed */, ""
```

_Here, initially all status's will be pending when we save the urls inside this csv file. When we run the `Stage 3` then it will use those other fields on the csv for itself, for example if it passed then it will save status to done and fileName to be the `folder`/`fileName`._

## Stage 3 - Job details scraper

-   File path: `/src/crawlers/stage3-details.js`

-   The `Stage 3` will take all urls that are either `pending` or `failed` and then extract the details from there. If the extraction was successful then it will mark the status of that url to `done` else `failed`. If success occurs then it will update the fileName field with the actual `folder`/`fileName` there, for example `houserx/1.txt`, here `houserx` is the folder name and `1.txt` is the name of hte fille.

-   It will do the exact job it's doing right now, extracting the details from the page. The only additional thing it has to do is to update the `Stage 2` csv file accordingly as per explained above.

-   As it parses the details on the file and gets either error or success, it should update the same json file that we talked about earlier. There we need to save save details of that domain and the link, passed or failure? If failure then reason that we get on errors on our code. We need to save the url according to success or failure. Under the `details_page_report` we will first have a company name which we are parsing, inside it `passeUrls` & `failedUrls` array of objects, which will be filled according to the success or failure.
