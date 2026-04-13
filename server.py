"""Twitter Intel Dashboard - FastAPI Server"""
import os
import logging
from pathlib import Path
from datetime import datetime, timezone

import uvicorn
from fastapi import FastAPI, Request, HTTPException, Depends
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, RedirectResponse, JSONResponse

from config import (
    PORT, STATIC_DIR, AVATARS_DIR, IMAGES_DIR, THUMBNAILS_DIR,
    ADMIN_EMAIL, ADMIN_PASSWORD, WORKER_PASSWORD, SCRAPE_PIN, USE_SUPABASE,
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
from tasks.pipeline import run_full_pipeline, run_new_only_pipeline, run_refresh_pipeline

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
log = logging.getLogger(__name__)

app = FastAPI(title="Twitter Intel", docs_url=None, redoc_url=None)


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
        except:
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
        except:
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
        except:
            pass
    # Fallback: redirect to original thumbnail/media URL
    post = get_post(int(post_id))
    if post:
        url = post.get("thumbnail_url") or post.get("media_url")
        if url:
            return RedirectResponse(url, status_code=302)
    raise HTTPException(404, "Thumbnail not found")


# ─── Static Files & SPA ────────────────────────────────────────────────────

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
async def index():
    return FileResponse(str(STATIC_DIR / "index.html"))


# ─── Startup ────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def startup():
    init_db()
    cancel_stale_jobs()
    log.info(f"Twitter Intel running on port {PORT} | Supabase: {USE_SUPABASE}")


if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=PORT, reload=False)
