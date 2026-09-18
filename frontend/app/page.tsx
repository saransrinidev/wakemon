"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Track = {
  id: string;
  title: string;
  artist: string;
  duration: number; // seconds
  thumbnail?: string;
};

const DEFAULT_QUERY = "lofi hip hop radio beats";
const MAX_RESULTS = 12;
const GENRES = ["lofi", "jazz", "chill", "instrumental", "study", "focus", "synthwave"];
const SLEEP_OPTS = [0, 5, 10, 30];

const LANGS = {
  en: {
    name: "English",
    brand: "WAKEMON",
    tagline: "radio — search, play, unwind",
    nowPlaying: "NOW PLAYING",
    search: "SEARCH",
    searchPlaceholder: "lofi, jazz, chill…",
    go: "GO",
    loading: "…",
    noResults: "Nothing found — try a different search.",
    shuffle: "Shuffle",
    repeat: "Repeat",
    vol: "VOL",
    play: "Play",
    pause: "Pause",
    prev: "Previous track",
    next: "Next track",
  },
  hi: {
    name: "हिन्दी",
    brand: "WAKEMON",
    tagline: "रेडियो — खोजें, चलाएं",
    nowPlaying: "अभी बज रहा है",
    search: "खोजें",
    searchPlaceholder: "लोफ़ाई, जैज़…",
    go: "जाएं",
    loading: "…",
    noResults: "कुछ नहीं मिला — दूसरी खोज आज़माएं।",
    shuffle: "शफल",
    repeat: "रिपीट",
    vol: "आवाज़",
    play: "चलाएं",
    pause: "रोकें",
    prev: "पिछला गीत",
    next: "अगला गीत",
  },
  ja: {
    name: "日本語",
    brand: "WAKEMON",
    tagline: "ラジオ — 検索・再生",
    nowPlaying: "再生中",
    search: "検索",
    searchPlaceholder: "ローファイ、ジャズ…",
    go: "検索",
    loading: "…",
    noResults: "見つかりませんでした — 別の検索をどうぞ。",
    shuffle: "シャッフル",
    repeat: "リピート",
    vol: "音量",
    play: "再生",
    pause: "一時停止",
    prev: "前の曲",
    next: "次の曲",
  },
  es: {
    name: "Español",
    brand: "WAKEMON",
    tagline: "radio — busca, reproduce",
    nowPlaying: "SONANDO AHORA",
    search: "BUSCAR",
    searchPlaceholder: "lofi, jazz, chill…",
    go: "IR",
    loading: "…",
    noResults: "Sin resultados — prueba otra búsqueda.",
    shuffle: "ALEATORIO",
    repeat: "REPETIR",
    vol: "VOL",
    play: "Reproducir",
    pause: "Pausar",
    prev: "Pista anterior",
    next: "Pista siguiente",
  },
  fr: {
    name: "Français",
    brand: "WAKEMON",
    tagline: "radio — cherchez, jouez",
    nowPlaying: "EN LECTURE",
    search: "RECHERCHER",
    searchPlaceholder: "lofi, jazz, chill…",
    go: "OK",
    loading: "…",
    noResults: "Aucun résultat — essayez une autre recherche.",
    shuffle: "ALÉATOIRE",
    repeat: "RÉPÉTER",
    vol: "VOL",
    play: "Lire",
    pause: "Pause",
    prev: "Piste précédente",
    next: "Piste suivante",
  },
} as const;

type LangKey = keyof typeof LANGS;

function formatTime(s: number) {
  const total = Math.max(0, Math.floor(s));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function withToken(url: string) {
  const token = process.env.NEXT_PUBLIC_API_TOKEN;
  if (!token) return url;
  return url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
}

async function api(path: string) {
  return fetch(withToken(path));
}

const MOTES = [
  { left: "10%", size: 5, delay: "0s", duration: "9s" },
  { left: "28%", size: 3, delay: "1.4s", duration: "11s" },
  { left: "52%", size: 4, delay: "2.8s", duration: "8s" },
  { left: "71%", size: 3, delay: "0.6s", duration: "10s" },
  { left: "88%", size: 5, delay: "3.6s", duration: "12s" },
];

export default function Page() {
  const [lang, setLang] = useState<LangKey>("en");
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [queue, setQueue] = useState<Track[]>([]);
  const [related, setRelated] = useState<Track[]>([]);
  const [index, setIndex] = useState(0);
  const [current, setCurrent] = useState<Track | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [shuffleOn, setShuffleOn] = useState(false);
  const [repeatOn, setRepeatOn] = useState(false);
  const [radioOn, setRadioOn] = useState(false);
  const [volume, setVolume] = useState(70);
  const [muted, setMuted] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [lyricsText, setLyricsText] = useState("");
  const [lyricsBusy, setLyricsBusy] = useState(false);
  const [sleepMin, setSleepMin] = useState(0);
  const [sleepLeft, setSleepLeft] = useState(0);

  const t = LANGS[lang];
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mountedRef = useRef(false);
  const initRef = useRef(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const progressRef = useRef<HTMLDivElement | null>(null);
  const seekingRef = useRef(false);
  const toastTimer = useRef<number | null>(null);
  const sleepEndRef = useRef(0);

  function toast(msg: string) {
    setToastMsg(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(null), 2400);
  }

  async function doSearch(q: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await api(`/api/search?q=${encodeURIComponent(q)}&limit=${MAX_RESULTS}`);
      if (!res.ok) throw new Error("Search failed — make sure the music server is running (python music_server.py).");
      const data = await res.json();
      const tracks = (data.tracks ?? []).slice(0, MAX_RESULTS);
      setQueue(tracks);
      setRelated([]);
      setIndex(0);
      if (tracks.length > 0) setCurrent(tracks[0]);
      else setCurrent(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed.");
    } finally {
      setLoading(false);
    }
  }

  async function playTrack(track: Track, idx: number) {
    if (!track) return;
    setCurrent(track);
    setIndex(idx);
    setElapsed(0);
    setError(null);
    setBusy(true);
    try {
      const res = await api(`/api/stream/${track.id}`);
      if (!res.ok) {
        let msg = "Could not load audio stream.";
        try {
          const d = await res.json();
          if (d?.detail) msg = d.detail;
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }
      const data = await res.json();
      const audio = audioRef.current;
      if (!audio) return;
      audio.src = withToken(`/api/audio/${track.id}`);
      audio.currentTime = 0;
      if (data.duration) {
        setCurrent((c) => (c && c.id === track.id ? { ...c, duration: data.duration } : c));
      }
      await audio.play();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Playback failed.");
    } finally {
      setBusy(false);
    }
  }

  function addToQueue(tr: Track) {
    if (queue.some((q) => q.id === tr.id)) {
      toast("Already in queue");
      return;
    }
    setQueue((q) => [...q, tr]);
    toast(`Added — ${tr.title}`);
  }

  function removeFromQueue(id: string) {
    const idx = queue.findIndex((x) => x.id === id);
    if (idx === -1) return;
    const wasCurrent = current?.id === id;
    const next = queue.filter((x) => x.id !== id);
    setQueue(next);
    if (wasCurrent) {
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
      }
      setCurrent(null);
      setIsPlaying(false);
      setElapsed(0);
      setIndex(Math.min(idx, Math.max(0, next.length - 1)));
    } else if (idx < index) {
      setIndex((i) => Math.max(0, i - 1));
    }
  }

  function clearQueue() {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
    }
    setQueue([]);
    setCurrent(null);
    setIndex(0);
    setIsPlaying(false);
    setElapsed(0);
    toast("Queue cleared");
  }

  async function loadSuggestions(id: string) {
    setBusy(true);
    try {
      const res = await api(`/api/related/${id}`);
      if (!res.ok) throw new Error("related");
      const d = await res.json();
      const fresh = (d.tracks ?? []).filter((tr: Track) => !queue.some((q) => q.id === tr.id));
      setRelated(fresh);
      if (fresh.length > 0) toast(`${fresh.length} similar — tap + to queue`);
    } catch {
      setRelated([]);
      toast("Could not load related tracks");
    } finally {
      setBusy(false);
    }
  }

  function pickRandomIndex(excluding: number, len: number) {
    if (len <= 1) return excluding;
    let next = excluding;
    while (next === excluding) {
      next = Math.floor(Math.random() * len);
    }
    return next;
  }

  function goNext() {
    if (queue.length === 0) return;
    const i = index;
    const n = repeatOn
      ? i
      : shuffleOn
        ? pickRandomIndex(i, queue.length)
        : (i + 1) % queue.length;
    playTrack(queue[n]!, n);
  }

  function goPrev() {
    if (queue.length === 0) return;
    const i = index;
    const n = shuffleOn ? pickRandomIndex(i, queue.length) : (i - 1 + queue.length) % queue.length;
    playTrack(queue[n]!, n);
  }

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      if (!audio.src && queue.length > 0) {
        playTrack(queue[index]!, index);
        return;
      }
      audio.play().catch(() => {
        /* autoplay policy */
      });
    } else {
      audio.pause();
    }
  }

  async function radioFill() {
    if (!current) return;
    try {
      const res = await api(`/api/related/${current.id}`);
      if (!res.ok) throw new Error("radio");
      const d = await res.json();
      const fresh = (d.tracks ?? []).filter((tr: Track) => !queue.some((q) => q.id === tr.id));
      if (fresh.length > 0) {
        const baseIdx = queue.length;
        setQueue([...queue, ...fresh]);
        playTrack(fresh[0]!, baseIdx);
      } else {
        setIsPlaying(false);
      }
    } catch {
      setIsPlaying(false);
    }
  }

  function playEnded() {
    if (repeatOn) {
      playTrack(queue[index]!, index);
      return;
    }
    if (index < queue.length - 1) {
      playTrack(queue[index + 1]!, index + 1);
      return;
    }
    if (radioOn) {
      radioFill();
      return;
    }
    setIsPlaying(false);
  }

  function seekToPct(pct: number) {
    const audio = audioRef.current;
    if (!audio || !current?.duration) return;
    audio.currentTime = (pct / 100) * current.duration;
  }

  function onSeek(e: React.PointerEvent | React.MouseEvent) {
    const el = progressRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pct = Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100));
    seekToPct(pct);
  }

  function toggleMute() {
    setMuted((m) => {
      const next = !m;
      if (audioRef.current) audioRef.current.muted = next;
      return next;
    });
  }

  function bumpVol(delta: number) {
    setVolume((v) => Math.max(0, Math.min(100, v + delta)));
  }

  function selectSleep(min: number) {
    setSleepMin(min);
    sleepEndRef.current = min ? Date.now() + min * 60000 : 0;
    if (!min) setSleepLeft(0);
  }

  function cycleSleep() {
    const idx = SLEEP_OPTS.indexOf(sleepMin);
    const next = SLEEP_OPTS[(idx + 1) % SLEEP_OPTS.length]!;
    selectSleep(next);
    if (next) toast(`Sleep in ${next}m`);
  }

  async function openLyrics() {
    if (!current) return;
    setLyricsBusy(true);
    setLyricsOpen(true);
    setLyricsText("");
    try {
      const res = await api(`/api/lyrics/${current.id}`);
      if (!res.ok) throw new Error("no lyrics");
      const d = await res.json();
      setLyricsText(d.lyrics || "");
    } catch {
      setLyricsText("No lyrics available for this track.");
    } finally {
      setLyricsBusy(false);
    }
  }

  async function shareTrack() {
    if (!current) return;
    const url = `${window.location.origin}${window.location.pathname}?track=${current.id}`;
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ title: current.title, text: `${current.title} — ${current.artist}`, url });
      } else {
        await navigator.clipboard.writeText(url);
        toast("Link copied");
      }
    } catch {
      /* share cancelled */
    }
  }

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (q) doSearch(q);
  }

  useEffect(() => {
    const stored = localStorage.getItem("wakemon-theme");
    const saved: "dark" | "light" =
      stored === "dark" || stored === "light"
        ? stored
        : window.matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark";
    document.documentElement.setAttribute("data-theme", saved);
    setTheme(saved);
  }, []);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("wakemon-theme", theme);
  }, [theme]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.volume = muted ? 0 : volume / 100;
      audio.muted = muted;
    }
  }, [volume, muted]);

  useEffect(() => {
    localStorage.setItem("wakemon-volume", String(volume));
  }, [volume]);

  useEffect(() => {
    if (!initRef.current) return;
    localStorage.setItem("wakemon-queue", JSON.stringify(queue));
  }, [queue]);

  useEffect(() => {
    const savedVol = localStorage.getItem("wakemon-volume");
    if (savedVol) {
      const n = Number(savedVol);
      if (!Number.isNaN(n)) setVolume(Math.max(0, Math.min(100, n)));
    }
    let saved: Track[] = [];
    try {
      const raw = localStorage.getItem("wakemon-queue");
      if (raw) {
        const arr = JSON.parse(raw) as Track[];
        if (Array.isArray(arr) && arr.length > 0 && arr[0]?.id) saved = arr;
      }
    } catch {
      /* ignore */
    }
    if (saved.length > 0) {
      setQueue(saved);
      setCurrent(saved[0]!);
    } else {
      doSearch(DEFAULT_QUERY);
    }
    initRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    if (!current) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: current.title,
      artist: current.artist,
      album: "WAKEMON radio",
      artwork: current.thumbnail ? [{ src: current.thumbnail, sizes: "512x512", type: "image/jpeg" }] : [],
    });
    const safe = (handler: MediaSessionAction, cb: MediaSessionActionHandler) => {
      try {
        navigator.mediaSession.setActionHandler(handler, cb);
      } catch {
        /* unsupported action */
      }
    };
    safe("play", togglePlay);
    safe("pause", togglePlay);
    safe("previoustrack", goPrev);
    safe("nexttrack", goNext);
    safe("seekto", (d) => {
      if (d.seekTime != null && audioRef.current) audioRef.current.currentTime = d.seekTime;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  useEffect(() => {
    if (!("mediaSession" in navigator) || !current?.duration) return;
    try {
      navigator.mediaSession.setPositionState?.({
        duration: current.duration,
        position: Math.min(elapsed, current.duration),
        playbackRate: 1,
      });
    } catch {
      /* ignore */
    }
  }, [elapsed, current]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        if (e.key === "Escape") {
          target.blur();
          setLangOpen(false);
        }
        return;
      }
      switch (e.key) {
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowRight":
          e.preventDefault();
          goNext();
          break;
        case "ArrowLeft":
          e.preventDefault();
          goPrev();
          break;
        case "ArrowUp":
          e.preventDefault();
          bumpVol(5);
          break;
        case "ArrowDown":
          e.preventDefault();
          bumpVol(-5);
          break;
        case "/":
          e.preventDefault();
          searchRef.current?.focus();
          break;
        case "s":
        case "S":
          setShuffleOn((v) => !v);
          break;
        case "r":
        case "R":
          setRepeatOn((v) => !v);
          break;
        case "m":
        case "M":
          toggleMute();
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (!sleepMin) return;
    const id = window.setInterval(() => {
      const left = Math.round((sleepEndRef.current - Date.now()) / 1000);
      setSleepLeft(Math.max(0, left));
      if (left <= 0) {
        window.clearInterval(id);
        audioRef.current?.pause();
        setSleepMin(0);
        setSleepLeft(0);
        toast("Sleep timer finished");
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [sleepMin]);

  const progressPct = useMemo(() => {
    if (!current || current.duration <= 0) return 0;
    return Math.min(100, (elapsed / current.duration) * 100);
  }, [elapsed, current]);

  const labelText = current ? current.title : t.brand;
  const labelMeta = current ? `${current.title} · ${current.artist}` : t.tagline;
  const marqueeText = current ? `${current.title} — ${current.artist}` : `${t.brand} — ${t.tagline}`;

  return (
    <main className="wrap">
      <div className="motes" aria-hidden="true">
        {MOTES.map((m, i) => (
          <span
            key={i}
            className="mote"
            style={{
              left: m.left,
              width: m.size,
              height: m.size,
              animationDelay: m.delay,
              animationDuration: m.duration,
            }}
          />
        ))}
      </div>

      <div className="device" role="group" aria-label="Wakemon music player">
        <header className="brandRow">
          <div className="brand">
            <span className="brandMark" aria-hidden="true" />
            <div>
              <div className="brandName">{t.brand}</div>
              <div className="tagline">{t.tagline}</div>
            </div>
          </div>

          <div className="topRight">
            <button
              className="themeBtn"
              onClick={() => setTheme((v) => (v === "dark" ? "light" : "dark"))}
              aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            >
              {theme === "dark" ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="12" cy="12" r="4.5" fill="currentColor" />
                  <path
                    d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z" fill="currentColor" />
                </svg>
              )}
            </button>
            <div className="langBox">
              <button
                className="langBtn"
                onClick={() => setLangOpen((v) => !v)}
                aria-expanded={langOpen}
                aria-haspopup="listbox"
              >
                {t.name.slice(0, 2).toUpperCase()}
                <svg width="10" height="6" viewBox="0 0 10 6" fill="none" aria-hidden="true">
                  <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
              {langOpen && (
                <ul className="langMenu" role="listbox">
                  {(Object.keys(LANGS) as LangKey[]).map((key) => (
                    <li key={key}>
                      <button
                        role="option"
                        aria-selected={key === lang}
                        className={"langOpt" + (key === lang ? " active" : "")}
                        onClick={() => {
                          setLang(key);
                          setLangOpen(false);
                        }}
                      >
                        {LANGS[key].name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </header>

        <section className="window">
          <div className="platter" aria-hidden="true">
            <div className={"vinyl" + (isPlaying ? " spinning" : "")}>
              {current?.thumbnail ? <img className="vinylArt" src={current.thumbnail} alt="" /> : null}
              <div className="vinylLabel">
                <span className="vinylLabelText">WK</span>
              </div>
            </div>
            <div className={"tonearm" + (isPlaying ? " down" : "")} />
          </div>

          <div className="labelStrip">
            <div className="labelTitle">{labelText}</div>
            <div className="labelMeta">{labelMeta}</div>
          </div>
        </section>

        <section className="trackInfo">
          <div className="eyebrow">{t.nowPlaying}</div>
          <div className="marqueeMask">
            <div className={"marquee" + (isPlaying ? " scrolling" : "")}>{marqueeText}</div>
          </div>

          <div className="actionsRow">
            <button className="actBtn" onClick={openLyrics} disabled={!current}>
              LYRICS
            </button>
            <button className="actBtn" onClick={shareTrack} disabled={!current}>
              SHARE
            </button>
            <a
              className="actBtn"
              href={current ? withToken(`/api/audio/${current.id}?download=1`) : undefined}
              download
              aria-disabled={!current}
              onClick={(e) => {
                if (!current) e.preventDefault();
              }}
            >
              DOWNLOAD
            </a>
            <button
              className={"actBtn" + (radioOn ? " on" : "")}
              onClick={() => setRadioOn((v) => !v)}
              disabled={!current}
              title="Keep playing similar tracks when the queue ends"
            >
              RADIO
            </button>
            <button className="actBtn" onClick={() => current && loadSuggestions(current.id)} disabled={!current}>
              SIMILAR
            </button>
          </div>

          <div className="progressRow">
            <span className="time">{current ? formatTime(elapsed) : "--:--"}</span>
            <div
              ref={progressRef}
              className="progressTrack"
              role="slider"
              aria-label="Playback position"
              aria-valuemin={0}
              aria-valuemax={current?.duration || 0}
              aria-valuenow={Math.floor(elapsed)}
              onClick={onSeek}
              onPointerDown={(e) => {
                seekingRef.current = true;
                onSeek(e);
              }}
              onPointerMove={(e) => {
                if (seekingRef.current) onSeek(e);
              }}
              onPointerUp={() => {
                seekingRef.current = false;
              }}
              onPointerLeave={() => {
                seekingRef.current = false;
              }}
            >
              <div className="progressFill" style={{ width: `${progressPct}%` }} />
              <div className="progressHead" style={{ left: `${progressPct}%` }} />
            </div>
            <span className="time">{current ? formatTime(current.duration) : "--:--"}</span>
          </div>
        </section>

        <section className="controls">
          <button
            className={"pillBtn" + (shuffleOn ? " on" : "")}
            onClick={() => setShuffleOn((v) => !v)}
            aria-pressed={shuffleOn}
            title={t.shuffle}
            disabled={queue.length === 0}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M3 6h3.5c1.8 0 3.4 1 4.3 2.5M3 18h3.5c1.8 0 3.4-1 4.3-2.5M15.2 8.5C16.1 7 17.7 6 19.5 6H21M15.2 15.5c.9 1.5 2.5 2.5 4.3 2.5H21M18 3l3 3-3 3M18 15l3 3-3 3"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          <div className="transport">
            <button className="transportBtn" onClick={goPrev} aria-label={t.prev} disabled={queue.length === 0}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M6 5h2v14H6zM19 6l-9 6 9 6z" />
              </svg>
            </button>

            <button className="playBtn" onClick={togglePlay} aria-label={isPlaying ? t.pause : t.play} disabled={busy}>
              {busy ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <circle cx="12" cy="12" r="2.2" fill="currentColor" />
                  <path d="M12 5a7 7 0 100 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
                </svg>
              ) : isPlaying ? (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <rect x="6" y="5" width="4" height="14" rx="1" />
                  <rect x="14" y="5" width="4" height="14" rx="1" />
                </svg>
              ) : (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M7 5v14l13-7z" />
                </svg>
              )}
            </button>

            <button className="transportBtn" onClick={goNext} aria-label={t.next} disabled={queue.length === 0}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M16 5h2v14h-2zM5 6l9 6-9 6z" />
              </svg>
            </button>
          </div>

          <button
            className={"pillBtn" + (repeatOn ? " on" : "")}
            onClick={() => setRepeatOn((v) => !v)}
            aria-pressed={repeatOn}
            title={t.repeat}
            disabled={queue.length === 0}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M4 7h13a3 3 0 013 3v1M20 17H7a3 3 0 01-3-3v-1M8 4L4 7l4 3M16 20l4-3-4-3"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </section>

        <section className="volumeRow">
          <span className="volLabel">{t.vol}</span>
          <input
            className="volSlider"
            type="range"
            min={0}
            max={100}
            value={muted ? 0 : volume}
            onChange={(e) => {
              setMuted(false);
              if (audioRef.current) audioRef.current.muted = false;
              setVolume(Number(e.target.value));
            }}
            aria-label={t.vol}
          />
          <span className="volValue">{muted ? "M" : volume}</span>
          <button className={"actBtn sleep" + (sleepMin ? " on" : "")} onClick={cycleSleep} title="Sleep timer">
            {sleepMin ? `SLEEP ${sleepMin}m` : "SLEEP"}
          </button>
        </section>

        <section className="tracklist">
          <div className="eyebrow">{t.search}</div>
          <div className="chips">
            {GENRES.map((g) => (
              <button
                key={g}
                className={"chip" + (query === g ? " on" : "")}
                onClick={() => {
                  setQuery(g);
                  doSearch(g);
                }}
              >
                {g}
              </button>
            ))}
          </div>
          <form className="searchForm" onSubmit={submitSearch} role="search">
            <input
              ref={searchRef}
              className="searchInput"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t.searchPlaceholder}
              aria-label={t.search}
            />
            <button className="searchBtn" type="submit" disabled={loading}>
              {loading ? t.loading : t.go}
            </button>
          </form>

          {error && (
            <div className="hint" role="alert">
              {error}
            </div>
          )}

          <div className="sectionRow">
            <span className="upNext">
              UP NEXT <span className="qCount">{queue.length}</span>
            </span>
            <button className="clearBtn" onClick={clearQueue} disabled={queue.length === 0}>
              CLEAR
            </button>
          </div>

          <ol>
            {queue.map((tr, i) => (
              <li key={tr.id + "_" + i}>
                <div className="qRow">
                  <button
                    className={"trackRow" + (i === index && current?.id === tr.id ? " active" : "")}
                    onClick={() => playTrack(tr, i)}
                  >
                    <span className="trackIndex">{(i + 1).toString().padStart(2, "0")}</span>
                    <span className="trackNames">
                      <span className="trackTitle">{tr.title}</span>
                      <span className="trackArtist">{tr.artist}</span>
                    </span>
                    <span className="trackDur">
                      {current?.id === tr.id && isPlaying ? "▶" : formatTime(tr.duration)}
                    </span>
                  </button>
                  <button
                    className="qBtn"
                    onClick={() => removeFromQueue(tr.id)}
                    aria-label="Remove from queue"
                    title="Remove"
                  >
                    ×
                  </button>
                </div>
              </li>
            ))}
            {!loading && queue.length === 0 && !error && <li className="hint">{t.noResults}</li>}
          </ol>

          {related.length > 0 && (
            <>
              <div className="sectionRow sectHead">
                <span className="upNext">SUGGESTED</span>
                <button className="clearBtn" onClick={() => setRelated([])}>
                  HIDE
                </button>
              </div>
              <ol className="suggestList">
                {related.map((tr) => (
                  <li key={tr.id}>
                    <div className="qRow">
                      <button className="trackRow" onClick={() => addToQueue(tr)}>
                        <span className="trackIndex">+</span>
                        <span className="trackNames">
                          <span className="trackTitle">{tr.title}</span>
                          <span className="trackArtist">{tr.artist}</span>
                        </span>
                        <span className="trackDur">{formatTime(tr.duration)}</span>
                      </button>
                      <button className="qBtn on" onClick={() => addToQueue(tr)} aria-label="Add to queue" title="Add">
                        +
                      </button>
                    </div>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      </div>

      {toastMsg && <div className="toast" role="status">{toastMsg}</div>}

      {lyricsOpen && (
        <div className="lyricsPanel" role="dialog" aria-label="Lyrics">
          <div className="lyricsHead">
            <span className="lyricsTitle">{current?.title || "Lyrics"}</span>
            <button className="qBtn" onClick={() => setLyricsOpen(false)} aria-label="Close lyrics">
              ×
            </button>
          </div>
          <div className="lyricsBody">
            {lyricsBusy ? <span className="hint">Loading…</span> : lyricsText || <span className="hint">—</span>}
          </div>
        </div>
      )}

      <audio
        ref={audioRef}
        preload="metadata"
        onTimeUpdate={(e) => setElapsed(e.currentTarget.currentTime)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={playEnded}
        onError={() => {
          setBusy(false);
          toast("Stream failed — try another track");
        }}
      />

      <style jsx>{`
        .wrap {
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 48px 20px;
          position: relative;
          z-index: 1;
        }

        .motes {
          position: fixed;
          inset: 0;
          overflow: hidden;
          pointer-events: none;
          z-index: 0;
        }

        .mote {
          position: absolute;
          bottom: -10px;
          border-radius: 50%;
          background: var(--amber-glow);
          filter: blur(1px);
          opacity: 0;
          animation-name: drift;
          animation-timing-function: ease-in-out;
          animation-iteration-count: infinite;
        }

        @keyframes drift {
          0% {
            transform: translate(0, 0);
            opacity: 0;
          }
          12% {
            opacity: 0.55;
          }
          50% {
            transform: translate(14px, -48vh);
            opacity: 0.35;
          }
          88% {
            opacity: 0.5;
          }
          100% {
            transform: translate(-10px, -96vh);
            opacity: 0;
          }
        }

        .device {
          position: relative;
          width: 100%;
          max-width: 400px;
          background: linear-gradient(180deg, var(--panel-raised), var(--panel));
          border: 1px solid var(--seam);
          border-radius: 30px;
          padding: 24px 22px 20px;
          box-shadow: 0 40px 90px -30px rgba(0, 0, 0, 0.85), 0 0 60px -20px var(--device-glow),
            0 0 0 1px rgba(255, 255, 255, 0.02) inset;
        }

        .topRight {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .themeBtn {
          width: 34px;
          height: 34px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--panel);
          border: 1px solid var(--seam);
          color: var(--cream-dim);
          border-radius: 50%;
          cursor: pointer;
        }

        .themeBtn:hover {
          color: var(--cream);
          border-color: var(--amber-deep);
        }

        .brandRow {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          margin-bottom: 18px;
        }

        .brand {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .brandMark {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: var(--amber);
          box-shadow: 0 0 12px 3px var(--accent-glow-ring);
          flex-shrink: 0;
        }

        .brandName {
          font-family: var(--font-display);
          font-size: 17px;
          font-weight: 600;
          letter-spacing: 0.08em;
          color: var(--cream);
        }

        .tagline {
          font-family: var(--font-mono);
          font-size: 10px;
          letter-spacing: 0.1em;
          color: var(--cream-faint);
          text-transform: lowercase;
        }

        .langBox {
          position: relative;
        }

        .langBtn {
          display: flex;
          align-items: center;
          gap: 6px;
          background: var(--panel);
          border: 1px solid var(--seam);
          color: var(--cream-dim);
          font-family: var(--font-mono);
          font-size: 11px;
          letter-spacing: 0.06em;
          padding: 7px 11px;
          border-radius: 999px;
          cursor: pointer;
        }

        .langBtn:hover {
          color: var(--cream);
          border-color: var(--amber-deep);
        }

        .langMenu {
          position: absolute;
          right: 0;
          top: calc(100% + 6px);
          background: var(--panel-raised);
          border: 1px solid var(--seam);
          border-radius: 14px;
          padding: 6px;
          list-style: none;
          margin: 0;
          min-width: 140px;
          z-index: 10;
          box-shadow: 0 20px 40px -12px rgba(0, 0, 0, 0.7);
        }

        .langOpt {
          width: 100%;
          text-align: left;
          background: none;
          border: none;
          color: var(--cream-dim);
          font-family: var(--font-body);
          font-weight: 500;
          font-size: 13px;
          padding: 8px 10px;
          border-radius: 9px;
          cursor: pointer;
        }

        .langOpt:hover {
          background: var(--hover-bg);
          color: var(--cream);
        }

        .langOpt.active {
          color: var(--amber);
        }

        .window {
          background: radial-gradient(ellipse at 50% 20%, var(--window-glow), transparent 60%), var(--window-bg);
          border: 1px solid var(--seam);
          border-radius: 18px;
          padding: 20px 16px 16px;
          margin-bottom: 16px;
          box-shadow: inset 0 2px 14px rgba(0, 0, 0, 0.6);
        }

        .platter {
          position: relative;
          width: 148px;
          height: 148px;
          margin: 4px auto 16px;
        }

        .vinyl {
          width: 148px;
          height: 148px;
          border-radius: 50%;
          background: repeating-radial-gradient(
            circle at center,
            var(--vinyl-a) 0px,
            var(--vinyl-a) 2px,
            var(--vinyl-b) 3px,
            var(--vinyl-b) 6px
          );
          box-shadow: 0 10px 26px -8px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.03);
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .vinylArt {
          position: absolute;
          inset: 12px;
          width: calc(100% - 24px);
          height: calc(100% - 24px);
          object-fit: cover;
          border-radius: 50%;
          opacity: 0.92;
          box-shadow: inset 0 0 30px rgba(0, 0, 0, 0.35);
        }

        .vinyl.spinning {
          animation: spin 3.4s linear infinite;
        }

        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }

        .vinylLabel {
          width: 56px;
          height: 56px;
          border-radius: 50%;
          background: radial-gradient(circle at 35% 30%, var(--amber-glow), var(--amber) 55%, var(--amber-deep));
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 2px 6px rgba(0, 0, 0, 0.5);
        }

        .vinylLabel::after {
          content: "";
          position: absolute;
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--void);
        }

        .vinylLabelText {
          font-family: var(--font-display);
          font-size: 13px;
          font-weight: 600;
          color: var(--void);
          letter-spacing: 0.06em;
        }

        .tonearm {
          position: absolute;
          top: -4px;
          right: 6px;
          width: 5px;
          height: 78px;
          border-radius: 3px;
          background: linear-gradient(180deg, var(--cream-dim), var(--cream-faint));
          transform-origin: top center;
          transform: rotate(-34deg);
          transition: transform 0.7s cubic-bezier(0.4, 0, 0.2, 1);
          box-shadow: 0 2px 6px rgba(0, 0, 0, 0.5);
        }

        .tonearm::before {
          content: "";
          position: absolute;
          top: -7px;
          left: 50%;
          transform: translateX(-50%);
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: var(--panel-raised);
          border: 2px solid var(--amber-deep);
        }

        .tonearm::after {
          content: "";
          position: absolute;
          bottom: -3px;
          left: 50%;
          transform: translateX(-50%);
          width: 12px;
          height: 8px;
          border-radius: 2px;
          background: var(--amber);
        }

        .tonearm.down {
          transform: rotate(-13deg);
        }

        .labelStrip {
          background: linear-gradient(180deg, var(--paper), var(--paper-edge));
          color: var(--paper-ink);
          border-radius: 9px;
          padding: 10px 12px;
          text-align: center;
          transform: rotate(-0.4deg);
          box-shadow: 0 3px 10px rgba(0, 0, 0, 0.45);
        }

        .labelTitle {
          font-family: var(--font-display);
          font-weight: 600;
          font-size: 13px;
          line-height: 1.2;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .labelMeta {
          font-family: var(--font-mono);
          font-size: 9px;
          letter-spacing: 0.04em;
          margin-top: 3px;
          color: var(--paper-ink-dim);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .trackInfo {
          margin-bottom: 14px;
        }

        .eyebrow {
          font-family: var(--font-mono);
          font-size: 10px;
          letter-spacing: 0.14em;
          color: var(--amber);
          margin-bottom: 6px;
        }

        .marqueeMask {
          overflow: hidden;
          white-space: nowrap;
        }

        .marquee {
          display: inline-block;
          font-family: var(--font-display);
          font-size: 17px;
          font-weight: 500;
          color: var(--cream);
        }

        .marquee.scrolling {
          animation: marquee 9s linear infinite;
        }

        @keyframes marquee {
          0%,
          15% {
            transform: translateX(0);
          }
          85%,
          100% {
            transform: translateX(calc(-100% + 260px));
          }
        }

        .actionsRow {
          display: flex;
          align-items: center;
          gap: 6px;
          margin: 10px 0 4px;
          flex-wrap: wrap;
        }

        .actBtn {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          background: var(--panel);
          border: 1px solid var(--seam);
          color: var(--cream-dim);
          font-family: var(--font-mono);
          font-size: 9px;
          letter-spacing: 0.1em;
          padding: 5px 9px;
          border-radius: 999px;
          cursor: pointer;
          text-decoration: none;
        }

        .actBtn:hover:not(:disabled) {
          color: var(--cream);
          border-color: var(--amber-deep);
        }

        .actBtn:disabled {
          opacity: 0.4;
          cursor: default;
        }

        .actBtn.on {
          color: var(--amber);
          border-color: var(--amber-deep);
          background: var(--accent-tint);
        }

        .progressRow {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-top: 12px;
        }

        .time {
          font-family: var(--font-mono);
          font-size: 10.5px;
          color: var(--cream-faint);
          min-width: 34px;
        }

        .progressTrack {
          position: relative;
          flex: 1;
          height: 4px;
          background: var(--seam);
          border-radius: 999px;
          cursor: pointer;
          touch-action: none;
        }

        .progressFill {
          height: 100%;
          background: linear-gradient(90deg, var(--amber-deep), var(--amber));
          border-radius: 999px;
        }

        .progressHead {
          position: absolute;
          top: 50%;
          width: 10px;
          height: 10px;
          background: var(--cream);
          border-radius: 50%;
          transform: translate(-50%, -50%);
          box-shadow: 0 0 0 3px var(--accent-glow-ring);
        }

        .controls {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 16px;
        }

        .pillBtn {
          width: 34px;
          height: 34px;
          border-radius: 50%;
          background: var(--panel);
          border: 1px solid var(--seam);
          color: var(--cream-faint);
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
        }

        .pillBtn:hover:not(:disabled) {
          color: var(--cream);
        }

        .pillBtn:disabled,
        .transportBtn:disabled {
          opacity: 0.4;
          cursor: default;
        }

        .pillBtn.on {
          color: var(--amber);
          border-color: var(--amber-deep);
          background: var(--accent-tint);
        }

        .transport {
          display: flex;
          align-items: center;
          gap: 14px;
        }

        .transportBtn {
          background: none;
          border: none;
          color: var(--cream-dim);
          cursor: pointer;
          display: flex;
          padding: 6px;
        }

        .transportBtn:hover:not(:disabled) {
          color: var(--cream);
        }

        .playBtn {
          width: 58px;
          height: 58px;
          border-radius: 50%;
          background: radial-gradient(circle at 35% 30%, var(--amber-glow), var(--amber) 60%, var(--amber-deep));
          border: none;
          color: var(--void);
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          box-shadow: 0 10px 24px -8px var(--button-glow);
        }

        .playBtn:active {
          transform: scale(0.96);
        }

        .volumeRow {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 18px;
        }

        .volLabel,
        .volValue {
          font-family: var(--font-mono);
          font-size: 10px;
          color: var(--cream-faint);
          letter-spacing: 0.08em;
          min-width: 22px;
        }

        .volValue {
          text-align: right;
        }

        .actBtn.sleep {
          flex-shrink: 0;
        }

        .volSlider {
          flex: 1;
          -webkit-appearance: none;
          appearance: none;
          height: 3px;
          background: var(--seam);
          border-radius: 999px;
          outline: none;
        }

        .volSlider::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 13px;
          height: 13px;
          border-radius: 50%;
          background: var(--amber);
          border: 2px solid var(--cream);
          cursor: pointer;
          margin-top: -5px;
        }

        .volSlider::-moz-range-thumb {
          width: 13px;
          height: 13px;
          border-radius: 50%;
          background: var(--amber);
          border: 2px solid var(--cream);
          cursor: pointer;
        }

        .tracklist {
          border-top: 1px solid var(--seam);
          padding-top: 14px;
        }

        .tracklist ol {
          list-style: none;
          margin: 6px 0 0;
          padding: 0;
          max-height: 200px;
          overflow-y: auto;
        }

        .tracklist ol.suggestList {
          border-top: 1px dashed var(--seam);
          margin-top: 8px;
        }

        .searchForm {
          display: flex;
          gap: 8px;
        }

        .chips {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin: 0 0 10px;
        }

        .chip {
          background: var(--panel);
          border: 1px solid var(--seam);
          color: var(--cream-faint);
          font-family: var(--font-mono);
          font-size: 10px;
          letter-spacing: 0.06em;
          padding: 5px 10px;
          border-radius: 999px;
          cursor: pointer;
        }

        .chip:hover {
          color: var(--cream);
          border-color: var(--amber-deep);
        }

        .chip.on {
          color: var(--amber);
          border-color: var(--amber-deep);
          background: var(--accent-tint);
        }

        .sectionRow {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin: 14px 0 4px;
        }

        .upNext {
          font-family: var(--font-mono);
          font-size: 10px;
          letter-spacing: 0.14em;
          color: var(--amber);
          text-transform: uppercase;
        }

        .qCount {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 16px;
          height: 16px;
          padding: 0 4px;
          border-radius: 999px;
          background: var(--accent-tint);
          color: var(--amber);
          font-size: 9px;
          margin-left: 4px;
        }

        .clearBtn {
          background: none;
          border: none;
          color: var(--cream-faint);
          font-family: var(--font-mono);
          font-size: 9px;
          letter-spacing: 0.1em;
          cursor: pointer;
        }

        .clearBtn:hover:not(:disabled) {
          color: var(--cream);
        }

        .clearBtn:disabled {
          opacity: 0.4;
          cursor: default;
        }

        .qRow {
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .qRow .trackRow {
          flex: 1;
          min-width: 0;
        }

        .qBtn {
          width: 26px;
          height: 26px;
          flex-shrink: 0;
          border-radius: 50%;
          background: var(--panel);
          border: 1px solid var(--seam);
          color: var(--cream-faint);
          font-size: 14px;
          line-height: 1;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .qBtn:hover {
          color: var(--cream);
          border-color: var(--amber-deep);
        }

        .qBtn.on {
          color: var(--amber);
          border-color: var(--amber-deep);
        }

        .toast {
          position: fixed;
          left: 50%;
          bottom: 26px;
          transform: translateX(-50%);
          background: var(--panel-raised);
          border: 1px solid var(--amber-deep);
          color: var(--cream);
          font-family: var(--font-mono);
          font-size: 10px;
          letter-spacing: 0.05em;
          padding: 7px 14px;
          border-radius: 999px;
          box-shadow: 0 14px 30px -10px rgba(0, 0, 0, 0.7);
          z-index: 30;
          white-space: nowrap;
          max-width: 90vw;
          overflow: hidden;
          text-overflow: ellipsis;
          animation: toastIn 0.18s ease-out;
        }

        @keyframes toastIn {
          from {
            opacity: 0;
            transform: translate(-50%, 6px);
          }
          to {
            opacity: 1;
            transform: translate(-50%, 0);
          }
        }

        .lyricsPanel {
          position: fixed;
          inset: 0;
          margin: auto;
          width: 100%;
          max-width: 400px;
          height: 100%;
          background: var(--window-bg);
          border-radius: 0;
          z-index: 25;
          display: flex;
          flex-direction: column;
          padding: 20px;
          box-shadow: 0 0 0 1px var(--seam);
        }

        .lyricsHead {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
        }

        .lyricsTitle {
          font-family: var(--font-display);
          font-weight: 600;
          font-size: 13px;
          color: var(--cream);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          margin-right: 12px;
        }

        .lyricsBody {
          flex: 1;
          overflow-y: auto;
          font-family: var(--font-mono);
          font-size: 11px;
          line-height: 1.8;
          color: var(--cream-dim);
          white-space: pre-wrap;
        }

        .hint {
          font-family: var(--font-mono);
          font-size: 10.5px;
          line-height: 1.5;
          color: var(--cream-faint);
          padding: 8px 6px;
          list-style: none;
        }

        .trackRow {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 10px;
          background: none;
          border: none;
          color: var(--cream-dim);
          padding: 7px 6px;
          border-radius: 9px;
          cursor: pointer;
          text-align: left;
        }

        .trackRow:hover {
          background: var(--hover-bg);
        }

        .trackRow.active {
          color: var(--amber);
          background: var(--accent-tint);
        }

        .trackIndex {
          font-family: var(--font-mono);
          font-size: 10px;
          color: var(--cream-faint);
          width: 16px;
          flex-shrink: 0;
        }

        .trackRow.active .trackIndex {
          color: var(--amber);
        }

        .trackNames {
          display: flex;
          flex-direction: column;
          flex: 1;
          min-width: 0;
        }

        .trackTitle {
          font-family: var(--font-body);
          font-size: 13px;
          font-weight: 600;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          color: var(--cream);
        }

        .trackRow.active .trackTitle {
          color: var(--amber);
        }

        .trackArtist {
          font-family: var(--font-mono);
          font-size: 10px;
          color: var(--cream-faint);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .trackDur {
          font-family: var(--font-mono);
          font-size: 10.5px;
          color: var(--cream-faint);
          flex-shrink: 0;
        }

        @media (max-width: 420px) {
          .device {
            padding: 20px 16px 16px;
            border-radius: 22px;
          }

          .lyricsPanel {
            border-radius: 0;
          }
        }

        @media (min-width: 421px) {
          .lyricsPanel {
            max-height: 80vh;
            height: auto;
            border-radius: 24px;
          }
        }
      `}</style>
    </main>
  );
}