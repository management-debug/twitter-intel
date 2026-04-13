"""Twitter media downloader - downloads, compresses and uploads to Supabase Storage."""
import os
import io
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
import httpx

from config import (
    IMAGES_DIR, THUMBNAILS_DIR, VIDEOS_DIR, AVATARS_DIR,
    IMAGE_MAX_WIDTH, IMAGE_QUALITY, USE_SUPABASE,
    SUPABASE_URL, SUPABASE_SERVICE_KEY,
)

log = logging.getLogger(__name__)

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False
    log.warning("Pillow not installed, images won't be compressed")


# ─── Supabase Storage ───────────────────────────────────────────────────────

def _sb_upload(bucket, path, content, content_type="image/jpeg"):
    """Upload file bytes to Supabase Storage. Returns public URL or None."""
    if not USE_SUPABASE:
        return None
    url = f"{SUPABASE_URL}/storage/v1/object/{bucket}/{path}"
    headers = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": content_type,
        "x-upsert": "true",
    }
    try:
        r = httpx.post(url, headers=headers, content=content, timeout=30)
        if r.status_code in (200, 201):
            return f"{SUPABASE_URL}/storage/v1/object/public/{bucket}/{path}"
        log.warning(f"Supabase upload failed {bucket}/{path}: {r.status_code} {r.text[:100]}")
    except Exception as e:
        log.error(f"Supabase upload error {bucket}/{path}: {e}")
    return None


def _sb_exists(bucket, path):
    """Check if file exists in Supabase Storage."""
    if not USE_SUPABASE:
        return False
    url = f"{SUPABASE_URL}/storage/v1/object/public/{bucket}/{path}"
    try:
        r = httpx.head(url, timeout=5)
        return r.status_code == 200
    except:
        return False


# ─── Download & Compress ────────────────────────────────────────────────────

def _download_bytes(url):
    """Download URL and return raw bytes, or None on failure."""
    if not url:
        return None
    try:
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
        r = httpx.get(url, headers=headers, timeout=20, follow_redirects=True)
        if r.status_code == 200 and len(r.content) > 500:
            return r.content
    except Exception as e:
        log.debug(f"Download failed {url[:60]}: {e}")
    return None


def _compress_image(raw_bytes, max_width=IMAGE_MAX_WIDTH, quality=IMAGE_QUALITY):
    """Compress image bytes. Returns compressed JPEG bytes."""
    if not HAS_PIL or not raw_bytes:
        return raw_bytes
    try:
        img = Image.open(io.BytesIO(raw_bytes))
        if img.mode in ('RGBA', 'P'):
            img = img.convert('RGB')
        if img.width > max_width:
            ratio = max_width / img.width
            new_size = (max_width, int(img.height * ratio))
            img = img.resize(new_size, Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format='JPEG', quality=quality, optimize=True)
        return buf.getvalue()
    except Exception as e:
        log.debug(f"Compression failed: {e}")
        return raw_bytes


def _save_local(save_path, content):
    """Save bytes to local file."""
    os.makedirs(os.path.dirname(save_path), exist_ok=True)
    with open(save_path, 'wb') as f:
        f.write(content)


# ─── Download Functions ─────────────────────────────────────────────────────

def download_avatar(username, avatar_url):
    """Download creator avatar → local + Supabase. Returns public URL or local path."""
    if not avatar_url:
        return None

    sb_path = f"{username}.jpg"
    if USE_SUPABASE and _sb_exists("avatars", sb_path):
        return f"{SUPABASE_URL}/storage/v1/object/public/avatars/{sb_path}"

    local_path = os.path.join(str(AVATARS_DIR), f"{username}.jpg")
    if os.path.exists(local_path) and os.path.getsize(local_path) > 100:
        # Upload existing local to Supabase if needed
        if USE_SUPABASE:
            with open(local_path, 'rb') as f:
                _sb_upload("avatars", sb_path, f.read())
        return local_path

    raw = _download_bytes(avatar_url)
    if not raw:
        return None

    compressed = _compress_image(raw, max_width=400, quality=70)

    # Save local
    _save_local(local_path, compressed)

    # Upload to Supabase
    if USE_SUPABASE:
        sb_url = _sb_upload("avatars", sb_path, compressed)
        if sb_url:
            return sb_url

    return local_path


def download_tweet_image(post_id, media_url):
    """Download tweet photo → local + Supabase. Returns public URL or local path."""
    if not media_url:
        return None

    post_id = str(post_id)
    sb_path = f"{post_id}.jpg"

    if USE_SUPABASE and _sb_exists("tweet-images", sb_path):
        return f"{SUPABASE_URL}/storage/v1/object/public/tweet-images/{sb_path}"

    local_path = os.path.join(str(IMAGES_DIR), f"{post_id}.jpg")
    if os.path.exists(local_path) and os.path.getsize(local_path) > 100:
        if USE_SUPABASE:
            with open(local_path, 'rb') as f:
                _sb_upload("tweet-images", sb_path, f.read())
        return local_path

    raw = _download_bytes(media_url)
    if not raw:
        return None

    compressed = _compress_image(raw, max_width=IMAGE_MAX_WIDTH, quality=IMAGE_QUALITY)

    _save_local(local_path, compressed)

    if USE_SUPABASE:
        sb_url = _sb_upload("tweet-images", sb_path, compressed)
        if sb_url:
            return sb_url

    return local_path


def download_tweet_thumbnail(post_id, thumbnail_url):
    """Download video thumbnail → local + Supabase. Returns public URL or local path."""
    if not thumbnail_url:
        return None

    post_id = str(post_id)
    sb_path = f"{post_id}.jpg"

    if USE_SUPABASE and _sb_exists("tweet-thumbnails", sb_path):
        return f"{SUPABASE_URL}/storage/v1/object/public/tweet-thumbnails/{sb_path}"

    local_path = os.path.join(str(THUMBNAILS_DIR), f"{post_id}.jpg")
    if os.path.exists(local_path) and os.path.getsize(local_path) > 100:
        if USE_SUPABASE:
            with open(local_path, 'rb') as f:
                _sb_upload("tweet-thumbnails", sb_path, f.read())
        return local_path

    raw = _download_bytes(thumbnail_url)
    if not raw:
        return None

    compressed = _compress_image(raw, max_width=IMAGE_MAX_WIDTH, quality=IMAGE_QUALITY)

    _save_local(local_path, compressed)

    if USE_SUPABASE:
        sb_url = _sb_upload("tweet-thumbnails", sb_path, compressed)
        if sb_url:
            return sb_url

    return local_path


def download_tweet_video(post_id, video_url):
    """Download tweet video .mp4 → local + Supabase. Returns public URL or local path."""
    if not video_url or 'video.twimg.com' not in video_url:
        return None

    post_id = str(post_id)
    sb_path = f"{post_id}.mp4"

    if USE_SUPABASE and _sb_exists("tweet-videos", sb_path):
        return f"{SUPABASE_URL}/storage/v1/object/public/tweet-videos/{sb_path}"

    local_path = os.path.join(str(VIDEOS_DIR), f"{post_id}.mp4")
    if os.path.exists(local_path) and os.path.getsize(local_path) > 1000:
        if USE_SUPABASE:
            with open(local_path, 'rb') as f:
                _sb_upload("tweet-videos", sb_path, f.read(), content_type="video/mp4")
        return local_path

    raw = _download_bytes(video_url)
    if not raw:
        return None

    # Save locally (no compression for video)
    _save_local(local_path, raw)

    # Upload to Supabase
    if USE_SUPABASE:
        sb_url = _sb_upload("tweet-videos", sb_path, raw, content_type="video/mp4")
        if sb_url:
            return sb_url

    return local_path


# ─── Batch Operations ───────────────────────────────────────────────────────

def batch_download_images(items, download_fn, max_workers=6):
    """Download multiple files in parallel.
    items: list of (id, url) tuples
    download_fn: function(id, url) -> path/url
    Returns count of successful downloads.
    """
    downloaded = 0
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {}
        for item_id, url in items:
            if url:
                f = executor.submit(download_fn, item_id, url)
                futures[f] = item_id

        for f in as_completed(futures):
            try:
                result = f.result()
                if result:
                    downloaded += 1
            except Exception as e:
                log.error(f"Download error for {futures[f]}: {e}")

    return downloaded


def download_all_media(posts, accounts):
    """Download all media for posts and accounts → local + Supabase Storage.
    Returns dict with download counts.
    """
    stats = {"avatars": 0, "images": 0, "thumbnails": 0, "videos": 0}

    # Download avatars (all accounts)
    avatar_items = [(a["username"], a.get("avatar_url", "")) for a in accounts if a.get("avatar_url")]
    if avatar_items:
        stats["avatars"] = batch_download_images(avatar_items, download_avatar, max_workers=6)
        log.info(f"Downloaded {stats['avatars']}/{len(avatar_items)} avatars")

    # Download tweet images (photos)
    photo_items = []
    for p in posts:
        if p.get("media_type") == "photo" and p.get("media_url"):
            pid = str(p.get("id", p.get("tweet_id", "")))
            photo_items.append((pid, p["media_url"]))
    if photo_items:
        stats["images"] = batch_download_images(photo_items, download_tweet_image, max_workers=6)
        log.info(f"Downloaded {stats['images']}/{len(photo_items)} tweet images")

    # Download tweet videos (.mp4 files)
    video_items = []
    for p in posts:
        if p.get("media_type") == "video" and p.get("media_url") and 'video.twimg.com' in p.get("media_url", ""):
            pid = str(p.get("id", p.get("tweet_id", "")))
            video_items.append((pid, p["media_url"]))
    if video_items:
        stats["videos"] = batch_download_images(video_items, download_tweet_video, max_workers=4)
        log.info(f"Downloaded {stats['videos']}/{len(video_items)} tweet videos")

    # Download video thumbnails
    thumb_items = []
    for p in posts:
        if p.get("media_type") == "video":
            pid = str(p.get("id", p.get("tweet_id", "")))
            url = p.get("thumbnail_url") or p.get("media_url", "")
            if url:
                thumb_items.append((pid, url))
    if thumb_items:
        stats["thumbnails"] = batch_download_images(thumb_items, download_tweet_thumbnail, max_workers=6)
        log.info(f"Downloaded {stats['thumbnails']}/{len(thumb_items)} video thumbnails")

    return stats
