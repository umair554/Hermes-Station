#!/usr/bin/env python3
"""Hermes_Station Hermes state backup via Hugging Face Datasets.

Based on the original HuggingMes project.
Backs up HERMES_HOME (which includes /opt/data/webui — the hermes-webui state dir)
so sessions, profiles, skills, cron, memory, and workspace all survive restarts.
"""

import hashlib
import json
import logging
import os
import shutil
import signal
import socket
import sys
import tempfile
import threading
import time
from pathlib import Path

try:
  import fcntl # POSIX only; always available on the Linux HF Space container
except ImportError: # pragma: no cover - non-POSIX dev environments
  fcntl = None

# Inter-process lock so concurrent sync_once calls (loop + shutdown sync)
# don't race on the same HF Dataset commit.
SYNC_LOCK_PATH = "/tmp/hermes_station-sync.lock"
_LOCK_HANDLE = None

os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("HF_HUB_VERBOSITY", "error")
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "300")
# huggingface_hub 0.30+ replaced HF_HUB_ENABLE_HF_TRANSFER with this flag;
# the legacy var triggers a FutureWarning at import on newer hubs and is
# silently ignored. Setting only the new var means older hubs miss the
# transfer accelerator (which is fine — they fall back to the standard
# downloader) but no version emits a deprecation warning.
os.environ.setdefault("HF_XET_HIGH_PERFORMANCE", "1")

from huggingface_hub import HfApi, snapshot_download, upload_folder
from huggingface_hub.errors import HfHubHTTPError, RepositoryNotFoundError

logging.getLogger("huggingface_hub").setLevel(logging.ERROR)

HERMES_HOME = Path(os.environ.get("HERMES_HOME", "/opt/data"))
STATUS_FILE = Path("/tmp/hermes_station-sync-status.json")
STATE_FILE = HERMES_HOME / ".hermes_station-sync-state.json"
INTERVAL = int(os.environ.get("SYNC_INTERVAL", "60"))
INITIAL_DELAY = int(os.environ.get("SYNC_START_DELAY", "5"))
# Change-driven settings: the loop polls cheap stat metadata every POLL_INTERVAL
# seconds, and once a change is observed waits DEBOUNCE_SECONDS of quiet before
# uploading. INTERVAL acts only as a hard ceiling — even if writes never settle,
# a sync is forced after INTERVAL seconds. This keeps the worst-case data loss
# window well under a minute without uploading on every keystroke.
POLL_INTERVAL = float(os.environ.get("SYNC_POLL_INTERVAL", "2"))
DEBOUNCE_SECONDS = float(os.environ.get("SYNC_DEBOUNCE_SECONDS", "3"))
HF_TOKEN = os.environ.get("HF_TOKEN", "").strip()
HF_USERNAME = os.environ.get("HF_USERNAME", "").strip()
SPACE_AUTHOR_NAME = os.environ.get("SPACE_AUTHOR_NAME", "").strip()
BACKUP_DATASET_NAME = os.environ.get("BACKUP_DATASET_NAME", "hermes-station-backup").strip()
INCLUDE_ENV = os.environ.get("SYNC_INCLUDE_ENV", "").strip().lower() in {"1", "true", "yes"}
MAX_FILE_SIZE_BYTES = int(os.environ.get("SYNC_MAX_FILE_BYTES", str(200 * 1024 * 1024)))

EXCLUDED_DIRS = {
  ".cache",
  ".git",
  ".npm",
  ".venv",
  "__pycache__",
  "node_modules",
  "venv",
  "logs", # log files are useless after a restart
}
EXCLUDED_TOP_LEVEL = {
  "logs",
  STATE_FILE.name,
  # The Telegram webhook secret is a credential that lets an attacker forge
  # webhook calls — it never belongs in a remote backup.
  ".hermes_station-telegram-webhook-secret",
}
EXCLUDED_SUFFIXES = (
  ".log", ".log.1", ".log.2",
  # SQLite rollback-journal files are safe to drop (they're transient and
  # only exist during a write transaction). DO NOT exclude .db-wal/.db-shm —
  # in WAL mode, uncommitted/recent data lives in state.db-wal and the
  # shared-memory index in state.db-shm is needed to read it. Excluding
  # them silently drops recent sessions from the backup.
  ".db-journal",
  ".pid", ".tmp",
)
if not INCLUDE_ENV:
  EXCLUDED_TOP_LEVEL.add(".env")

HF_API = HfApi(token=HF_TOKEN) if HF_TOKEN else None
STOP_EVENT = threading.Event()
_REPO_ID_CACHE: str | None = None

# `.env` warning: on HF Spaces, the dashboard's "Env" tab writes to
# $HERMES_HOME/.env which is *not* backed up by default (see EXCLUDED_TOP_LEVEL
# above). That means provider keys typed into the dashboard silently disappear
# on every restart. We can't safely fix that by default — uploading plaintext
# secrets to a dataset is the wrong tradeoff — but we can make the failure
# loud. The status surface on the Hermes_Station status page reads the JSON below,
# so an `env_warning` field renders as a banner without any extra plumbing.
ENV_FILE = HERMES_HOME / ".env"
ON_HF_SPACE = bool(os.environ.get("SPACE_ID") or os.environ.get("SPACE_HOST"))

def env_warning_payload() -> dict | None:
  """Detect plaintext-secret-loss risk and return a warning blob, or None.

  Fires when:
  * we're on an HF Space (ephemeral filesystem), AND
  * `.env` exists with non-trivial content, AND
  * SYNC_INCLUDE_ENV is off (so .env is NOT being backed up).

  The warning is informational. We never refuse to start sync, and we never
  auto-flip SYNC_INCLUDE_ENV — the user must opt in to backing up plaintext.
  """
  if not ON_HF_SPACE or INCLUDE_ENV:
    return None
  try:
    if not ENV_FILE.is_file():
      return None
    # Count non-empty, non-comment lines as a proxy for "user-set keys".
    keys = 0
    for raw in ENV_FILE.read_text(encoding="utf-8", errors="replace").splitlines():
      line = raw.strip()
      if not line or line.startswith("#"):
        continue
      if "=" in line:
        keys += 1
    if keys <= 0:
      return None
    return {
      "kind": "ephemeral_env",
      "keys": keys,
      "message": (
        f"{keys} entr{'y' if keys == 1 else 'ies'} in $HERMES_HOME/.env "
        "will be wiped on the next Space restart. Move secrets to "
        "Space Secrets (Settings -> Variables and secrets), or set "
        "SYNC_INCLUDE_ENV=1 to back up .env to the private dataset "
        "(plaintext; weaker security)."
      ),
    }
  except OSError:
    return None

def write_status(status: str, message: str, fingerprint: str | None = None, marker: tuple[int, int, int] | None = None) -> None:
  timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
  payload: dict = {"status": status, "message": message, "timestamp": timestamp}
  warning = env_warning_payload()
  if warning is not None:
    payload["warning"] = warning

  tmp_path = STATUS_FILE.with_suffix(".tmp")
  try:
    tmp_path.write_text(json.dumps(payload), encoding="utf-8")
    tmp_path.replace(STATUS_FILE)
  except OSError as exc:
    # E16: surface status write failures instead of swallowing silently.
    # If /tmp is unwritable (read-only FS, full disk) the status page
    # shows stale data with no log line to explain why.
    print(f"Warning: could not write sync status to {STATUS_FILE}: {exc}", file=sys.stderr)

  if fingerprint or marker:
    state = {}
    if STATE_FILE.exists():
      try:
        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
      except Exception:
        pass
    if fingerprint:
      state["last_fingerprint"] = fingerprint
    if marker:
      state["last_marker"] = list(marker)
    state["last_sync"] = timestamp
    # Atomic write: tmp + os.replace so a SIGKILL/OOM mid-write can't
    # leave STATE_FILE truncated (which would reset the marker and force
    # a redundant full re-upload on the next change).
    try:
      tmp_state = STATE_FILE.with_suffix(".tmp")
      tmp_state.write_text(json.dumps(state), encoding="utf-8")
      os.replace(tmp_state, STATE_FILE)
    except OSError as exc:
      print(f"Warning: could not write sync state to {STATE_FILE}: {exc}", file=sys.stderr)

def resolve_backup_repo() -> str:
  global _REPO_ID_CACHE
  if _REPO_ID_CACHE:
    return _REPO_ID_CACHE

  namespace = HF_USERNAME or SPACE_AUTHOR_NAME
  if not namespace and HF_API is not None:
    whoami = HF_API.whoami()
    namespace = whoami.get("name") or whoami.get("user") or ""

  namespace = str(namespace).strip()
  if not namespace:
    raise RuntimeError("Could not determine HF username. Set HF_USERNAME or use an account HF_TOKEN.")

  _REPO_ID_CACHE = f"{namespace}/{BACKUP_DATASET_NAME}"
  return _REPO_ID_CACHE

_REPO_VERIFIED = False

def ensure_repo_exists() -> str:
  # The repo only needs to be created once per process lifetime. After that
  # the repo_info() check on every sync_once was pure overhead + an extra
  # rate-limited HF Hub API call per sync.
  global _REPO_VERIFIED
  repo_id = resolve_backup_repo()
  if _REPO_VERIFIED:
    return repo_id
  try:
    HF_API.repo_info(repo_id=repo_id, repo_type="dataset")
    _REPO_VERIFIED = True
  except RepositoryNotFoundError:
    HF_API.create_repo(repo_id=repo_id, repo_type="dataset", private=True)
    _REPO_VERIFIED = True
  return repo_id

def should_exclude(rel_posix: str, path: Path) -> bool:
  parts = Path(rel_posix).parts
  if not parts:
    return False
  if parts[0] in EXCLUDED_TOP_LEVEL:
    return True
  if any(part in EXCLUDED_DIRS for part in parts):
    return True
  if path.is_file():
    name_lower = path.name.lower()
    if name_lower.endswith(EXCLUDED_SUFFIXES):
      return True
    # SQLite .db files are always essential (they hold sessions, kanban,
    # response store, etc.) — never exclude them by size, regardless of
    # how large they grow. The size cap is for model caches and other
    # large non-essential artifacts.
    if name_lower.endswith(".db"):
      return False
    try:
      return path.stat().st_size > MAX_FILE_SIZE_BYTES
    except OSError:
      return True
  return False

def _walk_files(root: Path):
  """Yield (rel_posix, path) for every non-excluded file under root.

  Uses os.walk with in-place dir pruning so we never descend into
  EXCLUDED_DIRS (node_modules, .venv, __pycache__, .cache, ...). The old
  rglob('*') walked into those subtrees and stat'd every file before
  filtering them out — a populated node_modules taxed every 2s poll.
  """
  if not root.exists():
    return
  for dirpath, dirnames, filenames in os.walk(root):
    # Prune excluded dirs in-place so os.walk skips them entirely.
    dirnames[:] = [d for d in dirnames if d not in EXCLUDED_DIRS]
    # Skip top-level excluded entries (config.yaml, .env, logs, ...).
    # For nested paths, EXCLUDED_DIRS (checked above) handles subtrees;
    # EXCLUDED_TOP_LEVEL only applies to the root's direct children.
    rel_dir = os.path.relpath(dirpath, root).replace(os.sep, "/")
    is_root = rel_dir == "."
    if is_root:
      filenames = [f for f in filenames if f not in EXCLUDED_TOP_LEVEL]
    for name in filenames:
      path = Path(dirpath, name)
      rel = path.relative_to(root).as_posix()
      if should_exclude(rel, path):
        continue
      yield rel, path

def metadata_marker(root: Path) -> tuple[int, int, int]:
  if not root.exists():
    return (0, 0, 0)
  file_count = 0
  total_size = 0
  newest_mtime = 0
  for _rel, path in _walk_files(root):
    try:
      stat = path.stat()
    except OSError:
      continue
    file_count += 1
    total_size += int(stat.st_size)
    newest_mtime = max(newest_mtime, int(stat.st_mtime_ns))
  return (file_count, total_size, newest_mtime)

def fingerprint_dir(root: Path) -> str:
  hasher = hashlib.sha256()
  if not root.exists():
    return hasher.hexdigest()
  # Sort by rel path so the fingerprint is stable across runs/platforms.
  entries = sorted(_walk_files(root), key=lambda e: e[0])
  for rel, path in entries:
    hasher.update(rel.encode("utf-8"))
    with path.open("rb") as handle:
      for chunk in iter(lambda: handle.read(1024 * 1024), b""):
        hasher.update(chunk)
  return hasher.hexdigest()

def create_snapshot_dir(source_root: Path) -> Path:
  staging_root = Path(tempfile.mkdtemp(prefix="hermes_station-sync-"))
  for path in sorted(source_root.rglob("*")):
    rel = path.relative_to(source_root)
    rel_posix = rel.as_posix()
    if should_exclude(rel_posix, path):
      continue
    target = staging_root / rel
    if path.is_dir():
      target.mkdir(parents=True, exist_ok=True)
      continue
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
      shutil.copy2(path, target)
    except OSError:
      continue
    # Redact secrets from config.yaml before it lands in the backup.
    # config.yaml IS backed up (so dashboard model/provider/settings
    # survive restarts) but it can carry a plaintext model.api_key if
    # the dashboard's config editor wrote one. Strip the api_key field
    # from the staged copy so plaintext keys never reach the dataset.
    # The real key comes from the process environment (Space Secrets) at
    # runtime, so removing it from the backup doesn't break anything.
    if rel_posix == "config.yaml":
      try:
        import yaml as _yaml
        text = target.read_text(encoding="utf-8")
        cfg = _yaml.safe_load(text)
        if isinstance(cfg, dict):
          model = cfg.get("model")
          if isinstance(model, dict) and "api_key" in model:
            # Remove the api_key entirely from the staged copy so
            # plaintext keys never reach the dataset. The real key
            # comes from the process environment (Space Secrets) at
            # runtime — Hermes reads ${OPENAI_API_KEY} etc. from env.
            del model["api_key"]
            target.write_text(
              _yaml.safe_dump(cfg, sort_keys=False),
              encoding="utf-8",
            )
      except Exception:
        pass # not valid YAML or no yaml module — leave as-is
  return staging_root

def restore() -> bool:
  if not HF_TOKEN:
    write_status("disabled", "HF_TOKEN is not configured.")
    return False

  repo_id = resolve_backup_repo()
  write_status("restoring", f"Restoring Hermes state from {repo_id}")
  try:
    # Push our exclusion rules into snapshot_download so HF Hub never
    # downloads the files we're going to throw away anyway (logs, .env,
    # caches, *.db-wal, files > MAX_FILE_SIZE_BYTES, etc.). Default
    # max_workers=8 is slow for many small state files; bump it.
    ignore_patterns = []
    for name in EXCLUDED_TOP_LEVEL:
      ignore_patterns.append(f"{name}")
      ignore_patterns.append(f"{name}/*")
    for name in EXCLUDED_DIRS:
      ignore_patterns.append(f"**/{name}")
      ignore_patterns.append(f"**/{name}/*")
    for suf in EXCLUDED_SUFFIXES:
      ignore_patterns.append(f"**/*{suf}")
    # HF Hub ignore_patterns are glob; we can't express the >50MB size
    # cap, so should_exclude() still runs post-download as a backstop.

    t0 = time.time()
    with tempfile.TemporaryDirectory() as tmpdir:
      snapshot_download(
        repo_id=repo_id,
        repo_type="dataset",
        token=HF_TOKEN,
        local_dir=tmpdir,
        ignore_patterns=ignore_patterns or None,
        max_workers=int(os.environ.get("SYNC_RESTORE_WORKERS", "16")),
        etag_timeout=30,
      )
      tmp_path = Path(tmpdir)
      if not any(tmp_path.iterdir()):
        write_status("fresh", "Backup dataset is empty. Starting fresh.")
        return True

      HERMES_HOME.mkdir(parents=True, exist_ok=True)
      # Atomic per-entry swap: rename the existing entry to .bak, move
      # the restored entry into place, then remove .bak. If anything
      # fails mid-copy the .bak is restored, so a partial restore never
      # leaves HERMES_HOME half-overwritten with the original gone.
      for child in tmp_path.iterdir():
        if should_exclude(child.name, child):
          continue
        target = HERMES_HOME / child.name
        backup = HERMES_HOME / f"{child.name}.restore-bak"
        # Clear any stale backup from a previous interrupted restore.
        if backup.exists():
          if backup.is_dir():
            shutil.rmtree(backup, ignore_errors=True)
          else:
            try:
              backup.unlink()
            except OSError:
              pass
        # Move existing aside (atomic rename on same filesystem).
        moved_existing = False
        if target.exists():
          try:
            os.rename(target, backup)
            moved_existing = True
          except OSError:
            # If rename fails (cross-device, busy), fall back to
            # the old delete-then-copy path for this entry only.
            if target.is_dir():
              shutil.rmtree(target, ignore_errors=True)
            else:
              try:
                target.unlink()
              except OSError:
                pass
        # Copy restored entry into place.
        try:
          if child.is_dir():
            shutil.copytree(child, target)
          else:
            shutil.copy2(child, target)
        except OSError:
          # Restore failed — roll back to the original if we moved it.
          if moved_existing and backup.exists():
            try:
              if backup.is_dir() and not target.exists():
                os.rename(backup, target)
              elif backup.is_dir():
                shutil.rmtree(target, ignore_errors=True)
                os.rename(backup, target)
              else:
                if target.exists():
                  try:
                    target.unlink()
                  except OSError:
                    pass
                os.rename(backup, target)
            except OSError:
              pass
          raise
        # Success — drop the backup.
        if backup.exists():
          if backup.is_dir():
            shutil.rmtree(backup, ignore_errors=True)
          else:
            try:
              backup.unlink()
            except OSError:
              pass

    elapsed = round(time.time() - t0, 1)
    write_status("restored", f"Restored Hermes state from {repo_id} ({elapsed}s)")
    return True
  except RepositoryNotFoundError:
    write_status("fresh", f"Backup dataset {repo_id} does not exist yet.")
    return True
  except HfHubHTTPError as exc:
    if exc.response is not None and exc.response.status_code == 404:
      write_status("fresh", f"Backup dataset {repo_id} does not exist yet.")
      return True
    # Transient HF outage (5xx, network) — distinguish from "no dataset".
    # Boot continues (start.sh runs restore with `|| true`) but surface a
    # loud banner so the user doesn't silently boot into an empty state.
    write_status(
      "error",
      f"Restore failed (transient?): {exc}. Hermes will boot with an "
      "empty/fresh state — your data is safe in the dataset, this is "
      "likely a temporary HF Hub issue. A restart should restore it.",
    )
    print(f"Restore failed (transient?): {exc}", file=sys.stderr)
    return False
  except Exception as exc:
    write_status(
      "error",
      f"Restore failed: {exc}. Hermes will boot with an empty/fresh "
      "state; your data is safe in the dataset.",
    )
    print(f"Restore failed: {exc}", file=sys.stderr)
    return False

def load_state() -> tuple[str | None, tuple[int, int, int] | None]:
  """E17: load (last_fingerprint, last_marker) from STATE_FILE.

  Factored from the duplicated parse block that appeared in both sync_once
  and loop. Returns (None, None) if the file is missing/corrupt.
  """
  if not STATE_FILE.exists():
    return (None, None)
  try:
    state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    last_fingerprint = state.get("last_fingerprint")
    m = state.get("last_marker")
    last_marker = tuple(m) if m and len(m) == 3 else None
    return (last_fingerprint, last_marker)
  except Exception:
    return (None, None)

def sync_once(last_fingerprint: str | None = None, last_marker: tuple[int, int, int] | None = None):
  # Inter-process lock: the loop process and a separate CLI sync-once
  # (run by start.sh's graceful_shutdown / exit handler) can both call
  # upload_folder against the same dataset concurrently, racing on HF
  # Hub commits and doubling disk usage with two snapshot temp dirs.
  # The lock is acquired once per process and held for the process
  # lifetime (sync_once is never re-entrant within a process); the
  # *other* process blocks here until the holder exits and the OS
  # releases the flock.
  global _LOCK_HANDLE
  if fcntl is not None and _LOCK_HANDLE is None:
    try:
      _LOCK_HANDLE = open(SYNC_LOCK_PATH, "w")
      # Blocking exclusive lock. The holder keeps it until process exit
      # (no explicit release — OS releases on close/exit). This is
      # intentional: within one process sync_once is sequential.
      fcntl.flock(_LOCK_HANDLE, fcntl.LOCK_EX)
    except OSError:
      _LOCK_HANDLE = None # non-fatal; proceed without the lock
  if last_fingerprint is None and last_marker is None:
    last_fingerprint, last_marker = load_state()

  repo_id = ensure_repo_exists()
  current_marker = metadata_marker(HERMES_HOME)
  if last_marker is not None and current_marker == last_marker:
    write_status("synced", "No Hermes state changes detected (marker match).")
    return (last_fingerprint or "", current_marker)

  current_fingerprint = fingerprint_dir(HERMES_HOME)
  if last_fingerprint is not None and current_fingerprint == last_fingerprint:
    write_status("synced", "No Hermes state changes detected (fingerprint match).")
    return (last_fingerprint, current_marker)

  hostname = socket.gethostname()
  write_status("syncing", f"Uploading Hermes state to {repo_id} from {hostname}")
  snapshot_dir = create_snapshot_dir(HERMES_HOME)
  try:
    upload_folder(
      folder_path=str(snapshot_dir),
      repo_id=repo_id,
      repo_type="dataset",
      token=HF_TOKEN,
      commit_message=f"Hermes_Station sync [{hostname}] {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}",
      ignore_patterns=[".git/*", ".git"],
    )
  finally:
    shutil.rmtree(snapshot_dir, ignore_errors=True)

  write_status("success", f"Uploaded Hermes state to {repo_id}", fingerprint=current_fingerprint, marker=current_marker)
  return (current_fingerprint, current_marker)

def handle_signal(_sig, _frame) -> None:
  STOP_EVENT.set()

def loop() -> int:
  signal.signal(signal.SIGTERM, handle_signal)
  signal.signal(signal.SIGINT, handle_signal)
  try:
    repo_id = resolve_backup_repo()
    write_status(
      "configured",
      f"Backup watcher active for {repo_id} "
      f"(poll={POLL_INTERVAL}s, debounce={DEBOUNCE_SECONDS}s, max={INTERVAL}s).",
    )
  except Exception as exc:
    write_status("error", str(exc))
    print(f"Hermes sync error: {exc}")
    return 1

  warning = env_warning_payload()
  if warning is not None:
    # Loud, single-line, easy to grep in HF Space logs.
    print(f"Hermes sync WARNING: {warning['message']}")

  # Seed from any prior run so we don't re-upload an identical tree.
  last_fingerprint: str | None = None
  last_marker: tuple[int, int, int] | None = None
  last_fingerprint, last_marker = load_state()
  if last_marker is None:
    last_marker = metadata_marker(HERMES_HOME)

  if STOP_EVENT.wait(INITIAL_DELAY):
    return 0
  print(
    f"Hermes state sync started: poll={POLL_INTERVAL}s "
    f"debounce={DEBOUNCE_SECONDS}s max={INTERVAL}s -> {repo_id}"
  )

  # Change-driven scheduler. Two clocks:
  # * `pending_since` — when we first noticed an unsynced change. Used
  #   with INTERVAL to enforce a hard ceiling so a
  #   continuously-busy session can't starve uploads.
  # * `last_change_at` — when we most recently saw the marker move. The
  #   debounce timer is measured against this so we
  #   wait for writes to settle before uploading.
  pending_since: float | None = None
  last_change_at: float | None = None
  candidate_marker = last_marker

  while not STOP_EVENT.is_set():
    if STOP_EVENT.wait(POLL_INTERVAL):
      break

    try:
      current_marker = metadata_marker(HERMES_HOME)
    except Exception as exc:
      # Don't let a transient stat error kill the loop.
      write_status("error", f"marker scan failed: {exc}")
      continue

    now = time.time()

    if current_marker != candidate_marker:
      # Files moved since the last poll. Start (or extend) a debounce.
      if pending_since is None:
        pending_since = now
      last_change_at = now
      candidate_marker = current_marker
      continue

    if pending_since is None:
      # Tree is unchanged and there's nothing waiting. Nothing to do.
      continue

    quiet_for = now - (last_change_at or now)
    held_for = now - pending_since
    # Trigger when writes have settled (debounce) OR when the hard ceiling
    # is hit, so a never-idle tree still gets snapshotted at least once
    # per INTERVAL seconds.
    if quiet_for < DEBOUNCE_SECONDS and held_for < INTERVAL:
      continue

    try:
      last_fingerprint, last_marker = sync_once(last_fingerprint, last_marker)
      candidate_marker = last_marker
    except Exception as exc:
      write_status("error", f"Sync failed: {exc}")
      print(f"Hermes sync failed: {exc}")
      # Back off briefly on failure so we don't hot-loop a broken upload.
      if STOP_EVENT.wait(min(5.0, POLL_INTERVAL * 2)):
        break
    finally:
      pending_since = None
      last_change_at = None

  return 0

def main() -> int:
  HERMES_HOME.mkdir(parents=True, exist_ok=True)
  if len(sys.argv) < 2:
    return loop()
  command = sys.argv[1]
  if command == "restore":
    return 0 if restore() else 1
  if command == "sync-once":
    try:
      sync_once()
      return 0
    except Exception as exc:
      write_status("error", f"Shutdown sync failed: {exc}")
      print(f"Hermes sync: shutdown sync failed: {exc}")
      return 1
  if command == "loop":
    return loop()
  print(f"Unknown command: {command}", file=sys.stderr)
  return 1

if __name__ == "__main__":
  raise SystemExit(main())