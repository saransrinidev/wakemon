"""WAKEMON music backend — YTMusic (ytmusicapi) wrapper.

Run with:
    pip install -r requirements.txt
    python music_server.py

Optional (makes streaming fully first-class — not required):
    ytmusicapi setup      # interactively creates headers_auth.json
    python music_server.py

If YouTube rejects stream resolution as a bot (common on cloud IPs):
    1. ytmusicapi setup  → paste browser headers/cookies → headers_auth.json
    2. or export cookies.txt and set YTDLP_COOKIES=/path/to/cookies.txt

ytmusicapi is used for search + song metadata. Audio stream URLs are
resolved with yt-dlp when ytmusicapi returns an unsigned signatureCipher
(which is the default without authentication).
"""

import base64
import binascii
import gzip
import os
import re
import time
from collections import defaultdict, deque

import requests
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from ytmusicapi import YTMusic

AUTH_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "headers_auth.json")
_COOKIES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cookies.txt")


def _materialize_cookies() -> str | None:
    """Resolve the yt-dlp cookie file, creating it from an env var if needed.

    Precedence:
      1. YTDLP_COOKIES / COOKIES_FILE pointing at an existing file on disk.
      2. YTDLP_COOKIES_CONTENT — the Netscape cookies.txt contents supplied as
         an env var (raw text or base64). This is the recommended approach on
         hosts like Railway where there is no browser and committing the file
         would leak credentials. It is written to cookies.txt on startup.

    Returns the cookie file path if one is available, else None.
    """
    existing = os.environ.get("YTDLP_COOKIES") or os.environ.get("COOKIES_FILE")
    if existing and os.path.exists(existing):
        return existing

    content = os.environ.get("YTDLP_COOKIES_CONTENT")
    if not content or not content.strip():
        return None

    raw = content.strip()
    # The env value may be: plain Netscape text, base64, or gzip+base64
    # (compressed to fit host env-var size limits like Railway's 32 KB cap).
    # If it doesn't look like plain cookie text, try to decode it.
    if not raw.startswith("# Netscape") and "\t" not in raw:
        try:
            decoded_bytes = base64.b64decode(raw, validate=True)
            # gzip streams start with the magic bytes 0x1f 0x8b.
            if decoded_bytes[:2] == b"\x1f\x8b":
                decoded_bytes = gzip.decompress(decoded_bytes)
            raw = decoded_bytes.decode("utf-8").strip()
        except (binascii.Error, ValueError, UnicodeDecodeError, OSError):
            pass  # fall through and write the raw value as-is

    try:
        with open(_COOKIES_PATH, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(raw)
            if not raw.endswith("\n"):
                fh.write("\n")
    except OSError as exc:  # noqa: BLE001
        print(f"Warning: could not write cookies file: {exc}")
        return None

    # Expose the path so the standard env lookups in _resolve_with_ytdlp work.
    os.environ["YTDLP_COOKIES"] = _COOKIES_PATH
    return _COOKIES_PATH


_COOKIES_FILE = _materialize_cookies()

app = FastAPI(title="WAKEMON music backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_STREAM_TTL = int(os.environ.get("STREAM_TTL_SECONDS", "900"))
_RATE_LIMIT = int(os.environ.get("RATE_LIMIT_PER_MIN", "90"))
_API_TOKEN = os.environ.get("API_TOKEN") or None
_stream_cache: dict[str, tuple[float, tuple[str, str, str, int]]] = {}
_hit_log: dict[str, deque] = defaultdict(deque)
_stats: dict[str, int] = defaultdict(int)


def _stat_key(path: str) -> str | None:
    parts = path.lstrip("/").split("/")
    if len(parts) >= 2 and parts[0] == "api":
        return parts[1].rstrip("/")
    return None


@app.middleware("http")
async def guard(request: Request, call_next):
    if _API_TOKEN:
        auth_header = request.headers.get("authorization", "")
        split = auth_header.split()
        header_ok = len(split) == 2 and split[0].lower() == "bearer" and split[1] == _API_TOKEN
        if not header_ok and request.query_params.get("token") != _API_TOKEN:
            return JSONResponse({"detail": "Unauthorized"}, status_code=401)

    path = request.url.path
    key = _stat_key(path)
    if key not in (None, "health", "stats"):
        now = time.monotonic()
        window = _hit_log[request.client.host if request.client else "?"]
        while window and now - window[0] > 60:
            window.popleft()
        if len(window) >= _RATE_LIMIT:
            return JSONResponse({"detail": "Rate limit exceeded — try again shortly."}, status_code=429)
        window.append(now)
        _stats[key] += 1

    return await call_next(request)

_client = None


def get_client() -> YTMusic:
    global _client
    if _client is None:
        if os.path.exists(AUTH_FILE):
            _client = YTMusic(AUTH_FILE)
        else:
            _client = YTMusic()
    return _client


def _parse_duration(raw: str | None) -> int:
    """'3:45' -> 225, '1:02:33' -> 3753. Returns 0 when unknown."""
    if not raw:
        return 0
    try:
        total = 0
        for part in str(raw).split(":"):
            total = total * 60 + int(part)
        return total
    except (ValueError, TypeError):
        return 0


def _to_track(result: dict) -> dict | None:
    video_id = result.get("videoId")
    if not video_id:
        return None
    artists = result.get("artists") or []
    return {
        "id": video_id,
        "title": result.get("title") or "Unknown title",
        "artist": ", ".join(str(a.get("name", "")) for a in artists) or "Unknown artist",
        "duration": _parse_duration(result.get("duration")),
        "thumbnail": result["thumbnails"][0]["url"] if result.get("thumbnails") else None,
    }


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "authed": os.path.exists(AUTH_FILE),
        "cookies": bool(_COOKIES_FILE and os.path.exists(_COOKIES_FILE)),
    }


@app.get("/api/search")
def search(q: str, limit: int = 12):
    if not q or not q.strip():
        raise HTTPException(400, "Missing query parameter 'q'")
    try:
        results = get_client().search(q, filter="songs", limit=max(1, min(limit, 50)))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"ytmusicapi search failed: {exc}") from exc
    tracks = [t for t in (_to_track(r) for r in results) if t is not None]
    return {"query": q, "tracks": tracks}


def _pick_stream_url(streaming_data: dict | None) -> str | None:
    """Pick the first usable direct URL from ytmusicapi streamingData."""
    if not streaming_data:
        return None
    formats = streaming_data.get("adaptiveFormats") or []
    audio = [f for f in formats if str(f.get("mimeType", "")).startswith("audio/")]
    if not audio:
        formats_all = streaming_data.get("formats") or []
        audio = [f for f in formats_all if str(f.get("mimeType", "")).startswith("audio/")]
        if not audio:
            audio = formats_all
    audio.sort(key=lambda f: f.get("bitrate", 0))
    for fmt in audio:
        url = fmt.get("url")
        if url:
            return url
    return None


def _resolve_with_ytdlp(video_id: str) -> tuple[str, str, int]:
    """Resolve a playable audio URL using yt-dlp. Returns (url, title, duration)."""
    try:
        import yt_dlp  # noqa: PLC0415
        from yt_dlp.utils import DownloadError  # noqa: PLC0415
    except ImportError as exc:  # noqa: BLE001
        raise HTTPException(
            502,
            "yt-dlp is not installed. Run: pip install -r requirements.txt",
        ) from exc

    cookies_file = (
        _COOKIES_FILE
        or os.environ.get("YTDLP_COOKIES")
        or os.environ.get("COOKIES_FILE")
    )
    have_cookies = bool(cookies_file and os.path.exists(cookies_file))

    def _base_opts(client: str) -> dict:
        opts = {
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "format": "bestaudio/best",
            "youtube_include_dash_manifest": False,
            "extractor_args": {"youtube": {"player_client": [client]}},
        }
        if have_cookies:
            opts["cookiefile"] = cookies_file
        return opts

    # YouTube frequently rejects the default player client (especially when an
    # account cookie is attached, which forces the "tv_downgraded" client and
    # yields "The page needs to be reloaded" / UNPLAYABLE). Trying a sequence of
    # clients is the standard workaround. Order matters: the mobile/tv clients
    # tend to return direct audio URLs without SABR/PO-token requirements.
    client_order = ["android_vr", "android", "ios", "mweb", "tv", "web_safari", "web"]

    bot_markers = ("Sign in to confirm", "not a bot", "LOGIN_REQUIRED", "HTTP Error 403")
    last_error: str | None = None

    for client in client_order:
        try:
            with yt_dlp.YoutubeDL(_base_opts(client)) as ydl:
                info = ydl.extract_info(
                    f"https://music.youtube.com/watch?v={video_id}", download=False
                )
        except DownloadError as exc:
            last_error = str(exc)
            if any(marker in last_error for marker in bot_markers):
                raise HTTPException(
                    502,
                    "YouTube blocked this request as a bot. Fix it by authenticating:\n"
                    "  1. Export a Netscape cookies.txt from a logged-in YouTube account and set "
                    "YTDLP_COOKIES_CONTENT to its contents (raw or base64) — recommended for cloud "
                    "hosts like Railway, OR\n"
                    "  2. Point YTDLP_COOKIES at an existing cookies.txt file on disk, OR\n"
                    "  3. Run 'ytmusicapi setup' in backend/ to create headers_auth.json.",
                ) from exc
            continue  # try the next player client
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)
            continue

        url = info.get("url")
        if url:
            return url, info.get("title") or "Song", int(info.get("duration") or 0)
        last_error = "No playable audio stream in response."

    raise HTTPException(
        502,
        "Could not resolve an audio stream after trying multiple YouTube clients. "
        f"Last error: {last_error}. If this persists, yt-dlp may need updating "
        "(YouTube changes break older versions).",
    )


def _resolve_stream(video_id: str) -> tuple[str, str, str, int]:
    """Return (stream_url, title, artist, duration). Cached for STREAM_TTL_SECONDS."""
    now = time.monotonic()
    if len(_stream_cache) > 512:
        for key in [k for k, (exp, _v) in _stream_cache.items() if now > exp]:
            del _stream_cache[key]
    cached = _stream_cache.get(video_id)
    if cached and now < cached[0]:
        return cached[1]

    stream_url = None
    title = "Song"
    artist = "Unknown artist"
    duration = 0

    try:
        song = get_client().get_song(video_id)
        if song:
            details = song.get("videoDetails") or {}
            title = details.get("title") or title
            artist = details.get("author") or artist
            duration = int(details.get("lengthSeconds") or 0)
            stream_url = _pick_stream_url(song.get("streamingData"))
    except Exception:  # noqa: BLE001
        pass  # fall back to yt-dlp below

    if not stream_url:
        try:
            url, dl_title, dl_duration = _resolve_with_ytdlp(video_id)
            stream_url = url
            if not title or title == "Song":
                title = dl_title
            if duration == 0:
                duration = dl_duration
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(404, f"Unable to obtain an audio stream: {exc}") from exc

    result = (stream_url, title, artist, duration)
    _stream_cache[video_id] = (now + _STREAM_TTL, result)
    return result


@app.get("/api/stream/{video_id}")
def stream(video_id: str):
    stream_url, title, artist, duration = _resolve_stream(video_id)
    return {
        "url": stream_url,
        "id": video_id,
        "title": title,
        "artist": artist,
        "duration": duration,
    }


_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)


def _yt_headers(range: str | None = None) -> dict[str, str]:
    """Headers for the upstream googlevideo request.

    DASH endpoints are picky: they want a browser UA, a Range request, and no
    custom Referer/Origin (those trigger 403s). Always ask for bytes 0- so the
    upstream answers with a clean HTTP 206 that the browser can play + seek.
    """
    headers = {
        "User-Agent": _BROWSER_UA,
        "Accept": "*/*",
        "Accept-Encoding": "identity",
    }
    if range:
        headers["Range"] = range
    else:
        headers["Range"] = "bytes=0-"
    return headers


def _ext_for_mime(mime: str) -> str:
    if "webm" in mime:
        return "webm"
    if "mp4" in mime:
        return "m4a"
    if "ogg" in mime:
        return "ogg"
    if "opus" in mime:
        return "opus"
    if "mpeg" in mime or "mp3" in mime:
        return "mp3"
    if "wav" in mime:
        return "wav"
    return "webm"


@app.get("/api/audio/{video_id}")
def audio(video_id: str, range: str | None = Header(default=None), download: bool = False):
    """Proxy the raw audio bytes so playback happens through this server.

    The stream URLs resolved by ytmusicapi/yt-dlp are signed for the machine
    that resolved them. Browsers cannot play them directly from a client IP,
    so we fetch upstream server-side and stream the bytes back.
    """
    stream_url, title, _artist, _duration = _resolve_stream(video_id)

    headers = _yt_headers(range)

    try:
        upstream = requests.get(stream_url, headers=headers, stream=True, timeout=30)
    except requests.RequestException as exc:
        raise HTTPException(502, f"Could not reach audio stream: {exc}") from exc

    if upstream.status_code >= 400:
        upstream.close()
        raise HTTPException(502, f"Audio upstream returned HTTP {upstream.status_code}")

    content_type = (upstream.headers.get("Content-Type") or "").strip()
    if content_type.startswith("text/html") or content_type.startswith("application/json"):
        upstream.close()
        raise HTTPException(
            502,
            "YouTube returned no playable audio. If this keeps happening, "
            "run 'ytmusicapi setup' in backend/ to authenticate.",
        )

    resp_headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache",
    }
    content_range = upstream.headers.get("Content-Range")
    if content_range:
        resp_headers["Content-Range"] = content_range
    content_length = upstream.headers.get("Content-Length")
    if content_length:
        resp_headers["Content-Length"] = content_length
    if not content_type:
        content_type = "audio/mpeg"

    if download:
        safe = re.sub(r'[^\w\s()-]', "", title).strip().replace(" ", "_") or "wakemon_track"
        resp_headers["Content-Disposition"] = f'attachment; filename="{safe}.{_ext_for_mime(content_type)}"'

    return StreamingResponse(
        upstream.iter_content(chunk_size=64 * 1024),
        status_code=upstream.status_code,
        media_type=content_type,
        headers=resp_headers,
    )


@app.get("/api/related/{video_id}")
def related(video_id: str, limit: int = 20):
    """Auto-play suggestions via ytmusicapi get_watch_playlist."""
    try:
        wl = get_client().get_watch_playlist(video_id, limit=max(2, min(limit, 50)))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"ytmusicapi watch playlist failed: {exc}") from exc
    tracks: list[dict] = []
    for r in wl.get("tracks") or []:
        tr = _to_track(r)
        if tr and tr["id"] != video_id:
            tracks.append(tr)
            if len(tracks) >= limit:
                break
    return {"id": video_id, "tracks": tracks}


@app.get("/api/lyrics/{video_id}")
def lyrics(video_id: str):
    """Return synchronized-instrumental style lyrics text if the track has any."""
    try:
        wl = get_client().get_watch_playlist(video_id, limit=1)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not load song details: {exc}") from exc
    tracks = wl.get("tracks") or []
    if not tracks or not (tracks[0].get("lyricsId") or tracks[0].get("lyricsB64TypeParam")):
        raise HTTPException(404, "No lyrics available for this track.")
    try:
        result = get_client().get_lyrics(tracks[0])
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(404, "No lyrics available for this track.") from exc
    text = (result or {}).get("lyrics")
    if not text:
        raise HTTPException(404, "No lyrics available for this track.")
    return {"id": video_id, "title": tracks[0].get("title"), "lyrics": text}


@app.get("/api/stats")
def stats():
    total = sum(v for k, v in _stats.items() if k not in ("health", "stats"))
    return {
        "total": total,
        "search": _stats["search"],
        "stream": _stats["stream"],
        "plays": _stats["audio"],
        "related": _stats["related"],
        "lyrics": _stats["lyrics"],
    }


if __name__ == "__main__":
    import os

    import uvicorn

    port = int(os.environ.get("PORT", "8787"))
    host = os.environ.get("HOST", "0.0.0.0")
    print(f"WAKEMON music backend listening on http://{host}:{port}")
    if _COOKIES_FILE and os.path.exists(_COOKIES_FILE):
        print(f"Using yt-dlp cookies from {_COOKIES_FILE}")
    elif not os.path.exists(AUTH_FILE):
        print("Note: running unauthenticated. Set YTDLP_COOKIES_CONTENT (recommended) or run")
        print("      'ytmusicapi setup' for reliable stream resolution.")
    uvicorn.run(app, host=host, port=port)