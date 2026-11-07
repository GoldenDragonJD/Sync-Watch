import base64
import datetime
import hashlib
import html
import ipaddress
import json
import os
import re
import socket
import sqlite3
import ssl
import threading
import time
import urllib.parse
import requests
from flask import Flask, Response, jsonify, request, send_file
from flask_socketio import SocketIO, emit

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "seasonal_cache.db")
SQL_FILE_PATH = os.path.join(BASE_DIR, "anime_servers.sql")
IMAGE_CACHE_DIR = os.path.join(BASE_DIR, "image_cache")
os.makedirs(IMAGE_CACHE_DIR, exist_ok=True)
db_lock = threading.Lock()

# Image cache in-memory tracking & policies
# Normal expiry: 24 hours. Startup expiry for unaccessed images: 12 hours.
IMAGE_EXPIRY_SECONDS = 24 * 3600
STARTUP_EXPIRY_SECONDS = 12 * 3600
image_cache_lock = threading.Lock()
server_start_time = time.time()
# Maps url_hash -> {"path": local_filepath, "expires_at": float_timestamp, "remote_url": str}
image_cache_index = {}


def init_image_cache_on_startup():
    """
    On server restart: scans existing images on disk in image_cache/
    and assigns a 12-hour grace timer. If an image is not accessed or refreshed
    within 12 hours of this restart, it will be automatically removed.
    """
    with image_cache_lock:
        if not os.path.exists(IMAGE_CACHE_DIR):
            return
        now = time.time()
        for fname in os.listdir(IMAGE_CACHE_DIR):
            fpath = os.path.join(IMAGE_CACHE_DIR, fname)
            if not os.path.isfile(fpath):
                continue
            name_part, _ = os.path.splitext(fname)
            image_cache_index[name_part] = {
                "path": fpath,
                "expires_at": now + STARTUP_EXPIRY_SECONDS,
                "remote_url": None,
            }


def touch_cached_image(url_hash):
    """
    When an image is requested/called, reset its timer to 24 hours.
    """
    with image_cache_lock:
        entry = image_cache_index.get(url_hash)
        if entry:
            entry["expires_at"] = time.time() + IMAGE_EXPIRY_SECONDS


def refresh_cached_images_for_urls(remote_urls):
    """
    When an anime check occurs and the anime is still active, reset the timer
    to 24 hours for all its associated images so active anime posters stay cached.
    """
    if not remote_urls:
        return
    now = time.time()
    with image_cache_lock:
        for url in remote_urls:
            if not url or not isinstance(url, str) or not url.startswith("http"):
                continue
            h = hashlib.sha256(url.encode("utf-8")).hexdigest()
            entry = image_cache_index.get(h)
            if entry:
                entry["expires_at"] = now + IMAGE_EXPIRY_SECONDS


def cleanup_expired_images():
    """
    Removes cached images whose timer has expired.
    """
    now = time.time()
    to_delete = []
    with image_cache_lock:
        for h, entry in list(image_cache_index.items()):
            if now >= entry["expires_at"]:
                to_delete.append((h, entry["path"]))
                del image_cache_index[h]

    for h, path in to_delete:
        try:
            if os.path.exists(path):
                os.remove(path)
        except Exception as e:
            print(f"Error removing expired image {path}: {e}")


def image_cleanup_loop():
    """
    Background worker that runs cleanup periodically (every 10 minutes).
    """
    while True:
        try:
            cleanup_expired_images()
        except Exception as e:
            print(f"Error in image cleanup worker: {e}")
        time.sleep(600)

# ==========================================
# ani-cli (hianime.at) Configuration & Scraping
# ==========================================

BASE_API = "https://hianime.at"
SEARCH_API = f"{BASE_API}/search?keyword=%s"
EPISODES_API = f"{BASE_API}/api/theme/episode/list/%s"
SERVERS_API = f"{BASE_API}/api/theme/episode/servers?episodeId=%s"
FILTER_API = f"{BASE_API}/filter?season=%s&sy=%s"
AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"


def sni_split_https_get(url, headers=None, timeout=10):
    """
    Fallback HTTPS fetcher that splits the TLS ClientHello across two TCP segments
    so network SNI filters (e.g. on zokoanime.video) do not intercept the handshake.
    """
    parsed = urllib.parse.urlparse(url)
    host = parsed.hostname
    port = parsed.port or 443
    path = parsed.path or "/"
    if parsed.query:
        path += f"?{parsed.query}"

    ctx = ssl.create_default_context()
    sock = socket.create_connection((host, port), timeout=timeout)
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

    in_bio = ssl.MemoryBIO()
    out_bio = ssl.MemoryBIO()
    sslobj = ctx.wrap_bio(in_bio, out_bio, server_hostname=host)

    try:
        sslobj.do_handshake()
    except ssl.SSLWantReadError:
        hello = out_bio.read()
        host_bytes = host.encode("ascii")
        idx = hello.find(host_bytes)
        split_at = (idx + len(host_bytes) // 2) if idx != -1 else (len(hello) // 2)
        sock.sendall(hello[:split_at])
        time.sleep(0.04)
        sock.sendall(hello[split_at:])

    while True:
        try:
            sslobj.do_handshake()
            break
        except ssl.SSLWantReadError:
            out_data = out_bio.read()
            if out_data:
                sock.sendall(out_data)
            in_data = sock.recv(8192)
            if not in_data:
                sock.close()
                raise EOFError(f"EOF during TLS handshake with {host}")
            in_bio.write(in_data)

    req_headers = {
        "Host": host,
        "User-Agent": AGENT,
        "Accept": "*/*",
        "Accept-Encoding": "identity",
        "Connection": "close",
    }
    if headers:
        for k, v in headers.items():
            if v is not None:
                req_headers[k] = v

    header_lines = "".join(f"{k}: {v}\r\n" for k, v in req_headers.items())
    raw_req = f"GET {path} HTTP/1.1\r\n{header_lines}\r\n".encode("utf-8")
    sslobj.write(raw_req)
    sock.sendall(out_bio.read())

    resp_bytes = b""
    while True:
        try:
            chunk = sslobj.read(16384)
            if not chunk:
                break
            resp_bytes += chunk
        except ssl.SSLWantReadError:
            in_data = sock.recv(16384)
            if not in_data:
                break
            in_bio.write(in_data)
        except ssl.SSLZeroReturnError:
            break
    sock.close()

    if b"\r\n\r\n" not in resp_bytes:
        return ""
    header_part, body = resp_bytes.split(b"\r\n\r\n", 1)
    if b"transfer-encoding: chunked" in header_part.lower():
        decoded_body = b""
        while body:
            line_end = body.find(b"\r\n")
            if line_end == -1:
                break
            size_str = body[:line_end].split(b";")[0].strip()
            try:
                chunk_size = int(size_str, 16)
            except ValueError:
                break
            if chunk_size == 0:
                break
            start = line_end + 2
            decoded_body += body[start : start + chunk_size]
            body = body[start + chunk_size + 2 :]
        body = decoded_body

    return body.decode("utf-8", errors="replace")


def hianime_curl(url, referer=None, timeout=10):
    """
    Port of ani-cli's hianime_curl.
    """
    headers = {"User-Agent": AGENT}
    if referer:
        headers["Referer"] = referer

    try:
        resp = requests.get(url, headers=headers, timeout=timeout)
        if resp.status_code // 100 != 2 and "just a moment" not in resp.text.lower():
            raise RuntimeError(f"Request failed: HTTP {resp.status_code} from {url}")
        return resp.text
    except requests.exceptions.SSLError:
        return sni_split_https_get(url, headers=headers, timeout=timeout)


def b64_decode(s):
    """
    Port of ani-cli's b64_decode.
    """
    if not s:
        return b""
    s = s.strip()
    padding = "=" * (-len(s) % 4)
    try:
        return base64.b64decode(s + padding)
    except Exception:
        return b""


def deobfuscate_blob(blob):
    """
    Port of ani-cli's deobfuscate_blob:
    The embed page ships its config as base64(json XOR "otaku-embed-v1").
    """
    raw_bytes = b64_decode(blob)
    if not raw_bytes:
        return ""
    key = [111, 116, 97, 107, 117, 45, 101, 109, 98, 101, 100, 45, 118, 49]
    out_bytes = bytes(b ^ key[i % len(key)] for i, b in enumerate(raw_bytes))
    return out_bytes.decode("utf-8", errors="replace")


def select_quality(links, quality="best"):
    """
    Port of ani-cli's select_quality:
    links is a list of (resolution_int, resolution_label, url) sorted descending.
    """
    if not links:
        return None
    if quality == "best":
        return links[0][2]
    if quality == "worst":
        return links[-1][2]
    for res_int, res_label, url in links:
        if str(quality) in res_label or str(quality) == str(res_int):
            return url
    return links[0][2]


class BaseAnimeServer:
    name = "base"

    def search(self, query):
        raise NotImplementedError

    def get_episodes(self, server_code):
        raise NotImplementedError

    def get_stream(self, server_code, ep_no, mode="sub", quality="best"):
        raise NotImplementedError

    def get_seasonal(self, year, season):
        return []


class HiAnimeServer(BaseAnimeServer):
    """
    Anime server implementation ported directly from ani-cli (hianime.at).
    """

    name = "hianime"

    def _parse_flw_items(self, page_html):
        if "<title>just a moment" in page_html.lower():
            raise RuntimeError("Blocked by Cloudflare on hianime.at")

        # Cut off #main-sidebar before parsing results, just like ani-cli:
        # sed '/id="main-sidebar"/,$d'
        main_content = page_html.split('id="main-sidebar"')[0]
        results = []

        # Parse each .flw-item card to extract slug, title, alt name (data-jname), and sub/dub counts
        items = re.split(r'<div class="flw-item[^"]*">', main_content)[1:]
        for item in items:
            m_link = re.search(
                r'<h3 class="film-name">\s*<a href="[^"]*/([^"/]*)"\s*title="([^"]*)"([^>]*)>',
                item,
                re.DOTALL,
            )
            if not m_link:
                continue

            slug = m_link.group(1).strip()
            raw_title = m_link.group(2)
            extra_attrs = m_link.group(3) or ""

            title = html.unescape(raw_title).strip()
            alt_names = [title]

            m_jname = re.search(r'data-jname="([^"]*)"', extra_attrs)
            if m_jname:
                jname = html.unescape(m_jname.group(1)).strip()
                if jname and jname not in alt_names:
                    alt_names.append(jname)

            m_sub = re.search(
                r'tick-sub[^>]*>.*?</i\s*>\s*([0-9]+)', item, re.DOTALL
            )
            m_dub = re.search(
                r'tick-dub[^>]*>.*?</i\s*>\s*([0-9]+)', item, re.DOTALL
            )

            sub_eps = m_sub.group(1) if m_sub else "?"
            dub_eps = m_dub.group(1) if m_dub else "0"

            # Poster image (prefer lazy-load data-src if present)
            m_img = re.search(
                r'<img[^>]*?(?:data-src|src)="([^"]+)"[^>]*film-poster-img'
                r'|<img[^>]*film-poster-img[^>]*?(?:data-src|src)="([^"]+)"',
                item,
                re.DOTALL,
            )
            image = ""
            if m_img:
                image = html.unescape((m_img.group(1) or m_img.group(2) or "").strip())
                allow_image_url(image)

            results.append(
                {
                    "server_code": slug,
                    "name": title,
                    "alt_names": alt_names,
                    "sub": sub_eps,
                    "dub": dub_eps,
                    "image": image,
                }
            )

        return results

    def search(self, query):
        """
        Port of ani-cli's hianime_search.
        """
        encoded_q = urllib.parse.quote_plus(query.strip())
        page = hianime_curl(SEARCH_API % encoded_q)
        return self._parse_flw_items(page)

    def get_episodes_map(self, server_code):
        """
        Port of ani-cli's hianime_episodes.
        Returns list of (ep_id, ep_no) tuples for the given server_code (slug).
        """
        num_id = server_code.rsplit("-", 1)[-1]
        page = hianime_curl(EPISODES_API % num_id)
        cleaned = page.replace("\\", "")
        chunks = cleaned.split("ep-item")[1:]
        pattern = re.compile(
            r'data-number="([^"]*)".*?data-id="([0-9]+)".*?/watch/'
            + re.escape(server_code)
            + r"\?ep=",
            re.DOTALL,
        )
        ep_map = []
        for chunk in chunks:
            m = pattern.search(chunk)
            if m:
                ep_no, ep_id = m.group(1), m.group(2)
                ep_map.append((ep_id, ep_no))
        return ep_map

    def get_episodes(self, server_code, cached_dub_count=None):
        ep_map = self.get_episodes_map(server_code)
        ep_numbers = [ep_no for _, ep_no in ep_map]
        dub_numbers = ep_numbers
        if cached_dub_count is not None and str(cached_dub_count).isdigit():
            dub_int = int(cached_dub_count)
            if 0 <= dub_int < len(ep_numbers):
                dub_numbers = ep_numbers[:dub_int]
        return {"sub": ep_numbers, "dub": dub_numbers}

    def get_stream(self, server_code, ep_no, mode="sub", quality="best"):
        """
        Port of ani-cli's hianime_m3u8 & get_video_link.
        """
        ep_map = self.get_episodes_map(server_code)
        ep_id = None
        for cid, cno in ep_map:
            if str(cno) == str(ep_no):
                ep_id = cid
                break

        if not ep_id:
            return None

        servers_raw = hianime_curl(SERVERS_API % ep_id).replace('\\"', '"')
        server_chunks = servers_raw.split("server-item")[1:]

        # Find ZokoAnime server hash for requested mode (sub/dub)
        target_hash = None
        hash_pattern = re.compile(
            r'data-type="'
            + re.escape(mode)
            + r'".*?data-server-name="ZokoAnime".*?data-hash="([^"]*)"',
            re.DOTALL,
        )
        for chunk in server_chunks:
            m = hash_pattern.search(chunk)
            if m:
                target_hash = m.group(1)
                break

        if not target_hash:
            return None

        embed_url = b64_decode(target_hash).decode("utf-8", errors="ignore").strip()
        if not embed_url:
            return None

        m_refr = re.match(r"^(https?://[^/]*)", embed_url)
        refr = (m_refr.group(1) + "/") if m_refr else "https://zokoanime.video/"

        m_mal = re.search(r"/mal/([0-9]+)/", embed_url)
        mal_id = int(m_mal.group(1)) if m_mal else None

        embed_page = hianime_curl(embed_url, referer=BASE_API + "/")
        m_blob = re.search(r'window\.__P="([^"]*)"', embed_page)
        if not m_blob:
            return None

        json_str = deobfuscate_blob(m_blob.group(1))
        if not json_str:
            return None

        try:
            embed_data = json.loads(json_str)
        except Exception:
            embed_data = {}

        m3u8_master = embed_data.get("src")
        if not m3u8_master:
            m_src = re.search(r'"src":"([^"]*\.m3u8[^"]*)"', json_str)
            if m_src:
                m3u8_master = m_src.group(1)

        if not m3u8_master:
            return None

        # Extract default subtitle link (and full subtitles list)
        sub_link = None
        subtitles = embed_data.get("subtitles") or []
        for sub in subtitles:
            if isinstance(sub, dict) and sub.get("default") and sub.get("src"):
                sub_link = sub["src"]
                break
        if not sub_link and subtitles:
            for sub in subtitles:
                if (
                    isinstance(sub, dict)
                    and "en" in str(sub.get("lang", "")).lower()
                    and sub.get("src")
                ):
                    sub_link = sub["src"]
                    break

        # Parse master playlist variants just like ani-cli
        playlist_text = hianime_curl(m3u8_master, referer=refr)
        base_master = m3u8_master.rsplit("/", 1)[0]

        links = []
        lines = [line.strip() for line in playlist_text.splitlines() if line.strip()]
        for i, line in enumerate(lines):
            if line.startswith("#EXT-X-STREAM-INF") and "EXT-X-I-FRAME" not in line:
                m_res = re.search(r"RESOLUTION=\d+x(\d+)", line)
                res_height = int(m_res.group(1)) if m_res else 0
                res_label = f"{res_height}p" if res_height else "auto"
                if i + 1 < len(lines) and not lines[i + 1].startswith("#"):
                    variant_url = lines[i + 1]
                    if not variant_url.startswith("http"):
                        variant_url = f"{base_master}/{variant_url}"
                    links.append((res_height, res_label, variant_url))

        links.sort(key=lambda x: x[0], reverse=True)

        # Check if separate audio track is specified in master playlist (ani-cli 5.1.6)
        has_separate_audio = any(
            line.startswith("#EXT-X-MEDIA:TYPE=AUDIO") and "URI=" in line
            for line in lines
        )

        selected_link = (
            m3u8_master
            if has_separate_audio or not links
            else select_quality(links, quality)
        )

        return {
            "url": selected_link,
            "master_url": m3u8_master,
            "referrer": refr,
            "sub_url": sub_link if mode == "sub" else None,
            "subtitles": subtitles,
            "mal_id": mal_id,
            "skip": embed_data.get("skip"),
        }

    SEASON_DATE_RANGES = {
        "winter": (1, 1, 3, 31),
        "spring": (3, 1, 6, 30),
        "summer": (6, 1, 9, 30),
        "fall": (9, 1, 12, 31),
    }

    def _fetch_paginated_filter(self, query_params, max_pages=15):
        all_items = []
        for page_num in range(1, max_pages + 1):
            url = f"{BASE_API}/filter?{query_params}&page={page_num}"
            page_html = hianime_curl(url)
            items = self._parse_flw_items(page_html)
            if not items:
                break
            all_items.extend(items)
            if f"page={page_num + 1}" not in page_html:
                break
        return all_items

    def get_seasonal(self, year, season):
        season_clean = str(season).strip().lower()
        if season_clean not in ("spring", "summer", "fall", "winter"):
            season_clean = "fall"
        yr = int(year)
        sm, sd, em, ed = self.SEASON_DATE_RANGES[season_clean]

        # 1. Fetch all pages matching the season's start-date window (catches shows missing season tags like Black Clover Season 2)
        date_query = (
            f"sy={yr}&sm={sm}&sd={sd}&ey={yr}&em={em}&ed={ed}&sort=updated_date"
        )
        date_items = self._fetch_paginated_filter(date_query)

        # 2. Fetch all pages explicitly tagged with the season on hianime.at
        season_query = f"season={season_clean}&sy={yr}&ey={yr}&sort=updated_date"
        season_items = self._fetch_paginated_filter(season_query)

        combined = []
        seen_codes = set()
        for item in date_items + season_items:
            code = item.get("server_code")
            if code and code not in seen_codes:
                seen_codes.add(code)
                combined.append(item)

        # Prefer entries that have aired episodes available; fall back to all if previewing a future un-aired season
        aired_items = [
            item
            for item in combined
            if not (item.get("sub", "?") == "?" and item.get("dub", "0") in ("0", "?"))
        ]
        return aired_items if aired_items else combined


# Registry of anime servers (supports multiple servers)
ANIME_SERVERS = {
    "hianime": HiAnimeServer(),
}


def register_anime_server(server_instance):
    ANIME_SERVERS[server_instance.name] = server_instance


# ==========================================
# SQL Database & Name / Alt-Name Indexing
# ==========================================


def normalize_name(name):
    if not name:
        return ""
    cleaned = re.sub(r"\s+", " ", str(name).strip().lower())
    return cleaned


def init_db():
    with db_lock:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute(
            """CREATE TABLE IF NOT EXISTS seasonal_cache
               (year INTEGER, season TEXT, data TEXT, last_updated REAL,
                PRIMARY KEY (year, season))"""
        )

        if os.path.exists(SQL_FILE_PATH):
            with open(SQL_FILE_PATH, "r", encoding="utf-8") as f:
                sql_script = f.read()
            c.executescript(sql_script)
        else:
            c.executescript(
                """
                PRAGMA foreign_keys = ON;
                CREATE TABLE IF NOT EXISTS anime (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    mal_id INTEGER,
                    sub_episodes TEXT DEFAULT '?',
                    dub_episodes TEXT DEFAULT '?',
                    last_updated REAL
                );
                CREATE TABLE IF NOT EXISTS anime_alt_names (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    anime_id INTEGER NOT NULL,
                    alt_name TEXT NOT NULL,
                    normalized_name TEXT NOT NULL,
                    UNIQUE(anime_id, normalized_name),
                    FOREIGN KEY(anime_id) REFERENCES anime(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_anime_alt_names_norm ON anime_alt_names(normalized_name);
                CREATE TABLE IF NOT EXISTS anime_server_codes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    anime_id INTEGER NOT NULL,
                    anime_name TEXT NOT NULL,
                    server_name TEXT NOT NULL,
                    server_code TEXT NOT NULL,
                    last_updated REAL,
                    UNIQUE(anime_id, server_name),
                    FOREIGN KEY(anime_id) REFERENCES anime(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_anime_server_codes_name ON anime_server_codes(anime_name, server_name);
                """
            )
        conn.commit()
        conn.close()


def _sql_quote(val):
    if val is None:
        return "NULL"
    if isinstance(val, (int, float)):
        return str(val)
    escaped = str(val).replace("'", "''")
    return f"'{escaped}'"


def sync_sql_file_locked(conn):
    """
    Exports the current anime, alternative names, and server code mappings
    to anime_servers.sql so the SQL file stays up to date on disk.
    Must be called while holding db_lock.
    """
    c = conn.cursor()
    lines = [
        "-- SQL schema and mappings for Name / Alternative Names -> Server -> Server Code",
        "PRAGMA foreign_keys = ON;",
        "",
        "CREATE TABLE IF NOT EXISTS anime (",
        "    id INTEGER PRIMARY KEY AUTOINCREMENT,",
        "    name TEXT NOT NULL UNIQUE,",
        "    mal_id INTEGER,",
        "    sub_episodes TEXT DEFAULT '?',",
        "    dub_episodes TEXT DEFAULT '?',",
        "    last_updated REAL",
        ");",
        "",
        "CREATE TABLE IF NOT EXISTS anime_alt_names (",
        "    id INTEGER PRIMARY KEY AUTOINCREMENT,",
        "    anime_id INTEGER NOT NULL,",
        "    alt_name TEXT NOT NULL,",
        "    normalized_name TEXT NOT NULL,",
        "    UNIQUE(anime_id, normalized_name),",
        "    FOREIGN KEY(anime_id) REFERENCES anime(id) ON DELETE CASCADE",
        ");",
        "",
        "CREATE INDEX IF NOT EXISTS idx_anime_alt_names_norm ON anime_alt_names(normalized_name);",
        "",
        "CREATE TABLE IF NOT EXISTS anime_server_codes (",
        "    id INTEGER PRIMARY KEY AUTOINCREMENT,",
        "    anime_id INTEGER NOT NULL,",
        "    anime_name TEXT NOT NULL,",
        "    server_name TEXT NOT NULL,",
        "    server_code TEXT NOT NULL,",
        "    last_updated REAL,",
        "    UNIQUE(anime_id, server_name),",
        "    FOREIGN KEY(anime_id) REFERENCES anime(id) ON DELETE CASCADE",
        ");",
        "",
        "CREATE INDEX IF NOT EXISTS idx_anime_server_codes_name ON anime_server_codes(anime_name, server_name);",
        "",
    ]

    c.execute(
        "SELECT id, name, mal_id, sub_episodes, dub_episodes, last_updated FROM anime ORDER BY id"
    )
    anime_rows = c.fetchall()
    if anime_rows:
        lines.append("-- Anime entries")
        for r in anime_rows:
            lines.append(
                f"INSERT OR REPLACE INTO anime (id, name, mal_id, sub_episodes, dub_episodes, last_updated) "
                f"VALUES ({_sql_quote(r[0])}, {_sql_quote(r[1])}, {_sql_quote(r[2])}, {_sql_quote(r[3])}, {_sql_quote(r[4])}, {_sql_quote(r[5])});"
            )
        lines.append("")

    c.execute(
        "SELECT anime_id, alt_name, normalized_name FROM anime_alt_names ORDER BY anime_id, id"
    )
    alt_rows = c.fetchall()
    if alt_rows:
        lines.append("-- Alternative names")
        for r in alt_rows:
            lines.append(
                f"INSERT OR IGNORE INTO anime_alt_names (anime_id, alt_name, normalized_name) "
                f"VALUES ({_sql_quote(r[0])}, {_sql_quote(r[1])}, {_sql_quote(r[2])});"
            )
        lines.append("")

    c.execute(
        "SELECT anime_id, anime_name, server_name, server_code, last_updated FROM anime_server_codes ORDER BY anime_id, id"
    )
    code_rows = c.fetchall()
    if code_rows:
        lines.append("-- Server code mappings (Name -> Server -> Code)")
        for r in code_rows:
            lines.append(
                f"INSERT OR REPLACE INTO anime_server_codes (anime_id, anime_name, server_name, server_code, last_updated) "
                f"VALUES ({_sql_quote(r[0])}, {_sql_quote(r[1])}, {_sql_quote(r[2])}, {_sql_quote(r[3])}, {_sql_quote(r[4])});"
            )
        lines.append("")

    with open(SQL_FILE_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


def save_anime_mappings_batch(entries):
    """
    Saves a batch of anime entries into the SQL database and updates anime_servers.sql.
    Each entry in `entries` is a dict:
      {
        "name": str,
        "alt_names": list[str],
        "server_name": str,
        "server_code": str,
        "sub": str,
        "dub": str,
        "mal_id": int | None
      }
    Returns a list of canonical anime names corresponding to the entries.
    """
    if not entries:
        return []

    now = time.time()
    canonical_names = []

    with db_lock:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()

        for item in entries:
            primary_name = str(item.get("name", "")).strip()
            if not primary_name:
                canonical_names.append("")
                continue

            alt_list = list(item.get("alt_names") or [])
            if primary_name not in alt_list:
                alt_list.insert(0, primary_name)

            server_name = item.get("server_name")
            server_code = item.get("server_code")
            sub_eps = str(item.get("sub", "?"))
            dub_eps = str(item.get("dub", "?"))
            mal_id = item.get("mal_id")

            # 1. Try to find existing anime by primary name or any alt_name
            anime_id = None
            canonical_name = primary_name

            c.execute("SELECT id, name FROM anime WHERE LOWER(name) = LOWER(?)", (primary_name,))
            row = c.fetchone()
            if row:
                anime_id, canonical_name = row[0], row[1]
            else:
                for alt in alt_list:
                    norm = normalize_name(alt)
                    if not norm:
                        continue
                    c.execute(
                        """SELECT a.id, a.name
                           FROM anime a
                           JOIN anime_alt_names an ON a.id = an.anime_id
                           WHERE an.normalized_name = ?
                           LIMIT 1""",
                        (norm,),
                    )
                    row = c.fetchone()
                    if row:
                        anime_id, canonical_name = row[0], row[1]
                        break

            # 2. Insert or update anime row
            existing = None
            if anime_id is None:
                c.execute(
                    """INSERT INTO anime (name, mal_id, sub_episodes, dub_episodes, last_updated)
                       VALUES (?, ?, ?, ?, ?)""",
                    (primary_name, mal_id, sub_eps, dub_eps, now),
                )
                anime_id = c.lastrowid
                canonical_name = primary_name
            else:
                c.execute(
                    "SELECT mal_id, sub_episodes, dub_episodes FROM anime WHERE id = ?",
                    (anime_id,),
                )
                existing = c.fetchone()
                new_mal = mal_id if mal_id is not None else (existing[0] if existing else None)
                new_sub = sub_eps if sub_eps != "?" else (existing[1] if existing else "?")
                new_dub = dub_eps if dub_eps not in ("?", "0") else (existing[2] if existing else dub_eps)
                c.execute(
                    """UPDATE anime
                       SET mal_id = ?, sub_episodes = ?, dub_episodes = ?, last_updated = ?
                       WHERE id = ?""",
                    (new_mal, new_sub, new_dub, now, anime_id),
                )

            # 3. Insert all alternative names
            for alt in alt_list:
                alt_clean = str(alt).strip()
                norm = normalize_name(alt_clean)
                if alt_clean and norm:
                    c.execute(
                        """INSERT OR IGNORE INTO anime_alt_names (anime_id, alt_name, normalized_name)
                           VALUES (?, ?, ?)""",
                        (anime_id, alt_clean, norm),
                    )

            # 4. Insert or update server -> code mapping
            if server_name and server_code:
                has_new_eps = (sub_eps != "?") or (dub_eps not in ("?", "0"))
                had_existing_eps = existing is not None and (
                    (existing[1] and existing[1] != "?")
                    or (existing[2] and existing[2] not in ("?", "0"))
                )
                if had_existing_eps and not has_new_eps:
                    c.execute(
                        """INSERT OR IGNORE INTO anime_server_codes (anime_id, anime_name, server_name, server_code, last_updated)
                           VALUES (?, ?, ?, ?, ?)""",
                        (anime_id, canonical_name, server_name, str(server_code), now),
                    )
                else:
                    c.execute(
                        """INSERT INTO anime_server_codes (anime_id, anime_name, server_name, server_code, last_updated)
                           VALUES (?, ?, ?, ?, ?)
                           ON CONFLICT(anime_id, server_name) DO UPDATE SET
                               anime_name = excluded.anime_name,
                               server_code = excluded.server_code,
                               last_updated = excluded.last_updated""",
                        (anime_id, canonical_name, server_name, str(server_code), now),
                    )

            canonical_names.append(canonical_name)

        conn.commit()
        sync_sql_file_locked(conn)
        conn.close()

    return canonical_names


def lookup_anime_in_db(name_or_alt):
    """
    Looks up an anime by its canonical name, any of its alternative names,
    or (for backward compatibility) an existing server_code.
    Returns a dict with anime metadata and `{server_name: server_code}` mappings, or None.
    """
    if not name_or_alt:
        return None

    clean_query = re.sub(r"\((?:Sub|Dub)\)", "", str(name_or_alt), flags=re.IGNORECASE).strip()
    norm = normalize_name(clean_query)

    with db_lock:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()

        # 1. Exact match on anime.name or anime_alt_names.normalized_name
        c.execute(
            """SELECT a.id, a.name, a.mal_id, a.sub_episodes, a.dub_episodes
               FROM anime a
               LEFT JOIN anime_alt_names an ON a.id = an.anime_id
               WHERE LOWER(a.name) = LOWER(?) OR an.normalized_name = ?
               LIMIT 1""",
            (clean_query, norm),
        )
        row = c.fetchone()

        # 2. Fallback: match by server_code if a legacy slug/code was passed
        if not row:
            c.execute(
                """SELECT a.id, a.name, a.mal_id, a.sub_episodes, a.dub_episodes
                   FROM anime a
                   JOIN anime_server_codes sc ON a.id = sc.anime_id
                   WHERE sc.server_code = ?
                   LIMIT 1""",
                (str(name_or_alt).strip(),),
            )
            row = c.fetchone()

        if not row:
            conn.close()
            return None

        anime_id, canonical_name, mal_id, sub_eps, dub_eps = row

        c.execute(
            "SELECT alt_name FROM anime_alt_names WHERE anime_id = ? ORDER BY id",
            (anime_id,),
        )
        alt_names = [r[0] for r in c.fetchall()]

        c.execute(
            "SELECT server_name, server_code FROM anime_server_codes WHERE anime_id = ?",
            (anime_id,),
        )
        servers = {r[0]: r[1] for r in c.fetchall()}

        conn.close()

        return {
            "id": anime_id,
            "name": canonical_name,
            "mal_id": mal_id,
            "sub_episodes": sub_eps,
            "dub_episodes": dub_eps,
            "alt_names": alt_names,
            "servers": servers,
        }


def search_db_anime(query):
    """
    Searches the local SQL database by name or alternative names.
    """
    norm = f"%{normalize_name(query)}%"
    with db_lock:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute(
            """SELECT DISTINCT a.id, a.name, a.sub_episodes, a.dub_episodes
               FROM anime a
               LEFT JOIN anime_alt_names an ON a.id = an.anime_id
               WHERE LOWER(a.name) LIKE ? OR an.normalized_name LIKE ?
               LIMIT 30""",
            (norm, norm),
        )
        rows = c.fetchall()
        results = []
        for r in rows:
            c.execute("SELECT alt_name FROM anime_alt_names WHERE anime_id = ?", (r[0],))
            alts = [ar[0] for ar in c.fetchall()]
            results.append(
                {
                    "_id": r[1],
                    "name": r[1],
                    "alt_names": alts,
                    "availableEpisodes": {"sub": str(r[2] or "?"), "dub": str(r[3] or "?")},
                    "__typename": "Anime",
                }
            )
        conn.close()
        return results


def resolve_anime_servers(anime_name):
    """
    Resolves an anime name (or alternative name) to its SQL record and server codes.
    If any active server does not yet have a server_code mapped for this anime,
    searches that server by the anime name, stores the mapping in SQL, and returns it.
    """
    record = lookup_anime_in_db(anime_name)
    target_name = record["name"] if record else str(anime_name).strip()
    norm_target = normalize_name(target_name)

    missing_servers = [
        srv
        for srv_name, srv in ANIME_SERVERS.items()
        if not record or srv_name not in record["servers"]
    ]

    if missing_servers:
        new_mappings = []
        for srv in missing_servers:
            try:
                search_results = srv.search(target_name)
                if not search_results:
                    continue

                # Prefer exact match on name or alt_names, otherwise take top result
                chosen = None
                for item in search_results:
                    candidates = [item["name"]] + list(item.get("alt_names") or [])
                    if any(normalize_name(c) == norm_target for c in candidates):
                        chosen = item
                        break
                if not chosen:
                    chosen = search_results[0]

                # Keep target_name as canonical if record already existed
                entry_name = record["name"] if record else chosen["name"]
                alt_names = list(chosen.get("alt_names") or [])
                if target_name not in alt_names:
                    alt_names.append(target_name)

                new_mappings.append(
                    {
                        "name": entry_name,
                        "alt_names": alt_names,
                        "server_name": srv.name,
                        "server_code": chosen["server_code"],
                        "sub": chosen.get("sub", "?"),
                        "dub": chosen.get("dub", "?"),
                    }
                )
            except Exception as e:
                print(f"Auto-mapping search error on {srv.name} for '{target_name}': {e}")

        if new_mappings:
            save_anime_mappings_batch(new_mappings)
            record = lookup_anime_in_db(target_name) or lookup_anime_in_db(anime_name)

    return record


# ==========================================
# Core Anime Backend Functions
# ==========================================


def search_anime(query, mode="sub"):
    print(f"--- Searching for: {query} ---")
    combined_by_name = {}
    batch_to_save = []

    for srv_name, srv in ANIME_SERVERS.items():
        try:
            srv_results = srv.search(query)
            for item in srv_results:
                batch_to_save.append(
                    {
                        "name": item["name"],
                        "alt_names": item.get("alt_names", [item["name"]]),
                        "server_name": srv_name,
                        "server_code": item["server_code"],
                        "sub": item.get("sub", "?"),
                        "dub": item.get("dub", "?"),
                        "image": item.get("image", ""),
                    }
                )
        except Exception as e:
            print(f"Search error on server '{srv_name}': {e}")

    if batch_to_save:
        canonical_names = save_anime_mappings_batch(batch_to_save)
        for item, c_name in zip(batch_to_save, canonical_names):
            final_name = c_name or item["name"]
            if final_name not in combined_by_name:
                combined_by_name[final_name] = {
                    "_id": final_name,
                    "name": final_name,
                    "alt_names": item.get("alt_names", [final_name]),
                    "availableEpisodes": {
                        "sub": str(item.get("sub", "?")),
                        "dub": str(item.get("dub", "?")),
                    },
                    "image": item.get("image", ""),
                    "__typename": "Anime",
                }

    if combined_by_name:
        return list(combined_by_name.values())

    # Fallback to searching local SQL database if live servers failed or returned nothing
    return search_db_anime(query)


def get_episodes(anime_name):
    record = resolve_anime_servers(anime_name)
    if not record or not record.get("servers"):
        return {"sub": [], "dub": []}

    for srv_name, srv in ANIME_SERVERS.items():
        server_code = record["servers"].get(srv_name)
        if not server_code:
            continue
        try:
            print(
                f"--- Fetching episodes for '{record['name']}' -> {srv_name} -> {server_code} ---"
            )
            if isinstance(srv, HiAnimeServer):
                eps = srv.get_episodes(
                    server_code, cached_dub_count=record.get("dub_episodes")
                )
            else:
                eps = srv.get_episodes(server_code)
            if eps and (eps.get("sub") or eps.get("dub")):
                return eps
        except Exception as e:
            print(f"Episodes error on {srv_name} ({server_code}): {e}")

    return {"sub": [], "dub": []}


def get_stream_for_episode(anime_name, episode_string, mode="sub"):
    record = resolve_anime_servers(anime_name)
    if not record or not record.get("servers"):
        return None

    for srv_name, srv in ANIME_SERVERS.items():
        server_code = record["servers"].get(srv_name)
        if not server_code:
            continue
        try:
            print(
                f"--- Fetching stream for '{record['name']}' ep {episode_string} ({mode}) -> {srv_name} -> {server_code} ---"
            )
            stream_data = srv.get_stream(server_code, episode_string, mode=mode)
            if stream_data and stream_data.get("url"):
                allow_stream_url(stream_data.get("url"))
                allow_stream_url(stream_data.get("master_url"))
                allow_stream_url(stream_data.get("sub_url"))
                for sub_item in stream_data.get("subtitles") or []:
                    if isinstance(sub_item, dict):
                        allow_stream_url(sub_item.get("src"))
                if stream_data.get("mal_id") and not record.get("mal_id"):
                    save_anime_mappings_batch(
                        [
                            {
                                "name": record["name"],
                                "alt_names": record.get("alt_names", [record["name"]]),
                                "server_name": srv_name,
                                "server_code": server_code,
                                "sub": record.get("sub_episodes", "?"),
                                "dub": record.get("dub_episodes", "?"),
                                "mal_id": stream_data["mal_id"],
                            }
                        ]
                    )
                return stream_data
        except Exception as e:
            print(f"Stream error on {srv_name} ({server_code}): {e}")

    return None


# ==========================================
# Proxy Security & SSRF Protection
# ==========================================

proxy_security_lock = threading.Lock()
ALLOWED_STREAM_HOSTS = {
    "dramahot.top",
    "hls.dramahot.top",
    "zokoanime.video",
}
ALLOWED_IMAGE_HOSTS = {
    "anipixcdn.co",
    "cdn.anipixcdn.co",
    "myanimelist.net",
    "cdn.myanimelist.net",
    "hianime.at",
    "noitatnemucod.net",
    "cdn.noitatnemucod.net",
}
MAX_IMAGE_BYTES = 10 * 1024 * 1024  # 10 MB cap per cached poster image
MAX_PLAYLIST_BYTES = 5 * 1024 * 1024  # 5 MB cap for .m3u8 / .vtt text payloads
SAFE_IMAGE_MIMETYPES = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/avif": ".avif",
}
SAFE_STREAM_MIMETYPES = {
    "video/mp2t",
    "video/mp4",
    "video/webm",
    "video/x-matroska",
    "audio/aac",
    "audio/mpeg",
    "audio/mp4",
    "application/octet-stream",
    "binary/octet-stream",
}
SECURITY_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
}


def _extract_clean_host(url):
    if not url or not isinstance(url, str):
        return None
    try:
        parsed = urllib.parse.urlparse(url.strip())
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            return None
        return parsed.hostname.lower().rstrip(".")
    except Exception:
        return None


def allow_stream_url(url):
    host = _extract_clean_host(url)
    if host:
        with proxy_security_lock:
            ALLOWED_STREAM_HOSTS.add(host)


def allow_image_url(url):
    host = _extract_clean_host(url)
    if host:
        with proxy_security_lock:
            ALLOWED_IMAGE_HOSTS.add(host)


def _is_host_in_allowlist(host, allowlist):
    with proxy_security_lock:
        snapshot = set(allowlist)
    for allowed in snapshot:
        if host == allowed or host.endswith("." + allowed):
            return True
    return False


def validate_public_http_url(url, allowed_hosts=None):
    """
    Validates that `url` is a standard public HTTP/HTTPS URL on port 80/443,
    matches `allowed_hosts` (if provided), and resolves exclusively to global
    public unicast IP addresses (blocking localhost, LAN, link-local, multicast,
    and reserved ranges against SSRF and DNS rebinding).
    """
    if not url or not isinstance(url, str):
        return False, "Missing URL"
    url = url.strip()
    if any(ch in url for ch in ("\r", "\n", "\x00")):
        return False, "Invalid characters in URL"

    try:
        parsed = urllib.parse.urlparse(url)
    except Exception:
        return False, "Malformed URL"

    if parsed.scheme not in ("http", "https"):
        return False, "Only http and https URLs are permitted"
    if parsed.username or parsed.password:
        return False, "Credentials in URL are not permitted"
    if not parsed.hostname:
        return False, "Missing hostname"

    try:
        port = parsed.port
    except ValueError:
        return False, "Invalid port"
    if port is not None and port not in (80, 443):
        return False, "Non-standard ports are not permitted"

    host = parsed.hostname.lower().rstrip(".")
    if host in ("localhost", "localhost.localdomain") or host.endswith(
        (".local", ".internal", ".lan", ".home", ".arpa")
    ):
        return False, "Local hostnames are not permitted"

    if allowed_hosts is not None and not _is_host_in_allowlist(host, allowed_hosts):
        return False, "Host is not in the allowed proxy list"

    effective_port = port or (443 if parsed.scheme == "https" else 80)
    try:
        addr_info = socket.getaddrinfo(
            host, effective_port, proto=socket.IPPROTO_TCP
        )
    except Exception:
        return False, "DNS resolution failed"

    if not addr_info:
        return False, "No DNS records found"

    for entry in addr_info:
        ip_str = entry[4][0]
        try:
            ip_obj = ipaddress.ip_address(ip_str)
        except ValueError:
            return False, "Invalid IP address"
        if (
            ip_obj.is_private
            or ip_obj.is_loopback
            or ip_obj.is_link_local
            or ip_obj.is_multicast
            or ip_obj.is_reserved
            or ip_obj.is_unspecified
            or not ip_obj.is_global
        ):
            return False, "Private or non-global IP addresses are forbidden"

    return True, None


def safe_upstream_get(url, headers=None, timeout=15, allowed_hosts=None, max_redirects=3):
    """
    Performs an HTTP GET with SSRF & host-allowlist validation on the initial
    URL and every redirect hop (`allow_redirects=False`).
    Returns `(response, final_url)` or raises `PermissionError` / `RuntimeError`.
    """
    current_url = url.strip()
    for _ in range(max_redirects + 1):
        ok, reason = validate_public_http_url(current_url, allowed_hosts=allowed_hosts)
        if not ok:
            raise PermissionError(reason)

        req = requests.get(
            current_url,
            headers=headers,
            stream=True,
            timeout=timeout,
            allow_redirects=False,
        )
        if req.status_code in (301, 302, 303, 307, 308):
            loc = req.headers.get("Location")
            req.close()
            if not loc:
                raise RuntimeError("Redirect missing Location header")
            current_url = urllib.parse.urljoin(current_url, loc.strip())
            # If the initial URL was on an allowed host, allow the redirect target only if it is public
            allowed_hosts = None
            continue

        return req, current_url

    raise RuntimeError("Too many redirects")


def _read_bounded_bytes(req, max_bytes):
    chunks = []
    total = 0
    for chunk in req.iter_content(chunk_size=65536):
        if chunk:
            total += len(chunk)
            if total > max_bytes:
                raise ValueError("Upstream response exceeded size limit")
            chunks.append(chunk)
    return b"".join(chunks)


# ==========================================
# Proxy Route (HLS .m3u8, Subtitles .vtt, Video Chunks)
# ==========================================


@app.route("/proxy")
def proxy():
    target_url = request.args.get("url")
    referrer = request.args.get("ref")
    if not target_url:
        return "No URL provided", 400

    safe_ref = "https://zokoanime.video/"
    if referrer:
        ok_ref, _ = validate_public_http_url(referrer)
        if ok_ref:
            safe_ref = referrer.strip()

    headers = {
        "User-Agent": AGENT,
        "Referer": safe_ref,
    }

    range_header = request.headers.get("Range", None)
    if range_header and re.match(r"^bytes=\d*-\d*(,\s*\d*-\d*)*$", range_header):
        headers["Range"] = range_header

    try:
        req, final_url = safe_upstream_get(
            target_url,
            headers=headers,
            timeout=15,
            allowed_hosts=ALLOWED_STREAM_HOSTS,
        )
    except PermissionError as e:
        return f"Forbidden proxy target: {e}", 403
    except Exception:
        return "Upstream request failed", 502

    content_type = req.headers.get("Content-Type", "").split(";")[0].strip().lower()
    lower_url = urllib.parse.urlparse(final_url).path.lower()

    # 1. Handle WebVTT Subtitles
    if lower_url.endswith(".vtt") or content_type == "text/vtt":
        try:
            body = _read_bounded_bytes(req, MAX_PLAYLIST_BYTES)
        except ValueError:
            return "Subtitle file too large", 502
        finally:
            req.close()
        return Response(
            body,
            status=req.status_code,
            mimetype="text/vtt",
            headers=dict(SECURITY_HEADERS),
        )

    # 2. Handle HLS Playlist (.m3u8) Rewriting
    if lower_url.endswith(".m3u8") or "mpegurl" in content_type:
        try:
            raw_bytes = _read_bounded_bytes(req, MAX_PLAYLIST_BYTES)
        except ValueError:
            return "Playlist too large", 502
        finally:
            req.close()

        content = raw_bytes.decode("utf-8", errors="replace")
        new_lines = []

        def make_proxy_url(raw_url):
            full_url = urllib.parse.urljoin(final_url, raw_url.strip())
            allow_stream_url(full_url)
            encoded_url = urllib.parse.quote(full_url, safe="")
            proxied = f"/proxy?url={encoded_url}"
            if referrer:
                proxied += f"&ref={urllib.parse.quote(safe_ref, safe='')}"
            return proxied

        for line in content.splitlines():
            stripped = line.strip()
            if not stripped:
                new_lines.append(line)
            elif stripped.startswith("#"):
                # Rewrite URI="..." attributes inside #EXT-X-MEDIA, #EXT-X-KEY, #EXT-X-MAP
                if 'URI="' in line:
                    line = re.sub(
                        r'URI="([^"]+)"',
                        lambda m: f'URI="{make_proxy_url(m.group(1))}"',
                        line,
                    )
                new_lines.append(line)
            else:
                new_lines.append(make_proxy_url(stripped))

        return Response(
            "\n".join(new_lines),
            mimetype="application/vnd.apple.mpegurl",
            headers=dict(SECURITY_HEADERS),
        )

    # 3. Block dangerous non-media content types (e.g. text/html, image/svg+xml, javascript)
    if content_type in (
        "text/html",
        "application/xhtml+xml",
        "image/svg+xml",
        "text/javascript",
        "application/javascript",
        "application/x-javascript",
    ):
        req.close()
        return "Forbidden upstream content type", 403

    out_content_type = (
        content_type if content_type in SAFE_STREAM_MIMETYPES else "video/mp2t"
    )

    # 4. Stream Video Segments / MP4
    def generate():
        try:
            for chunk in req.iter_content(chunk_size=1024 * 512):
                if chunk:
                    yield chunk
        finally:
            req.close()

    response_headers = {
        **SECURITY_HEADERS,
        "Content-Type": out_content_type,
        "Accept-Ranges": "bytes",
    }
    if "Content-Range" in req.headers:
        response_headers["Content-Range"] = req.headers["Content-Range"]
    if "Content-Length" in req.headers:
        response_headers["Content-Length"] = req.headers["Content-Length"]

    return Response(generate(), status=req.status_code, headers=response_headers)


@app.route("/api/image_proxy")
def image_proxy():
    raw_url = request.args.get("url")
    if not raw_url:
        return "Missing url parameter", 400

    raw_url = raw_url.strip()
    h = hashlib.sha256(raw_url.encode("utf-8")).hexdigest()

    # Determine extension from url or default to .jpg
    ext = ".jpg"
    parsed_path = urllib.parse.urlparse(raw_url).path
    candidate_ext = os.path.splitext(parsed_path)[1].lower()
    if candidate_ext in [".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]:
        ext = candidate_ext

    cache_file = os.path.join(IMAGE_CACHE_DIR, f"{h}{ext}")

    # Check if cached and valid
    now = time.time()
    with image_cache_lock:
        entry = image_cache_index.get(h)
        if entry and os.path.exists(entry["path"]):
            # Reset the timer to 24 hours whenever called!
            entry["expires_at"] = now + IMAGE_EXPIRY_SECONDS
            cached_path = entry["path"]
        elif os.path.exists(cache_file):
            image_cache_index[h] = {
                "path": cache_file,
                "expires_at": now + IMAGE_EXPIRY_SECONDS,
                "remote_url": raw_url,
            }
            cached_path = cache_file
        else:
            cached_path = None

    if cached_path and os.path.exists(cached_path):
        resp = send_file(cached_path)
        for k, v in SECURITY_HEADERS.items():
            resp.headers[k] = v
        return resp

    # Validate URL against SSRF & image host allowlist before fetching
    try:
        headers = {
            "User-Agent": AGENT,
            "Referer": "https://hianime.at/",
        }
        resp, _ = safe_upstream_get(
            raw_url,
            headers=headers,
            timeout=10,
            allowed_hosts=ALLOWED_IMAGE_HOSTS,
        )
    except PermissionError as e:
        return f"Forbidden image URL: {e}", 403
    except Exception as e:
        print(f"Error fetching image for proxy ({raw_url}): {e}")
        return "Image fetch failed", 502

    try:
        if resp.status_code != 200:
            return f"Failed to retrieve image: status {resp.status_code}", 502

        ct = resp.headers.get("Content-Type", "").split(";")[0].strip().lower()
        if ct and ct not in SAFE_IMAGE_MIMETYPES:
            return "Unsupported image content type", 403

        ext = SAFE_IMAGE_MIMETYPES.get(ct, ext)
        img_bytes = _read_bounded_bytes(resp, MAX_IMAGE_BYTES)
        if not img_bytes:
            return "Empty image response", 502

        final_cache_file = os.path.join(IMAGE_CACHE_DIR, f"{h}{ext}")
        with open(final_cache_file, "wb") as f:
            f.write(img_bytes)

        with image_cache_lock:
            image_cache_index[h] = {
                "path": final_cache_file,
                "expires_at": now + IMAGE_EXPIRY_SECONDS,
                "remote_url": raw_url,
            }

        return Response(
            img_bytes,
            mimetype=ct if ct in SAFE_IMAGE_MIMETYPES else "image/jpeg",
            headers=dict(SECURITY_HEADERS),
        )
    except ValueError:
        return "Image exceeds maximum allowed size", 413
    except Exception as e:
        print(f"Error saving proxied image ({raw_url}): {e}")
        return "Image fetch failed", 500
    finally:
        resp.close()


# ==========================================
# Routes
# ==========================================


@app.route("/")
def hello_world():
    return send_file("Public/Static/index.html", mimetype="text/html")


@app.route("/style")
def style():
    return send_file("Public/Static/style.css", mimetype="text/css")


@app.route("/logic")
def logic():
    return send_file("Public/Static/logic.js", mimetype="text/javascript")


@app.route("/api/search/<path:anime>")
def search(anime):
    mode = request.args.get("mode", "sub")
    results = search_anime(anime, mode)
    return jsonify(results)


@app.route("/api/<path:show_id>/episodes")
def show(show_id):
    results = get_episodes(show_id)
    return jsonify(results)


@app.route("/api/stream/<path:show_id>/<episode_string>")
def get_stream(show_id, episode_string):
    mode = request.args.get("mode", "sub")
    stream_data = get_stream_for_episode(show_id, episode_string, mode)

    if stream_data and stream_data.get("url"):
        return jsonify(
            {
                "status": "success",
                "stream_url": stream_data["url"],
                "referrer": stream_data.get("referrer"),
                "sub_url": stream_data.get("sub_url"),
                "subtitles": stream_data.get("subtitles", []),
                "mal_id": stream_data.get("mal_id"),
                "skip": stream_data.get("skip"),
            }
        )
    else:
        return jsonify({"error": "Failed to extract streaming link."}), 500


@app.route("/api/mappings")
def get_mappings():
    """
    Returns the stored Name / Alternative Names -> Server -> Code mappings from SQL.
    """
    name_filter = request.args.get("name")
    if name_filter:
        rec = lookup_anime_in_db(name_filter)
        return jsonify({"data": [rec] if rec else []})

    with db_lock:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("SELECT id, name, mal_id, sub_episodes, dub_episodes FROM anime ORDER BY id")
        rows = c.fetchall()
        out = []
        for r in rows:
            anime_id = r[0]
            c.execute("SELECT alt_name FROM anime_alt_names WHERE anime_id = ?", (anime_id,))
            alts = [ar[0] for ar in c.fetchall()]
            c.execute(
                "SELECT server_name, server_code FROM anime_server_codes WHERE anime_id = ?",
                (anime_id,),
            )
            servers = {sr[0]: sr[1] for sr in c.fetchall()}
            out.append(
                {
                    "id": anime_id,
                    "name": r[1],
                    "mal_id": r[2],
                    "sub_episodes": r[3],
                    "dub_episodes": r[4],
                    "alt_names": alts,
                    "servers": servers,
                }
            )
        conn.close()
    return jsonify({"data": out})


# ==========================================
# Seasonal Releases & Background Updater
# ==========================================


def get_current_season():
    now = datetime.datetime.now()
    month = now.month
    year = now.year
    if 3 <= month <= 5:
        season = "spring"
    elif 6 <= month <= 8:
        season = "summer"
    elif 9 <= month <= 11:
        season = "fall"
    else:
        season = "winter"
    return year, season


def fetch_and_cache_season(year, season_str):
    season_clean = str(season_str).strip().lower()
    batch_to_save = []

    for srv_name, srv in ANIME_SERVERS.items():
        try:
            items = srv.get_seasonal(year, season_clean)
            for item in items:
                batch_to_save.append(
                    {
                        "name": item["name"],
                        "alt_names": item.get("alt_names", [item["name"]]),
                        "server_name": srv_name,
                        "server_code": item["server_code"],
                        "sub": item.get("sub", "?"),
                        "dub": item.get("dub", "?"),
                        "image": item.get("image", ""),
                    }
                )
        except Exception as e:
            print(f"Seasonal fetch error on {srv_name} for {season_clean} {year}: {e}")

    formatted_results = []
    if batch_to_save:
        canonical_names = save_anime_mappings_batch(batch_to_save)
        seen = set()
        for item, c_name in zip(batch_to_save, canonical_names):
            final_name = c_name or item["name"]
            if final_name in seen:
                continue
            seen.add(final_name)
            formatted_results.append(
                {
                    "_id": final_name,
                    "name": final_name,
                    "alt_names": item.get("alt_names", [final_name]),
                    "availableEpisodes": {
                        "sub": str(item.get("sub", "?")),
                        "dub": str(item.get("dub", "?")),
                    },
                    "image": item.get("image", ""),
                }
            )

        with db_lock:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute(
                "INSERT OR REPLACE INTO seasonal_cache (year, season, data, last_updated) VALUES (?, ?, ?, ?)",
                (int(year), season_clean, json.dumps(formatted_results), time.time()),
            )
            conn.commit()
            conn.close()

        # Reset expiry timer for cached images of active seasonal anime
        all_image_urls = [it.get("image") for it in formatted_results if it.get("image")]
        refresh_cached_images_for_urls(all_image_urls)

    return formatted_results


update_event = threading.Event()


def update_current_season_loop():
    while True:
        update_event.clear()
        try:
            year, season_str = get_current_season()
            results = fetch_and_cache_season(year, season_str)
            if results:
                print(
                    f"Successfully cached {len(results)} seasonal anime for {season_str} {year}."
                )
        except Exception as e:
            print(f"Error in background season updater: {e}")

        update_event.wait(3600)


@app.route("/api/seasonal/force_update", methods=["POST"])
def force_update_season():
    req_data = request.get_json(silent=True) or {}
    req_year = req_data.get("year") or request.args.get("year", type=int)
    req_season = (req_data.get("season") or request.args.get("season") or "").lower()

    curr_year, curr_season = get_current_season()
    target_year = int(req_year) if req_year else curr_year
    target_season = req_season if req_season else curr_season

    try:
        results = fetch_and_cache_season(target_year, target_season)
        update_event.set()
        return jsonify(
            {
                "status": "success",
                "message": f"Updated {len(results)} anime for {target_season} {target_year}",
                "data": results,
            }
        )
    except Exception as e:
        print(f"Force update error: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/seasonal")
def get_seasonal():
    req_year = request.args.get("year", type=int)
    req_season = request.args.get("season", "").lower()

    curr_year, curr_season = get_current_season()
    if not req_year:
        req_year = curr_year
    if not req_season:
        req_season = curr_season

    try:
        with db_lock:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute(
                "SELECT data FROM seasonal_cache WHERE year=? AND season=?",
                (req_year, req_season),
            )
            row = c.fetchone()
            conn.close()
        if row:
            cached_data = json.loads(row[0])
            # Ensure cached entries use canonical Name as _id (in case of old numeric MAL cache)
            # and include poster images (older caches predate the image field)
            if (
                cached_data
                and not all(str(item.get("_id", "")).isdigit() for item in cached_data)
                and all("image" in item for item in cached_data)
            ):
                return jsonify({"data": cached_data})
    except Exception as e:
        print(f"Cache read error: {e}")

    try:
        formatted_results = fetch_and_cache_season(req_year, req_season)
        return jsonify({"data": formatted_results})
    except Exception as e:
        print(f"Seasonal Error: {e}")
        return jsonify({"error": str(e)}), 500


# ==========================================
# Socket.IO Event Handlers & Sync Logic
# ==========================================

clients = {}
room_was_buffering = False
sync_cooldown_until = 0.0


@socketio.on("connect")
def handle_connect():
    clients[request.sid] = {
        "status": "browsing",
        "video_state": "paused",
        "time": 0.0,
        "showId": None,
        "epNum": None,
    }


@socketio.on("disconnect")
def handle_disconnect():
    clients.pop(request.sid, None)


@socketio.on("report_state")
def handle_report_state(data):
    if request.sid in clients:
        clients[request.sid].update(data)
    evaluate_room_sync()


def evaluate_room_sync():
    global room_was_buffering
    global sync_cooldown_until

    if not clients:
        return

    watching_clients = {
        sid: data for sid, data in clients.items() if data.get("status") == "watching"
    }

    if not watching_clients:
        return

    if len(watching_clients) < len(clients):
        lead = list(watching_clients.values())[0]
        for sid, data in clients.items():
            if data.get("status") == "browsing":
                socketio.emit(
                    "force_load",
                    {
                        "showId": lead["showId"],
                        "epNum": lead["epNum"],
                        "time": lead["time"],
                    },
                    to=sid,
                )
        return

    is_anyone_buffering = any(
        c.get("video_state") == "buffering" for c in watching_clients.values()
    )

    if is_anyone_buffering:
        room_was_buffering = True
        for sid, c in watching_clients.items():
            if c.get("video_state") == "playing":
                socketio.emit("sync_correction", {"action": "pause_for_buffer"}, to=sid)
        return

    if room_was_buffering and not is_anyone_buffering:
        room_was_buffering = False
        socketio.emit("sync_correction", {"action": "all_ready_play"})
        return

    if time.time() < sync_cooldown_until:
        return

    playing_clients = [
        sid for sid, c in watching_clients.items() if c.get("video_state") == "playing"
    ]
    paused_clients = [
        sid for sid, c in watching_clients.items() if c.get("video_state") == "paused"
    ]

    if len(playing_clients) > 0 and len(paused_clients) > 0:
        return

    if len(watching_clients) > 1 and len(playing_clients) == len(watching_clients):
        times = [(sid, c.get("time", 0.0)) for sid, c in watching_clients.items()]
        times.sort(key=lambda x: x[1])

        lowest_sid, lowest_time = times[0]
        highest_sid, highest_time = times[-1]

        time_diff = highest_time - lowest_time

        if time_diff > 3.0:
            socketio.emit(
                "sync_correction",
                {"action": "resync_time", "target_time": lowest_time},
                to=highest_sid,
            )
            return


def heartbeat_loop():
    while True:
        socketio.sleep(1)
        socketio.emit("request_heartbeat")


socketio.start_background_task(heartbeat_loop)


@socketio.on("search_action")
def handle_search_sync(data):
    emit("receive_search", data, broadcast=True, include_self=False)


@socketio.on("load_show_action")
def handle_load_show_sync(data):
    global sync_cooldown_until
    sync_cooldown_until = time.time() + 5.0
    emit("receive_load_show", data, broadcast=True, include_self=False)


@socketio.on("load_episode_action")
def handle_load_episode_sync(data):
    global sync_cooldown_until
    sync_cooldown_until = time.time() + 5.0
    emit("receive_load_episode", data, broadcast=True, include_self=False)


@socketio.on("back_action")
def handle_back_sync():
    emit("receive_back", broadcast=True, include_self=False)


@socketio.on("play_action")
def handle_play_sync(data):
    global sync_cooldown_until
    sync_cooldown_until = time.time() + 5.0
    emit("receive_play", data, broadcast=True, include_self=False)


@socketio.on("pause_action")
def handle_pause_sync(data):
    global sync_cooldown_until
    sync_cooldown_until = time.time() + 5.0
    emit("receive_pause", data, broadcast=True, include_self=False)


@socketio.on("seek_action")
def handle_seek_sync(data):
    global sync_cooldown_until
    sync_cooldown_until = time.time() + 5.0
    emit("receive_seek", data, broadcast=True, include_self=False)

# Initialize database and background threads for both Flask and Gunicorn
init_db()
init_image_cache_on_startup()
socketio.start_background_task(update_current_season_loop)
socketio.start_background_task(image_cleanup_loop)

if __name__ == "__main__":
    socketio.run(
        app,
        debug=os.environ.get("FLASK_DEBUG", "0") == "1",
        host="0.0.0.0",
        port=5000,
        allow_unsafe_werkzeug=True,
    )
