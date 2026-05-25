import base64
import time
import urllib.parse

import requests
from flask import Flask, Response, jsonify, request, send_file
from flask_socketio import SocketIO, emit

# ==========================================
# anipy-cli (anipy-api) Integration
# ==========================================
provider = None
HAS_ANIPY = False
Anime = None
LANG_SUB = "sub"
LANG_DUB = "dub"

try:
    from anipy_api.anime import Anime

    try:
        from anipy_api.provider import LanguageTypeEnum

        LANG_SUB = LanguageTypeEnum.SUB
        LANG_DUB = LanguageTypeEnum.DUB
    except ImportError:
        pass

    from anipy_api.provider import list_providers

    available_providers = list(list_providers())

    # FIX 1: Aggressively hunt for AllAnime by checking the underlying Python Module and Class names
    for p_class in available_providers:
        c_name = getattr(p_class, "__name__", "").lower()
        m_name = getattr(p_class, "__module__", "").lower()

        if "allanime" in c_name or "allanime" in m_name:
            provider = p_class()
            break

    # FIX 2: If AllAnime is broken/missing, fallback to AnimeKai but forcefully spoof AJAX headers
    if provider is None:
        for p_class in available_providers:
            c_name = getattr(p_class, "__name__", "").lower()
            m_name = getattr(p_class, "__module__", "").lower()

            if "animekai" in c_name or "animekai" in m_name:
                provider = p_class()
                # AnimeKai strictly requires these AJAX headers to bypass the 403 Forbidden block
                if hasattr(provider, "session"):
                    provider.session.headers.update(
                        {
                            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                            "Accept": "application/json, text/javascript, */*; q=0.01",
                            "X-Requested-With": "XMLHttpRequest",
                            "Referer": "https://animekai.to/",
                        }
                    )
                break

    # Failsafe
    if provider is None and available_providers:
        for p_class in available_providers:
            if "native" not in getattr(p_class, "__name__", "").lower():
                provider = p_class()
                break

    if provider is not None:
        HAS_ANIPY = True
        actual_name = getattr(provider.__class__, "__name__", "Unknown")
        print(f"Successfully loaded anipy-api provider: {actual_name}")
    else:
        print(
            "WARNING: anipy-api provider could not be loaded. No online providers found."
        )

except ImportError as e:
    print(f"WARNING: anipy-api modules not found: {e}")
except Exception as e:
    print(f"ERROR initializing provider: {e}")


app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*")

# General headers for bypass if needed
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
}


@app.route("/proxy")
def proxy():
    target_url = request.args.get("url")
    if not target_url:
        return "No URL provided", 400

    # FIX: Added the specific Referer back so the video server allows the connection!
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://allmanga.to",
    }

    # Pass the seeking header to the target
    range_header = request.headers.get("Range", None)
    if range_header:
        headers["Range"] = range_header

    req = requests.get(target_url, headers=headers, stream=True)

    # 1. Handle HLS Playlist (.m3u8) Rewriting for CORS bypassing
    if (
        ".m3u8" in target_url
        or "mpegurl" in req.headers.get("Content-Type", "").lower()
    ):
        content = req.text
        new_lines = []
        base_url = target_url.rsplit("/", 1)[0]

        for line in content.splitlines():
            if line.startswith("#") or not line.strip():
                new_lines.append(line)
            else:
                if line.startswith("http"):
                    segment_url = line
                else:
                    segment_url = f"{base_url}/{line}"
                encoded_url = urllib.parse.quote(segment_url)
                new_lines.append(f"/proxy?url={encoded_url}")

        return Response("\n".join(new_lines), mimetype="application/vnd.apple.mpegurl")

    # 2. Handle Video Data (Chunks or MP4)
    def generate():
        for chunk in req.iter_content(chunk_size=1024 * 1024):
            if chunk:
                yield chunk

    response_headers = {
        "Content-Type": req.headers.get("Content-Type", "video/mp4"),
        "Accept-Ranges": "bytes",
    }

    if "Content-Range" in req.headers:
        response_headers["Content-Range"] = req.headers["Content-Range"]
    if "Content-Length" in req.headers:
        response_headers["Content-Length"] = req.headers["Content-Length"]

    return Response(generate(), status=req.status_code, headers=response_headers)


# ==========================================
# New Scraping Logic using anipy-api
# ==========================================


def search_anime(query, mode="sub"):
    if not HAS_ANIPY or not provider:
        return [
            {
                "name": "Error: anipy-api provider failed to load",
                "_id": "",
                "availableEpisodes": {"sub": "?", "dub": "?"},
            }
        ]

    search_query = f"{query} dub" if mode == "dub" else query
    print(f"--- Searching for: {search_query} ---")

    try:
        search_results = provider.get_search(search_query)
        formatted_results = []

        for res in search_results:
            _id = None
            name = "Unknown"
            eps_sub = "?"
            eps_dub = "?"

            if isinstance(res, dict):
                _id = (
                    res.get("url")
                    or res.get("slug")
                    or res.get("id")
                    or res.get("identifier")
                    or res.get("link")
                )
                name = res.get("name") or res.get("title") or "Unknown"
                av_eps = res.get("availableEpisodes", {})
                if isinstance(av_eps, dict):
                    eps_sub = av_eps.get("sub", "?")
                    eps_dub = av_eps.get("dub", "?")
                else:
                    eps_sub = res.get("episodes", "?")

            else:
                _id = (
                    getattr(res, "url", None)
                    or getattr(res, "slug", None)
                    or getattr(res, "id", None)
                    or getattr(res, "identifier", None)
                    or getattr(res, "link", None)
                )
                name = (
                    getattr(res, "name", None)
                    or getattr(res, "title", None)
                    or "Unknown"
                )

                av_eps = getattr(res, "availableEpisodes", None)
                if isinstance(av_eps, dict):
                    eps_sub = av_eps.get("sub", "?")
                    eps_dub = av_eps.get("dub", "?")
                else:
                    eps_sub = getattr(
                        res, "episodes", getattr(res, "episode_count", "?")
                    )

                if not _id and hasattr(res, "__dict__"):
                    d = vars(res)
                    _id = d.get("url") or d.get("slug") or d.get("id") or d.get("link")
                    name = d.get("name") or d.get("title") or name
                    av_eps_d = d.get("availableEpisodes", {})
                    if isinstance(av_eps_d, dict):
                        eps_sub = av_eps_d.get("sub", "?")
                        eps_dub = av_eps_d.get("dub", "?")
                    else:
                        eps_sub = d.get("episodes", eps_sub)

            if not _id:
                clean_name = (
                    str(name)
                    .lower()
                    .replace(" ", "-")
                    .replace(":", "")
                    .replace("!", "")
                    .replace("'", "")
                    .replace(",", "")
                )
                _id = f"/category/{clean_name}"

            safe_id = base64.urlsafe_b64encode(str(_id).encode("utf-8")).decode("utf-8")
            safe_id = safe_id.rstrip("=")

            formatted_results.append(
                {
                    "_id": safe_id,
                    "name": str(name),
                    "availableEpisodes": {"sub": eps_sub, "dub": eps_dub},
                    "__typename": "Anime",
                }
            )

        if not formatted_results:
            print("WARNING: Provider returned an empty list for this query.")

        return formatted_results
    except Exception as e:
        print(f"Search Error: {e}")
        return []


def get_episodes(show_id):
    if not HAS_ANIPY or not provider or not Anime:
        return {"sub": [], "dub": []}

    try:
        padded_id = show_id + "=" * (-len(show_id) % 4)
        try:
            real_id = base64.urlsafe_b64decode(padded_id.encode("utf-8")).decode(
                "utf-8"
            )
        except:
            real_id = show_id

        print(f"--- Fetching episodes for decoded ID: {real_id} ---")

        anime = Anime(provider, real_id, real_id, "Unknown")
        eps = anime.get_episodes(lang=LANG_SUB)

        if not eps:
            eps = anime.get_episodes()

        ep_numbers = []
        if eps:
            ep_numbers = [str(getattr(ep, "number", i + 1)) for i, ep in enumerate(eps)]

        return {"sub": ep_numbers, "dub": ep_numbers}
    except Exception as e:
        print(f"Episodes Error: {e}")
        return {"sub": [], "dub": []}


def get_stream_for_episode(show_id, episode_string, mode="sub"):
    if not HAS_ANIPY or not provider or not Anime:
        return None

    try:
        padded_id = show_id + "=" * (-len(show_id) % 4)
        try:
            real_id = base64.urlsafe_b64decode(padded_id.encode("utf-8")).decode(
                "utf-8"
            )
        except:
            real_id = show_id

        anime = Anime(provider, real_id, real_id, "Unknown")
        lang = LANG_DUB if mode == "dub" else LANG_SUB

        try:
            ep_num = float(episode_string)
            if ep_num.is_integer():
                ep_num = int(ep_num)
        except ValueError:
            ep_num = episode_string

        stream = anime.get_video(episode=ep_num, lang=lang, preferred_quality=1080)

        if stream:
            return getattr(stream, "url", None)

        stream = anime.get_video(episode=ep_num, lang=lang)
        if stream:
            return getattr(stream, "url", None)

        return None
    except Exception as e:
        print(f"Stream Error: {e}")
        return None


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


@app.route("/api/embed/<path:show_id>/<episode_string>")
def embed(show_id, episode_string):
    mode = request.args.get("mode", "sub")
    stream_url = get_stream_for_episode(show_id, episode_string, mode)

    if stream_url:
        return jsonify(
            {
                "data": {
                    "episode": {
                        "sourceUrls": [
                            {"sourceName": "anipy-cli GoGo", "sourceUrl": stream_url}
                        ]
                    }
                }
            }
        )
    return jsonify({"error": "No embed found"}), 404


@app.route("/api/stream/<path:show_id>/<episode_string>")
def get_stream(show_id, episode_string):
    mode = request.args.get("mode", "sub")
    final_video_link = get_stream_for_episode(show_id, episode_string, mode)

    if final_video_link:
        return jsonify({"status": "success", "stream_url": final_video_link})
    else:
        return jsonify(
            {"error": "Failed to extract final video link using anipy-cli provider."}
        ), 500


@app.route("/api/schedule")
def get_schedule():
    day = request.args.get("day")
    jikan_url = "https://api.jikan.moe/v4/schedules"
    if day:
        jikan_url += f"?filter={day.lower()}&sfw=false"

    try:
        response = requests.get(jikan_url)
        if response.status_code == 200:
            return jsonify(response.json())
        else:
            return jsonify({"error": "Failed to fetch schedule from Jikan"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ==========================================
# Socket.IO Event Handlers & Sync Logic
# ==========================================

clients = {}
room_was_buffering = False
sync_cooldown_until = 0.0  # NEW: The Heartbeat Shield timer


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
    """Clients send this back every time the server sends a heartbeat."""
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

    # Priority 1: Sync browsing users into active show
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

    # Priority 2: Buffering handling
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

    # === COOLDOWN SHIELD ===
    if time.time() < sync_cooldown_until:
        return

    # Gather states
    playing_clients = [
        sid for sid, c in watching_clients.items() if c.get("video_state") == "playing"
    ]
    paused_clients = [
        sid for sid, c in watching_clients.items() if c.get("video_state") == "paused"
    ]

    # 🔥 FIX: DO NOT FORCE PAUSE ON MINOR MISMATCH
    # Only act if LARGE disagreement persists

    if len(playing_clients) > 0 and len(paused_clients) > 0:
        # Wait for natural resolution instead of forcing pause
        return

    # Priority 4: Time desync correction ONLY (no pause spam)
    if len(watching_clients) > 1 and len(playing_clients) == len(watching_clients):
        times = [(sid, c.get("time", 0.0)) for sid, c in watching_clients.items()]
        times.sort(key=lambda x: x[1])

        lowest_sid, lowest_time = times[0]
        highest_sid, highest_time = times[-1]

        time_diff = highest_time - lowest_time

        if time_diff > 3.0:
            # 🔥 FIX: Instead of pausing, gently resync time
            socketio.emit(
                "sync_correction",
                {"action": "resync_time", "target_time": lowest_time},
                to=highest_sid,
            )
            return


def heartbeat_loop():
    """Sends a ping every 1 second to all clients asking for their state."""
    while True:
        socketio.sleep(1)
        socketio.emit("request_heartbeat")


socketio.start_background_task(heartbeat_loop)


# ==========================================
# Explicit UI and Media Sync Broadcasts
# ==========================================


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


if __name__ == "__main__":
    socketio.run(app, debug=True, host="0.0.0.0", port=5000)
