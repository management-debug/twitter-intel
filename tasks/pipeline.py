"""Scraping pipeline orchestration."""
import logging
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

from config import USE_SUPABASE
from db.database import (
    get_pending_accounts, get_scraped_accounts, get_accounts,
    update_account, bulk_upsert_posts, create_job, update_job,
    calc_viral,
)
from scrapers.profile_scraper import scrape_profile
from scrapers.post_scraper import scrape_posts
from scrapers.media_downloader import download_all_media
from tasks.task_manager import should_stop

log = logging.getLogger(__name__)

REFRESH_WORKERS = 8


def run_full_pipeline(test_limit=0):
    """Full scrape: profiles → posts → viral detection → media download."""
    job_id = create_job("full")
    log.info(f"Starting FULL pipeline (job #{job_id}, test={test_limit})")

    try:
        # Phase 1: Profiles
        accounts = get_pending_accounts(limit=test_limit) if test_limit else get_pending_accounts()
        if not accounts:
            accounts = get_accounts(limit=test_limit if test_limit else 9999, status="scraped")

        total = len(accounts)
        update_job(job_id, {"total_accounts": total})
        log.info(f"Phase 1: Scraping {total} profiles...")

        processed = 0
        for acc in accounts:
            if should_stop():
                update_job(job_id, {"status": "cancelled", "error_message": "Stopped by user"})
                return

            profile = scrape_profile(acc["username"])
            if profile:
                now = datetime.now(timezone.utc).isoformat()
                update_data = {
                    "user_id": profile["user_id"],
                    "display_name": profile["display_name"],
                    "bio": profile["bio"],
                    "bio_link": profile.get("bio_link", ""),
                    "location": profile.get("location", ""),
                    "followers": profile["followers"],
                    "following": profile["following"],
                    "tweet_count": profile["tweet_count"],
                    "is_verified": profile["is_verified"],
                    "avatar_url": profile["avatar_url"],
                    "banner_url": profile.get("banner_url", ""),
                    "scrape_status": "scraped",
                    "last_scraped_at": now,
                }
                if not acc.get("first_scraped_at"):
                    update_data["first_scraped_at"] = now
                update_account(acc["id"], update_data)
            else:
                update_account(acc["id"], {"scrape_status": "error"})

            processed += 1
            if processed % 10 == 0:
                update_job(job_id, {"processed_accounts": processed})

        update_job(job_id, {"processed_accounts": processed})
        log.info(f"Phase 1 complete: {processed}/{total} profiles scraped")

        # Phase 2: Posts
        scraped_accs = get_scraped_accounts()
        if test_limit:
            scraped_accs = scraped_accs[:test_limit]

        log.info(f"Phase 2: Scraping posts for {len(scraped_accs)} accounts...")
        total_posts = 0
        viral_found = 0
        all_posts = []

        for acc in scraped_accs:
            if should_stop():
                update_job(job_id, {"status": "cancelled", "error_message": "Stopped by user"})
                return

            posts = scrape_posts(acc["username"], acc["id"])

            # Calculate viral status
            avg_likes = acc.get("avg_likes_30d", 0) or 0
            avg_views = acc.get("avg_views_30d", 0) or 0

            for p in posts:
                is_v, mult = calc_viral(p["media_type"], p["likes"], p["views"], avg_likes, avg_views)
                p["is_viral"] = 1 if is_v else 0
                p["performance_multiplier"] = mult
                if is_v:
                    viral_found += 1

            if posts:
                bulk_upsert_posts(posts)
                all_posts.extend(posts)
                total_posts += len(posts)

                # Update account averages
                _update_account_averages(acc["id"], posts)

            update_job(job_id, {"total_posts_found": total_posts, "viral_found": viral_found})

        log.info(f"Phase 2 complete: {total_posts} posts, {viral_found} viral")

        # Phase 3: Media download + upload to Supabase Storage
        log.info("Phase 3: Downloading media...")
        media_stats = download_all_media(all_posts, scraped_accs)
        total_media = media_stats["avatars"] + media_stats["images"] + media_stats["thumbnails"]
        update_job(job_id, {"images_downloaded": total_media})
        log.info(f"Phase 3 complete: {total_media} media files")

        # Phase 4: Update avatar_local in DB for Supabase URLs
        if USE_SUPABASE:
            from config import SUPABASE_URL as SB_URL
            for acc in scraped_accs:
                sb_avatar = f"{SB_URL}/storage/v1/object/public/avatars/{acc['username']}.jpg"
                update_account(acc["id"], {"avatar_local": sb_avatar})

        # Done
        update_job(job_id, {
            "status": "completed",
            "completed_at": datetime.now(timezone.utc).isoformat(),
        })
        log.info(f"FULL pipeline complete! Job #{job_id}")

    except Exception as e:
        log.error(f"Pipeline error: {e}", exc_info=True)
        update_job(job_id, {
            "status": "failed",
            "error_message": str(e)[:500],
            "completed_at": datetime.now(timezone.utc).isoformat(),
        })


def run_new_only_pipeline():
    """Scrape only pending (new) accounts."""
    job_id = create_job("new_only")
    log.info(f"Starting NEW-ONLY pipeline (job #{job_id})")

    try:
        accounts = get_pending_accounts()
        if not accounts:
            update_job(job_id, {"status": "completed", "error_message": "No pending accounts",
                                "completed_at": datetime.now(timezone.utc).isoformat()})
            return

        total = len(accounts)
        update_job(job_id, {"total_accounts": total})

        processed = 0
        total_posts = 0
        viral_found = 0

        for acc in accounts:
            if should_stop():
                update_job(job_id, {"status": "cancelled"})
                return

            # Profile
            profile = scrape_profile(acc["username"])
            if profile:
                now = datetime.now(timezone.utc).isoformat()
                update_account(acc["id"], {
                    **{k: v for k, v in profile.items() if k != "username"},
                    "scrape_status": "scraped",
                    "first_scraped_at": now,
                    "last_scraped_at": now,
                })

                # Posts
                posts = scrape_posts(acc["username"], acc["id"])
                for p in posts:
                    is_v, mult = calc_viral(p["media_type"], p["likes"], p["views"], 0, 0)
                    p["is_viral"] = 1 if is_v else 0
                    p["performance_multiplier"] = mult
                    if is_v:
                        viral_found += 1

                if posts:
                    bulk_upsert_posts(posts)
                    total_posts += len(posts)
                    _update_account_averages(acc["id"], posts)
            else:
                update_account(acc["id"], {"scrape_status": "error"})

            processed += 1
            update_job(job_id, {"processed_accounts": processed, "total_posts_found": total_posts, "viral_found": viral_found})

        # Media
        scraped = get_scraped_accounts()
        new_scraped = [a for a in scraped if a["username"] in {a2["username"] for a2 in accounts}]
        all_posts_db = []
        from db.database import get_account_posts
        for a in new_scraped:
            all_posts_db.extend(get_account_posts(a["id"]))
        media_stats = download_all_media(all_posts_db, new_scraped)

        update_job(job_id, {
            "status": "completed",
            "images_downloaded": sum(media_stats.values()),
            "completed_at": datetime.now(timezone.utc).isoformat(),
        })
        log.info(f"NEW-ONLY pipeline complete! {processed} accounts, {total_posts} posts")

    except Exception as e:
        log.error(f"Pipeline error: {e}", exc_info=True)
        update_job(job_id, {"status": "failed", "error_message": str(e)[:500],
                            "completed_at": datetime.now(timezone.utc).isoformat()})


def _refresh_one_account(acc, days_back=7):
    """Refresh a single account. Thread-safe — no shared state writes.
    Returns (posts_count, viral_count). Errors logged but not raised so one
    bad account doesn't poison the batch.
    """
    try:
        profile = scrape_profile(acc["username"])
        if profile:
            update_account(acc["id"], {
                "followers": profile["followers"],
                "following": profile["following"],
                "tweet_count": profile["tweet_count"],
                "bio": profile["bio"],
                "bio_link": profile.get("bio_link", ""),
                "is_verified": profile["is_verified"],
                "last_scraped_at": datetime.now(timezone.utc).isoformat(),
            })

        posts = scrape_posts(acc["username"], acc["id"], days_back=days_back)
        avg_likes = acc.get("avg_likes_30d", 0) or 0
        avg_views = acc.get("avg_views_30d", 0) or 0

        viral_count = 0
        for p in posts:
            is_v, mult = calc_viral(p["media_type"], p["likes"], p["views"], avg_likes, avg_views)
            p["is_viral"] = 1 if is_v else 0
            p["performance_multiplier"] = mult
            if is_v:
                viral_count += 1

        if posts:
            bulk_upsert_posts(posts)

        return len(posts), viral_count
    except Exception as e:
        log.warning(f"Refresh failed for @{acc.get('username','?')}: {e}")
        return 0, 0


def _run_refresh_window(job_type, days_back, label):
    """Shared refresh implementation. Re-scrapes posts for the last `days_back`
    days across all scraped accounts, in parallel."""
    job_id = create_job(job_type)
    log.info(f"Starting {label} pipeline (job #{job_id}, {REFRESH_WORKERS} workers, {days_back}d window)")

    try:
        accounts = get_scraped_accounts()
        total = len(accounts)
        update_job(job_id, {"total_accounts": total})

        counters = {"processed": 0, "posts": 0, "viral": 0}
        lock = threading.Lock()
        cancelled = False

        with ThreadPoolExecutor(max_workers=REFRESH_WORKERS) as executor:
            futures = {executor.submit(_refresh_one_account, acc, days_back): acc for acc in accounts}
            for fut in as_completed(futures):
                if should_stop():
                    cancelled = True
                    for f in futures:
                        f.cancel()
                    break
                posts_n, viral_n = fut.result()
                with lock:
                    counters["processed"] += 1
                    counters["posts"] += posts_n
                    counters["viral"] += viral_n
                    if counters["processed"] % 10 == 0 or counters["processed"] == total:
                        update_job(job_id, {
                            "processed_accounts": counters["processed"],
                            "total_posts_found": counters["posts"],
                            "viral_found": counters["viral"],
                        })

        if cancelled:
            update_job(job_id, {
                "status": "cancelled",
                "error_message": "Stopped by user",
                "processed_accounts": counters["processed"],
                "total_posts_found": counters["posts"],
                "viral_found": counters["viral"],
                "completed_at": datetime.now(timezone.utc).isoformat(),
            })
            log.info(f"{label} cancelled after {counters['processed']}/{total}")
            return

        update_job(job_id, {
            "status": "completed",
            "processed_accounts": counters["processed"],
            "total_posts_found": counters["posts"],
            "viral_found": counters["viral"],
            "completed_at": datetime.now(timezone.utc).isoformat(),
        })
        log.info(f"{label} pipeline complete! {counters['posts']} new posts, {counters['viral']} viral")

    except Exception as e:
        log.error(f"Pipeline error: {e}", exc_info=True)
        update_job(job_id, {"status": "failed", "error_message": str(e)[:500],
                            "completed_at": datetime.now(timezone.utc).isoformat()})


def run_refresh_pipeline():
    """Refresh existing accounts (last 7 days)."""
    _run_refresh_window("refresh", days_back=7, label="REFRESH")


def run_monthly_refresh_pipeline():
    """Refresh existing accounts (last 30 days)."""
    _run_refresh_window("monthly_refresh", days_back=30, label="MONTHLY REFRESH")


def _median(values):
    """Calculate median of a list of numbers."""
    if not values:
        return 0
    s = sorted(values)
    n = len(s)
    if n % 2 == 1:
        return s[n // 2]
    return (s[n // 2 - 1] + s[n // 2]) / 2


def _update_account_averages(account_id, posts):
    """Recalculate account MEDIAN averages from posts (resistant to outliers)."""
    photos = [p for p in posts if p["media_type"] == "photo"]
    videos = [p for p in posts if p["media_type"] == "video"]
    texts = [p for p in posts if p["media_type"] == "text"]

    avg_likes = _median([p["likes"] for p in posts])
    avg_views = _median([p["views"] for p in posts])
    avg_photo = _median([p["likes"] for p in photos])
    avg_video = _median([p["views"] for p in videos])
    avg_text = _median([p["likes"] for p in texts])

    update_account(account_id, {
        "avg_likes_30d": round(avg_likes, 1),
        "avg_views_30d": round(avg_views, 1),
        "avg_photo_likes": round(avg_photo, 1),
        "avg_video_views": round(avg_video, 1),
        "avg_text_likes": round(avg_text, 1),
        "photo_count": len(photos),
        "video_count": len(videos),
        "text_count": len(texts),
    })
