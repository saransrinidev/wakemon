"""WAKEMON music backend — YTMusic (ytmusicapi) wrapper.

Run with:
    pip install -r requirements.txt
    python music_server.py

Optional (makes streaming fully first-class — not required):
    ytmusicapi setup      # interactively creates headers_auth.json
    python music_server.py

ytmusicapi is used for search + song metadata. Audio stream URLs are
resolved with yt-dlp when ytmusicapi returns an unsigned signatureCipher
(which is the default without authentication).
"""

import os

import requests
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from ytmusicapi import YTMusic

AUTH_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "headers_auth.json")

app = FastAPI(title="WAKEMON music backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

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
    return {"ok": True, "authed": os.path.exists(AUTH_FILE)}


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
    except ImportError as exc:  # noqa: BLE001
        raise HTTPException(
            502,
            "yt-dlp is not installed. Run: pip install -r requirements.txt",
        ) from exc

    format_selector = "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/(best)"
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "format": format_selector,
        "youtube_include_dash_manifest": False,
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"https://music.youtube.com/watch?v={video_id}", download=False)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not resolve an audio stream: {exc}") from exc

    url = info.get("url")
    if not url:
        raise HTTPException(404, "No playable audio stream found for this track.")
    return url, info.get("title") or "Song", int(info.get("duration") or 0)


def _resolve_stream(video_id: str) -> tuple[str, str, str, int]:
    """Return (stream_url, title, artist, duration)."""
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

    return stream_url, title, artist, duration


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


def _yt_headers() -> dict[str, str]:
    return {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
        ),
        "Referer": "https://music.youtube.com/",
        "Origin": "https://music.youtube.com",
    }


@app.get("/api/audio/{video_id}")
def audio(video_id: str, range: str | None = Header(default=None)):
    """Proxy the raw audio bytes so playback happens through this server.

    The stream URLs resolved by ytmusicapi/yt-dlp are signed for the machine
    that resolved them. Browsers cannot play them directly from a client IP,
    so we fetch upstream server-side and stream the bytes back.
    """
    stream_url, _title, _artist, _duration = _resolve_stream(video_id)

    headers = _yt_headers()
    if range:
        headers["Range"] = range

    try:
        upstream = requests.get(stream_url, headers=headers, stream=True, timeout=30)
    except requests.RequestException as exc:
        raise HTTPException(502, f"Could not reach audio stream: {exc}") from exc

    if upstream.status_code >= 400:
        upstream.close()
        raise HTTPException(502, f"Audio upstream returned HTTP {upstream.status_code}")

    resp_headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache",
    }
    content_range = upstream.headers.get("Content-Range")
    if content_range:
        resp_headers["Content-Range"] = content_range
    content_type = upstream.headers.get("Content-Type")
    if not content_type:
        content_type = "audio/mpeg"

    return StreamingResponse(
        upstream.iter_content(chunk_size=64 * 1024),
        status_code=upstream.status_code,
        media_type=content_type,
        headers=resp_headers,
    )


if __name__ == "__main__":
    import os

    import uvicorn

    port = int(os.environ.get("PORT", "8787"))
    host = os.environ.get("HOST", "0.0.0.0")
    print(f"WAKEMON music backend listening on http://{host}:{port}")
    uvicorn.run(app, host=host, port=port)