"""Why did the server stop, and how loaded is it? Everything lands in <data_dir>/logs/server (app.activity).

- A crash inside Python (an uncaught exception in any thread) is logged with its traceback.
- A crash of the process itself (a segfault in a PDF library, an out-of-memory kill, a power cut) leaves
  no Python to log it: `faulthandler` writes the native traceback to logs/server/crash-faults.log, and a
  `.running` marker written at start-up and removed at a clean stop tells the next start that the last
  run ended without saying goodbye; that start logs it ("previous run ended without a clean shutdown").
- Every 5 minutes a "load" line: the process's memory, the machine's free memory, free disk under the
  work and data folders, and how many jobs are queued or running; a WARNING as soon as free memory
  or disk gets low, so the log shows the squeeze before the crash it causes.
"""

import faulthandler
import logging
import os
import shutil
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from app.config import get_settings

log = logging.getLogger("watchdog")
EVERY_S = 300
LOW_RAM_MB, LOW_DISK_GB = 700, 3
_marker: Path | None = None


def _server_logs() -> Path:
    path = Path(get_settings().data_dir) / "logs" / "server"
    path.mkdir(parents=True, exist_ok=True)
    return path


def memory_mb() -> tuple[float | None, float | None]:
    """(this process's resident memory, the machine's free memory) in MB; None where the OS gives no number."""
    try:
        if sys.platform == "win32":
            import ctypes
            from ctypes import wintypes

            class Counters(ctypes.Structure):
                _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t),
                            ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                            ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]

            class Status(ctypes.Structure):
                _fields_ = [("dwLength", wintypes.DWORD), ("dwMemoryLoad", wintypes.DWORD), ("ullTotalPhys", ctypes.c_ulonglong),
                            ("ullAvailPhys", ctypes.c_ulonglong), ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong), ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

            c = Counters()
            c.cb = ctypes.sizeof(c)
            ctypes.windll.kernel32.GetCurrentProcess.restype = wintypes.HANDLE
            ctypes.windll.psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
            ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.windll.kernel32.GetCurrentProcess(), ctypes.byref(c), c.cb)
            s = Status()
            s.dwLength = ctypes.sizeof(s)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(s))
            return c.WorkingSetSize / 2**20, s.ullAvailPhys / 2**20
        rss = int(Path("/proc/self/statm").read_text().split()[1]) * os.sysconf("SC_PAGE_SIZE") / 2**20
        free = None
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemAvailable:"):
                free = int(line.split()[1]) / 1024
        return rss, free
    except Exception:  # noqa: BLE001 - a number we cannot read is not worth a crash
        return None, None


def load_line() -> dict:
    s = get_settings()
    rss, free = memory_mb()
    fields: dict = {"rss_mb": round(rss) if rss else None, "free_ram_mb": round(free) if free else None, "threads": threading.active_count()}
    for name, folder in (("work", s.work_dir), ("data", s.data_dir)):
        try:
            fields[f"disk_free_gb_{name}"] = round(shutil.disk_usage(Path(folder).resolve().anchor or ".").free / 2**30, 1)
        except OSError:
            pass
    try:
        from sqlalchemy import func, select
        from sqlalchemy.orm import Session

        from app.db import get_engine
        from app.models import Job

        with Session(get_engine()) as session:
            rows = session.execute(select(Job.status, func.count()).where(Job.status.in_(("QUEUED", "RUNNING"))).group_by(Job.status)).all()
        fields.update({f"jobs_{st.lower()}": n for st, n in rows})
    except Exception:  # noqa: BLE001 - the database is reported elsewhere
        pass
    return fields


def _check() -> None:
    fields = load_line()
    low = []
    if fields.get("free_ram_mb") is not None and fields["free_ram_mb"] < LOW_RAM_MB:
        low.append(f"free memory {fields['free_ram_mb']} MB")
    for k, v in fields.items():
        if k.startswith("disk_free_gb") and v < LOW_DISK_GB:
            low.append(f"{k} {v} GB")
    if low:
        log.warning("low resources: " + ", ".join(low) + " (a job needing 1-2 GB may fail with MemoryError or the process may be killed)", extra={"fields": fields})
    else:
        log.info("load", extra={"fields": fields})


def _loop() -> None:
    while True:
        try:
            _check()
        except Exception:  # noqa: BLE001
            log.exception("watchdog check failed")
        time.sleep(EVERY_S)


def start() -> None:
    global _marker
    logs = _server_logs()
    faulthandler.enable(open(logs / "crash-faults.log", "a", encoding="utf-8"), all_threads=True)  # noqa: SIM115 - kept open for the process's life
    threading.excepthook = lambda args: log.error("uncaught exception in thread %s", args.thread.name if args.thread else "?",
                                                  exc_info=(args.exc_type, args.exc_value, args.exc_traceback))
    _marker = logs / ".running"
    if _marker.exists():
        previous = _marker.read_text(encoding="utf-8").strip()
        other = int(previous.rsplit("pid ", 1)[-1]) if "pid " in previous else 0
        if other and _alive(other):
            # (a second start while the first still runs, e.g. two autostart loops: this one will fail to
            # bind the port and leave; the marker stays the running server's)
            log.warning("another server process is running (pid %d, %s): this start will not take the port", other, previous)
            _marker = None
            return
        log.error("previous run ended without a clean shutdown (crash, kill or power loss); it started at %s. Native crashes: crash-faults.log; "
                  "the last 'load' lines before the gap show memory and disk at the time", previous or "?")
    _marker.write_text(f"{datetime.now(timezone.utc).isoformat(timespec='seconds')} pid {os.getpid()}", encoding="utf-8")
    log.info("server started", extra={"fields": {"pid": os.getpid(), **load_line()}})
    threading.Thread(target=_loop, name="watchdog", daemon=True).start()


def _alive(pid: int) -> bool:
    if pid == os.getpid():
        return False
    if sys.platform == "win32":
        import ctypes

        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        code = ctypes.c_ulong()
        running = ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code)) and code.value == 259  # STILL_ACTIVE
        ctypes.windll.kernel32.CloseHandle(handle)
        return bool(running)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def stop() -> None:
    log.info("server stopped (clean shutdown)")
    if _marker is not None and f"pid {os.getpid()}" in (_marker.read_text(encoding="utf-8") if _marker.exists() else ""):
        _marker.unlink(missing_ok=True)  # (only our own marker: never the running server's)
