"""Twitter media downloader - downloads and compresses tweet images."""
import os
import io
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
import httpx

from config import (
    IMAGES_DIR, THUMBNAILS_DIR, VIDEOS_DIR, AVATARS_DIR,
    IMAGE_MAX_WIDTH, IMAGE_QUALITY, USE_SUPABASE,
)

log = logging.getLogger(__name__)

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False
    log.warning("Pillow not installed, images won't be compressed")


def download_file(url, save_path, compress=True):
    """Download a file from URL and optionally compress it.
    Returns the local path or None on failure.
    """
    if not url:
        return None
    if os.path.exists(save_path) and os.path.getsize(save_path) > 100:
        return save_path

    try:
        headers = {"User-Agent": "Mozilla/5.0"}
        r = httpx.get(url, headers=headers, timeout=15, follow_redirects=True)
        if r.status_code != 200 or len(r.content) < 100:
            return None

        content = r.content

        # Compress if image and PIL available
        if compress and HAS_PIL and save_path.endswith(('.jpg', '.jpeg', '.png')):
            try:
                img = Image.open(io.BytesIO(content))
                if img.mode in ('RGBA', 'P'):
                    img = img.convert('RGB')
                if img.width > IMAGE_MAX_WIDTH:
                    ratio = IMAGE_MAX_WIDTH / img.width
                    new_size = (IMAGE_MAX_WIDTH, int(img.height * ratio))
                    img = img.resize(new_size, Image.LANCZOS)
                buf = io.BytesIO()
                img.save(buf, format='JPEG', quality=IMAGE_QUALITY, optimize=True)
                content = buf.getvalue()
            except Exception as e:
                log.debug(f"Compression failed, saving original: {e}")

        os.makedirs(os.path.dirname(save_path), exist_ok=True)
        with open(save_path, 'wb') as f:
            f.write(content)

        return save_path
    except Exception as e:
        log.error(f"Download failed {url[:60]}: {e}")
        return None


def download_avatar(username, avatar_url):
    """Download creator avatar."""
    if not avatar_url:
        return None
    save_path = os.path.join(str(AVATARS_DIR), f"{username}.jpg")
    return download_file(avatar_url, save_path, compress=True)


def download_tweet_image(post_id, media_url):
    """Download tweet image."""
    if not media_url:
        return None
    save_path = os.path.join(str(IMAGES_DIR), f"{post_id}.jpg")
    return download_file(media_url, save_path, compress=True)


def download_tweet_thumbnail(post_id, thumbnail_url):
    """Download tweet video thumbnail."""
    if not thumbnail_url:
        return None
    save_path = os.path.join(str(THUMBNAILS_DIR), f"{post_id}.jpg")
    return download_file(thumbnail_url, save_path, compress=True)


def batch_download_images(items, download_fn, max_workers=6):
    """Download multiple files in parallel.
    items: list of (id, url) tuples
    download_fn: function(id, url) -> path
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
    """Download all media for a set of posts and accounts.
    Returns dict with download counts.
    """
    stats = {"avatars": 0, "images": 0, "thumbnails": 0}

    # Download avatars
    avatar_items = [(a["username"], a.get("avatar_url", "")) for a in accounts if a.get("avatar_url")]
    if avatar_items:
        stats["avatars"] = batch_download_images(avatar_items, download_avatar, max_workers=6)
        log.info(f"Downloaded {stats['avatars']}/{len(avatar_items)} avatars")

    # Download tweet images (photos only)
    photo_items = [(str(p.get("id", p.get("tweet_id", ""))), p.get("media_url", ""))
                   for p in posts if p.get("media_type") == "photo" and p.get("media_url")]
    if photo_items:
        stats["images"] = batch_download_images(photo_items, download_tweet_image, max_workers=6)
        log.info(f"Downloaded {stats['images']}/{len(photo_items)} tweet images")

    # Download video thumbnails
    video_items = [(str(p.get("id", p.get("tweet_id", ""))), p.get("thumbnail_url", ""))
                   for p in posts if p.get("media_type") == "video" and p.get("thumbnail_url")]
    if video_items:
        stats["thumbnails"] = batch_download_images(video_items, download_tweet_thumbnail, max_workers=6)
        log.info(f"Downloaded {stats['thumbnails']}/{len(video_items)} video thumbnails")

    return stats
