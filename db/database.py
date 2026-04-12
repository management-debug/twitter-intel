"""Twitter Intel - Database Layer (Dual-mode: SQLite + Supabase)"""
import sqlite3
import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

from config import (
    DB_PATH, USE_SUPABASE, SUPABASE_URL, SUPABASE_SERVICE_KEY,
    VIRAL_MIN_LIKES_PHOTO, VIRAL_MIN_LIKES_TEXT, VIRAL_MIN_VIEWS_VIDEO,
    VIRAL_MULTIPLIER_PHOTO, VIRAL_MULTIPLIER_VIDEO, VIRAL_MULTIPLIER_TEXT,
)

log = logging.getLogger(__name__)

# ─── SQLite Setup ───────────────────────────────────────────────────────────

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    user_id TEXT,
    display_name TEXT,
    bio TEXT DEFAULT '',
    bio_link TEXT DEFAULT '',
    location TEXT DEFAULT '',
    followers INTEGER DEFAULT 0,
    following INTEGER DEFAULT 0,
    tweet_count INTEGER DEFAULT 0,
    is_verified INTEGER DEFAULT 0,
    avatar_url TEXT DEFAULT '',
    avatar_local TEXT DEFAULT '',
    banner_url TEXT DEFAULT '',
    avg_likes_30d REAL DEFAULT 0,
    avg_views_30d REAL DEFAULT 0,
    avg_photo_likes REAL DEFAULT 0,
    avg_video_views REAL DEFAULT 0,
    avg_text_likes REAL DEFAULT 0,
    photo_count INTEGER DEFAULT 0,
    video_count INTEGER DEFAULT 0,
    text_count INTEGER DEFAULT 0,
    is_our_team INTEGER DEFAULT 0,
    model_name TEXT DEFAULT '',
    worker_name TEXT DEFAULT '',
    scrape_status TEXT DEFAULT 'pending',
    first_scraped_at TEXT,
    last_scraped_at TEXT,
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tweet_id TEXT UNIQUE NOT NULL,
    account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
    username TEXT NOT NULL,
    caption TEXT DEFAULT '',
    create_time TEXT,
    media_type TEXT DEFAULT 'text',
    likes INTEGER DEFAULT 0,
    views INTEGER DEFAULT 0,
    bookmarks INTEGER DEFAULT 0,
    retweets INTEGER DEFAULT 0,
    replies INTEGER DEFAULT 0,
    quote_count INTEGER DEFAULT 0,
    media_url TEXT DEFAULT '',
    media_local TEXT DEFAULT '',
    thumbnail_url TEXT DEFAULT '',
    thumbnail_local TEXT DEFAULT '',
    is_viral INTEGER DEFAULT 0,
    performance_multiplier REAL DEFAULT 0,
    caption_category TEXT DEFAULT '',
    raw_json TEXT DEFAULT '',
    scraped_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scrape_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_type TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    total_accounts INTEGER DEFAULT 0,
    processed_accounts INTEGER DEFAULT 0,
    total_posts_found INTEGER DEFAULT 0,
    viral_found INTEGER DEFAULT 0,
    images_downloaded INTEGER DEFAULT 0,
    error_message TEXT DEFAULT '',
    started_at TEXT,
    completed_at TEXT
);

CREATE TABLE IF NOT EXISTS watchlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
    notes TEXT DEFAULT '',
    added_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_accounts_username ON accounts(username);
CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(scrape_status);
CREATE INDEX IF NOT EXISTS idx_posts_account ON posts(account_id);
CREATE INDEX IF NOT EXISTS idx_posts_tweet_id ON posts(tweet_id);
CREATE INDEX IF NOT EXISTS idx_posts_viral ON posts(is_viral, media_type);
CREATE INDEX IF NOT EXISTS idx_posts_likes ON posts(likes DESC);
CREATE INDEX IF NOT EXISTS idx_posts_views ON posts(views DESC);
CREATE INDEX IF NOT EXISTS idx_posts_time ON posts(create_time DESC);
CREATE INDEX IF NOT EXISTS idx_posts_media_type ON posts(media_type);
CREATE INDEX IF NOT EXISTS idx_watchlist_username ON watchlist(username);
"""


def get_db():
    """Get SQLite connection with WAL mode and FK enabled."""
    conn = sqlite3.connect(str(DB_PATH), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    """Initialize database schema."""
    if USE_SUPABASE:
        log.info("Using Supabase (tables must exist in dashboard)")
        return
    conn = get_db()
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()
    log.info(f"SQLite initialized at {DB_PATH}")


# ─── Supabase Helpers ───────────────────────────────────────────────────────

_sb_headers = {
    "apikey": SUPABASE_SERVICE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}


def _sb_get(table, params=None, single=False):
    """Supabase REST GET."""
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    r = httpx.get(url, headers=_sb_headers, params=params or {}, timeout=30)
    r.raise_for_status()
    data = r.json()
    if single:
        return data[0] if data else None
    return data


def _sb_insert(table, rows, upsert_col=None):
    """Supabase REST POST (insert or upsert)."""
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    h = {**_sb_headers}
    if upsert_col:
        h["Prefer"] = f"resolution=merge-duplicates,return=representation"
        url += f"?on_conflict={upsert_col}"
    if not isinstance(rows, list):
        rows = [rows]
    r = httpx.post(url, headers=h, json=rows, timeout=30)
    r.raise_for_status()
    return r.json()


def _sb_update(table, match, data):
    """Supabase REST PATCH."""
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    params = {f"{k}": f"eq.{v}" for k, v in match.items()}
    r = httpx.patch(url, headers=_sb_headers, params=params, json=data, timeout=30)
    r.raise_for_status()
    return r.json()


def _sb_delete(table, match):
    """Supabase REST DELETE."""
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    params = {f"{k}": f"eq.{v}" for k, v in match.items()}
    r = httpx.delete(url, headers=_sb_headers, params=params, timeout=30)
    r.raise_for_status()
    return True


def _sb_count(table, filters=None):
    """Supabase count query."""
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    h = {**_sb_headers, "Prefer": "count=exact", "Range": "0-0"}
    params = filters or {}
    r = httpx.get(url, headers=h, params=params, timeout=30)
    r.raise_for_status()
    cr = r.headers.get("content-range", "0/0")
    return int(cr.split("/")[-1]) if "/" in cr else 0


# ─── Supabase Storage ───────────────────────────────────────────────────────

def sb_upload_file(bucket, path, file_bytes, content_type="image/jpeg"):
    """Upload file to Supabase Storage."""
    url = f"{SUPABASE_URL}/storage/v1/object/{bucket}/{path}"
    h = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": content_type,
        "x-upsert": "true",
    }
    r = httpx.post(url, headers=h, content=file_bytes, timeout=60)
    if r.status_code in (200, 201):
        return f"{SUPABASE_URL}/storage/v1/object/public/{bucket}/{path}"
    return None


# ─── Account Operations ────────────────────────────────────────────────────

def add_account(username, is_team=0, model_name="", worker_name=""):
    """Add a single account. Returns True if added, False if exists."""
    username = username.lower().strip().lstrip("@")
    now = datetime.now(timezone.utc).isoformat()

    if USE_SUPABASE:
        existing = _sb_get("accounts", {"username": f"eq.{username}", "select": "id"})
        if existing:
            return False
        _sb_insert("accounts", {
            "username": username,
            "is_our_team": is_team,
            "model_name": model_name,
            "worker_name": worker_name,
            "scrape_status": "pending",
            "created_at": now,
        })
        return True

    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO accounts (username, is_our_team, model_name, worker_name, created_at) VALUES (?, ?, ?, ?, ?)",
            (username, is_team, model_name, worker_name, now)
        )
        conn.commit()
        return True
    except sqlite3.IntegrityError:
        return False
    finally:
        conn.close()


def bulk_add_accounts(usernames, is_team=0):
    """Add multiple accounts. Returns (added, skipped) counts."""
    added = skipped = 0
    for u in usernames:
        u = u.strip().lower().lstrip("@")
        if not u:
            continue
        if add_account(u, is_team):
            added += 1
        else:
            skipped += 1
    return added, skipped


def get_account(account_id=None, username=None):
    """Get single account by ID or username."""
    if USE_SUPABASE:
        if account_id:
            return _sb_get("accounts", {"id": f"eq.{account_id}"}, single=True)
        return _sb_get("accounts", {"username": f"eq.{username}"}, single=True)

    conn = get_db()
    if account_id:
        row = conn.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
    else:
        row = conn.execute("SELECT * FROM accounts WHERE username = ?", (username,)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_accounts(limit=500, sort="followers", search="", is_team=None, status=None):
    """List accounts with filters."""
    valid_sorts = {"followers", "avg_likes_30d", "avg_views_30d", "username", "created_at", "last_scraped_at"}
    sort = sort if sort in valid_sorts else "followers"

    if USE_SUPABASE:
        params = {"select": "*", "order": f"{sort}.desc.nullslast", "limit": limit}
        if search:
            params["username"] = f"ilike.%{search}%"
        if is_team is not None:
            params["is_our_team"] = f"eq.{is_team}"
        if status:
            params["scrape_status"] = f"eq.{status}"
        return _sb_get("accounts", params)

    conn = get_db()
    q = "SELECT * FROM accounts WHERE 1=1"
    args = []
    if search:
        q += " AND username LIKE ?"
        args.append(f"%{search}%")
    if is_team is not None:
        q += " AND is_our_team = ?"
        args.append(is_team)
    if status:
        q += " AND scrape_status = ?"
        args.append(status)
    q += f" ORDER BY {sort} DESC LIMIT ?"
    args.append(limit)
    rows = conn.execute(q, args).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def update_account(account_id, data):
    """Update account fields."""
    if USE_SUPABASE:
        _sb_update("accounts", {"id": account_id}, data)
        return

    conn = get_db()
    sets = ", ".join(f"{k} = ?" for k in data.keys())
    vals = list(data.values()) + [account_id]
    conn.execute(f"UPDATE accounts SET {sets} WHERE id = ?", vals)
    conn.commit()
    conn.close()


def delete_account(account_id):
    """Delete account and all associated posts."""
    if USE_SUPABASE:
        _sb_delete("watchlist", {"account_id": account_id})
        _sb_delete("posts", {"account_id": account_id})
        _sb_delete("accounts", {"id": account_id})
        return True

    conn = get_db()
    conn.execute("DELETE FROM watchlist WHERE account_id = ?", (account_id,))
    conn.execute("DELETE FROM posts WHERE account_id = ?", (account_id,))
    conn.execute("DELETE FROM accounts WHERE id = ?", (account_id,))
    conn.commit()
    conn.close()
    return True


def get_pending_accounts(limit=0):
    """Get accounts with scrape_status='pending'."""
    if USE_SUPABASE:
        params = {"scrape_status": "eq.pending", "select": "*", "order": "id.asc"}
        if limit:
            params["limit"] = limit
        return _sb_get("accounts", params)

    conn = get_db()
    q = "SELECT * FROM accounts WHERE scrape_status = 'pending' ORDER BY id"
    if limit:
        q += f" LIMIT {limit}"
    rows = conn.execute(q).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_scraped_accounts():
    """Get accounts that have been successfully scraped."""
    if USE_SUPABASE:
        return _sb_get("accounts", {"scrape_status": "eq.scraped", "select": "*", "order": "id.asc"})

    conn = get_db()
    rows = conn.execute("SELECT * FROM accounts WHERE scrape_status = 'scraped' ORDER BY id").fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ─── Post Operations ───────────────────────────────────────────────────────

def upsert_post(post_data):
    """Insert or update a post by tweet_id."""
    if USE_SUPABASE:
        _sb_insert("posts", post_data, upsert_col="tweet_id")
        return

    conn = get_db()
    existing = conn.execute("SELECT id FROM posts WHERE tweet_id = ?", (post_data["tweet_id"],)).fetchone()
    if existing:
        pid = existing["id"]
        sets = ", ".join(f"{k} = ?" for k in post_data.keys())
        conn.execute(f"UPDATE posts SET {sets} WHERE id = ?", list(post_data.values()) + [pid])
    else:
        cols = ", ".join(post_data.keys())
        placeholders = ", ".join("?" * len(post_data))
        conn.execute(f"INSERT INTO posts ({cols}) VALUES ({placeholders})", list(post_data.values()))
    conn.commit()
    conn.close()


def bulk_upsert_posts(posts):
    """Bulk insert/update posts."""
    if USE_SUPABASE:
        # Batch in chunks of 500
        for i in range(0, len(posts), 500):
            chunk = posts[i:i+500]
            _sb_insert("posts", chunk, upsert_col="tweet_id")
        return

    conn = get_db()
    for p in posts:
        existing = conn.execute("SELECT id FROM posts WHERE tweet_id = ?", (p["tweet_id"],)).fetchone()
        if existing:
            pid = existing["id"]
            sets = ", ".join(f"{k} = ?" for k in p.keys())
            conn.execute(f"UPDATE posts SET {sets} WHERE id = ?", list(p.values()) + [pid])
        else:
            cols = ", ".join(p.keys())
            placeholders = ", ".join("?" * len(p))
            conn.execute(f"INSERT INTO posts ({cols}) VALUES ({placeholders})", list(p.values()))
    conn.commit()
    conn.close()


def get_posts(page=1, limit=50, sort="likes", media_type=None, viral_only=False,
              period="all", min_mult=0, search="", account_id=None):
    """Get posts with extensive filtering."""
    valid_sorts = {"likes", "views", "bookmarks", "retweets", "create_time", "performance_multiplier"}
    sort = sort if sort in valid_sorts else "likes"
    offset = (page - 1) * limit

    if USE_SUPABASE:
        params = {
            "select": "*",
            "order": f"{sort}.desc.nullslast",
            "limit": limit,
            "offset": offset,
        }
        if media_type:
            params["media_type"] = f"eq.{media_type}"
        if viral_only:
            params["is_viral"] = "eq.1"
        if min_mult > 0:
            params["performance_multiplier"] = f"gte.{min_mult}"
        if account_id:
            params["account_id"] = f"eq.{account_id}"
        if search:
            params["caption"] = f"ilike.%{search}%"
        if period != "all":
            cutoff = _period_cutoff(period)
            if cutoff:
                params["create_time"] = f"gte.{cutoff}"
        return _sb_get("posts", params)

    conn = get_db()
    q = "SELECT * FROM posts WHERE 1=1"
    args = []

    if media_type:
        q += " AND media_type = ?"
        args.append(media_type)
    if viral_only:
        q += " AND is_viral = 1"
    if min_mult > 0:
        q += " AND performance_multiplier >= ?"
        args.append(min_mult)
    if account_id:
        q += " AND account_id = ?"
        args.append(account_id)
    if search:
        q += " AND caption LIKE ?"
        args.append(f"%{search}%")
    if period != "all":
        cutoff = _period_cutoff(period)
        if cutoff:
            q += " AND create_time >= ?"
            args.append(cutoff)

    q += f" ORDER BY {sort} DESC LIMIT ? OFFSET ?"
    args.extend([limit, offset])

    rows = conn.execute(q, args).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_post(post_id):
    """Get single post by ID."""
    if USE_SUPABASE:
        return _sb_get("posts", {"id": f"eq.{post_id}"}, single=True)
    conn = get_db()
    row = conn.execute("SELECT * FROM posts WHERE id = ?", (post_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_account_posts(account_id, media_type=None, limit=100):
    """Get all posts for a specific account."""
    if USE_SUPABASE:
        params = {"account_id": f"eq.{account_id}", "order": "likes.desc", "limit": limit, "select": "*"}
        if media_type:
            params["media_type"] = f"eq.{media_type}"
        return _sb_get("posts", params)

    conn = get_db()
    q = "SELECT * FROM posts WHERE account_id = ?"
    args = [account_id]
    if media_type:
        q += " AND media_type = ?"
        args.append(media_type)
    q += " ORDER BY likes DESC LIMIT ?"
    args.append(limit)
    rows = conn.execute(q, args).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def delete_post(post_id):
    """Delete a single post."""
    if USE_SUPABASE:
        return _sb_delete("posts", {"id": post_id})
    conn = get_db()
    conn.execute("DELETE FROM posts WHERE id = ?", (post_id,))
    conn.commit()
    conn.close()
    return True


# ─── Viral Detection ───────────────────────────────────────────────────────

def calc_viral(media_type, likes, views, avg_likes, avg_views):
    """Determine if a post is viral based on content type."""
    if media_type == "photo":
        if likes < VIRAL_MIN_LIKES_PHOTO:
            return False, 0
        if avg_likes > 0:
            mult = round(likes / avg_likes, 1)
            return mult >= VIRAL_MULTIPLIER_PHOTO, mult
        return True, 0

    elif media_type == "video":
        if views < VIRAL_MIN_VIEWS_VIDEO:
            return False, 0
        if avg_views > 0:
            mult = round(views / avg_views, 1)
            return mult >= VIRAL_MULTIPLIER_VIDEO, mult
        return True, 0

    elif media_type == "text":
        if likes < VIRAL_MIN_LIKES_TEXT:
            return False, 0
        if avg_likes > 0:
            mult = round(likes / avg_likes, 1)
            return mult >= VIRAL_MULTIPLIER_TEXT, mult
        return True, 0

    return False, 0


# ─── Stats / Dashboard ─────────────────────────────────────────────────────

def get_dashboard_stats():
    """Get overview stats for dashboard."""
    if USE_SUPABASE:
        total_accounts = _sb_count("accounts")
        scraped = _sb_count("accounts", {"scrape_status": "eq.scraped"})
        pending = _sb_count("accounts", {"scrape_status": "eq.pending"})
        total_posts = _sb_count("posts")
        viral_photos = _sb_count("posts", {"is_viral": "eq.1", "media_type": "eq.photo"})
        viral_videos = _sb_count("posts", {"is_viral": "eq.1", "media_type": "eq.video"})
        viral_texts = _sb_count("posts", {"is_viral": "eq.1", "media_type": "eq.text"})
        photos = _sb_count("posts", {"media_type": "eq.photo"})
        videos = _sb_count("posts", {"media_type": "eq.video"})
        texts = _sb_count("posts", {"media_type": "eq.text"})
        return {
            "total_accounts": total_accounts,
            "scraped_accounts": scraped,
            "pending_accounts": pending,
            "total_posts": total_posts,
            "photo_posts": photos,
            "video_posts": videos,
            "text_posts": texts,
            "viral_photos": viral_photos,
            "viral_videos": viral_videos,
            "viral_texts": viral_texts,
        }

    conn = get_db()
    stats = {
        "total_accounts": conn.execute("SELECT COUNT(*) FROM accounts").fetchone()[0],
        "scraped_accounts": conn.execute("SELECT COUNT(*) FROM accounts WHERE scrape_status='scraped'").fetchone()[0],
        "pending_accounts": conn.execute("SELECT COUNT(*) FROM accounts WHERE scrape_status='pending'").fetchone()[0],
        "total_posts": conn.execute("SELECT COUNT(*) FROM posts").fetchone()[0],
        "photo_posts": conn.execute("SELECT COUNT(*) FROM posts WHERE media_type='photo'").fetchone()[0],
        "video_posts": conn.execute("SELECT COUNT(*) FROM posts WHERE media_type='video'").fetchone()[0],
        "text_posts": conn.execute("SELECT COUNT(*) FROM posts WHERE media_type='text'").fetchone()[0],
        "viral_photos": conn.execute("SELECT COUNT(*) FROM posts WHERE is_viral=1 AND media_type='photo'").fetchone()[0],
        "viral_videos": conn.execute("SELECT COUNT(*) FROM posts WHERE is_viral=1 AND media_type='video'").fetchone()[0],
        "viral_texts": conn.execute("SELECT COUNT(*) FROM posts WHERE is_viral=1 AND media_type='text'").fetchone()[0],
    }
    conn.close()
    return stats


def get_top_creators(limit=20, period="all"):
    """Get top creators by avg engagement."""
    if USE_SUPABASE:
        params = {
            "select": "*",
            "order": "avg_likes_30d.desc.nullslast",
            "limit": limit,
            "scrape_status": "eq.scraped",
        }
        return _sb_get("accounts", params)

    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM accounts WHERE scrape_status='scraped' ORDER BY avg_likes_30d DESC LIMIT ?",
        (limit,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ─── Scrape Jobs ───────────────────────────────────────────────────────────

def create_job(job_type):
    """Create a new scrape job."""
    now = datetime.now(timezone.utc).isoformat()
    if USE_SUPABASE:
        result = _sb_insert("scrape_jobs", {
            "job_type": job_type,
            "status": "running",
            "started_at": now,
        })
        return result[0]["id"] if result else None

    conn = get_db()
    cur = conn.execute(
        "INSERT INTO scrape_jobs (job_type, status, started_at) VALUES (?, 'running', ?)",
        (job_type, now)
    )
    conn.commit()
    job_id = cur.lastrowid
    conn.close()
    return job_id


def update_job(job_id, data):
    """Update scrape job progress."""
    if USE_SUPABASE:
        _sb_update("scrape_jobs", {"id": job_id}, data)
        return
    conn = get_db()
    sets = ", ".join(f"{k} = ?" for k in data.keys())
    conn.execute(f"UPDATE scrape_jobs SET {sets} WHERE id = ?", list(data.values()) + [job_id])
    conn.commit()
    conn.close()


def get_job(job_id):
    """Get single job."""
    if USE_SUPABASE:
        return _sb_get("scrape_jobs", {"id": f"eq.{job_id}"}, single=True)
    conn = get_db()
    row = conn.execute("SELECT * FROM scrape_jobs WHERE id = ?", (job_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_jobs(limit=20):
    """Get recent jobs."""
    if USE_SUPABASE:
        return _sb_get("scrape_jobs", {"select": "*", "order": "id.desc", "limit": limit})
    conn = get_db()
    rows = conn.execute("SELECT * FROM scrape_jobs ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def cancel_stale_jobs():
    """Cancel any running jobs from previous deploys."""
    if USE_SUPABASE:
        _sb_update("scrape_jobs", {"status": "running"}, {"status": "cancelled", "error_message": "Stale job cancelled on restart"})
        return
    conn = get_db()
    conn.execute("UPDATE scrape_jobs SET status='cancelled', error_message='Stale job cancelled on restart' WHERE status='running'")
    conn.commit()
    conn.close()


# ─── Watchlist ─────────────────────────────────────────────────────────────

def add_to_watchlist(username, account_id=None, notes=""):
    """Add creator to watchlist."""
    username = username.lower().strip()
    now = datetime.now(timezone.utc).isoformat()

    if USE_SUPABASE:
        existing = _sb_get("watchlist", {"username": f"eq.{username}"})
        if existing:
            return False
        _sb_insert("watchlist", {"username": username, "account_id": account_id, "notes": notes, "added_at": now})
        return True

    conn = get_db()
    try:
        conn.execute("INSERT INTO watchlist (username, account_id, notes, added_at) VALUES (?, ?, ?, ?)",
                      (username, account_id, notes, now))
        conn.commit()
        return True
    except sqlite3.IntegrityError:
        return False
    finally:
        conn.close()


def remove_from_watchlist(username):
    """Remove from watchlist."""
    if USE_SUPABASE:
        return _sb_delete("watchlist", {"username": username.lower()})
    conn = get_db()
    conn.execute("DELETE FROM watchlist WHERE username = ?", (username.lower(),))
    conn.commit()
    conn.close()
    return True


def get_watchlist():
    """Get all watchlist entries with account stats."""
    if USE_SUPABASE:
        return _sb_get("watchlist", {"select": "*", "order": "added_at.desc"})

    conn = get_db()
    rows = conn.execute("""
        SELECT w.*, a.followers, a.avg_likes_30d, a.avg_views_30d, a.avatar_url,
               a.display_name, a.bio, a.is_verified
        FROM watchlist w
        LEFT JOIN accounts a ON w.account_id = a.id
        ORDER BY w.added_at DESC
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def is_watched(username):
    """Check if username is on watchlist."""
    if USE_SUPABASE:
        r = _sb_get("watchlist", {"username": f"eq.{username.lower()}", "select": "id"})
        return bool(r)
    conn = get_db()
    row = conn.execute("SELECT id FROM watchlist WHERE username = ?", (username.lower(),)).fetchone()
    conn.close()
    return bool(row)


# ─── Helpers ───────────────────────────────────────────────────────────────

def _period_cutoff(period):
    """Convert period string to ISO datetime cutoff."""
    now = datetime.now(timezone.utc)
    deltas = {
        "today": timedelta(days=1),
        "yesterday": timedelta(days=2),
        "week": timedelta(days=7),
        "2weeks": timedelta(days=14),
        "month": timedelta(days=30),
        "3months": timedelta(days=90),
    }
    d = deltas.get(period)
    if d:
        return (now - d).isoformat()
    return None
