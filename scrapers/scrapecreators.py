"""ScrapeCreators API client for Twitter/X."""
import time
import logging
import httpx
from config import SCRAPECREATORS_API_KEY, REQUEST_DELAY, MAX_RETRIES

log = logging.getLogger(__name__)

BASE_URL = "https://api.scrapecreators.com"
HEADERS = {"x-api-key": SCRAPECREATORS_API_KEY}


def _request(endpoint, params=None):
    """Make API request with retries and rate limiting."""
    url = f"{BASE_URL}{endpoint}"
    for attempt in range(MAX_RETRIES):
        try:
            time.sleep(REQUEST_DELAY)
            r = httpx.get(url, headers=HEADERS, params=params or {}, timeout=30)
            if r.status_code == 200:
                return r.json()
            elif r.status_code == 429:
                wait = 5 * (attempt + 1)
                log.warning(f"Rate limited, waiting {wait}s...")
                time.sleep(wait)
            else:
                log.warning(f"API {r.status_code}: {endpoint} - {r.text[:200]}")
                if attempt < MAX_RETRIES - 1:
                    time.sleep(2)
        except Exception as e:
            log.error(f"API error: {endpoint} - {e}")
            if attempt < MAX_RETRIES - 1:
                time.sleep(2)
    return None


def get_profile(handle):
    """Get Twitter user profile.
    Returns dict with user info or None.
    """
    return _request("/v1/twitter/profile", {"handle": handle})


def get_user_tweets(handle, trim=False):
    """Get user's tweets.
    Returns dict with tweets array or None.
    trim=True reduces response size.
    """
    params = {"handle": handle}
    if trim:
        params["trim"] = "true"
    return _request("/v1/twitter/user-tweets", params)


def get_tweet(url, trim=False):
    """Get single tweet detail by URL."""
    params = {"url": url}
    if trim:
        params["trim"] = "true"
    return _request("/v1/twitter/tweet", params)
