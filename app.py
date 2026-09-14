import collections
import json
import os
import re
import socket
import sys
import threading
import time
import uuid
from pathlib import Path

# --- self-heal: always run inside the project's .venv -----------------------
# Launched with a different interpreter (e.g. `uv run app.py`, which uses uv's
# managed Python 3.11), the process imports a CPU-only torch and speaker
# diarization dies with "AssertionError: Torch not compiled with CUDA enabled".
# Re-exec ourselves with the project venv so the CUDA torch wheels and the
# cuBLAS/cuDNN DLLs are always the ones installed for this project.
def _reexec_in_project_venv() -> None:
    here = Path(__file__).resolve()
    venv_python = here.parent / ".venv" / "Scripts" / "python.exe"
    if not venv_python.exists():
        return
    try:
        if Path(sys.executable).resolve() == venv_python.resolve():
            return
    except OSError:
        pass
    if os.environ.get("STT_IN_VENV") == "1":  # already re-exec'd — never loop
        return
    os.environ["STT_IN_VENV"] = "1"
    print(f"[app] wrong interpreter: {sys.executable}", file=sys.stderr)
    print(f"[app] re-launching inside project venv: {venv_python}", file=sys.stderr)
    # os.execv on Windows joins argv with spaces and does NOT quote — the
    # project path contains spaces, so quote the path arguments ourselves
    # (the MSVC runtime strips the quotes when it builds the child's argv).
    os.execv(str(venv_python), [f'"{venv_python}"', f'"{here}"', *sys.argv[1:]])


_reexec_in_project_venv()

from flask import (Flask, Response, jsonify, render_template, request,
                   send_file, stream_with_context)

from engine import (JobCancelled, WhisperEngine, assign_speakers, chat_stream,
                    diarize, ensure_deps, fit_transcript, labeled_srt, labeled_text,
                    labeled_vtt, load_nvidia_dlls, proofread)

load_nvidia_dlls()
ensure_deps()

# --- hard guard: never allow a second server instance on port 5000 ----------
# (two instances caused stale templates/code being served to the browser)
def _port_in_use(port: int) -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        return s.connect_ex(("127.0.0.1", port)) == 0
    finally:
        s.close()

if _port_in_use(5000):
    print("[app] port 5000 is already in use — another instance is running.", file=sys.stderr)
    print("[app] Kill it first (e.g. re-run start_server.bat), then start again.", file=sys.stderr)
    sys.exit(1)

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)
RESULT_DIR = BASE_DIR / "results"
RESULT_DIR.mkdir(exist_ok=True)

ALLOWED_SUFFIXES = {".mp3", ".wav", ".m4a", ".flac", ".aac", ".ogg", ".opus", ".wma", ".mp4", ".mkv", ".webm", ".mov", ".amr", ".3gp", ".aiff", ".caf"}

def _load_config() -> dict:
    cfg = BASE_DIR / "config.json"
    try:
        if cfg.is_file():
            return json.loads(cfg.read_text(encoding="utf-8")) or {}
    except Exception:  # noqa: BLE001 — a broken config must not stop the server
        print("[app] config.json could not be parsed — using defaults", file=sys.stderr)
    return {}


CONFIG = _load_config()

# HuggingFace token for the gated pyannote diarization model — read from the
# local config file (never from chat memory), or the HF_TOKEN env var.
HF_TOKEN = CONFIG.get("hf_token") or os.environ.get("HF_TOKEN", "")

# Local Ollama (Qwen3) — used by the optional proofreading pass and by the
# transcript chat box. All overridable in config.json.
OLLAMA_URL = CONFIG.get("ollama_url", "http://127.0.0.1:11434")
PROOFREAD_MODEL = CONFIG.get("proofread_model", "qwen3:8b")
CHAT_MODEL = CONFIG.get("chat_model", PROOFREAD_MODEL)
CHAT_NUM_CTX = int(CONFIG.get("chat_num_ctx", 16384))
CHAT_NUM_PREDICT = int(CONFIG.get("chat_num_predict", 2048))
# How much of the transcript fits in that context. Chinese runs roughly one
# token per character; ~0.7 leaves room for the system prompt, the chat
# history and the reply itself.
CHAT_CHAR_BUDGET = max(1500, int(CHAT_NUM_CTX * 0.7))

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024**3  # 2 GB local limit
app.config["JSON_AS_ASCII"] = False

ENGINE = WhisperEngine()

# --------------------------------------------------------------------------
# Job queue: one GPU at a time, jobs processed serially by a worker thread
# --------------------------------------------------------------------------

JOBS = {}
JOBS_LOCK = threading.Lock()
QUEUE = collections.deque()
QUEUE_COND = threading.Condition()


def _snapshot(job, include_text=True):
    keys = ["status", "progress", "error", "language", "language_probability",
            "duration", "segments_count", "filename", "model", "speakers",
            "diarize", "diarize_skipped"]
    snap = {k: job.get(k) for k in keys}
    if include_text:
        snap["text"] = job.get("text", "")
        snap["corrected_text"] = job.get("corrected_text")
    snap["segments"] = job.get("segments", []) if job.get("status") in ("done", "cancelled") else []
    return snap


def _finish_cancelled(job) -> None:
    """Mark a job the user aborted. Keep whatever transcript we already have."""
    with JOBS_LOCK:
        job["status"] = "cancelled"
        job["progress"] = 0
        job["error"] = None
        text, srt, vtt = job.get("text", ""), job.get("srt", ""), job.get("vtt", "")
    if not text:
        return
    RESULT_DIR.joinpath(f"{job['id']}.txt").write_text(text, encoding="utf-8")
    if srt:
        RESULT_DIR.joinpath(f"{job['id']}.srt").write_text(srt, encoding="utf-8")
    if vtt:
        RESULT_DIR.joinpath(f"{job['id']}.vtt").write_text(vtt, encoding="utf-8")


def _run_job(job_id: str) -> None:
    with JOBS_LOCK:
        job = JOBS[job_id]
        cancel = job["cancel"]
        job["status"] = "loading"
        job["progress"] = 0
        audio_path, model, language = job["path"], job["model"], job["language"]
    try:
        if cancel.is_set():  # aborted while still sitting in the queue
            _finish_cancelled(job)
            return
        for update in ENGINE.transcribe(audio_path, model=model, language=language,
                                        should_cancel=cancel.is_set):
            with JOBS_LOCK:
                job["status"] = "transcribing" if update["phase"] == "transcribing" else "loading"
                job["progress"] = update.get("progress", 0)
                job["language"] = update.get("language")
                job["language_probability"] = update.get("language_probability")
                job["duration"] = update.get("duration")
                job["segments_count"] = update.get("segments_count")
                job["segments"] = update.get("segments", [])
                job["text"] = update.get("text", "")
                if update["phase"] == "done":
                    job["srt"] = update.get("srt", "")
                    job["vtt"] = update.get("vtt", "")
                    job["status"] = "done"
                    # persist results to disk so downloads survive restarts
                    RESULT_DIR.joinpath(f"{job_id}.txt").write_text(job["text"], encoding="utf-8")
                    RESULT_DIR.joinpath(f"{job_id}.srt").write_text(job["srt"], encoding="utf-8")
                    RESULT_DIR.joinpath(f"{job_id}.vtt").write_text(job["vtt"], encoding="utf-8")
                if update["phase"] == "done":
                    break
        if cancel.is_set():
            _finish_cancelled(job)
            return
        # speaker diarization (pyannote) — label each segment with a speaker
        if job["diarize"] and HF_TOKEN:
            with JOBS_LOCK:
                job["status"] = "diarizing"
                job["progress"] = 99.0
            turns, derr = diarize(job["path"], HF_TOKEN)
            if turns:
                segs = assign_speakers(job["segments"], turns)
                n_spk = len({s["speaker"] for s in segs if s.get("speaker")}) or None
                with JOBS_LOCK:
                    job["segments"] = segs
                    job["speakers"] = n_spk
                    job["segments_count"] = len(segs)
                    job["text"] = labeled_text(segs)
                    job["srt"] = labeled_srt(segs)
                    job["vtt"] = labeled_vtt(segs)
                    RESULT_DIR.joinpath(f"{job_id}.txt").write_text(job["text"], encoding="utf-8")
                    RESULT_DIR.joinpath(f"{job_id}.srt").write_text(job["srt"], encoding="utf-8")
                    RESULT_DIR.joinpath(f"{job_id}.vtt").write_text(job["vtt"], encoding="utf-8")
            else:
                with JOBS_LOCK:
                    job["diarize_skipped"] = derr or "分離失敗"
        if cancel.is_set():
            _finish_cancelled(job)
            return
        # optional second pass: local Qwen3 proofreading via Ollama
        if job["proofread"]:
            with JOBS_LOCK:
                job["status"] = "proofreading"
                job["progress"] = 99.0
            corrected = proofread(job["text"], base_url=OLLAMA_URL,
                                  model=PROOFREAD_MODEL,
                                  should_cancel=cancel.is_set)
            with JOBS_LOCK:
                job["corrected_text"] = corrected  # None if Ollama unavailable
        # always finish — diarization/proofread are both optional stages
        with JOBS_LOCK:
            job["status"] = "done"
            job["progress"] = 100.0
    except JobCancelled:
        print(f"[app] job {job_id} cancelled by user")
        _finish_cancelled(job)
    except Exception as exc:  # noqa: BLE001 — report any failure to the UI
        with JOBS_LOCK:
            job["status"] = "error"
            job["error"] = f"{type(exc).__name__}: {exc}"


def _worker_loop() -> None:
    while True:
        with QUEUE_COND:
            while not QUEUE:
                QUEUE_COND.wait()
            job_id = QUEUE.popleft()
        _run_job(job_id)


threading.Thread(target=_worker_loop, daemon=True, name="whisper-worker").start()

# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------

@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/health")
def health():
    return jsonify({
        "status": "ok",
        "gpu": ENGINE.cuda_device_count() > 0,
        "cuda_devices": ENGINE.cuda_device_count(),
        "model_loaded": ENGINE._model_name,  # noqa: SLF001
        "chat_model": CHAT_MODEL,
        "chat_ctx": CHAT_NUM_CTX,
        "queued": len(QUEUE),
        "running": sum(1 for j in JOBS.values() if j.get("status") in ("loading", "transcribing")),
    })


@app.post("/api/transcribe")
def transcribe():
    f = request.files.get("audio")
    if f is None or not f.filename:
        return jsonify({"error": "no audio file provided"}), 400
    suffix = Path(f.filename).suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        return jsonify({"error": f"unsupported file type '{suffix}'"}), 400

    model = request.form.get("model", "medium")
    if model not in ("medium", "large-v3"):
        model = "medium"
    language = request.form.get("language", "auto")
    if language not in ("auto", "zh", "yue"):
        language = "auto"
    proofread_on = request.form.get("proofread", "1") == "1"
    diarize_on = request.form.get("diarize", "0") == "1"

    job_id = uuid.uuid4().hex[:12]
    store_path = UPLOAD_DIR / f"{job_id}{suffix}"
    f.save(store_path)

    with JOBS_LOCK:
        JOBS[job_id] = {
            "id": job_id, "filename": f.filename, "path": str(store_path),
            "model": model, "language": language, "proofread": proofread_on,
            "diarize": diarize_on, "diarize_skipped": False,
            "status": "queued", "progress": 0, "error": None,
            "language_detected": None, "language_probability": None,
            "duration": None, "segments_count": 0, "segments": [],
            "speakers": None, "text": "", "srt": "", "vtt": "", "corrected_text": None,
            "cancel": threading.Event(),
            "created": time.time(),
        }
    with QUEUE_COND:
        QUEUE.append(job_id)
        QUEUE_COND.notify()

    return jsonify({"job_id": job_id}), 202


@app.get("/api/status/<job_id>")
def status(job_id):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            return jsonify({"error": "job not found"}), 404
        include_text = job["status"] in ("transcribing", "done", "cancelled")
        return jsonify(_snapshot(job, include_text=include_text))


@app.post("/api/cancel/<job_id>")
def cancel(job_id):
    """Abort a job. Cooperative: the worker checks the flag between transcription
    segments, between pipeline stages and between proofread chunks, so the status
    flips to 'cancelled' within a few seconds."""
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            return jsonify({"error": "job not found"}), 404
        if job["status"] in ("done", "error", "cancelled"):
            return jsonify({"ok": True, "status": job["status"]}), 200
        job["cancel"].set()
        job["status"] = "cancelling"
    # a job still parked in the queue never reaches the worker — retire it here
    removed = False
    with QUEUE_COND:
        if job_id in QUEUE:
            QUEUE.remove(job_id)
            QUEUE_COND.notify()
            removed = True
    if removed:
        _finish_cancelled(job)
    with JOBS_LOCK:
        return jsonify({"ok": True, "status": job["status"]}), 200


def _sse(payload) -> str:
    """One server-sent event."""
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


@app.post("/api/chat")
def api_chat():
    """Stream a local-LLM reply about a finished transcript.

    The browser sends the text it is currently showing (校對版 or 原文) plus the
    conversation so far; the answer streams back as server-sent events so the
    box fills in while the model writes instead of hanging for a minute.
    """
    body = request.get_json(silent=True) or {}
    transcript = (body.get("text") or "").strip()
    if not transcript:
        return jsonify({"error": "還沒有逐字稿可以對話"}), 400

    msgs = []
    for m in (body.get("messages") or []):
        if not isinstance(m, dict):
            continue
        role, content = m.get("role"), m.get("content")
        if role in ("user", "assistant") and isinstance(content, str) and content.strip():
            msgs.append({"role": role, "content": content[:8000]})
    msgs = msgs[-12:]  # keep the tail of the conversation only
    if not msgs:
        return jsonify({"error": "沒有訊息"}), 400

    fitted, truncated, omitted = fit_transcript(transcript, CHAT_CHAR_BUDGET)
    # Whisper and the LLM share one 8 GB GPU — hand the whole card to the LLM
    # for the duration of the chat (the next transcription reloads Whisper).
    ENGINE.unload()

    def gen():
        yield _sse({"meta": {"truncated": truncated, "omitted": omitted,
                             "chars": len(fitted), "model": CHAT_MODEL}})
        try:
            for delta in chat_stream(msgs, fitted, base_url=OLLAMA_URL, model=CHAT_MODEL,
                                     num_ctx=CHAT_NUM_CTX, num_predict=CHAT_NUM_PREDICT):
                yield _sse({"delta": delta})
            yield _sse({"done": True})
        except GeneratorExit:  # client pressed 停止 or closed the tab
            print("[app] chat stream closed by the client", file=sys.stderr)
            raise
        except Exception as exc:  # noqa: BLE001 — report the real reason to the UI
            print(f"[app] chat failed: {type(exc).__name__}: {exc}", file=sys.stderr)
            yield _sse({"error": str(exc)})

    return Response(stream_with_context(gen()), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/download/<job_id>/<fmt>")
def download(job_id, fmt):
    if fmt not in ("txt", "srt", "vtt"):
        return jsonify({"error": "unknown format"}), 400
    # 1) prefer the persisted file on disk (survives restarts)
    path = RESULT_DIR / f"{job_id}.{fmt}"
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        in_memory = (job is not None and bool(job["text"])
                     and job["status"] in ("done", "cancelled"))
        stem = Path(job["filename"]).stem if job else job_id
    if not path.is_file():
        # 2) fall back to in-memory results (job done in THIS server session)
        if not in_memory:
            return jsonify({"error": "result file not found — please transcribe the audio again"}), 404
        body = job[fmt if fmt in ("srt", "vtt") else "text"]
    stem = re.sub(r'[\\/:*?"<>|\r\n]', "_", stem).strip() or job_id
    mime = {"txt": "text/plain; charset=utf-8",
            "srt": "application/x-subrip",
            "vtt": "text/vtt; charset=utf-8"}[fmt]
    # send_file handles non-ASCII filenames via RFC 5987 (filename*=UTF-8''…)
    from urllib.parse import quote
    if stem.isascii():
        disp = f'attachment; filename="{stem}.{fmt}"'
    else:
        disp = f'attachment; filename="transcript.{fmt}"; filename*=UTF-8\'\'{quote(stem + "." + fmt)}'
    if path.is_file():
        resp = send_file(path, mimetype=mime)
    else:
        resp = Response(body, mimetype=mime)
    resp.headers["Content-Disposition"] = disp
    return resp


@app.get("/api/jobs")
def jobs():
    with JOBS_LOCK:
        recent = sorted(JOBS.values(), key=lambda j: j["created"], reverse=True)[:10]
        return jsonify([_snapshot(j, include_text=False) for j in recent])


if __name__ == "__main__":
    import webbrowser
    url = "http://127.0.0.1:5000"
    threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    print(f" * Serving on {url}  (Ctrl+C to stop)")
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True)