"""Seed database with existing scraped data and account list."""
import json
import os
import re
import sys
import logging
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from db.database import init_db, add_account, bulk_add_accounts, bulk_upsert_posts, update_account, calc_viral, get_account
from config import AVATARS_DIR, IMAGES_DIR

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)


def safe_int(val, default=0):
    try:
        return int(val)
    except (TypeError, ValueError):
        return default


def seed_from_dataset(dataset_path):
    """Import the 4996-tweet dataset into the database."""
    log.info(f"Loading dataset: {dataset_path}")
    with open(dataset_path, 'r') as f:
        data = json.load(f)

    log.info(f"Loaded {len(data)} tweets")

    # Group by user
    users = {}
    for tweet in data:
        user = tweet.get('user', {})
        legacy = user.get('legacy', {})
        uid = tweet.get('user_id_str', '')

        if uid not in users:
            link = ''
            try:
                urls = legacy.get('entities', {}).get('url', {}).get('urls', [])
                if urls:
                    link = urls[0].get('expanded_url', '') or urls[0].get('display_url', '')
            except:
                pass

            avatar = user.get('avatar', {})
            avatar_url = ''
            if isinstance(avatar, dict):
                avatar_url = avatar.get('image_url', '').replace('_normal', '_400x400')
            elif isinstance(avatar, str):
                avatar_url = avatar.replace('_normal', '_400x400')

            loc = user.get('location', {})
            location = loc.get('location', '') if isinstance(loc, dict) else str(loc) if loc else ''

            users[uid] = {
                'username': legacy.get('screen_name', '').lower(),
                'display_name': legacy.get('name', ''),
                'bio': legacy.get('description', ''),
                'followers': safe_int(legacy.get('followers_count', 0)),
                'following': safe_int(legacy.get('friends_count', 0)),
                'tweet_count': safe_int(legacy.get('statuses_count', 0)),
                'is_verified': 1 if user.get('is_blue_verified', False) else 0,
                'avatar_url': avatar_url,
                'banner_url': legacy.get('profile_banner_url', ''),
                'bio_link': link,
                'location': location,
                'user_id': uid,
                'tweets': [],
            }

        text = re.sub(r'https?://t\.co/\S+', '', str(tweet.get('full_text', ''))).strip()
        ext = tweet.get('extended_entities') or {}
        media_list = ext.get('media', []) if ext else []
        media_type = 'text'
        media_url = ''

        if media_list:
            first = media_list[0]
            mtype = first.get('type', '')
            if mtype == 'photo':
                media_type = 'photo'
                media_url = first.get('media_url_https', '')
            elif mtype in ('video', 'animated_gif'):
                media_type = 'video'
                media_url = first.get('media_url_https', '')

        users[uid]['tweets'].append({
            'tweet_id': str(tweet.get('id_str', tweet.get('id', ''))),
            'caption': text,
            'create_time': _parse_date(tweet.get('created_at', '')),
            'media_type': media_type,
            'likes': safe_int(tweet.get('favorite_count', 0)),
            'views': safe_int(tweet.get('views_count', 0)),
            'bookmarks': safe_int(tweet.get('bookmark_count', 0)),
            'retweets': safe_int(tweet.get('retweet_count', 0)),
            'replies': safe_int(tweet.get('reply_count', 0)),
            'quote_count': safe_int(tweet.get('quote_count', 0)),
            'media_url': media_url,
            'thumbnail_url': media_url if media_type == 'video' else '',
        })

    # Insert accounts and posts
    log.info(f"Inserting {len(users)} accounts...")
    total_posts = 0

    for uid, u in users.items():
        if not u['username']:
            continue

        add_account(u['username'])
        acc = get_account(username=u['username'])
        if not acc:
            continue

        now = datetime.now(timezone.utc).isoformat()
        update_account(acc['id'], {
            'user_id': u['user_id'],
            'display_name': u['display_name'],
            'bio': u['bio'],
            'bio_link': u['bio_link'],
            'location': u['location'],
            'followers': u['followers'],
            'following': u['following'],
            'tweet_count': u['tweet_count'],
            'is_verified': u['is_verified'],
            'avatar_url': u['avatar_url'],
            'banner_url': u['banner_url'],
            'scrape_status': 'scraped',
            'first_scraped_at': now,
            'last_scraped_at': now,
        })

        # Prepare posts
        tweets = u['tweets']
        if not tweets:
            continue

        # Calc averages
        all_likes = [t['likes'] for t in tweets]
        all_views = [t['views'] for t in tweets]
        avg_likes = sum(all_likes) / len(all_likes) if all_likes else 0
        avg_views = sum(all_views) / len(all_views) if all_views else 0

        photos = [t for t in tweets if t['media_type'] == 'photo']
        videos = [t for t in tweets if t['media_type'] == 'video']
        texts = [t for t in tweets if t['media_type'] == 'text']

        update_account(acc['id'], {
            'avg_likes_30d': round(avg_likes, 1),
            'avg_views_30d': round(avg_views, 1),
            'avg_photo_likes': round(sum(t['likes'] for t in photos) / len(photos), 1) if photos else 0,
            'avg_video_views': round(sum(t['views'] for t in videos) / len(videos), 1) if videos else 0,
            'avg_text_likes': round(sum(t['likes'] for t in texts) / len(texts), 1) if texts else 0,
            'photo_count': len(photos),
            'video_count': len(videos),
            'text_count': len(texts),
        })

        # Classify captions and detect viral
        post_rows = []
        for t in tweets:
            is_v, mult = calc_viral(t['media_type'], t['likes'], t['views'], avg_likes, avg_views)
            cat = _classify_caption(t['caption'])

            post_rows.append({
                'tweet_id': t['tweet_id'],
                'account_id': acc['id'],
                'username': u['username'],
                'caption': t['caption'],
                'create_time': t['create_time'],
                'media_type': t['media_type'],
                'likes': t['likes'],
                'views': t['views'],
                'bookmarks': t['bookmarks'],
                'retweets': t['retweets'],
                'replies': t['replies'],
                'quote_count': t['quote_count'],
                'media_url': t['media_url'],
                'thumbnail_url': t['thumbnail_url'],
                'is_viral': 1 if is_v else 0,
                'performance_multiplier': mult,
                'caption_category': cat,
                'scraped_at': now,
            })

        bulk_upsert_posts(post_rows)
        total_posts += len(post_rows)

    log.info(f"Seeded {len(users)} accounts and {total_posts} posts")


def seed_account_list(filepath):
    """Add accounts from a text file (one URL or username per line)."""
    log.info(f"Loading account list: {filepath}")
    with open(filepath, 'r') as f:
        lines = f.readlines()

    usernames = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        # Extract username from URL or raw username
        if 'x.com/' in line or 'twitter.com/' in line:
            parts = line.rstrip('/').split('/')
            username = parts[-1].lower().lstrip('@')
        else:
            username = line.lower().lstrip('@')
        if username:
            usernames.append(username)

    added, skipped = bulk_add_accounts(usernames)
    log.info(f"Account list: {added} added, {skipped} already existed (from {len(usernames)} total)")


def copy_downloaded_images(source_dir):
    """Copy pre-downloaded images to the data directories."""
    import shutil

    # Copy avatars
    src_avatars = Path(source_dir) / "avatars"
    if src_avatars.exists():
        for f in src_avatars.glob("*.jpg"):
            dest = AVATARS_DIR / f.name
            if not dest.exists():
                shutil.copy2(f, dest)
        log.info(f"Copied avatars from {src_avatars}")

    # Copy tweet images
    src_tweets = Path(source_dir) / "tweets"
    if src_tweets.exists():
        for f in src_tweets.glob("*.jpg"):
            # Map filename back to tweet - we'll handle this in the serve layer
            dest = IMAGES_DIR / f.name
            if not dest.exists():
                shutil.copy2(f, dest)
        log.info(f"Copied tweet images from {src_tweets}")


def _classify_caption(text):
    if not text:
        return "none"
    t = text.lower()
    if re.search(r'delet|surprise.*dm|say\s*hi.*dm|reply.*surprise', t):
        return "fomo"
    if re.search(r'be\s*honest|smash|pass\?|rate\s*(me|my|this)|1-10|yes\s*or\s*no|describe\s*me', t):
        return "engagement"
    if re.search(r'eyes\s*up|looking\s*at|motivation|mercy|staring|caught|stop\s*scroll', t):
        return "tease"
    if len(text) <= 20 and '?' not in text:
        return "short"
    return "personality"


def _parse_date(date_str):
    if not date_str:
        return ''
    try:
        dt = datetime.strptime(date_str, "%a %b %d %H:%M:%S %z %Y")
        return dt.isoformat()
    except:
        return date_str


if __name__ == "__main__":
    init_db()

    # 1. Seed from the main dataset
    dataset = "/Users/erdoka/Downloads/dataset_twitter-tweets-scraper_2026-03-29_03-09-01-576.json"
    if os.path.exists(dataset):
        seed_from_dataset(dataset)

    # 2. Add the 182 test accounts
    account_list = "/Users/erdoka/Downloads/message 2.txt"
    if os.path.exists(account_list):
        seed_account_list(account_list)

    # 3. Copy pre-downloaded images
    images_src = "/Users/erdoka/twitter-playbook/images"
    if os.path.exists(images_src):
        copy_downloaded_images(images_src)

    log.info("Seeding complete!")
