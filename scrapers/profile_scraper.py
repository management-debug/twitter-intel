"""Twitter profile scraper - extracts creator profile data."""
import logging
from datetime import datetime, timezone
from . import scrapecreators

log = logging.getLogger(__name__)


def scrape_profile(username):
    """Scrape a single Twitter profile.
    Returns dict with profile data or None on error.
    """
    data = scrapecreators.get_profile(username)
    if not data:
        log.warning(f"No data for @{username}")
        return None

    # The API returns nested structure - extract from legacy/user fields
    user = data
    legacy = user.get("legacy", user)

    # Try to find the right fields
    profile = {
        "user_id": str(user.get("rest_id", user.get("id_str", user.get("id", "")))),
        "username": legacy.get("screen_name", username).lower(),
        "display_name": legacy.get("name", ""),
        "bio": legacy.get("description", ""),
        "followers": _safe_int(legacy.get("followers_count", legacy.get("normal_followers_count", 0))),
        "following": _safe_int(legacy.get("friends_count", 0)),
        "tweet_count": _safe_int(legacy.get("statuses_count", 0)),
        "is_verified": 1 if user.get("is_blue_verified", False) else 0,
        "location": "",
        "bio_link": "",
        "avatar_url": "",
        "banner_url": legacy.get("profile_banner_url", ""),
    }

    # Extract avatar (replace _normal with _400x400 for HQ)
    avatar = user.get("avatar", {})
    if isinstance(avatar, dict):
        profile["avatar_url"] = avatar.get("image_url", "").replace("_normal", "_400x400")
    elif isinstance(avatar, str):
        profile["avatar_url"] = avatar.replace("_normal", "_400x400")
    else:
        pic = legacy.get("profile_image_url_https", "")
        profile["avatar_url"] = pic.replace("_normal", "_400x400")

    # Extract location
    loc = user.get("location", {})
    if isinstance(loc, dict):
        profile["location"] = loc.get("location", "")
    elif isinstance(loc, str):
        profile["location"] = loc

    # Extract bio link
    try:
        urls = legacy.get("entities", {}).get("url", {}).get("urls", [])
        if urls:
            profile["bio_link"] = urls[0].get("expanded_url", "") or urls[0].get("display_url", "")
    except (KeyError, IndexError, TypeError):
        pass

    return profile


def _safe_int(val, default=0):
    try:
        return int(val)
    except (TypeError, ValueError):
        return default
