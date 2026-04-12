"""Twitter Intel Dashboard - Configuration"""
import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

# --- Paths ---
BASE_DIR = Path(__file__).parent
DB_PATH = BASE_DIR / "data" / "intel.db"
IMAGES_DIR = BASE_DIR / "data" / "images"
THUMBNAILS_DIR = BASE_DIR / "data" / "thumbnails"
VIDEOS_DIR = BASE_DIR / "data" / "videos"
AVATARS_DIR = BASE_DIR / "data" / "avatars"
EXPORTS_DIR = BASE_DIR / "data" / "exports"
STATIC_DIR = BASE_DIR / "static"

# Create dirs
for d in [IMAGES_DIR, THUMBNAILS_DIR, VIDEOS_DIR, AVATARS_DIR, EXPORTS_DIR, DB_PATH.parent]:
    d.mkdir(parents=True, exist_ok=True)

# --- API Keys ---
SCRAPECREATORS_API_KEY = os.getenv("SCRAPECREATORS_API_KEY", "")

# --- Supabase (dual-mode: if set, uses Supabase; otherwise SQLite) ---
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
USE_SUPABASE = bool(SUPABASE_URL and SUPABASE_SERVICE_KEY)

# --- Auth ---
ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "admin@sunny-model.com")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "9h8zu9eyxmf75afs")
WORKER_PASSWORD = os.getenv("WORKER_PASSWORD", "worker2026")
SCRAPE_PIN = os.getenv("SCRAPE_PIN", "2580")

# --- Server ---
PORT = int(os.getenv("PORT", "8097"))

# --- Scraping ---
DAYS_BACK = 90
REQUEST_DELAY = 0.5
MAX_RETRIES = 3
BATCH_SIZE = 50

# --- Viral Thresholds (split by content type) ---
VIRAL_MIN_LIKES_PHOTO = 3000
VIRAL_MIN_LIKES_TEXT = 2000
VIRAL_MIN_VIEWS_VIDEO = 30000
VIRAL_MULTIPLIER_PHOTO = 1.5
VIRAL_MULTIPLIER_VIDEO = 1.5
VIRAL_MULTIPLIER_TEXT = 2.0

# --- Image Compression ---
IMAGE_MAX_WIDTH = 600
IMAGE_QUALITY = 60
