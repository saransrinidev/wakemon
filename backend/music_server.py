"""WAKEMON music backend — multi-source audio search and streaming.

Run with:
    pip install -r requirements.txt
    python music_server.py

SOURCES
-------
Audius (default) — a free, open, permissionless music API. No API key, no
cookies, no bot checks, and it works from datacenter IPs (Railway, Fly, etc.).
Catalog is indie/electronic/lofi/hip-hop rather than mainstream chart music.

YouTube (opt-in)  — the original ytmusicapi + yt-dlp path. Set MUSIC_SOURCE=youtube
to enable. This only works reliably from a residential IP: YouTube serves
datacenter ranges either a bot challenge or URL-less SABR formats, so it will
usually fail on cloud hosts even with valid cookies.

    MUSIC_SOURCE=audius   (default)
    MUSIC_SOURCE=youtube

Track IDs are namespaced so both sources can coexist:
    au:<id>   an Audius track
    yt:<id>   a YouTube video
A bare id with no prefix is resolved using the default source.

YouTube auth (only relevant when MUSIC_SOURCE=youtube):
    1. YTDLP_COOKIES_CONTENT — cookies.txt contents (raw, base64, or gzip+base64)
    2. YTDLP_COOKIES         — path to an existing cookies.txt
    3. ytmusicapi setup      — creates headers_auth.json
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

AUTH_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "headers_auth.json")
_COOKIES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cookies.txt")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SOURCE_AUDIUS = "audius"
SOURCE_YOUTUBE = "youtube"

_DEFAULT_SOURCE = (os.environ.get("MUSIC_SOURCE") or SOURCE_AUDIUS).strip().lower()
if _DEFAULT_SOURCE not in (SOURCE_AUDIUS, SOURCE_YOUTUBE):
    _DEFAULT_SOURCE = SOURCE_AUDIUS

AUDIUS_APP_NAME = os.environ.get("AUDIUS_APP_NAME", "wakemon")
AUDIUS_HOST = (os.environ.get("AUDIUS_HOST") or "https://api.audius.co").rstrip("/")

_PREFIXES = {"au": SOURCE_AUDIUS, "yt": SOURCE_YOUTUBE}
_PREFIX_FOR = {SOURCE_AUDIUS: "au", SOURCE_YOUTUBE: "yt"}


def _split_id(raw: str) -> tuple[str, str]:
    """'au:abc' -> ('audius', 'abc'). Bare ids use the default source."""
    if ":" in raw:
        head, rest = raw.split(":", 1)
        source = _PREFIXES.get(head.lower())
        if source and rest:
            return source, rest
    return _DEFAULT_SOURCE, raw


def _tag_id(source: str, native_id: str) -> str:
    return f"{_PREFIX_FOR[source]}:{native_id}"


def _materialize_cookies() -> str | None:
    """Resolve the yt-dlp cookie file, creating it from an env var if needed.

    Precedence:
      1. YTDLP_COOKIES / COOKIES_FILE pointing at an existing file on disk.
      2. YTDLP_COOKIES_CONTENT — cookies.txt contents as an env var. Accepts
         plain Netscape text, base64, or gzip+base64 (compressed to fit host
         env-var size limits such as Railway's 32 KB cap).

    Returns the cookie file path if one is available, else None.
    """
    existing = os.environ.get("YTDLP_COOKIES") or os.environ.get("COOKIES_FILE")
    if existing and os.path.exists(existing):
        return existing

    content = os.environ.get("YTDLP_COOKIES_CONTENT")
    if not content or not content.strip():
        return None

    raw = content.strip()
    if not raw.startswith("# Netscape") and "\t" not in raw:
        try:
            decoded = base64.b64decode(raw, validate=True)
            if decoded[:2] == b"\x1f\x8b":  # gzip magic bytes
                decoded = gzip.decompress(decoded)
            raw = decoded.decode("utf-8").strip()
        except (binascii.Error, ValueError, UnicodeDecodeError, OSError):
            pass  # write the raw value as-is

    try:
        with open(_COOKIES_PATH, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(raw)
            if not raw.endswith("\n"):
                fh.write("\n")
    except OSError as exc:  # noqa: BLE001
        print(f"Warning: could not write cookies file: {exc}")
        return None

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

_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)


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


# ---------------------------------------------------------------------------
# Audius source
# ---------------------------------------------------------------------------

_audius_session = requests.Session()


def _audius_get(path: str, **params) -> dict:
    """GET an Audius v1 endpoint and return the decoded JSON body."""
    params.setdefault("app_name", AUDIUS_APP_NAME)
    try:
        resp = _audius_session.get(
            f"{AUDIUS_HOST}{path}", params=params, timeout=25,
            headers={"Accept": "application/json"},
        )
    except requests.RequestException as exc:
        raise HTTPException(502, f"Audius request failed: {exc}") from exc
    if resp.status_code == 404:
        raise HTTPException(404, "Not found on Audius.")
    if resp.status_code >= 400:
        raise HTTPException(502, f"Audius returned HTTP {resp.status_code}")
    try:
        return resp.json()
    except ValueError as exc:
        raise HTTPException(502, "Audius returned a non-JSON response.") from exc


def _audius_artwork(track: dict) -> str | None:
    art = track.get("artwork") or {}
    for size in ("480x480", "1000x1000", "150x150"):
        if art.get(size):
            return art[size]
    return None


def _audius_to_track(track: dict) -> dict | None:
    native_id = track.get("id")
    if not native_id:
        return None
    user = track.get("user") or {}
    return {
        "id": _tag_id(SOURCE_AUDIUS, native_id),
        "title": track.get("title") or "Unknown title",
        "artist": user.get("name") or user.get("handle") or "Unknown artist",
        "duration": int(track.get("duration") or 0),
        "thumbnail": _audius_artwork(track),
    }


def _audius_search(query: str, limit: int) -> list[dict]:
    body = _audius_get("/v1/tracks/search", query=query, limit=limit)
    items = body.get("data") or []
    tracks = [t for t in (_audius_to_track(x) for x in items) if t]
    return tracks[:limit]


def _audius_fetch_track(native_id: str) -> dict:
    body = _audius_get(f"/v1/tracks/{native_id}")
    data = body.get("data")
    if not isinstance(data, dict):
        raise HTTPException(404, "Track not found on Audius.")
    return data


def _audius_stream(native_id: str) -> tuple[str, str, str, int]:
    """Return (upstream_url, title, artist, duration) for an Audius track.

    The /stream endpoint 302-redirects to a CDN object; /api/audio follows it.
    """
    track = _audius_fetch_track(native_id)
    user = track.get("user") or {}
    url = (
        f"{AUDIUS_HOST}/v1/tracks/{native_id}/stream"
        f"?app_name={AUDIUS_APP_NAME}"
    )
    return (
        url,
        track.get("title") or "Song",
        user.get("name") or user.get("handle") or "Unknown artist",
        int(track.get("duration") or 0),
    )


def _audius_related(native_id: str, limit: int) -> list[dict]:
    """Audius has no /related endpoint, so approximate a radio queue.

    Use the seed track's genre to pull trending tracks in the same genre, then
    top up with plain trending if the genre pool is thin.
    """
    try:
        seed = _audius_fetch_track(native_id)
    except HTTPException:
        seed = {}
    genre = seed.get("genre")

    collected: list[dict] = []
    seen = {native_id}

    def absorb(items: list[dict]) -> None:
        for raw in items:
            if raw.get("id") in seen:
                continue
            tr = _audius_to_track(raw)
            if tr:
                seen.add(raw["id"])
                collected.append(tr)

    if genre:
        try:
            body = _audius_get("/v1/tracks/trending", genre=genre, limit=limit * 2)
            absorb(body.get("data") or [])
        except HTTPException:
            pass

    if len(collected) < limit:
        try:
            body = _audius_get("/v1/tracks/trending", limit=limit * 2)
            absorb(body.get("data") or [])
        except HTTPException:
            pass

    return collected[:limit]


# ---------------------------------------------------------------------------
# YouTube source (opt-in; unreliable from datacenter IPs)
# ---------------------------------------------------------------------------

_yt_client = None


def get_client():
    """Lazily build the YTMusic client. Only used when MUSIC_SOURCE=youtube."""
    global _yt_client
    if _yt_client is None:
        try:
            from ytmusicapi import YTMusic  # noqa: PLC0415
        except ImportError as exc:
            raise HTTPException(
                502, "ytmusicapi is not installed. Run: pip install -r requirements.txt"
            ) from exc
        _yt_client = YTMusic(AUTH_FILE) if os.path.exists(AUTH_FILE) else YTMusic()
    return _yt_client


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


def _yt_to_track(result: dict) -> dict | None:
    native_id = result.get("videoId")
    if not native_id:
        return None
    artists = result.get("artists") or []
    return {
        "id": _tag_id(SOURCE_YOUTUBE, native_id),
        "title": result.get("title") or "Unknown title",
        "artist": ", ".join(str(a.get("name", "")) for a in artists) or "Unknown artist",
        "duration": _parse_duration(result.get("duration")),
        "thumbnail": result["thumbnails"][0]["url"] if result.get("thumbnails") else None,
    }


def _yt_search(query: str, limit: int) -> list[dict]:
    try:
        results = get_client().search(query, filter="songs", limit=limit)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"ytmusicapi search failed: {exc}") from exc
    return [t for t in (_yt_to_track(r) for r in results) if t]


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
        if fmt.get("url"):
            return fmt["url"]
    return None


def _resolve_with_ytdlp(video_id: str) -> tuple[str, str, int]:
    """Resolve a playable audio URL using yt-dlp. Returns (url, title, duration)."""
    try:
        import yt_dlp  # noqa: PLC0415
        from yt_dlp.utils import DownloadError  # noqa: PLC0415
    except ImportError as exc:
        raise HTTPException(
            502, "yt-dlp is not installed. Run: pip install -r requirements.txt"
        ) from exc

    cookies_file = (
        _COOKIES_FILE or os.environ.get("YTDLP_COOKIES") or os.environ.get("COOKIES_FILE")
    )
    have_cookies = bool(cookies_file and os.path.exists(cookies_file))

    def _opts(client: str) -> dict:
        # No "format" key on purpose: pre-selecting a format makes yt-dlp raise
        # "Requested format is not available" when YouTube only offers
        # SABR/URL-less audio. We pick a usable format ourselves below.
        opts = {
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "ignore_no_formats_error": True,
            "extractor_args": {
                "youtube": {"player_client": [client], "formats": ["missing_pot"]}
            },
        }
        if have_cookies:
            opts["cookiefile"] = cookies_file
        return opts

    def _pick(info: dict) -> str | None:
        if not info:
            return None
        if info.get("url"):
            return info["url"]
        usable = [f for f in (info.get("formats") or []) if f.get("url")]
        if not usable:
            return None

        def bitrate(f: dict) -> float:
            return f.get("abr") or f.get("tbr") or 0

        audio_only = [
            f for f in usable
            if f.get("acodec") not in (None, "none") and f.get("vcodec") in (None, "none")
        ]
        if audio_only:
            return max(audio_only, key=bitrate)["url"]
        with_audio = [f for f in usable if f.get("acodec") not in (None, "none")]
        if with_audio:
            return max(with_audio, key=bitrate)["url"]
        return None

    clients = ["android_vr", "android", "ios", "mweb", "tv", "web_safari", "web"]
    bot_markers = ("Sign in to confirm", "not a bot", "LOGIN_REQUIRED", "HTTP Error 403")
    last_error: str | None = None

    for client in clients:
        try:
            with yt_dlp.YoutubeDL(_opts(client)) as ydl:
                info = ydl.extract_info(
                    f"https://music.youtube.com/watch?v={video_id}", download=False
                )
        except DownloadError as exc:
            last_error = str(exc)
            if any(m in last_error for m in bot_markers):
                raise HTTPException(
                    502,
                    "YouTube blocked this request as a bot. Cloud/datacenter IPs are "
                    "blocked aggressively — this usually cannot be fixed with cookies "
                    "alone. Use MUSIC_SOURCE=audius, run this backend from a "
                    "residential IP, or route yt-dlp through a residential proxy.",
                ) from exc
            continue
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)
            continue

        url = _pick(info)
        if url:
            return url, info.get("title") or "Song", int(info.get("duration") or 0)
        last_error = f"No audio format with a usable URL from client '{client}'."

    raise HTTPException(
        502,
        "Could not resolve a YouTube audio stream after trying multiple clients. "
        f"Last error: {last_error}. YouTube blocks datacenter IPs; consider "
        "MUSIC_SOURCE=audius.",
    )


def _youtube_stream(video_id: str) -> tuple[str, str, str, int]:
    """Return (upstream_url, title, artist, duration) for a YouTube video."""
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
        pass  # fall through to yt-dlp

    if not stream_url:
        url, dl_title, dl_duration = _resolve_with_ytdlp(video_id)
        stream_url = url
        if title == "Song":
            title = dl_title
        if duration == 0:
            duration = dl_duration

    return stream_url, title, artist, duration


def _youtube_related(video_id: str, limit: int) -> list[dict]:
    try:
        wl = get_client().get_watch_playlist(video_id, limit=max(2, min(limit, 50)))
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"ytmusicapi watch playlist failed: {exc}") from exc
    tracks: list[dict] = []
    for r in wl.get("tracks") or []:
        tr = _yt_to_track(r)
        if tr and tr["id"] != _tag_id(SOURCE_YOUTUBE, video_id):
            tracks.append(tr)
            if len(tracks) >= limit:
                break
    return tracks


# ---------------------------------------------------------------------------
# Source-agnostic resolution
# ---------------------------------------------------------------------------


def _resolve_stream(track_id: str) -> tuple[str, str, str, int]:
    """Return (upstream_url, title, artist, duration). Cached for STREAM_TTL_SECONDS."""
    now = time.monotonic()
    if len(_stream_cache) > 512:
        for key in [k for k, (exp, _v) in _stream_cache.items() if now > exp]:
            del _stream_cache[key]
    cached = _stream_cache.get(track_id)
    if cached and now < cached[0]:
        return cached[1]

    source, native_id = _split_id(track_id)
    if source == SOURCE_AUDIUS:
        result = _audius_stream(native_id)
    else:
        result = _youtube_stream(native_id)

    _stream_cache[track_id] = (now + _STREAM_TTL, result)
    return result


def _upstream_headers(source: str, range_header: str | None) -> dict[str, str]:
    """Headers for the upstream audio request.

    googlevideo DASH endpoints want a browser UA and an explicit Range so they
    answer with a clean 206 the browser can seek within. The Audius CDN handles
    ordinary requests fine, so only forward a Range when the client sent one.
    """
    headers = {
        "User-Agent": _BROWSER_UA,
        "Accept": "*/*",
        "Accept-Encoding": "identity",
    }
    if range_header:
        headers["Range"] = range_header
    elif source == SOURCE_YOUTUBE:
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
    return "mp3"


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "source": _DEFAULT_SOURCE,
        "authed": os.path.exists(AUTH_FILE),
        "cookies": bool(_COOKIES_FILE and os.path.exists(_COOKIES_FILE)),
    }


@app.get("/api/search")
def search(q: str, limit: int = 12):
    if not q or not q.strip():
        raise HTTPException(400, "Missing query parameter 'q'")
    capped = max(1, min(limit, 50))
    if _DEFAULT_SOURCE == SOURCE_AUDIUS:
        tracks = _audius_search(q.strip(), capped)
    else:
        tracks = _yt_search(q.strip(), capped)
    return {"query": q, "source": _DEFAULT_SOURCE, "tracks": tracks}


@app.get("/api/stream/{track_id}")
def stream(track_id: str):
    upstream_url, title, artist, duration = _resolve_stream(track_id)
    return {
        "url": upstream_url,
        "id": track_id,
        "title": title,
        "artist": artist,
        "duration": duration,
    }


@app.get("/api/audio/{track_id}")
def audio(track_id: str, range: str | None = Header(default=None), download: bool = False):
    """Proxy the raw audio bytes so playback happens through this server.

    Upstream URLs are either signed for the resolving machine (YouTube) or a
    redirect to a CDN object (Audius), so we fetch server-side and relay bytes.
    """
    upstream_url, title, _artist, _duration = _resolve_stream(track_id)
    source, _native = _split_id(track_id)

    try:
        upstream = requests.get(
            upstream_url,
            headers=_upstream_headers(source, range),
            stream=True,
            timeout=30,
            allow_redirects=True,
        )
    except requests.RequestException as exc:
        raise HTTPException(502, f"Could not reach audio stream: {exc}") from exc

    if upstream.status_code >= 400:
        upstream.close()
        raise HTTPException(502, f"Audio upstream returned HTTP {upstream.status_code}")

    content_type = (upstream.headers.get("Content-Type") or "").strip()
    if content_type.startswith("text/html") or content_type.startswith("application/json"):
        upstream.close()
        raise HTTPException(502, "Upstream returned no playable audio for this track.")
    if not content_type:
        content_type = "audio/mpeg"

    resp_headers = {"Accept-Ranges": "bytes", "Cache-Control": "no-cache"}
    if upstream.headers.get("Content-Range"):
        resp_headers["Content-Range"] = upstream.headers["Content-Range"]
    if upstream.headers.get("Content-Length"):
        resp_headers["Content-Length"] = upstream.headers["Content-Length"]

    if download:
        safe = re.sub(r"[^\w\s()-]", "", title).strip().replace(" ", "_") or "wakemon_track"
        resp_headers["Content-Disposition"] = (
            f'attachment; filename="{safe}.{_ext_for_mime(content_type)}"'
        )

    return StreamingResponse(
        upstream.iter_content(chunk_size=64 * 1024),
        status_code=upstream.status_code,
        media_type=content_type,
        headers=resp_headers,
    )


@app.get("/api/related/{track_id}")
def related(track_id: str, limit: int = 20):
    """Auto-play / radio suggestions for the given track."""
    capped = max(2, min(limit, 50))
    source, native_id = _split_id(track_id)
    if source == SOURCE_AUDIUS:
        tracks = _audius_related(native_id, capped)
    else:
        tracks = _youtube_related(native_id, capped)
    return {"id": track_id, "tracks": tracks}


@app.get("/api/lyrics/{track_id}")
def lyrics(track_id: str):
    """Lyrics, where the source provides them. Audius does not."""
    source, native_id = _split_id(track_id)
    if source == SOURCE_AUDIUS:
        raise HTTPException(404, "Lyrics are not available for Audius tracks.")

    try:
        wl = get_client().get_watch_playlist(native_id, limit=1)
    except HTTPException:
        raise
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
    return {"id": track_id, "title": tracks[0].get("title"), "lyrics": text}


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
    import uvicorn

    port = int(os.environ.get("PORT", "8787"))
    host = os.environ.get("HOST", "0.0.0.0")
    print(f"WAKEMON music backend listening on http://{host}:{port}")
    print(f"Music source: {_DEFAULT_SOURCE}")
    if _DEFAULT_SOURCE == SOURCE_YOUTUBE:
        if _COOKIES_FILE and os.path.exists(_COOKIES_FILE):
            print(f"Using yt-dlp cookies from {_COOKIES_FILE}")
        else:
            print("Warning: no YouTube cookies configured. Set YTDLP_COOKIES_CONTENT.")
        print("Note: YouTube blocks datacenter IPs; this mode is for local/residential use.")
    uvicorn.run(app, host=host, port=port)
