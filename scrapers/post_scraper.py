"""Twitter post scraper - extracts tweet data with engagement metrics."""
import re
import logging
from datetime import datetime, timezone, timedelta
from config import DAYS_BACK
from . import scrapecreators

log = logging.getLogger(__name__)


def scrape_posts(username, account_id, days_back=None):
    """Scrape tweets for a user.
    Returns list of post dicts ready for DB insertion.
    """
    if days_back is None:
        days_back = DAYS_BACK

    data = scrapecreators.get_user_tweets(username)
    if not data:
        log.warning(f"No tweets for @{username}")
        return []

    # API may return tweets directly or nested
    tweets = data if isinstance(data, list) else data.get("tweets", data.get("results", []))
    if not isinstance(tweets, list):
        log.warning(f"Unexpected tweet format for @{username}: {type(tweets)}")
        return []

    cutoff = datetime.now(timezone.utc) - timedelta(days=days_back)
    posts = []

    for tweet in tweets:
        try:
            post = _parse_tweet(tweet, username, account_id, cutoff)
            if post:
                posts.append(post)
        except Exception as e:
            log.error(f"Error parsing tweet for @{username}: {e}")

    log.info(f"@{username}: {len(posts)} posts scraped (from {len(tweets)} raw)")
    return posts


def _parse_tweet(tweet, username, account_id, cutoff):
    """Parse a single tweet into a post dict.
    ScrapeCreators nests tweet data under 'legacy', with views at top level.
    """
    # ScrapeCreators wraps tweet data in 'legacy'
    legacy = tweet.get("legacy", tweet)

    # Get tweet ID
    tweet_id = str(legacy.get("id_str", tweet.get("rest_id", "")))
    if not tweet_id:
        return None

    # Parse creation time
    created = legacy.get("created_at", "")
    create_time = _parse_twitter_date(created)
    if create_time and create_time < cutoff:
        return None

    # Get text (remove t.co links)
    full_text = legacy.get("full_text", legacy.get("text", ""))
    caption = re.sub(r'https?://t\.co/\S+', '', str(full_text)).strip()

    # Engagement metrics
    likes = _safe_int(legacy.get("favorite_count", 0))
    bookmarks = _safe_int(legacy.get("bookmark_count", 0))
    retweets = _safe_int(legacy.get("retweet_count", 0))
    replies = _safe_int(legacy.get("reply_count", 0))
    quote_count = _safe_int(legacy.get("quote_count", 0))

    # Views are at top level in ScrapeCreators format: {"views": {"count": "12345"}}
    views_obj = tweet.get("views", {})
    if isinstance(views_obj, dict):
        views = _safe_int(views_obj.get("count", 0))
    else:
        views = _safe_int(legacy.get("views_count", 0))

    # Determine media type
    media_type = "text"
    media_url = ""
    thumbnail_url = ""

    ext = legacy.get("extended_entities") or legacy.get("entities") or {}
    media_list = ext.get("media", [])

    if media_list:
        first_media = media_list[0]
        mtype = first_media.get("type", "")

        if mtype == "photo":
            media_type = "photo"
            media_url = first_media.get("media_url_https", "")
            thumbnail_url = media_url
        elif mtype == "video" or mtype == "animated_gif":
            media_type = "video"
            media_url = first_media.get("media_url_https", "")
            thumbnail_url = media_url
            # Try to get video URL
            variants = first_media.get("video_info", {}).get("variants", [])
            mp4s = [v for v in variants if v.get("content_type") == "video/mp4"]
            if mp4s:
                # Get mid-quality
                mp4s.sort(key=lambda v: v.get("bitrate", 0))
                mid = mp4s[len(mp4s)//2] if len(mp4s) > 1 else mp4s[0]
                media_url = mid.get("url", media_url)

    # Classify caption
    caption_category = _classify_caption(caption)

    # Tweet URL
    tweet_url = tweet.get("url", f"https://x.com/{username}/status/{tweet_id}")

    return {
        "tweet_id": tweet_id,
        "account_id": account_id,
        "username": username.lower(),
        "caption": caption,
        "create_time": create_time.isoformat() if create_time else "",
        "media_type": media_type,
        "likes": likes,
        "views": views,
        "bookmarks": bookmarks,
        "retweets": retweets,
        "replies": replies,
        "quote_count": quote_count,
        "media_url": media_url,
        "thumbnail_url": thumbnail_url,
        "caption_category": caption_category,
        "scraped_at": datetime.now(timezone.utc).isoformat(),
    }


def _classify_caption(text):
    """Classify caption into one of 5 categories."""
    if not text:
        return "none"

    t = text.lower()

    # FOMO / DM Bait
    if re.search(r'delet|surprise.*dm|say\s*hi.*dm|reply.*surprise|free.*dm', t):
        return "fomo"

    # Engagement Bait
    if re.search(r'be\s*honest|smash|pass\?|rate\s*(me|my|this)|1-10|yes\s*or\s*no|describe\s*me|type\?', t):
        return "engagement"

    # Tease / Suggestive
    if re.search(r'eyes\s*up|looking\s*at|motivation|mercy|staring|caught|stop\s*scroll', t):
        return "tease"

    # Short & Sweet (under 20 chars, no question)
    if len(text) <= 20 and '?' not in text:
        return "short"

    # Personality / Humor (default for everything else with text)
    return "personality"


def _parse_twitter_date(date_str):
    """Parse Twitter's date format to datetime."""
    if not date_str:
        return None
    try:
        # Twitter format: "Mon Jan 01 00:00:00 +0000 2024"
        return datetime.strptime(date_str, "%a %b %d %H:%M:%S %z %Y")
    except ValueError:
        try:
            # ISO format fallback
            return datetime.fromisoformat(date_str.replace("Z", "+00:00"))
        except ValueError:
            return None


def _safe_int(val, default=0):
    try:
        return int(val)
    except (TypeError, ValueError):
        return default
