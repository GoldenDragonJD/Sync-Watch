import urllib.parse

import requests
from flask import Flask, Response, jsonify, request, send_file
from flask_socketio import SocketIO, emit

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*")

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
    "Referer": "https://allmanga.to",
}
API_URL = "https://api.allanime.day/api"


@app.route("/proxy")
def proxy():
    target_url = request.args.get("url")
    if not target_url:
        return "No URL provided", 400

    # Base headers to bypass the 403 Forbidden blocks
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
        "Referer": "https://allmanga.to",
    }

    # --- THE SEEKING FIX ---
    # If the browser is trying to seek, it will send a 'Range' header.
    # We MUST catch it and forward it to the anime server.
    range_header = request.headers.get("Range", None)
    if range_header:
        headers["Range"] = range_header

    # Fetch the data
    req = requests.get(target_url, headers=headers, stream=True)

    # 1. Handle HLS Playlist (.m3u8) Rewriting
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
        # Stream in chunks so we don't blow up the server RAM
        for chunk in req.iter_content(chunk_size=1024 * 1024):
            if chunk:
                yield chunk

    # --- THE SEEKING RESPONSE FIX ---
    # We must pass the specific headers back to the browser so it knows
    # the server successfully handled the byte-range request.
    response_headers = {
        "Content-Type": req.headers.get("Content-Type", "video/mp4"),
        "Accept-Ranges": "bytes",  # Tells the browser "Yes, you can seek!"
    }

    # If the anime server responded with partial content (a chunk of the video),
    # we pass those specific length/range details back to the browser.
    if "Content-Range" in req.headers:
        response_headers["Content-Range"] = req.headers["Content-Range"]
    if "Content-Length" in req.headers:
        response_headers["Content-Length"] = req.headers["Content-Length"]

    # req.status_code will be 206 if it's a partial chunk, or 200 if it's the full file.
    return Response(generate(), status=req.status_code, headers=response_headers)


def search_anime(query, mode="sub"):
    search_gql = """
    query( $search: SearchInput $limit: Int $page: Int $translationType: VaildTranslationTypeEnumType $countryOrigin: VaildCountryOriginEnumType ) {
        shows( search: $search limit: $limit page: $page translationType: $translationType countryOrigin: $countryOrigin ) {
            edges { _id name availableEpisodes __typename }
        }
    }
    """

    payload = {
        "variables": {
            "search": {"allowAdult": False, "allowUnknown": False, "query": query},
            "limit": 40,
            "page": 1,
            "translationType": mode,
            "countryOrigin": "ALL",
        },
        "query": search_gql,
    }

    response = requests.post(API_URL, json=payload, headers=HEADERS)
    data = response.json()

    # Returns a list of dictionaries containing _id, name, and episode counts!
    return data["data"]["shows"]["edges"]


def get_episodes(show_id):
    episodes_list_gql = """
    query ($showId: String!) {
        show( _id: $showId ) { _id availableEpisodesDetail }
    }
    """

    payload = {"variables": {"showId": show_id}, "query": episodes_list_gql}

    response = requests.post(API_URL, json=payload, headers=HEADERS)
    data = response.json()

    # Depending on 'sub' or 'dub', this returns the list of available episode numbers
    return data["data"]["show"]["availableEpisodesDetail"]


def get_embed_urls(show_id, episode_string, mode="sub"):
    episode_embed_gql = """
    query ($showId: String!, $translationType: VaildTranslationTypeEnumType!, $episodeString: String!) {
        episode( showId: $showId translationType: $translationType episodeString: $episodeString ) {
            episodeString sourceUrls
        }
    }
    """

    payload = {
        "variables": {
            "showId": show_id,
            "translationType": mode,
            "episodeString": str(episode_string),
        },
        "query": episode_embed_gql,
    }

    response = requests.post(API_URL, json=payload, headers=HEADERS)
    return response.json()


def decrypt_source_url(encrypted_str):
    # Remove the starting "--"
    if encrypted_str.startswith("--"):
        encrypted_str = encrypted_str[2:]

    # The exact cipher mapped from the ani-cli bash script
    cipher_map = {
        "79": "A",
        "7a": "B",
        "7b": "C",
        "7c": "D",
        "7d": "E",
        "7e": "F",
        "7f": "G",
        "70": "H",
        "71": "I",
        "72": "J",
        "73": "K",
        "74": "L",
        "75": "M",
        "76": "N",
        "77": "O",
        "68": "P",
        "69": "Q",
        "6a": "R",
        "6b": "S",
        "6c": "T",
        "6d": "U",
        "6e": "V",
        "6f": "W",
        "60": "X",
        "61": "Y",
        "62": "Z",
        "59": "a",
        "5a": "b",
        "5b": "c",
        "5c": "d",
        "5d": "e",
        "5e": "f",
        "5f": "g",
        "50": "h",
        "51": "i",
        "52": "j",
        "53": "k",
        "54": "l",
        "55": "m",
        "56": "n",
        "57": "o",
        "48": "p",
        "49": "q",
        "4a": "r",
        "4b": "s",
        "4c": "t",
        "4d": "u",
        "4e": "v",
        "4f": "w",
        "40": "x",
        "41": "y",
        "42": "z",
        "08": "0",
        "09": "1",
        "0a": "2",
        "0b": "3",
        "0c": "4",
        "0d": "5",
        "0e": "6",
        "0f": "7",
        "00": "8",
        "01": "9",
        "15": "-",
        "16": ".",
        "67": "_",
        "46": "~",
        "02": ":",
        "17": "/",
        "07": "?",
        "1b": "#",
        "63": "[",
        "65": "]",
        "78": "@",
        "19": "!",
        "1c": "$",
        "1e": "&",
        "10": "(",
        "11": ")",
        "12": "*",
        "13": "+",
        "14": ",",
        "03": ";",
        "05": "=",
        "1d": "%",
    }

    decrypted = ""
    for i in range(0, len(encrypted_str), 2):
        pair = encrypted_str[i : i + 2]
        # FIXED: Added the += assignment
        decrypted += cipher_map.get(pair, pair)

    return decrypted.replace("/clock", "/clock.json")


def get_actual_video_link(decoded_path):
    # 1. Format the URL correctly depending on what the cipher returned
    if decoded_path.startswith("http"):
        final_url = decoded_path
    elif decoded_path.startswith("//"):
        final_url = f"https:{decoded_path}"
    else:
        final_url = f"https://allanime.day{decoded_path}"

    if "clock.json" not in final_url:
        return final_url

    response = requests.get(final_url, headers=HEADERS)

    if response.status_code != 200:
        return None

    try:
        data = response.json()
        if "links" in data and len(data["links"]) > 0:
            # Try to find a 1080p link first
            for link_obj in data["links"]:
                if "1080" in str(link_obj.get("resolutionStr", "")):
                    return link_obj["link"]
            # If no 1080p, try 720p
            for link_obj in data["links"]:
                if "720" in str(link_obj.get("resolutionStr", "")):
                    return link_obj["link"]

            # Fallback to the first available link
            return data["links"][0]["link"]
    except Exception as e:
        print(f"Error parsing JSON: {e}")

    return None


@app.route("/")
def hello_world():
    return send_file("Public/Static/index.html", mimetype="text/html")


@app.route("/style")
def style():
    return send_file("Public/Static/style.css", mimetype="text/css")


@app.route("/logic")
def logic():
    return send_file("Public/Static/logic.js", mimetype="text/javascript")


@app.route("/api/search/<anime>")
def search(anime):
    mode = request.args.get("mode", "sub")
    results = search_anime(anime, mode)
    return jsonify(results)


@app.route("/api/<show_id>/episodes")
def show(show_id):
    results = get_episodes(show_id)
    return jsonify(results)


@app.route("/api/embed/<show_id>/<episode_string>")
def embed(show_id, episode_string):
    mode = request.args.get("mode", "sub")
    results = get_embed_urls(show_id, episode_string, mode)
    return jsonify(results)


@app.route("/api/stream/<show_id>/<episode_string>")
def get_stream(show_id, episode_string):
    mode = request.args.get("mode", "sub")

    # 1. Get the list of embed URLs for this episode
    embed_data = get_embed_urls(show_id, episode_string, mode)

    # Safety check: make sure we got valid data back
    if "data" not in embed_data or "episode" not in embed_data["data"]:
        return jsonify({"error": "Could not fetch episode data"}), 404

    source_urls = embed_data["data"]["episode"]["sourceUrls"]

    # 2. Hunt for the best provider (Luf-Mp4 or Yt-mp4 are best for raw links)
    target_encrypted_url = None
    for source in source_urls:
        name = source.get("sourceName")
        url = source.get("sourceUrl", "")

        if name in ["Luf-Mp4", "Yt-mp4", "S-mp4"] and url.startswith("--"):
            target_encrypted_url = url
            break  # We found a good one, stop looking

    if not target_encrypted_url:
        return jsonify({"error": "No raw stream provider found for this episode."}), 404

    # 3. Decrypt the URL
    decoded_path = decrypt_source_url(target_encrypted_url)

    # 4. Fetch the final .m3u8 link
    final_video_link = get_actual_video_link(decoded_path)

    if final_video_link:
        return jsonify({"status": "success", "stream_url": final_video_link})
    else:
        return jsonify({"error": "Failed to extract final video link."}), 500


@app.route("/api/schedule")
def get_schedule():
    day = request.args.get("day")

    # Jikan v4 schedule endpoint takes a 'filter' parameter for the day of the week
    jikan_url = "https://api.jikan.moe/v4/schedules"

    # If a day was provided, append it to the query
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


@socketio.on("search_action")
def handle_search_sync(data):
    # Broadcast the search query to everyone ELSE in the room
    emit("receive_search", data, broadcast=True, include_self=False)


@socketio.on("play_action")
def handle_play_sync(data):
    emit("receive_play", data, broadcast=True, include_self=False)


@socketio.on("pause_action")
def handle_pause_sync(data):
    emit("receive_pause", data, broadcast=True, include_self=False)


@socketio.on("seek_action")
def handle_seek_sync(data):
    emit("receive_seek", data, broadcast=True, include_self=False)


@socketio.on("load_show_action")
def handle_load_show_sync(data):
    # Syncs clicking a show card from the search results
    emit("receive_load_show", data, broadcast=True, include_self=False)


@socketio.on("load_episode_action")
def handle_load_episode_sync(data):
    # Syncs clicking a specific episode number button
    emit("receive_load_episode", data, broadcast=True, include_self=False)


@socketio.on("back_action")
def handle_back_sync():
    # Syncs clicking the "Back to Search" button
    emit("receive_back", broadcast=True, include_self=False)


if __name__ == "__main__":
    socketio.run(app, debug=True, host="0.0.0.0", port=5000)
