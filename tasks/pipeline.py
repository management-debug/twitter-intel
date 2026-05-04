"""Scraping pipeline orchestration."""
import logging
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

from config import USE_SUPABASE
from db.database import (
    get_pending_accounts, get_scraped_accounts, get_accounts,
    update_account, bulk_upsert_posts, update_post_media,
    get_posts_missing_media,
    create_job, update_job,
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
    Returns (upserted_rows, viral_count). Upserted rows have DB id populated,
    which the media downloader needs to key files correctly. Errors logged
    but not raised so one bad account doesn't poison the batch.
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

        upserted = bulk_upsert_posts(posts) if posts else []
        return upserted, viral_count
    except Exception as e:
        log.warning(f"Refresh failed for @{acc.get('username','?')}: {e}")
        return [], 0


def _run_refresh_window(job_type, days_back, label):
    """Shared refresh implementation. Re-scrapes posts for the last `days_back`
    days across all scraped accounts, in parallel. Then downloads media so
    images/videos survive past the ~24h Twitter CDN expiry."""
    job_id = create_job(job_type)
    log.info(f"Starting {label} pipeline (job #{job_id}, {REFRESH_WORKERS} workers, {days_back}d window)")

    try:
        accounts = get_scraped_accounts()
        total = len(accounts)
        update_job(job_id, {"total_accounts": total})

        counters = {"processed": 0, "posts": 0, "viral": 0}
        all_upserted = []
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
                upserted, viral_n = fut.result()
                with lock:
                    counters["processed"] += 1
                    counters["posts"] += len(upserted)
                    counters["viral"] += viral_n
                    all_upserted.extend(upserted)
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

        # Phase 2: download media so the dashboard isn't dependent on
        # Twitter's expiring CDN URLs. download_all_media skips files already
        # present locally / in Supabase, so re-running is cheap.
        media_stats = {"avatars": 0, "images": 0, "thumbnails": 0, "videos": 0}
        try:
            posts_with_media = [
                p for p in all_upserted
                if p.get("media_url") or p.get("thumbnail_url")
            ]
            if posts_with_media:
                log.info(f"{label} phase 2: downloading media for {len(posts_with_media)} posts...")
                media_stats = download_all_media(posts_with_media, accounts)
                _persist_media_paths(posts_with_media, media_stats)
        except Exception as e:
            log.error(f"{label} media download failed: {e}", exc_info=True)

        update_job(job_id, {
            "status": "completed",
            "processed_accounts": counters["processed"],
            "total_posts_found": counters["posts"],
            "viral_found": counters["viral"],
            "images_downloaded": (
                media_stats.get("images", 0)
                + media_stats.get("videos", 0)
                + media_stats.get("thumbnails", 0)
            ),
            "completed_at": datetime.now(timezone.utc).isoformat(),
        })
        log.info(
            f"{label} complete! {counters['posts']} posts, {counters['viral']} viral, "
            f"media: {media_stats}"
        )

    except Exception as e:
        log.error(f"Pipeline error: {e}", exc_info=True)
        update_job(job_id, {"status": "failed", "error_message": str(e)[:500],
                            "completed_at": datetime.now(timezone.utc).isoformat()})


def _persist_media_paths(posts_with_media, media_stats):
    """Write the public Supabase URL (or a sentinel) into media_local /
    thumbnail_local for each post.

    CRITICAL: every processed post must end up with a non-empty media_local,
    even if we couldn't upload anything — otherwise get_posts_missing_media
    keeps returning the same row and the auto-loop never terminates.
    """
    if not USE_SUPABASE:
        return
    from config import SUPABASE_URL as SB_URL

    for p in posts_with_media:
        pid = p.get("id")
        if not pid:
            continue
        media_type = p.get("media_type")
        media_url = (p.get("media_url") or "").strip()
        thumb_url = (p.get("thumbnail_url") or "").strip()
        try:
            fields = {}
            if media_type == "photo":
                if media_url:
                    fields["media_local"] = f"{SB_URL}/storage/v1/object/public/tweet-images/{pid}.jpg"
                else:
                    # No CDN url to download; mark processed so we don't loop.
                    fields["media_local"] = "_no_media"
            elif media_type == "video":
                if media_url and "video.twimg.com" in media_url:
                    fields["media_local"] = f"{SB_URL}/storage/v1/object/public/tweet-videos/{pid}.mp4"
                else:
                    fields["media_local"] = "_no_media"
                if thumb_url or media_url:
                    fields["thumbnail_local"] = f"{SB_URL}/storage/v1/object/public/tweet-thumbnails/{pid}.jpg"
            else:
                fields["media_local"] = "_no_media"
            if fields:
                update_post_media(pid, **fields)
        except Exception as e:
            log.warning(f"media_local persist failed for post {pid}: {e}")


def run_refresh_pipeline():
    """Refresh existing accounts (last 7 days)."""
    _run_refresh_window("refresh", days_back=7, label="REFRESH")


def run_monthly_refresh_pipeline():
    """Refresh existing accounts (last 30 days)."""
    _run_refresh_window("monthly_refresh", days_back=30, label="MONTHLY REFRESH")


def run_media_backfill_pipeline():
    """Download media for posts whose media_local is empty. Doesn't re-scrape,
    so no API credits — just walks the DB for gaps and pulls from Twitter CDN
    while the URLs are still alive. Auto-loops in batches of 10K so the whole
    table gets covered in a single job, no manual re-trigger needed."""
    job_id = create_job("media_backfill")
    log.info(f"Starting MEDIA BACKFILL pipeline (job #{job_id})")

    try:
        scraped = get_scraped_accounts()
        scraped_idx = {a["username"]: a for a in scraped}

        BATCH = 10000
        CHUNK = 200
        downloaded = 0
        processed = 0
        round_num = 0

        while True:
            if should_stop():
                update_job(job_id, {
                    "status": "cancelled",
                    "error_message": "Stopped by user",
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                })
                log.info(f"Backfill cancelled after {processed} posts")
                return

            posts = get_posts_missing_media(limit=BATCH)
            if not posts:
                log.info(f"BACKFILL round {round_num}: 0 posts left — done")
                break

            round_num += 1
            log.info(f"BACKFILL round {round_num}: {len(posts)} posts to process")

            # Build accounts list for avatar downloads from this batch's posts.
            accs_by_user = {p["username"]: {"username": p["username"]} for p in posts if p.get("username")}
            accounts = list(accs_by_user.values())
            for a in accounts:
                src = scraped_idx.get(a["username"])
                if src and src.get("avatar_url"):
                    a["avatar_url"] = src["avatar_url"]

            update_job(job_id, {
                "total_posts_found": processed + len(posts),
                "processed_accounts": processed,
            })

            for i in range(0, len(posts), CHUNK):
                if should_stop():
                    update_job(job_id, {
                        "status": "cancelled",
                        "error_message": "Stopped by user",
                        "completed_at": datetime.now(timezone.utc).isoformat(),
                    })
                    return
                chunk = posts[i:i+CHUNK]
                # avatars only on the very first chunk of the very first round
                stats = download_all_media(chunk, accounts if (round_num == 1 and i == 0) else [])
                _persist_media_paths(chunk, stats)
                downloaded += stats.get("images", 0) + stats.get("videos", 0) + stats.get("thumbnails", 0)
                processed += len(chunk)
                update_job(job_id, {
                    "processed_accounts": processed,
                    "images_downloaded": downloaded,
                })

            # Loop back to fetch next batch — there may be more older posts.

        update_job(job_id, {
            "status": "completed",
            "processed_accounts": processed,
            "images_downloaded": downloaded,
            "completed_at": datetime.now(timezone.utc).isoformat(),
        })
        log.info(f"BACKFILL complete! {processed} posts, {downloaded} media files in {round_num} rounds")

    except Exception as e:
        log.error(f"Backfill error: {e}", exc_info=True)
        update_job(job_id, {"status": "failed", "error_message": str(e)[:500],
                            "completed_at": datetime.now(timezone.utc).isoformat()})


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
