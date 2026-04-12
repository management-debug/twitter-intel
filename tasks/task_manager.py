"""Background task manager for scraping pipelines."""
import threading
import logging

log = logging.getLogger(__name__)

_current_task = None
_lock = threading.Lock()
_stop_event = threading.Event()


def start_task(target, args=()):
    """Start a background task. Returns True if started, False if busy."""
    global _current_task
    with _lock:
        if _current_task and _current_task.is_alive():
            return False
        _stop_event.clear()
        _current_task = threading.Thread(target=target, args=args, daemon=True)
        _current_task.start()
        return True


def stop_task():
    """Signal the current task to stop."""
    _stop_event.set()
    return True


def is_running():
    """Check if a task is currently running."""
    return _current_task is not None and _current_task.is_alive()


def should_stop():
    """Check if the current task should stop (called by pipeline)."""
    return _stop_event.is_set()
