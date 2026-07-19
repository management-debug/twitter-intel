"""Apify-based tweet fetching — latest tweets incl. 18+ accounts.

ScrapeCreators' user-tweets endpoint only returns ~100 all-time *popular*
tweets and comes up empty for sensitive (18+) accounts (guest sessions).
The gentle_cloud actor is search-based with authenticated sessions:
reverse-chronological, includes possibly_sensitive tweets.

Accounts are processed in chunks of BATCH per actor run, at most WORKERS
runs in parallel, with backoff-retry on Apify's concurrency/rate limit.
"""
import time
import logging
from datetime import datetime, timezone, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed

import httpx

from config import APIFY_TOKEN

log = logging.getLogger(__name__)

ACTOR = "gentle_cloud~twitter-tweets-scraper"
BATCH = 10        # account URLs per actor run
WORKERS = 2       # concurrent runs (4 hit Apify's rate limit on long runs)
RESULT_COUNT = "500"  # billing cap per run (10 accounts × 7d rarely exceed this)


def _run_batch(usernames, since_date):
    """One actor run for a chunk of handles -> {username_lower: [raw tweets]}."""
    payload = {
        "start_urls": [{"url": f"https://x.com/{u}"} for u in usernames],
        "since_date": since_date,
        "result_count": RESULT_COUNT,
    }
    r = None
    for attempt in range(4):
        resp = httpx.post(f"https://api.apify.com/v2/acts/{ACTOR}/runs?token={APIFY_TOKEN}",
                          json=payload, timeout=30).json()
        if "data" in resp:
            r = resp["data"]
            break
        time.sleep(30 * (attempt + 1))  # concurrency/rate limit -> back off
    if r is None:
        raise RuntimeError(f"apify run start failed: {str(resp)[:150]}")
    run_id, ds_id = r["id"], r["defaultDatasetId"]

    status = "RUNNING"
    for _ in range(60):
        time.sleep(5)
        status = httpx.get(f"https://api.apify.com/v2/actor-runs/{run_id}?token={APIFY_TOKEN}",
                           timeout=30).json()["data"]["status"]
        if status in ("SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"):
            break
    if status != "SUCCEEDED":
        raise RuntimeError(f"apify run {run_id}: {status}")

    items = httpx.get(f"https://api.apify.com/v2/datasets/{ds_id}/items?token={APIFY_TOKEN}&limit=1000",
                      timeout=60).json()
    grouped = {}
    for it in items:
        if not it.get("id_str") or it["id_str"] == "-1":  # simulation placeholder rows
            continue
        sn = ((it.get("user") or {}).get("core") or {}).get("screen_name") or ""
        if sn:
            grouped.setdefault(sn.lower(), []).append(it)
    return grouped


def fetch_tweets_map(usernames, days_back):
    """Fetch latest tweets for all usernames. Returns {username_lower: [raw]}.
    Failed chunks are logged and skipped — the next daily catches them up."""
    since = (datetime.now(timezone.utc) - timedelta(days=days_back)).strftime("%Y-%m-%d")
    chunks = [usernames[i:i+BATCH] for i in range(0, len(usernames), BATCH)]
    result, failed = {}, 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(_run_batch, c, since): c for c in chunks}
        for i, fut in enumerate(as_completed(futs), 1):
            try:
                result.update(fut.result())
            except Exception as e:
                failed += 1
                log.warning(f"apify chunk failed ({futs[fut][0]}..): {e}")
            if i % 20 == 0 or i == len(chunks):
                log.info(f"apify: {i}/{len(chunks)} chunks, {len(result)} accounts with tweets, {failed} failed")
    if failed and not result:
        # total failure (e.g. monthly usage limit) -> let the caller fall back
        raise RuntimeError(f"all {failed} apify chunks failed")
    return result
