# 粵語語音轉文字（Cantonese Speech-to-Text）

本機運行嘅粵語轉寫系統：**faster-whisper (GPU)** ＋ **說話人分離 (pyannote)** ＋
**本地 LLM 校對／會議記錄助手 (Ollama)**，配一個 Apple 風格嘅繁體中文網頁。

> 全部運算都喺你部機進行，音檔唔會上傳去任何雲端服務。

---

## 功能

- **上傳 → 按「開始轉寫」先開始**：唔會一上傳就跑，隨時可以**中止**，已完成嘅部分會保留
- 逐段即時顯示、進度、預估剩餘時間；可下載 **TXT / SRT / VTT**（`medium` 或 `large-v3`）
- **Qwen3 校對**（可關）：只校正、不摘要；保留粵語口語、英文借詞、全形標點
- **說話人分離**（可關，需 HuggingFace token）：原文／校對版並排，字幕帶「說話人N：」標籤
- **會議記錄助手**（chatbox）：就住你目前檢視嗰份逐字稿問答、生成會議記錄（SSE 串流）
- 網頁可選語言（自動／粵語／中文／英文）

## 環境需求

| 項目 | 備註 |
| --- | --- |
| Windows 11 | 已測試（Linux/macOS 理論可行，但 FFmpeg／DLL 部分係 Windows 專用） |
| Python 3.14 | 本專案用 `.venv`（**必須**，見下面「注意事項」） |
| NVIDIA GPU | 已測試 RTX 4060 Laptop 8GB ＋ CUDA 12.8 |
| FFmpeg | **shared** build（見步驟 4）＋ `ffmpeg` 指令要在 PATH |
| Ollama | 0.33+，並 `ollama pull qwen3:8b` |
| HuggingFace | 帳號 + read token（說話人分離用） |

## 安裝

**1. 建立虛擬環境**

```bash
python -m venv .venv
.venv/Scripts/python.exe -m pip install -U pip
```

**2. 先裝 PyTorch CUDA 版**（唔可以靠 `requirements.txt`，否則會裝到 CPU 版）

```bash
.venv/Scripts/pip.exe install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
```

**3. 裝其餘套件**

```bash
.venv/Scripts/pip.exe install -r requirements.txt
```

**4. FFmpeg shared build**（pyannote 4.x 用 torchcodec 解碼音訊，需要 DLL）

1. 去 <https://github.com/BtbN/FFmpeg-Builds/releases> 下載 `ffmpeg-master-latest-win64-gpl-shared.zip`
2. 解壓，將整個 `ffmpeg-master-latest-win64-gpl-shared` 資料夾放入專案根目錄嘅 `ffmpeg-shared/`
   （即 `ffmpeg-shared/ffmpeg-master-latest-win64-gpl-shared/bin/*.dll`）
3. 將同一個 `bin` 加入系統 PATH，等 `_to_wav16k()` 叫得到 `ffmpeg` 指令

> `ffmpeg-shared/` 有 179 MB，已列入 `.gitignore`，唔會入 repo。

**5. 建立 `config.json`**

```bash
cp config.example.json config.json
```

打開 `config.json` 填入自己嘅 HuggingFace token：

| 欄位 | 說明 |
| --- | --- |
| `hf_token` | 必填（說話人分離用）。亦可用環境變數 `HF_TOKEN` |
| `ollama_url` | 預設 `http://127.0.0.1:11434` |
| `proofread_model` / `chat_model` | 預設 `qwen3:8b` |
| `chat_num_ctx` / `chat_num_predict` | 預設 `16384` / `2048` |

> ⚠️ `config.json` 已列入 `.gitignore` —— **唔好** commit 呢個檔。

**6. 接受 HuggingFace 模型授權**（用同一個帳號撳「Agree」）

- `pyannote/speaker-diarization-3.1`
- `pyannote/segmentation-3.0`
- `pyannote/wespeaker-voxceleb-resnet34-LM`
- `pyannote/speaker-diarization-community-1`

**7. Ollama**

```bash
ollama pull qwen3:8b
```

## 啟動

```bash
start_server.bat        # Windows：先清走佔用 5000 埠嘅舊進程，再開瀏覽器
# 或者
.venv/Scripts/python.exe app.py
```

開啟 <http://127.0.0.1:5000>。

## HTTP API

| 方法 | 路徑 | 用途 |
| --- | --- | --- |
| GET | `/` | 網頁介面 |
| GET | `/api/health` | 健康檢查 |
| POST | `/api/transcribe` | 上傳並開始轉寫（multipart，欄位 `audio`；`model`=`medium`\|`large-v3`、`language`、`proofread`=`1/0`、`diarize`=`1/0`） |
| GET | `/api/status/<job_id>` | 進度／分段結果（前端輪詢） |
| POST | `/api/cancel/<job_id>` | 中止（協作式取消，保留已完成部分） |
| GET | `/api/download/<job_id>/<fmt>` | 下載 `txt` / `srt` / `vtt` |
| GET | `/api/jobs` | 列出任務 |
| POST | `/api/chat` | 會議記錄助手（SSE 串流；body: `{messages, text}`） |

## 專案結構

```
app.py                     Flask 伺服器、任務管理、API
engine.py                  WhisperEngine（轉寫／校對／分離／chat_stream）
templates/index.html       單頁介面
static/app.js              前端邏輯（輪詢、SSE、下載）
static/style.css           Apple 風格樣式
config.example.json        設定範本（複製成 config.json）
start_server.bat           Windows 啟動腳本
e2e_chat.mjs               Headless Chrome (CDP) 端到端測試
test_chatformat.mjs        前端格式化單元測試
```

## 測試

```bash
node test_chatformat.mjs        # 純函式測試，唔需要伺服器

# 端到端（需要：伺服器已啟動、自己有 test_2speaker.wav、headless Chrome）
"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new \
  --remote-debugging-port=9333 --user-data-dir="$LOCALAPPDATA/Temp/chrome-cdp-test" \
  "http://127.0.0.1:5000/" &
node e2e_chat.mjs
```

> `e2e_chat.mjs` 會上傳 `test_2speaker.wav`（2 人粵語對話，自己錄一段即可）。
> 測試音檔已列入 `.gitignore`，避免私人錄音入 repo。

## 注意事項（實測踩過嘅坑）

- **一定要用專案 `.venv`**：用其他 Python（例如 uv 嘅 3.11）會載入 CPU 版 torch，
  一分離說話人就 `AssertionError: Torch not compiled with CUDA enabled`。
  `app.py` 有自我修復（`os.execv` 重啟入 `.venv`），但自己跑 script 時要留意。
- **改完前端要 bump cache-bust 再重啟**：`templates/index.html` 內嘅 `app.js?v=` / `style.css?v=`，
  再加 Flask 會 cache 模板，唔重啟唔會生效。
- **VRAM 好緊**：8GB 卡同時跑 Whisper + pyannote + Qwen3 會接近上限；
  校對係分塊進行（`chunk_chars=1200`，`keep_alive="5m"`），長稿（~19.5k 字）約需 11 分鐘。
- **Qwen3 校對只做一次**，唔會重試，亦唔會變成摘要（有 marker guard）。
- 會議記錄助手回答前會 `unload()` Whisper 釋放 VRAM，下次轉寫會重新載入模型。
- 所有 `.wav` 都唔會入 repo。

## 授權

未指定（`No license`）—— 如需開源請補上 LICENSE。
