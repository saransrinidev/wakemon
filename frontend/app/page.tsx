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
    shuffle: "SHUFFLE",
    repeat: "REPEAT",
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
  const [results, setResults] = useState<Track[]>([]);
  const [index, setIndex] = useState(0);
  const [current, setCurrent] = useState<Track | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [shuffleOn, setShuffleOn] = useState(false);
  const [repeatOn, setRepeatOn] = useState(false);
  const [volume, setVolume] = useState(70);
  const [langOpen, setLangOpen] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const t = LANGS[lang];
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mountedRef = useRef(false);

  async function doSearch(q: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=${MAX_RESULTS}`);
      if (!res.ok) throw new Error("Search failed — make sure the music server is running (python music_server.py).");
      const data = await res.json();
      setResults((data.tracks ?? []).slice(0, MAX_RESULTS));
      setIndex(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed.");
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  async function playTrack(i: number) {
    const track = results[i];
    if (!track) return;
    setCurrent(track);
    setIndex(i);
    setElapsed(0);
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/stream/${track.id}`);
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
      audio.src = `/api/audio/${track.id}`;
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

  function pickRandomIndex(excluding: number, len: number) {
    if (len <= 1) return excluding;
    let next = excluding;
    while (next === excluding) {
      next = Math.floor(Math.random() * len);
    }
    return next;
  }

  function goNext() {
    if (results.length === 0) return;
    const i = index;
    const n = repeatOn
      ? i
      : shuffleOn
        ? pickRandomIndex(i, results.length)
        : (i + 1) % results.length;
    playTrack(n);
  }

  function goPrev() {
    if (results.length === 0) return;
    const i = index;
    const n = shuffleOn ? pickRandomIndex(i, results.length) : (i - 1 + results.length) % results.length;
    playTrack(n);
  }

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      if (!audio.src && results.length > 0) {
        playTrack(index);
        return;
      }
      audio.play().catch(() => {
        /* autoplay policy */
      });
    } else {
      audio.pause();
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
    if (audio) audio.volume = volume / 100;
  }, [volume]);

  useEffect(() => {
    doSearch(DEFAULT_QUERY);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

          <div className="progressRow">
            <span className="time">{current ? formatTime(elapsed) : "--:--"}</span>
            <div
              className="progressTrack"
              role="slider"
              aria-label="Playback position"
              aria-valuemin={0}
              aria-valuemax={current?.duration || 0}
              aria-valuenow={Math.floor(elapsed)}
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
            disabled={results.length === 0}
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
            <button className="transportBtn" onClick={goPrev} aria-label={t.prev} disabled={results.length === 0}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M6 5h2v14H6zM19 6l-9 6 9 6z" />
              </svg>
            </button>

            <button
              className="playBtn"
              onClick={togglePlay}
              aria-label={isPlaying ? t.pause : t.play}
              disabled={busy}
            >
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

            <button className="transportBtn" onClick={goNext} aria-label={t.next} disabled={results.length === 0}>
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
            disabled={results.length === 0}
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
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            aria-label={t.vol}
          />
          <span className="volValue">{volume}</span>
        </section>

        <section className="tracklist">
          <div className="eyebrow">{t.search}</div>
          <form className="searchForm" onSubmit={submitSearch} role="search">
            <input
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

          <ol>
            {results.map((tr, i) => (
              <li key={tr.id}>
                <button
                  className={"trackRow" + (i === index ? " active" : "")}
                  onClick={() => playTrack(i)}
                >
                  <span className="trackIndex">{(i + 1).toString().padStart(2, "0")}</span>
                  <span className="trackNames">
                    <span className="trackTitle">{tr.title}</span>
                    <span className="trackArtist">{tr.artist}</span>
                  </span>
                  <span className="trackDur">
                    {i === index && current && isPlaying ? "▶" : formatTime(tr.duration)}
                  </span>
                </button>
              </li>
            ))}
            {!loading && results.length === 0 && !error && (
              <li className="hint">{t.noResults}</li>
            )}
          </ol>
        </section>
      </div>

      <audio
        ref={audioRef}
        preload="metadata"
        onTimeUpdate={(e) => setElapsed(e.currentTarget.currentTime)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={goNext}
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

        .searchForm {
          display: flex;
          gap: 8px;
        }

        .searchInput {
          flex: 1;
          min-width: 0;
          background: var(--panel);
          border: 1px solid var(--seam);
          border-radius: 999px;
          padding: 9px 14px;
          color: var(--cream);
          font-family: var(--font-body);
          font-size: 13px;
          font-weight: 500;
          outline: none;
        }

        .searchInput::placeholder {
          color: var(--cream-faint);
        }

        .searchInput:focus {
          border-color: var(--amber-deep);
        }

        .searchBtn {
          flex-shrink: 0;
          background: var(--panel);
          border: 1px solid var(--seam);
          color: var(--cream-dim);
          font-family: var(--font-mono);
          font-size: 10px;
          letter-spacing: 0.1em;
          padding: 0 16px;
          border-radius: 999px;
          cursor: pointer;
        }

        .searchBtn:hover:not(:disabled) {
          color: var(--cream);
          border-color: var(--amber-deep);
        }

        .searchBtn:disabled {
          opacity: 0.5;
          cursor: default;
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
        }
      `}</style>
    </main>
  );
}