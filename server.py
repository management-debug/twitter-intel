"""Twitter Intel Dashboard - FastAPI Server"""
import os
import json
import logging
from pathlib import Path
from datetime import datetime, timezone

import httpx
import uvicorn
from fastapi import FastAPI, Request, HTTPException, Depends
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, RedirectResponse, JSONResponse

from config import (
    PORT, STATIC_DIR, AVATARS_DIR, IMAGES_DIR, THUMBNAILS_DIR,
    ADMIN_EMAIL, ADMIN_PASSWORD, WORKER_PASSWORD, SCRAPE_PIN,
    USE_SUPABASE, SUPABASE_URL, BASE_DIR,
)
from db.database import (
    init_db, cancel_stale_jobs,
    get_dashboard_stats, get_top_creators,
    get_accounts, get_account, add_account, bulk_add_accounts, update_account, delete_account,
    get_posts, get_post, get_post_count, get_account_posts, delete_post,
    get_jobs, get_job,
    add_to_watchlist, remove_from_watchlist, get_watchlist, is_watched,
)
from tasks import task_manager
from tasks.pipeline import (
    run_full_pipeline, run_new_only_pipeline,
    run_refresh_pipeline, run_monthly_refresh_pipeline,
    run_media_backfill_pipeline,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
log = logging.getLogger(__name__)

app = FastAPI(title="Twitter Intel", docs_url=None, redoc_url=None)

# GZip — workers in PH on slow mobile data were loading uncompressed assets.
# index.html / app.js / style.css ≈ 165 KB → ~40 KB with gzip.
app.add_middleware(GZipMiddleware, minimum_size=1000)


# Long-lived cache for static assets. CSS/JS are cache-busted via ?v=N in
# index.html, so safe to cache for a year. HTML stays uncached so deploys
# propagate immediately.
class _CachedStaticFiles(StaticFiles):
    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        if resp.status_code == 200 and not path.endswith(".html"):
            resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return resp


# ─── Settings (file-backed JSON) ───────────────────────────────────────────
# Auto-refresh toggle is persisted here. On Railway the data dir is ephemeral
# across deploys, so admin re-toggles after a redeploy if needed.
_SETTINGS_PATH = BASE_DIR / "data" / "settings.json"


def _load_settings():
    if not _SETTINGS_PATH.exists():
        return {}
    try:
        return json.loads(_SETTINGS_PATH.read_text())
    except Exception:
        return {}


def _save_settings(data: dict):
    _SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    _SETTINGS_PATH.write_text(json.dumps(data, indent=2))


_scheduler = None


# ─── Auth ───────────────────────────────────────────────────────────────────

def get_role(request: Request):
    """Extract role from Bearer token."""
    auth = request.headers.get("Authorization", "")
    token = auth.replace("Bearer ", "") if auth.startswith("Bearer ") else ""
    if token == "admin_session":
        return "admin"
    elif token == "worker_session":
        return "worker"
    return None


def require_auth(request: Request):
    role = get_role(request)
    if not role:
        raise HTTPException(401, "Unauthorized")
    return role


def require_admin(request: Request):
    role = get_role(request)
    if role != "admin":
        raise HTTPException(403, "Admin only")
    return role


@app.post("/api/auth/login")
async def login(request: Request):
    body = await request.json()
    email = body.get("email", "")
    password = body.get("password", "")

    if email == ADMIN_EMAIL and password == ADMIN_PASSWORD:
        return {"role": "admin", "token": "admin_session"}
    elif password == WORKER_PASSWORD:
        return {"role": "worker", "token": "worker_session"}
    raise HTTPException(401, "Invalid credentials")


# ─── Dashboard ──────────────────────────────────────────────────────────────

@app.get("/api/dashboard/stats")
async def dashboard_stats(role=Depends(require_auth)):
    return get_dashboard_stats()


@app.get("/api/dashboard/scrape-status")
async def scrape_status(role=Depends(require_auth)):
    jobs = get_jobs(limit=1)
    running = task_manager.is_running()
    return {
        "is_running": running,
        "current_job": jobs[0] if jobs else None,
    }


# ─── Scrape Control ────────────────────────────────────────────────────────

@app.post("/api/scrape/full")
async def scrape_full(pin: str = "", test: int = 0, role=Depends(require_admin)):
    if pin != SCRAPE_PIN:
        raise HTTPException(403, "Invalid PIN")
    if task_manager.is_running():
        raise HTTPException(409, "A scrape is already running")
    started = task_manager.start_task(run_full_pipeline, args=(test,))
    if not started:
        raise HTTPException(409, "Could not start task")
    return {"status": "started", "test_limit": test}


@app.post("/api/scrape/new-only")
async def scrape_new(pin: str = "", role=Depends(require_admin)):
    if pin != SCRAPE_PIN:
        raise HTTPException(403, "Invalid PIN")
    if task_manager.is_running():
        raise HTTPException(409, "A scrape is already running")
    task_manager.start_task(run_new_only_pipeline)
    return {"status": "started"}


@app.post("/api/scrape/refresh")
async def scrape_refresh(pin: str = "", role=Depends(require_admin)):
    if pin != SCRAPE_PIN:
        raise HTTPException(403, "Invalid PIN")
    if task_manager.is_running():
        raise HTTPException(409, "A scrape is already running")
    task_manager.start_task(run_refresh_pipeline)
    return {"status": "started"}


@app.post("/api/scrape/monthly-refresh")
async def scrape_monthly_refresh(pin: str = "", role=Depends(require_admin)):
    if pin != SCRAPE_PIN:
        raise HTTPException(403, "Invalid PIN")
    if task_manager.is_running():
        raise HTTPException(409, "A scrape is already running")
    task_manager.start_task(run_monthly_refresh_pipeline)
    return {"status": "started", "window_days": 30}


@app.get("/api/debug/storage")
async def debug_storage(role=Depends(require_admin)):
    """Diagnose Supabase Storage: test upload, head, and list buckets.
    Helps figure out why media files aren't appearing publicly."""
    from config import SUPABASE_SERVICE_KEY
    out = {"USE_SUPABASE": USE_SUPABASE, "SUPABASE_URL": SUPABASE_URL}
    if not USE_SUPABASE:
        return out

    h = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
    }
    # 1) List buckets
    try:
        r = httpx.get(f"{SUPABASE_URL}/storage/v1/bucket", headers=h, timeout=10)
        out["list_buckets_status"] = r.status_code
        out["list_buckets_body"] = r.text[:1000]
    except Exception as e:
        out["list_buckets_error"] = str(e)

    # 2) Try a test upload
    try:
        url = f"{SUPABASE_URL}/storage/v1/object/tweet-images/_diag_test.txt"
        r = httpx.post(url, headers={**h, "Content-Type": "text/plain", "x-upsert": "true"},
                       content=b"diag", timeout=10)
        out["upload_status"] = r.status_code
        out["upload_body"] = r.text[:500]
    except Exception as e:
        out["upload_error"] = str(e)

    # 3) HEAD the public URL
    try:
        r = httpx.head(f"{SUPABASE_URL}/storage/v1/object/public/tweet-images/_diag_test.txt", timeout=5)
        out["public_head_status"] = r.status_code
    except Exception as e:
        out["public_head_error"] = str(e)

    return out


@app.get("/api/debug/list-files")
async def debug_list_files(bucket: str = "tweet-images", prefix: str = "", role=Depends(require_admin)):
    """List actual files in a Supabase bucket so we can see what's there."""
    from config import SUPABASE_SERVICE_KEY
    if not USE_SUPABASE:
        return {"error": "supabase not configured"}
    h = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }
    try:
        r = httpx.post(
            f"{SUPABASE_URL}/storage/v1/object/list/{bucket}",
            headers=h,
            json={"limit": 100, "prefix": prefix, "sortBy": {"column": "created_at", "order": "desc"}},
            timeout=10,
        )
        return {"status": r.status_code, "files": r.json() if r.status_code == 200 else r.text}
    except Exception as e:
        return {"error": str(e)}


@app.post("/api/debug/create-buckets")
async def debug_create_buckets(role=Depends(require_admin)):
    """Create the four storage buckets we depend on if they don't exist.
    Idempotent — Supabase returns 409 on duplicate which we treat as ok."""
    from config import SUPABASE_SERVICE_KEY
    if not USE_SUPABASE:
        raise HTTPException(400, "Supabase not configured")
    h = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }
    results = {}
    for name in ["avatars", "tweet-images", "tweet-thumbnails", "tweet-videos"]:
        body = {"id": name, "name": name, "public": True}
        try:
            r = httpx.post(f"{SUPABASE_URL}/storage/v1/bucket", headers=h, json=body, timeout=10)
            results[name] = {"status": r.status_code, "body": r.text[:200]}
        except Exception as e:
            results[name] = {"error": str(e)}
    return results


@app.post("/api/scrape/media-backfill")
async def scrape_media_backfill(pin: str = "", role=Depends(require_admin)):
    """Download missing media (images/videos/thumbnails) for posts that
    already exist in the DB. No API credits used."""
    if pin != SCRAPE_PIN:
        raise HTTPException(403, "Invalid PIN")
    if task_manager.is_running():
        raise HTTPException(409, "A scrape is already running")
    task_manager.start_task(run_media_backfill_pipeline)
    return {"status": "started"}


@app.post("/api/scrape/stop")
async def scrape_stop(role=Depends(require_admin)):
    task_manager.stop_task()
    return {"status": "stop_requested"}


@app.get("/api/scrape/jobs")
async def list_jobs(role=Depends(require_auth)):
    return get_jobs(limit=20)


@app.get("/api/scrape/jobs/{job_id}")
async def get_job_detail(job_id: int, role=Depends(require_auth)):
    job = get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job


# ─── Creators ───────────────────────────────────────────────────────────────

@app.get("/api/creators")
async def list_creators(limit: int = 500, sort: str = "followers", search: str = "",
                        is_team: int = None, role=Depends(require_auth)):
    return get_accounts(limit=limit, sort=sort, search=search,
                        is_team=is_team if is_team is not None else None)


@app.get("/api/creators/top")
async def top_creators(limit: int = 20, period: str = "all", role=Depends(require_auth)):
    return get_top_creators(limit=limit, period=period)


@app.get("/api/creators/{account_id}")
async def get_creator(account_id: int, role=Depends(require_auth)):
    acc = get_account(account_id=account_id)
    if not acc:
        raise HTTPException(404, "Creator not found")
    return acc


@app.get("/api/creators/{account_id}/posts")
async def get_creator_posts(account_id: int, media_type: str = None, limit: int = 100,
                            role=Depends(require_auth)):
    return get_account_posts(account_id, media_type=media_type, limit=limit)


@app.post("/api/creators/add")
async def add_creator(username: str, is_team: int = 0, role=Depends(require_admin)):
    added = add_account(username, is_team=is_team)
    if added:
        return {"status": "added", "username": username}
    return {"status": "exists", "username": username}


@app.post("/api/creators/bulk-add")
async def bulk_add(request: Request, is_team: int = 0, role=Depends(require_admin)):
    body = await request.json()
    usernames = body.get("usernames", [])
    if isinstance(usernames, str):
        usernames = [u.strip() for u in usernames.split("\n") if u.strip()]
    added, skipped = bulk_add_accounts(usernames, is_team=is_team)
    return {"added": added, "skipped": skipped}


@app.delete("/api/creators/{account_id}")
async def remove_creator(account_id: int, role=Depends(require_admin)):
    delete_account(account_id)
    return {"status": "deleted"}


# ─── Posts ──────────────────────────────────────────────────────────────────

@app.get("/api/posts/viral")
async def viral_posts(page: int = 1, limit: int = 50, sort: str = "likes",
                      media_type: str = None, period: str = "all",
                      min_mult: float = 0, search: str = "",
                      role=Depends(require_auth)):
    posts = get_posts(page=page, limit=limit, sort=sort, media_type=media_type,
                      viral_only=True, period=period, min_mult=min_mult, search=search)
    total = get_post_count(media_type=media_type, viral_only=True, period=period,
                           min_mult=min_mult, search=search)
    return {"posts": posts, "total": total}


@app.get("/api/posts")
async def list_posts(page: int = 1, limit: int = 50, sort: str = "likes",
                     media_type: str = None, period: str = "all",
                     search: str = "", account_id: int = None,
                     role=Depends(require_auth)):
    return get_posts(page=page, limit=limit, sort=sort, media_type=media_type,
                     period=period, search=search, account_id=account_id)


@app.get("/api/posts/{post_id}")
async def get_post_detail(post_id: int, role=Depends(require_auth)):
    post = get_post(post_id)
    if not post:
        raise HTTPException(404, "Post not found")
    return post


@app.delete("/api/posts/{post_id}")
async def remove_post(post_id: int, role=Depends(require_admin)):
    delete_post(post_id)
    return {"status": "deleted"}


# ─── Watchlist ──────────────────────────────────────────────────────────────

@app.get("/api/watchlist")
async def list_watchlist(role=Depends(require_auth)):
    return get_watchlist()


@app.post("/api/watchlist/add")
async def watchlist_add(username: str, notes: str = "", role=Depends(require_admin)):
    acc = get_account(username=username.lower())
    account_id = acc["id"] if acc else None
    added = add_to_watchlist(username, account_id=account_id, notes=notes)
    return {"status": "added" if added else "exists"}


@app.delete("/api/watchlist/{username}")
async def watchlist_remove(username: str, role=Depends(require_admin)):
    remove_from_watchlist(username)
    return {"status": "removed"}


@app.get("/api/watchlist/check/{username}")
async def watchlist_check(username: str, role=Depends(require_auth)):
    return {"watched": is_watched(username)}


# ─── Media Serving ──────────────────────────────────────────────────────────

@app.get("/api/avatars/{username}")
async def serve_avatar(username: str):
    # Local file first
    path = AVATARS_DIR / f"{username}.jpg"
    if path.exists():
        return FileResponse(str(path), media_type="image/jpeg")
    # Supabase storage
    if USE_SUPABASE:
        sb_url = f"{SUPABASE_URL}/storage/v1/object/public/avatars/{username}.jpg"
        return RedirectResponse(sb_url, status_code=302)
    # Fallback: redirect to Twitter CDN avatar
    acc = get_account(username=username.lower())
    if acc and acc.get("avatar_url"):
        return RedirectResponse(acc["avatar_url"], status_code=302)
    raise HTTPException(404, "Avatar not found")


@app.get("/api/images/{post_id}")
async def serve_image(post_id: str):
    # Local file first
    path = IMAGES_DIR / f"{post_id}.jpg"
    if path.exists():
        return FileResponse(str(path), media_type="image/jpeg")
    # Supabase storage
    if USE_SUPABASE:
        sb_url = f"{SUPABASE_URL}/storage/v1/object/public/tweet-images/{post_id}.jpg"
        # Check if exists, otherwise fall back to CDN
        try:
            r = httpx.head(sb_url, timeout=3)
            if r.status_code == 200:
                return RedirectResponse(sb_url, status_code=302)
        except Exception:
            pass
    # Fallback: redirect to original media URL from DB
    post = get_post(int(post_id))
    if post and post.get("media_url"):
        return RedirectResponse(post["media_url"], status_code=302)
    raise HTTPException(404, "Image not found")


@app.get("/api/videos/{post_id}")
async def serve_video(post_id: str):
    """Proxy video from Twitter CDN or Supabase Storage."""
    # Supabase storage first
    if USE_SUPABASE:
        sb_url = f"{SUPABASE_URL}/storage/v1/object/public/tweet-videos/{post_id}.mp4"
        try:
            r = httpx.head(sb_url, timeout=3)
            if r.status_code == 200:
                return RedirectResponse(sb_url, status_code=302)
        except Exception:
            pass
    # Get video URL from DB and proxy it
    post = get_post(int(post_id))
    if not post:
        raise HTTPException(404, "Post not found")
    video_url = post.get("media_url", "")
    if not video_url or "video.twimg.com" not in video_url:
        raise HTTPException(404, "No video URL")
    # Stream the video through our server
    try:
        r = httpx.get(video_url, headers={"User-Agent": "Mozilla/5.0"}, timeout=30, follow_redirects=True)
        if r.status_code == 200:
            from fastapi.responses import Response
            return Response(
                content=r.content,
                media_type="video/mp4",
                headers={"Cache-Control": "public, max-age=86400"}
            )
    except Exception as e:
        log.error(f"Video proxy error: {e}")
    raise HTTPException(502, "Could not fetch video")


@app.get("/api/thumbnails/{post_id}")
async def serve_thumbnail(post_id: str):
    # Local file first
    path = THUMBNAILS_DIR / f"{post_id}.jpg"
    if path.exists():
        return FileResponse(str(path), media_type="image/jpeg")
    # Supabase storage
    if USE_SUPABASE:
        sb_url = f"{SUPABASE_URL}/storage/v1/object/public/tweet-thumbnails/{post_id}.jpg"
        try:
            r = httpx.head(sb_url, timeout=3)
            if r.status_code == 200:
                return RedirectResponse(sb_url, status_code=302)
        except Exception:
            pass
    # Fallback: redirect to original thumbnail/media URL
    post = get_post(int(post_id))
    if post:
        url = post.get("thumbnail_url") or post.get("media_url")
        if url:
            return RedirectResponse(url, status_code=302)
    raise HTTPException(404, "Thumbnail not found")


# ─── Auto-Refresh Settings ─────────────────────────────────────────────────

@app.get("/api/settings/auto-refresh")
async def get_auto_refresh(role=Depends(require_admin)):
    """Current auto-refresh state + next scheduled run."""
    settings = _load_settings()
    enabled = bool(settings.get("auto_refresh_enabled", False))
    next_run = None
    if _scheduler:
        try:
            job = _scheduler.get_job("monthly_auto_refresh")
            if job and job.next_run_time:
                next_run = job.next_run_time.isoformat()
        except Exception:
            pass
    return {
        "enabled": enabled,
        "next_run": next_run,
        "schedule": "1st of month, 02:00 Europe/Berlin",
    }


@app.post("/api/settings/auto-refresh")
async def set_auto_refresh(enabled: bool, role=Depends(require_admin)):
    settings = _load_settings()
    settings["auto_refresh_enabled"] = bool(enabled)
    _save_settings(settings)
    log.info(f"Auto-refresh toggle → {enabled}")
    return {"enabled": bool(enabled)}


def _auto_refresh_job():
    """Cron-fired monthly refresh. Skips if disabled or another scrape running."""
    try:
        settings = _load_settings()
        if not settings.get("auto_refresh_enabled"):
            log.info("Auto-refresh: disabled, skipping")
            return
        if task_manager.is_running():
            log.warning("Auto-refresh: scrape already running, skipping this slot")
            return
        started = task_manager.start_task(run_monthly_refresh_pipeline)
        if started:
            log.info("Auto-refresh: started monthly refresh")
        else:
            log.error("Auto-refresh: could not start task")
    except Exception as e:
        log.error(f"Auto-refresh job crashed: {e}", exc_info=True)


# ─── Static Files & SPA ────────────────────────────────────────────────────

app.mount("/static", _CachedStaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
async def index():
    return FileResponse(str(STATIC_DIR / "index.html"))


# ─── Startup ────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def startup():
    global _scheduler
    init_db()
    cancel_stale_jobs()

    # Monthly auto-refresh: 1st of each month at 02:00 Europe/Berlin
    try:
        from apscheduler.schedulers.background import BackgroundScheduler
        from apscheduler.triggers.cron import CronTrigger
        import pytz
        _scheduler = BackgroundScheduler(timezone=pytz.timezone("Europe/Berlin"))
        _scheduler.add_job(
            _auto_refresh_job,
            trigger=CronTrigger(day=1, hour=2, minute=0, timezone="Europe/Berlin"),
            id="monthly_auto_refresh",
            max_instances=1,
            coalesce=True,
            misfire_grace_time=3600,
        )
        _scheduler.start()
        log.info("Scheduler started: monthly auto-refresh = 1st of month, 02:00 Europe/Berlin")
    except Exception as e:
        log.warning(f"Scheduler init failed: {e}")

    log.info(f"Twitter Intel running on port {PORT} | Supabase: {USE_SUPABASE}")


@app.on_event("shutdown")
async def shutdown():
    if _scheduler:
        try:
            _scheduler.shutdown(wait=False)
        except Exception:
            pass


if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=PORT, reload=False)
