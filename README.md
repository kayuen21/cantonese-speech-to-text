# Cantonese Speech-to-Text

Local Cantonese transcription pipeline: **faster-whisper (GPU)** + **speaker
diarization (pyannote)** + **local LLM proofreading / meeting-notes assistant
(Ollama)**, wrapped in an Apple-style Traditional Chinese web UI.

> Everything runs on your own machine — audio is never sent to any cloud service.

---

## Features

- **Upload, then press 「開始轉寫」 (Start)** — nothing runs until you confirm it,
  and you can **abort** at any time; work already completed is kept
- Live per-segment output with progress and ETA; download **TXT / SRT / VTT**
  (`medium` or `large-v3`)
- **Qwen3 proofreading** (optional): corrects only, never summarizes; preserves
  Cantonese colloquialisms, English loanwords and full-width punctuation
- **Speaker diarization** (optional, needs a HuggingFace token): original and
  proofread text side by side, subtitles labelled `說話人N：`
- **Meeting-notes assistant** (chatbox): ask questions about the transcript you
  are viewing, or generate meeting minutes (SSE streaming)
- UI language selector (auto / Cantonese / Chinese / English)

## Requirements

| Item | Notes |
| --- | --- |
| Windows 11 | Tested (Linux/macOS should work in principle, but the FFmpeg/DLL handling is Windows-specific) |
| Python 3.14 | This project uses `.venv` (**mandatory** — see “Gotchas”) |
| NVIDIA GPU | Tested on RTX 4060 Laptop 8 GB + CUDA 12.8 |
| FFmpeg | **shared** build (step 4) **and** the `ffmpeg` command on PATH |
| Ollama | 0.33+, with `ollama pull qwen3:8b` |
| HuggingFace | account + read token (for diarization) |

## Installation

**1. Create the virtual environment**

```bash
python -m venv .venv
.venv/Scripts/python.exe -m pip install -U pip
```

**2. Install the CUDA build of PyTorch first** (don't rely on `requirements.txt`,
or you will get the CPU build)

```bash
.venv/Scripts/pip.exe install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
```

**3. Install the remaining packages**

```bash
.venv/Scripts/pip.exe install -r requirements.txt
```

**4. FFmpeg shared build** (pyannote 4.x decodes audio through torchcodec, which
needs the DLLs)

1. Download `ffmpeg-master-latest-win64-gpl-shared.zip` from
   <https://github.com/BtbN/FFmpeg-Builds/releases>
2. Extract it and put the whole `ffmpeg-master-latest-win64-gpl-shared` folder
   into `ffmpeg-shared/` in the project root
   (i.e. `ffmpeg-shared/ffmpeg-master-latest-win64-gpl-shared/bin/*.dll`)
3. Add that same `bin` folder to your system PATH so `_to_wav16k()` can call the
   `ffmpeg` command

> `ffmpeg-shared/` is 179 MB and is listed in `.gitignore` — it is not part of
> the repo.

**5. Create `config.json`**

```bash
cp config.example.json config.json
```

Open `config.json` and fill in your HuggingFace token:

| Field | Description |
| --- | --- |
| `hf_token` | Required (for diarization). The `HF_TOKEN` environment variable also works |
| `ollama_url` | Defaults to `http://127.0.0.1:11434` |
| `proofread_model` / `chat_model` | Default `qwen3:8b` |
| `chat_num_ctx` / `chat_num_predict` | Default `16384` / `2048` |

> ⚠️ `config.json` is in `.gitignore` — do **not** commit this file.

**6. Accept the HuggingFace model licences** (click “Agree” while signed in to
the same account)

- `pyannote/speaker-diarization-3.1`
- `pyannote/segmentation-3.0`
- `pyannote/wespeaker-voxceleb-resnet34-LM`
- `pyannote/speaker-diarization-community-1`

**7. Ollama**

```bash
ollama pull qwen3:8b
```

## Running

```bash
start_server.bat        # Windows: clears any stale process on port 5000, then opens the browser
# or
.venv/Scripts/python.exe app.py
```

Open <http://127.0.0.1:5000>.

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | Web UI |
| GET | `/api/health` | Health check |
| POST | `/api/transcribe` | Upload and start transcription (multipart, field `audio`; `model`=`medium`\|`large-v3`, `language`, `proofread`=`1/0`, `diarize`=`1/0`) |
| GET | `/api/status/<job_id>` | Progress / segment results (polled by the frontend) |
| POST | `/api/cancel/<job_id>` | Abort (cooperative cancellation; completed work is kept) |
| GET | `/api/download/<job_id>/<fmt>` | Download `txt` / `srt` / `vtt` |
| GET | `/api/jobs` | List jobs |
| POST | `/api/chat` | Meeting-notes assistant (SSE stream; body: `{messages, text}`) |

## Project layout

```
app.py                     Flask server, job management, API
engine.py                  WhisperEngine (transcribe / proofread / diarize / chat_stream)
templates/index.html       single-page UI
static/app.js              frontend logic (polling, SSE, downloads)
static/style.css           Apple-style stylesheet
config.example.json        config template (copy to config.json)
start_server.bat           Windows launch script
e2e_chat.mjs               end-to-end test via headless Chrome (CDP)
test_chatformat.mjs        frontend formatting unit test
```

## Testing

```bash
node test_chatformat.mjs        # pure function test, no server needed

# End-to-end (needs: the server running, your own test_2speaker.wav, headless Chrome)
"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new \
  --remote-debugging-port=9333 --user-data-dir="$LOCALAPPDATA/Temp/chrome-cdp-test" \
  "http://127.0.0.1:5000/" &
node e2e_chat.mjs
```

> `e2e_chat.mjs` uploads `test_2speaker.wav` (a two-speaker Cantonese
> conversation — just record your own). Test audio is in `.gitignore` so private
> recordings never end up in the repo.

## Gotchas (things that actually bit us)

- **Always use the project's `.venv`**: any other Python (e.g. uv's 3.11) loads
  the CPU build of torch and diarization dies with
  `AssertionError: Torch not compiled with CUDA enabled`. `app.py` self-heals
  (re-execs into `.venv` via `os.execv`), but standalone scripts need care.
- **After touching the frontend, bump the cache-bust query and restart**:
  `app.js?v=` / `style.css?v=` in `templates/index.html`; Flask also caches
  templates, so changes do not take effect without a restart.
- **VRAM is tight**: running Whisper + pyannote + Qwen3 at once on an 8 GB card
  is close to the limit. Proofreading is chunked (`chunk_chars=1200`,
  `keep_alive="5m"`); a long transcript (~19.5k characters) takes about 11 minutes.
- **Qwen3 proofreading runs once** — no retries, and it cannot degrade into a
  summary (marker guard).
- The meeting-notes assistant calls `unload()` to free Whisper's VRAM before
  answering; the next transcription reloads the model.
- No `.wav` file is ever committed.
