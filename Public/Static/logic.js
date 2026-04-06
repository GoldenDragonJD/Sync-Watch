// --- DOM Elements ---
const searchView = document.getElementById("search-view");
const watchView = document.getElementById("watch-view");
const searchForm = document.getElementById("search-form");
const searchInput = document.getElementById("search-input");
const resultsGrid = document.getElementById("results-grid");
const loadingSpinner = document.getElementById("loading-spinner");

const backBtn = document.getElementById("back-btn");
const showTitleEl = document.getElementById("current-show-title");
const episodeGrid = document.getElementById("episode-grid");
const videoPlayer = document.getElementById("video-player");
const videoOverlay = document.getElementById("video-loading-overlay");
const modeToggle = document.getElementById("dub-sub-toggle");

// --- Global State ---
let currentShowId = null;
let currentShowName = "";
let currentHlsInstance = null;
let currentEpNum = null;

// --- NEW DOM Element ---
const syncToggle = document.getElementById("sync-toggle");

// --- NEW Global Sync State (Defaults to false/off) ---
// We check localStorage. If it's explicitly "true", we turn it on.
let isSyncEnabled = localStorage.getItem("syncEnabled") === "true";
syncToggle.checked = isSyncEnabled;

// Listen for the user clicking the switch
syncToggle.addEventListener("change", (e) => {
  isSyncEnabled = e.target.checked;
  localStorage.setItem("syncEnabled", isSyncEnabled);
});

// --- Event Listeners ---
searchForm.addEventListener("submit", handleSearch);
backBtn.addEventListener("click", () => {
  updateURL("");
  showSearchView();
  if (isSyncEnabled) {
    socket.emit("back_action"); // Tell the friend's browser to go back too!
  }
});

modeToggle.addEventListener("change", () => {
  if (currentShowId) loadEpisodes(currentShowId, currentShowName, currentEpNum);
});

videoPlayer.addEventListener("timeupdate", () => {
  // Only save if we are actually watching something
  if (currentShowId && currentEpNum && videoPlayer.currentTime > 0) {
    // Creates a unique save slot like: "save_JqWBkZQZwEjhLTDC2_1"
    localStorage.setItem(
      `save_${currentShowId}_${currentEpNum}`,
      videoPlayer.currentTime,
    );
  }
});

videoOverlay.addEventListener("click", () => {
  videoOverlay.classList.add("hidden");
  videoPlayer.play();
});

// --- URL Routing & State Persistence ---
// This runs immediately when the page loads or refreshes
document.addEventListener("DOMContentLoaded", () => {
  const params = new URLSearchParams(window.location.search);
  const showId = params.get("show");
  const epNum = params.get("ep");
  const showName = params.get("name") || "Anime";

  if (showId) {
    // If the URL has data, immediately load the player!
    loadEpisodes(showId, showName, epNum);
  } else {
    showSearchView();
  }
});

// Silently updates the browser URL without refreshing the page
function updateURL(showId, showName, epNum) {
  if (!showId) {
    window.history.pushState({}, "", "/");
  } else {
    const newUrl = `/?show=${showId}&name=${encodeURIComponent(showName)}&ep=${epNum || 1}`;
    window.history.pushState({}, "", newUrl);
  }
}

// Listen for the user clicking the "Back" button on their browser/phone
window.addEventListener("popstate", () => {
  const params = new URLSearchParams(window.location.search);
  if (params.get("show")) {
    loadEpisodes(params.get("show"), params.get("name"), params.get("ep"));
  } else {
    showSearchView();
  }
});

// --- Core Functions ---

async function handleSearch(e) {
  e.preventDefault();
  const query = searchInput.value.trim();
  if (!query) return;

  if (isSyncEnabled) {
    socket.emit("search_action", { query: query });
  }

  resultsGrid.innerHTML = "";
  loadingSpinner.classList.remove("hidden");

  try {
    const res = await fetch(`/api/search/${encodeURIComponent(query)}`);
    const data = await res.json();
    renderSearchResults(data);
  } catch (err) {
    resultsGrid.innerHTML =
      '<p class="text-danger">Failed to fetch results.</p>';
  } finally {
    loadingSpinner.classList.add("hidden");
  }
}

function renderSearchResults(shows) {
  if (!shows || shows.length === 0) {
    resultsGrid.innerHTML = "<p>No shows found.</p>";
    return;
  }

  shows.forEach((show) => {
    const card = document.createElement("div");
    card.className = "card";
    const totalEps =
      show.availableEpisodes?.sub || show.availableEpisodes?.dub || "?";

    card.innerHTML = `
            <h3>${show.name}</h3>
            <p>${totalEps} Episodes Available</p>
        `;

    card.addEventListener("click", () => loadEpisodes(show._id, show.name, 1));
    resultsGrid.appendChild(card);
  });
}

async function loadEpisodes(
  showId,
  showName,
  targetEpNum = 1,
  isRemote = false,
) {
  // 1. If YOU clicked this, tell your friend's browser to do it too
  if (!isRemote) {
    if (isSyncEnabled) {
      socket.emit("load_show_action", { showId, showName, targetEpNum });
    }
  }

  currentShowId = showId;
  currentShowName = showName;
  currentEpNum = targetEpNum;

  showTitleEl.textContent = showName;
  showWatchView();
  updateURL(showId, showName, targetEpNum);

  episodeGrid.innerHTML = "<p>Loading episodes...</p>";

  try {
    const res = await fetch(`/api/${showId}/episodes`);
    const episodeData = await res.json();
    const mode = modeToggle.value;
    const episodes = episodeData[mode] || [];

    renderEpisodeButtons(episodes, targetEpNum);

    // Auto-play the target episode. Pass the isRemote flag down
    // so it doesn't accidentally trigger a double-broadcast!
    if (
      episodes.includes(targetEpNum.toString()) ||
      episodes.includes(Number(targetEpNum))
    ) {
      playVideo(targetEpNum, isRemote);
    }
  } catch (err) {
    episodeGrid.innerHTML = "<p>Error loading episodes.</p>";
  }
}

function renderEpisodeButtons(episodes, activeEpNum) {
  episodeGrid.innerHTML = "";
  if (episodes.length === 0) {
    episodeGrid.innerHTML = "<p>No episodes found for this mode.</p>";
    return;
  }

  episodes.forEach((epNum) => {
    const btn = document.createElement("button");
    btn.className = `ep-btn ${epNum == activeEpNum ? "active" : ""}`;
    btn.textContent = epNum;

    btn.addEventListener("click", () => {
      document
        .querySelectorAll(".ep-btn")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      playVideo(epNum);
    });

    episodeGrid.appendChild(btn);
  });
}

async function playVideo(epNum, isRemote = false) {
  // 1. If YOU clicked the episode button, broadcast it
  if (!isRemote) {
    if (isSyncEnabled) {
      socket.emit("load_episode_action", { epNum });
    }
  }

  currentEpNum = epNum;
  updateURL(currentShowId, currentShowName, epNum);
  videoOverlay.classList.remove("hidden");
  videoOverlay.innerHTML = "Buffering Stream...";

  try {
    const mode = modeToggle.value;
    const res = await fetch(
      `/api/stream/${currentShowId}/${epNum}?mode=${mode}`,
    );
    const data = await res.json();

    if (data.status !== "success" || !data.stream_url)
      throw new Error("Stream not found");

    const proxyUrl = `/proxy?url=${encodeURIComponent(data.stream_url)}`;

    // Clean up old HLS instances so they don't fight with the new video
    if (currentHlsInstance) {
      currentHlsInstance.destroy();
      currentHlsInstance = null;
    }

    // --- THE RESUME HELPER FIX ---
    const resumePlayback = () => {
      const savedTime = localStorage.getItem(`save_${currentShowId}_${epNum}`);
      if (savedTime) {
        videoPlayer.currentTime = parseFloat(savedTime);
      }
      videoOverlay.classList.add("hidden");

      // PREVENT THE ECHO LOOP: Tell the player this play command came from the code
      if (isRemote) {
        isRemoteAction = true;
      }

      // Catch Autoplay errors (Browsers sometimes block video if the user didn't click)
      const playPromise = videoPlayer.play();
      if (playPromise !== undefined) {
        playPromise.catch((error) => {
          console.warn("Autoplay blocked by browser:", error);
          videoOverlay.innerHTML = "Click Video to Play";
          videoOverlay.classList.remove("hidden");
        });
      }
    };
    // -----------------------------

    if (Hls.isSupported() && data.stream_url.includes(".m3u8")) {
      currentHlsInstance = new Hls({
        capLevelToPlayerSize: false,
        startLevel: -1,
        maxBufferLength: 30,
      });
      currentHlsInstance.loadSource(proxyUrl);
      currentHlsInstance.attachMedia(videoPlayer);

      currentHlsInstance.on(Hls.Events.MANIFEST_PARSED, function (event, data) {
        const maxQualityLevel = data.levels.length - 1;
        currentHlsInstance.currentLevel = maxQualityLevel;
        resumePlayback();
      });

      currentHlsInstance.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          videoOverlay.innerHTML = "Playback Error";
          videoOverlay.classList.remove("hidden");
        }
      });
    } else {
      videoPlayer.src = proxyUrl;
      // FIX THE STACKING BUG: Use onloadedmetadata instead of addEventListener
      videoPlayer.onloadedmetadata = resumePlayback;
      // Force the browser to fetch the new video metadata
      videoPlayer.load();
    }
  } catch (err) {
    videoOverlay.innerHTML = "Failed to load stream.";
    videoOverlay.classList.remove("hidden");
  }
}

function showSearchView() {
  searchView.classList.remove("hidden");
  watchView.classList.add("hidden");
  videoPlayer.pause();
  videoPlayer.removeAttribute("src");
  videoPlayer.load();
}

function showWatchView() {
  searchView.classList.add("hidden");
  watchView.classList.remove("hidden");
}

// --- WebSocket Setup & Watch Party Logic ---
const socket = io(); // Connects to your Flask-SocketIO server
let isRemoteAction = false; // The crucial flag to prevent infinite echo loops

// 1. Sending / Receiving Search Sync
socket.on("receive_search", async (data) => {
  // A remote user searched! Update our input box and trigger the search
  searchInput.value = data.query;

  // We manually execute the search logic without triggering another socket emission
  resultsGrid.innerHTML = "";
  loadingSpinner.classList.remove("hidden");
  try {
    const res = await fetch(`/api/search/${encodeURIComponent(data.query)}`);
    const searchData = await res.json();
    renderSearchResults(searchData);
    showSearchView(); // Force the screen back to search if they were watching a video
  } catch (err) {
    console.error("Remote search failed", err);
  } finally {
    loadingSpinner.classList.add("hidden");
  }
});

// 2. Sending / Receiving Video Play
videoPlayer.addEventListener("play", () => {
  if (!isRemoteAction) {
    if (isSyncEnabled) {
      socket.emit("play_action", { time: videoPlayer.currentTime });
    }
  }
  isRemoteAction = false; // Reset the flag immediately after letting it pass
});

socket.on("receive_play", (data) => {
  isRemoteAction = true; // Tell the player "Don't echo this back!"

  // If the time difference is greater than 1 second, snap to their time
  if (Math.abs(videoPlayer.currentTime - data.time) > 1) {
    videoPlayer.currentTime = data.time;
  }
  videoPlayer.play();
});

socket.on("receive_load_show", (data) => {
  // Pass 'true' at the end so it knows this is a remote action
  loadEpisodes(data.showId, data.showName, data.targetEpNum, true);
});

// Receive a command to swap episodes
socket.on("receive_load_episode", (data) => {
  // Visually update the episode buttons so the active one highlights
  document.querySelectorAll(".ep-btn").forEach((b) => {
    b.classList.remove("active");
    if (b.textContent == data.epNum) {
      b.classList.add("active");
    }
  });
  // Play the video remotely
  playVideo(data.epNum, true);
});

// Receive a command to go back to the search page
socket.on("receive_back", () => {
  if (!isSyncEnabled) return;
  updateURL("");
  showSearchView();
});

// 3. Sending / Receiving Video Pause
videoPlayer.addEventListener("pause", () => {
  if (!isRemoteAction) {
    if (isSyncEnabled) {
      socket.emit("pause_action", { time: videoPlayer.currentTime });
    }
  }
  isRemoteAction = false;
});

socket.on("receive_pause", (data) => {
  if (!isSyncEnabled) return;
  isRemoteAction = true;
  videoPlayer.currentTime = data.time; // Lock to their exact pause frame
  videoPlayer.pause();
});

// 4. Sending / Receiving Video Seeking (Timeline scrubbing)
videoPlayer.addEventListener("seeked", () => {
  if (!isRemoteAction) {
    if (isSyncEnabled) {
      socket.emit("seek_action", { time: videoPlayer.currentTime });
    }
  }
  isRemoteAction = false;
});

socket.on("receive_seek", (data) => {
  if (!isSyncEnabled) return;
  isRemoteAction = true;
  videoPlayer.currentTime = data.time;
});
