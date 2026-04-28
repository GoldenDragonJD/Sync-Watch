// --- DOM Elements ---
const searchView = document.getElementById("search-view");
const watchView = document.getElementById("watch-view");
const searchForm = document.getElementById("search-form");
const searchInput = document.getElementById("search-input");
const resultsGrid = document.getElementById("results-grid");
const loadingSpinner = document.getElementById("loading-spinner");
const scheduleContainer = document.getElementById("schedule-container");
const cwContainer = document.getElementById("continue-watching-container");
const cwControls = document.getElementById("continue-watching-controls");

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

// --- Sync Toggle State ---
const syncToggle = document.getElementById("sync-toggle");
let isSyncEnabled = localStorage.getItem("syncEnabled") === "true";
if (syncToggle) syncToggle.checked = isSyncEnabled;

if (syncToggle) {
  syncToggle.addEventListener("change", (e) => {
    isSyncEnabled = e.target.checked;
    localStorage.setItem("syncEnabled", isSyncEnabled);
  });
}

// --- Event Listeners ---
searchForm.addEventListener("submit", handleSearch);

// Bring schedule & history back if user deletes their search
searchInput.addEventListener("input", (e) => {
  if (e.target.value.trim() === "") {
    if (scheduleContainer) scheduleContainer.classList.remove("hidden");
    resultsGrid.innerHTML = "";
    renderContinueWatching();
  }
});

backBtn.addEventListener("click", () => {
  updateURL("");
  showSearchView();
  if (isSyncEnabled && typeof socket !== "undefined") {
    socket.emit("back_action");
  }
});

modeToggle.addEventListener("change", () => {
  if (currentShowId) loadEpisodes(currentShowId, currentShowName, currentEpNum);
});

videoPlayer.addEventListener("timeupdate", () => {
  if (currentShowId && currentEpNum && videoPlayer.currentTime > 0) {
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
document.addEventListener("DOMContentLoaded", () => {
  renderContinueWatching();

  const params = new URLSearchParams(window.location.search);
  const showId = params.get("show");
  const epNum = params.get("ep");
  const showName = params.get("name") || "Anime";

  // Validate that the showId from URL isn't empty or 'undefined'
  if (showId && showId !== "undefined" && showId !== "null") {
    loadEpisodes(showId, showName, epNum);
  } else {
    showSearchView();
  }
});

function updateURL(showId, showName, epNum) {
  if (!showId || showId === "undefined" || showId === "null") {
    window.history.pushState({}, "", "/");
  } else {
    const newUrl = `/?show=${encodeURIComponent(showId)}&name=${encodeURIComponent(showName)}&ep=${epNum || 1}`;
    window.history.pushState({}, "", newUrl);
  }
}

window.addEventListener("popstate", () => {
  const params = new URLSearchParams(window.location.search);
  const showId = params.get("show");
  if (showId && showId !== "undefined" && showId !== "null") {
    loadEpisodes(showId, params.get("name"), params.get("ep"));
  } else {
    showSearchView();
  }
});

// --- Core Functions ---
async function handleSearch(e) {
  e.preventDefault();
  const query = searchInput.value.trim();
  if (!query) return;

  if (isSyncEnabled && typeof socket !== "undefined") {
    socket.emit("search_action", { query: query });
  }

  // Hide the schedule and history so they don't overlap the search results
  if (scheduleContainer) scheduleContainer.classList.add("hidden");
  if (cwContainer) cwContainer.classList.add("hidden");

  resultsGrid.innerHTML = "";
  loadingSpinner.classList.remove("hidden");

  try {
    const res = await fetch(`/api/search/${encodeURIComponent(query)}`);
    const data = await res.json();
    renderSearchResults(data);
  } catch (err) {
    console.error(err);
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

  // Guard: Catch backend failure payloads so they don't render as clickable cards
  if (
    shows.length === 1 &&
    shows[0].name &&
    shows[0].name.startsWith("Error:")
  ) {
    resultsGrid.innerHTML = `<p class="text-danger" style="color: #ff4c4c; font-weight: bold; text-align: center; margin-top: 2rem;">Backend Server Issue: ${shows[0].name}</p>`;
    return;
  }

  shows.forEach((show) => {
    const card = document.createElement("div");
    card.className = "card";

    // Check what the API actually gave us
    const subCount = show.availableEpisodes?.sub;
    const dubCount = show.availableEpisodes?.dub;

    // Grab whichever number is higher/exists
    const totalEps =
      subCount !== "?" ? subCount : dubCount !== "?" ? dubCount : null;

    // If we have a real number, show it. Otherwise, show a clean fallback text.
    const epsText = totalEps
      ? `${totalEps} Episodes Available`
      : "View Episodes";

    card.innerHTML = `
      <h3>${show.name}</h3>
      <p class="eps-text" style="color: var(--primary); font-size: 0.9rem;">${epsText}</p>
    `;

    card.addEventListener("click", () => {
      // Robust ID extraction in case the API payload changes
      const id = show._id || show.id || show.url;
      if (!id) {
        alert("Sorry, this show has a broken ID and cannot be loaded.");
        return;
      }
      loadEpisodes(id, show.name, 1);
    });

    resultsGrid.appendChild(card);
  });
}

async function loadEpisodes(
  showId,
  showName,
  targetEpNum = 1,
  isRemote = false,
) {
  // Guard against empty or invalid IDs that cause the //episodes 404 error
  if (!showId || showId === "undefined" || showId === "null") {
    console.error("loadEpisodes called with invalid showId:", showId);
    showSearchView();
    return;
  }

  if (!isRemote && isSyncEnabled && typeof socket !== "undefined") {
    socket.emit("load_show_action", { showId, showName, targetEpNum });
  }

  currentShowId = showId;
  currentShowName = showName;
  currentEpNum = targetEpNum;

  // Update history silently in the background
  updateWatchHistory(showId, showName, targetEpNum);

  showTitleEl.textContent = showName;
  showWatchView();
  updateURL(showId, showName, targetEpNum);

  episodeGrid.innerHTML = "<p>Loading episodes...</p>";

  try {
    // encodeURIComponent protects against raw slashes breaking the routing
    const res = await fetch(`/api/${encodeURIComponent(showId)}/episodes`);
    if (!res.ok) throw new Error("Failed to fetch episodes");

    const episodeData = await res.json();
    const mode = modeToggle.value;
    const episodes = episodeData[mode] || [];

    renderEpisodeButtons(episodes, targetEpNum);

    if (
      episodes.includes(targetEpNum.toString()) ||
      episodes.includes(Number(targetEpNum))
    ) {
      playVideo(targetEpNum, isRemote);
    }
  } catch (err) {
    console.error(err);
    episodeGrid.innerHTML =
      "<p>Error loading episodes. Please go back and try again.</p>";
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
  if (!currentShowId) return;

  if (!isRemote && isSyncEnabled && typeof socket !== "undefined") {
    socket.emit("load_episode_action", { epNum });
  }

  currentEpNum = epNum;
  updateWatchHistory(currentShowId, currentShowName, epNum);
  updateURL(currentShowId, currentShowName, epNum);

  videoOverlay.classList.remove("hidden");
  videoOverlay.innerHTML = "Buffering Stream...";
  videoPlayer.currentTime = 0;

  try {
    const mode = modeToggle.value;
    // Safely encode the ID to prevent routing errors
    const res = await fetch(
      `/api/stream/${encodeURIComponent(currentShowId)}/${encodeURIComponent(epNum)}?mode=${mode}`,
    );
    const data = await res.json();

    if (data.status !== "success" || !data.stream_url) {
      throw new Error("Stream not found");
    }

    const proxyUrl = `/proxy?url=${encodeURIComponent(data.stream_url)}`;

    if (currentHlsInstance) {
      currentHlsInstance.destroy();
      currentHlsInstance = null;
    }

    const resumePlayback = () => {
      const savedTime = localStorage.getItem(`save_${currentShowId}_${epNum}`);
      if (savedTime) {
        videoPlayer.currentTime = parseFloat(savedTime);
      } else {
        videoPlayer.currentTime = 0;
      }

      videoOverlay.classList.add("hidden");

      if (isRemote) isRemoteAction = true;

      const playPromise = videoPlayer.play();
      if (playPromise !== undefined) {
        playPromise.catch((error) => {
          console.warn("Autoplay blocked by browser:", error);
          videoOverlay.innerHTML = "Click Video to Play";
          videoOverlay.classList.remove("hidden");
        });
      }
    };

    // Make sure Hls is defined before trying to use it
    if (
      typeof Hls !== "undefined" &&
      Hls.isSupported() &&
      data.stream_url.includes(".m3u8")
    ) {
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
      videoPlayer.onloadedmetadata = resumePlayback;
      videoPlayer.load();
    }
  } catch (err) {
    console.error(err);
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

  // Bring schedule & history back when you return to the home screen
  if (searchInput.value.trim() === "") {
    if (scheduleContainer) scheduleContainer.classList.remove("hidden");
    renderContinueWatching();
    resultsGrid.innerHTML = "";
  }
}

function showWatchView() {
  searchView.classList.add("hidden");
  watchView.classList.remove("hidden");
}

// --- WebSocket Setup & Watch Party Logic ---
const socket = typeof io !== "undefined" ? io() : null;
let isRemoteAction = false;

if (socket) {
  socket.on("receive_search", async (data) => {
    if (!isSyncEnabled) return;
    searchInput.value = data.query;

    if (scheduleContainer) scheduleContainer.classList.add("hidden");
    if (cwContainer) cwContainer.classList.add("hidden");

    resultsGrid.innerHTML = "";
    loadingSpinner.classList.remove("hidden");
    try {
      const res = await fetch(`/api/search/${encodeURIComponent(data.query)}`);
      const searchData = await res.json();
      renderSearchResults(searchData);
      showSearchView();
    } catch (err) {
      console.error("Remote search failed", err);
    } finally {
      loadingSpinner.classList.add("hidden");
    }
  });

  socket.on("receive_play", (data) => {
    if (!isSyncEnabled) return;
    isRemoteAction = true;
    if (Math.abs(videoPlayer.currentTime - data.time) > 1) {
      videoPlayer.currentTime = data.time;
    }
    videoPlayer.play();
  });

  socket.on("receive_load_show", (data) => {
    if (!isSyncEnabled) return;
    loadEpisodes(data.showId, data.showName, data.targetEpNum, true);
  });

  socket.on("receive_load_episode", (data) => {
    if (!isSyncEnabled) return;
    document.querySelectorAll(".ep-btn").forEach((b) => {
      b.classList.remove("active");
      if (b.textContent == data.epNum) b.classList.add("active");
    });
    playVideo(data.epNum, true);
  });

  socket.on("receive_back", () => {
    if (!isSyncEnabled) return;
    updateURL("");
    showSearchView();
  });

  socket.on("receive_pause", (data) => {
    if (!isSyncEnabled) return;
    isRemoteAction = true;
    videoPlayer.currentTime = data.time;
    videoPlayer.pause();
  });

  socket.on("receive_seek", (data) => {
    if (!isSyncEnabled) return;
    isRemoteAction = true;
    videoPlayer.currentTime = data.time;
  });
}

// Video Player Event Listeners for Sockets
videoPlayer.addEventListener("play", () => {
  if (!isRemoteAction && isSyncEnabled && socket) {
    socket.emit("play_action", { time: videoPlayer.currentTime });
  }
  isRemoteAction = false;
});

videoPlayer.addEventListener("pause", () => {
  if (!isRemoteAction && isSyncEnabled && socket) {
    socket.emit("pause_action", { time: videoPlayer.currentTime });
  }
  isRemoteAction = false;
});

videoPlayer.addEventListener("seeked", () => {
  if (!isRemoteAction && isSyncEnabled && socket) {
    socket.emit("seek_action", { time: videoPlayer.currentTime });
  }
  isRemoteAction = false;
});

// --- Jikan Schedule Integration ---
const scheduleGrid = document.getElementById("schedule-grid");
const scheduleTitle = document.getElementById("schedule-title");
const scheduleControls = document.getElementById("schedule-controls");

const daysOfWeek = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

document.addEventListener("DOMContentLoaded", () => {
  if (scheduleControls) buildDayFilters();
});

function buildDayFilters() {
  scheduleControls.innerHTML = "";
  const todayIndex = new Date().getDay();

  daysOfWeek.forEach((day, index) => {
    const btn = document.createElement("button");
    btn.className = `ep-btn ${index === todayIndex ? "active" : ""}`;
    btn.textContent = day.substring(0, 3);
    btn.style.padding = "0.5rem 1rem";
    btn.style.minWidth = "60px";

    btn.addEventListener("click", () => {
      document
        .querySelectorAll("#schedule-controls .ep-btn")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      fetchSchedule(day.toLowerCase(), `${day}'s Releases`);
    });
    scheduleControls.appendChild(btn);
  });

  const todayName = daysOfWeek[todayIndex];
  fetchSchedule(todayName.toLowerCase(), `Today's Releases (${todayName})`);
}

async function fetchSchedule(dayName, titleLabel) {
  if (!scheduleTitle || !scheduleGrid) return;

  scheduleTitle.textContent = "Loading...";
  scheduleGrid.innerHTML = "";

  try {
    const res = await fetch(`/api/schedule?day=${dayName}`);
    const json = await res.json();

    if (json.data && json.data.length > 0) {
      scheduleTitle.textContent = titleLabel;
      renderSchedule(json.data);
    } else {
      scheduleTitle.textContent = titleLabel;
      scheduleGrid.innerHTML = "<p>No releases found for this day.</p>";
    }
  } catch (err) {
    console.error("Failed to load schedule", err);
    scheduleTitle.textContent = "Error Loading Schedule";
  }
}

function renderSchedule(animeList) {
  scheduleGrid.innerHTML = "";

  animeList.forEach((anime) => {
    const card = document.createElement("div");
    card.className = "card";

    const imageUrl = anime.images?.jpg?.image_url || "";
    const title = anime.title_english || anime.title || "Unknown Title";
    const score = anime.score ? `★ ${anime.score}` : "Unrated";

    card.innerHTML = `
      <div style="display: flex; gap: 1rem; align-items: center;">
          <img src="${imageUrl}" alt="${title}" style="width: 60px; height: 85px; border-radius: 8px; object-fit: cover;">
          <div>
              <h4 style="margin-bottom: 0.3rem; font-size: 1rem;">${title}</h4>
              <p style="color: var(--primary); font-weight: bold; font-size: 0.9rem;">
                  ${score}
              </p>
          </div>
      </div>
    `;

    card.addEventListener("click", () => {
      searchInput.value = title;
      if (isSyncEnabled && socket) {
        socket.emit("search_action", { query: title });
      }
      searchForm.dispatchEvent(
        new Event("submit", { cancelable: true, bubbles: true }),
      );
    });

    scheduleGrid.appendChild(card);
  });
}

// --- Continue Watching (Watch History) ---
function updateWatchHistory(showId, showName, epNum) {
  if (!showId || showId === "undefined" || showId === "null") return;

  let history = JSON.parse(localStorage.getItem("watchHistory") || "[]");

  history = history.filter((item) => item.id !== showId);

  history.unshift({
    id: showId,
    name: showName,
    ep: epNum,
  });

  if (history.length > 15) history.pop();

  localStorage.setItem("watchHistory", JSON.stringify(history));
}

function renderContinueWatching() {
  if (!cwContainer || !cwControls) return;

  // Filter out any broken history items from before the fix
  let history = JSON.parse(localStorage.getItem("watchHistory") || "[]");
  const validHistory = history.filter(
    (item) => item && item.id && item.id !== "undefined" && item.id !== "null",
  );

  // If we had to clean up broken items, save the clean version back to storage
  if (validHistory.length !== history.length) {
    localStorage.setItem("watchHistory", JSON.stringify(validHistory));
  }

  if (validHistory.length === 0) {
    cwContainer.classList.add("hidden");
    return;
  }

  cwContainer.classList.remove("hidden");
  cwControls.innerHTML = "";

  validHistory.forEach((item) => {
    const card = document.createElement("div");
    card.className = "history-card";
    card.innerHTML = `
            <div>
                <h4>${item.name}</h4>
                <p style="font-size: 0.85rem; color: var(--text-muted);">Resume watching</p>
            </div>
            <div>
                <span class="ep-badge">Episode ${item.ep}</span>
            </div>
        `;

    card.addEventListener("click", () => {
      if (isSyncEnabled && socket) {
        socket.emit("load_show_action", {
          showId: item.id,
          showName: item.name,
          targetEpNum: item.ep,
        });
      }
      loadEpisodes(item.id, item.name, item.ep);
    });

    cwControls.appendChild(card);
  });
}
