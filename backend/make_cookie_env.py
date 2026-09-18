"""Turn a full cookies.txt into a compact value for YTDLP_COOKIES_CONTENT.

Usage:
    python make_cookie_env.py C:\\path\\to\\cookies.txt

It keeps only the YouTube auth cookies yt-dlp needs, gzips + base64-encodes
them, and prints the result. Paste that output into the Railway variable
YTDLP_COOKIES_CONTENT. The compressed value fits well under Railway's 32 KB
env-var limit.
"""

import base64
import gzip
import sys

# Only these cookies matter for authenticating yt-dlp with YouTube.
KEEP = {
    "SID", "HSID", "SSID", "APISID", "SAPISID",
    "__Secure-1PSID", "__Secure-3PSID",
    "__Secure-1PAPISID", "__Secure-3PAPISID",
    "__Secure-1PSIDTS", "__Secure-3PSIDTS",
    "__Secure-1PSIDCC", "__Secure-3PSIDCC",
    "LOGIN_INFO", "PREF", "VISITOR_INFO1_LIVE", "VISITOR_PRIVACY_METADATA",
    "__Secure-YEC", "YSC",
}

HEADER = "# Netscape HTTP Cookie File\n"


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: python make_cookie_env.py <path-to-cookies.txt>")
        return 1

    path = sys.argv[1]
    kept_lines = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if line.startswith("#") or not line.strip():
                continue
            parts = line.rstrip("\n").split("\t")
            if len(parts) == 7 and parts[5] in KEEP:
                kept_lines.append(line.rstrip("\n"))

    if not kept_lines:
        print("No matching auth cookies found. Are you logged into YouTube?")
        return 1

    trimmed = HEADER + "\n".join(kept_lines) + "\n"
    encoded = base64.b64encode(gzip.compress(trimmed.encode("utf-8"))).decode()

    print(f"Kept {len(kept_lines)} cookies. Encoded length: {len(encoded)} chars\n")
    print("Set this as YTDLP_COOKIES_CONTENT in Railway:\n")
    print(encoded)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
