// --- DOM Elements ---
const searchView = document.getElementById("search-view");
const libraryView = document.getElementById("library-view");
const watchView = document.getElementById("watch-view");
const searchForm = document.getElementById("search-form");
const searchInput = document.getElementById("search-input");
const resultsGrid = document.getElementById("results-grid");
const loadingSpinner = document.getElementById("loading-spinner");
const scheduleContainer = document.getElementById("schedule-container");
const cwContainer = document.getElementById("continue-watching-container");
const cwControls = document.getElementById("continue-watching-controls");

// Navigation & Library DOM Elements
const logoHomeBtn = document.getElementById("logo-home-btn");
const navMainBtn = document.getElementById("nav-main-btn");
const navLibraryBtn = document.getElementById("nav-library-btn");
const navDownloadsBtn = document.getElementById("nav-downloads-btn");
const libraryCountBadge = document.getElementById("library-count-badge");
const downloadsActiveBadge = document.getElementById("downloads-active-badge");
const librarySearchInput = document.getElementById("library-search-input");
const libraryGrid = document.getElementById("library-grid");
const libraryEmptyState = document.getElementById("library-empty-state");
const libraryBrowseBtn = document.getElementById("library-browse-btn");

const backBtn = document.getElementById("back-btn");
const showTitleEl = document.getElementById("current-show-title");
const watchCachedBadge = document.getElementById("watch-cached-badge");
const watchOfflinePlayingBadge = document.getElementById("watch-offline-playing-badge");
const episodeGrid = document.getElementById("episode-grid");
const videoPlayer = document.getElementById("video-player");
const videoOverlay = document.getElementById("video-loading-overlay");
const modeToggle = document.getElementById("dub-sub-toggle");

const controlsContainer = document.getElementById("player-controls-container");
const nextEpBtn = document.getElementById("next-ep-btn");
const autoplayCheckbox = document.getElementById("autoplay-toggle");

// Custom Player DOM Elements
const videoWrapper = document.getElementById("video-wrapper");
const playPauseBtn = document.getElementById("play-pause-btn");
const playerNextEpBtn = document.getElementById("player-next-ep-btn");
const progressBar = document.getElementById("progress-bar");
const muteBtn = document.getElementById("mute-btn");
const volumeBar = document.getElementById("volume-bar");
const timeDisplay = document.getElementById("time-display");
const fullscreenBtn = document.getElementById("fullscreen-btn");
const skipButton = document.getElementById("skip-button");
const hoverTooltip = document.getElementById("hover-time-tooltip");

// --- Global State ---
let currentShowId = null;
let currentShowName = "";
let currentShowImage = "";
let currentHlsInstance = null;
let currentEpNum = null;
let currentEpisodeList = [];
let currentAllEpisodesData = { sub: [], dub: [], cached: { sub: [], dub: [] } };
let isAutoplayEnabled = localStorage.getItem("autoplayEnabled") !== "false";
let lastBrowseWindow = "main"; // "main" or "library"

// Offline Library & Download State
let cachedAnimeMap = {};
let libraryAnimeList = [];
let playerDownloadTarget = "cache"; // "cache" or "local"
let isSelectingEpisodesForDownload = false;
let selectedPlayerEpisodes = new Set();
let activeDownloadJobs = {};
let triggeredLocalDownloads = new Set();

// NEW Global State for AniSkip & Sockets
let currentSkipTimes = [];
let activeSkip = null;
let currentStreamFetchId = 0;
let idleTimer;
let isRemoteAction = false;

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

// =========================================
// CUSTOM VIDEO PLAYER LOGIC
// =========================================

function showUIAndResetTimer() {
  videoWrapper.classList.remove("idle-hidden");

  clearTimeout(idleTimer);

  if (!videoPlayer.paused) {
    idleTimer = setTimeout(() => {
      videoWrapper.classList.add("idle-hidden");
    }, 3000);
  }
}

videoWrapper.addEventListener("mousemove", showUIAndResetTimer);
videoWrapper.addEventListener("mousedown", showUIAndResetTimer);
videoWrapper.addEventListener("touchstart", showUIAndResetTimer);

videoPlayer.addEventListener("pause", () => {
  videoWrapper.classList.remove("idle-hidden");
  clearTimeout(idleTimer);
});

// 1. Play & Pause
function togglePlay() {
  if (videoPlayer.paused) {
    videoOverlay.classList.add("hidden");
    videoPlayer.play();
  } else {
    videoPlayer.pause();
  }
}
playPauseBtn.addEventListener("click", togglePlay);
videoPlayer.addEventListener("click", togglePlay);

// Native Video Events -> Sync Broadcasts
videoPlayer.addEventListener("play", () => {
  playPauseBtn.textContent = "⏸";
  videoWrapper.classList.remove("paused");
  showUIAndResetTimer();

  if (isRemoteAction) {
    isRemoteAction = false;
    return;
  }

  if (isSyncEnabled && typeof socket !== "undefined") {
    socket.emit("play_action", { time: videoPlayer.currentTime });
  }
});

videoPlayer.addEventListener("pause", () => {
  playPauseBtn.textContent = "▶";
  videoWrapper.classList.add("paused");

  if (isRemoteAction) {
    isRemoteAction = false;
    return;
  }

  if (isSyncEnabled && typeof socket !== "undefined") {
    socket.emit("pause_action", { time: videoPlayer.currentTime });
  }
});

videoPlayer.addEventListener("seeked", () => {
  if (isRemoteAction) {
    isRemoteAction = false;
    return;
  }

  if (isSyncEnabled && typeof socket !== "undefined") {
    socket.emit("seek_action", { time: videoPlayer.currentTime });
  }
});

// 2. Formatting Time helper
function formatTime(seconds) {
  if (isNaN(seconds)) return "00:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m < 10 ? "0" : ""}${m}:${s < 10 ? "0" : ""}${s}`;
}

// --- Hover Tooltip Logic ---
progressBar.addEventListener("mousemove", (e) => {
  if (!videoPlayer.duration) return;

  const rect = progressBar.getBoundingClientRect();
  let mouseX = e.clientX - rect.left;
  mouseX = Math.max(0, Math.min(mouseX, rect.width));
  const hoverTime = (mouseX / rect.width) * videoPlayer.duration;

  hoverTooltip.textContent = formatTime(hoverTime);
  hoverTooltip.style.left = `${mouseX}px`;
});

progressBar.addEventListener("mouseenter", () => {
  if (videoPlayer.duration) {
    hoverTooltip.style.opacity = "1";
  }
});

progressBar.addEventListener("mouseleave", () => {
  hoverTooltip.style.opacity = "0";
});

// 5. Volume Controls
volumeBar.addEventListener("input", (e) => {
  videoPlayer.volume = e.target.value;
  videoPlayer.muted = false;
  updateMuteIcon();
});

function updateMuteIcon() {
  if (videoPlayer.muted || videoPlayer.volume === 0) muteBtn.textContent = "🔇";
  else if (videoPlayer.volume < 0.5) muteBtn.textContent = "🔉";
  else muteBtn.textContent = "🔊";
}

muteBtn.addEventListener("click", () => {
  videoPlayer.muted = !videoPlayer.muted;
  if (videoPlayer.muted) volumeBar.value = 0;
  else volumeBar.value = videoPlayer.volume || 1;
  updateMuteIcon();
});

// 6. Fullscreen Handler
function toggleFullScreen() {
  if (!document.fullscreenElement) {
    if (videoWrapper.requestFullscreen) videoWrapper.requestFullscreen();
    else if (videoWrapper.webkitRequestFullscreen)
      videoWrapper.webkitRequestFullscreen();
    else if (videoWrapper.msRequestFullscreen)
      videoWrapper.msRequestFullscreen();
  } else {
    if (document.exitFullscreen) document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    else if (document.msExitFullscreen) document.msExitFullscreen();
  }
}

fullscreenBtn.addEventListener("click", toggleFullScreen);
videoWrapper.addEventListener("dblclick", toggleFullScreen);

// 7. Global Keyboard Controls on Watch Screen
window.addEventListener(
  "keydown",
  (e) => {
    if (watchView.classList.contains("hidden")) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    if (e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      if (videoPlayer.duration) {
        videoPlayer.currentTime = Math.max(0, (videoPlayer.currentTime || 0) - 5);
      }
      showUIAndResetTimer();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      if (videoPlayer.duration) {
        videoPlayer.currentTime = Math.min(
          videoPlayer.duration,
          (videoPlayer.currentTime || 0) + 5,
        );
      }
      showUIAndResetTimer();
    } else if (e.key === " " || e.code === "Space") {
      e.preventDefault();
      e.stopPropagation();
      togglePlay();
      showUIAndResetTimer();
    } else if (e.key === "f" || e.key === "F" || e.code === "KeyF") {
      e.preventDefault();
      e.stopPropagation();
      toggleFullScreen();
      showUIAndResetTimer();
    }
  },
  true,
);

window.addEventListener(
  "keyup",
  (e) => {
    if (watchView.classList.contains("hidden")) return;
    if (e.key === " " || e.code === "Space") {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true,
);

// Loading overlay click
videoOverlay.addEventListener("click", () => {
  videoOverlay.classList.add("hidden");
  videoPlayer.play();
});

// =========================================
// STANDARD APP LOGIC
// =========================================

searchForm.addEventListener("submit", handleSearch);

searchInput.addEventListener("input", (e) => {
  if (e.target.value.trim() === "") {
    if (scheduleContainer) scheduleContainer.classList.remove("hidden");
    resultsGrid.innerHTML = "";
    renderContinueWatching();
  }
});

backBtn.addEventListener("click", () => {
  if (lastBrowseWindow === "library") {
    updateURL("", "", "", "library");
    showLibraryView();
  } else {
    updateURL("");
    showSearchView();
  }
  if (isSyncEnabled && typeof socket !== "undefined") {
    socket.emit("back_action");
  }
});

if (navMainBtn) {
  navMainBtn.addEventListener("click", () => {
    updateURL("");
    showSearchView();
  });
}

if (logoHomeBtn) {
  logoHomeBtn.addEventListener("click", () => {
    updateURL("");
    showSearchView();
  });
}

if (navLibraryBtn) {
  navLibraryBtn.addEventListener("click", () => {
    updateURL("", "", "", "library");
    showLibraryView();
  });
}

if (libraryBrowseBtn) {
  libraryBrowseBtn.addEventListener("click", () => {
    updateURL("");
    showSearchView();
  });
}

if (librarySearchInput) {
  librarySearchInput.addEventListener("input", () => {
    renderLibraryGrid();
  });
}

modeToggle.addEventListener("change", () => {
  modeToggle.blur();
  if (currentShowId) {
    localStorage.setItem(`langPref_${currentShowId}`, modeToggle.value);
    loadEpisodes(currentShowId, currentShowName, currentEpNum);
  }
});

let isSkipping = false;

function playNextEpisode() {
  if (isSkipping || !currentEpisodeList.length) return;
  const currentIndex = currentEpisodeList.indexOf(currentEpNum.toString());

  if (currentIndex !== -1 && currentIndex < currentEpisodeList.length - 1) {
    isSkipping = true;
    setTimeout(() => {
      isSkipping = false;
    }, 2000);

    if (currentShowId && currentEpNum) {
      localStorage.removeItem(`save_${currentShowId}_${currentEpNum}`);
    }

    const nextEp = currentEpisodeList[currentIndex + 1];

    document.querySelectorAll("#episode-grid .ep-btn").forEach((b) => {
      b.classList.remove("active");
      if (b.dataset.ep == nextEp || b.textContent == nextEp) b.classList.add("active");
    });

    playVideo(nextEp);
  }
}

nextEpBtn.addEventListener("click", playNextEpisode);
if (playerNextEpBtn) {
  playerNextEpBtn.addEventListener("click", playNextEpisode);
}

videoPlayer.addEventListener("ended", () => {
  if (currentShowId && currentEpNum) {
    localStorage.removeItem(`save_${currentShowId}_${currentEpNum}`);
  }
  if (isAutoplayEnabled) {
    playNextEpisode();
  }
});

autoplayCheckbox.checked = isAutoplayEnabled;
autoplayCheckbox.addEventListener("change", (e) => {
  isAutoplayEnabled = e.target.checked;
  localStorage.setItem("autoplayEnabled", isAutoplayEnabled);
});

if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("nexttrack", () => {
    playNextEpisode();
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  await fetchLibraryData();
  fetchDownloadJobs();
  renderContinueWatching();

  const params = new URLSearchParams(window.location.search);
  const showId = params.get("show");
  const epNum = params.get("ep");
  const showName = params.get("name") || "Anime";
  const viewParam = params.get("view");

  if (showId && showId !== "undefined" && showId !== "null") {
    loadEpisodes(showId, showName, epNum);
  } else if (viewParam === "library") {
    showLibraryView();
  } else {
    showSearchView();
  }
});

function updateURL(showId, showName, epNum, viewMode = "") {
  if (viewMode === "library") {
    window.history.pushState({}, "", "/?view=library");
  } else if (!showId || showId === "undefined" || showId === "null") {
    window.history.pushState({}, "", "/");
  } else {
    const newUrl = `/?show=${encodeURIComponent(showId)}&name=${encodeURIComponent(showName)}&ep=${epNum || 1}`;
    window.history.pushState({}, "", newUrl);
  }
}

window.addEventListener("popstate", () => {
  const params = new URLSearchParams(window.location.search);
  const showId = params.get("show");
  const viewParam = params.get("view");
  if (showId && showId !== "undefined" && showId !== "null") {
    loadEpisodes(showId, params.get("name"), params.get("ep"));
  } else if (viewParam === "library") {
    showLibraryView();
  } else {
    showSearchView();
  }
});

async function resolveMalId(showId, showName) {
  if (/^\d+$/.test(showId)) {
    return parseInt(showId, 10);
  }

  try {
    const cleanName = showName.replace(/\(Dub\)|\(Sub\)/gi, "").trim();
    const res = await fetch(
      `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(cleanName)}&limit=1`,
    );
    const json = await res.json();

    if (json.data && json.data.length > 0) {
      return json.data[0].mal_id;
    }
  } catch (err) {
    console.warn("Failed to resolve MAL ID via Jikan:", err);
  }
  return null;
}

async function fetchSkipTimes(malId, epNum) {
  currentSkipTimes = [];
  activeSkip = null;
  hideSkipButton();

  try {
    const res = await fetch(
      `https://api.aniskip.com/v2/skip-times/${malId}/${epNum}?types=op&types=ed&types=mixed-op&types=mixed-ed&types=recap&episodeLength=0`,
    );

    if (!res.ok) throw new Error(`AniSkip returned ${res.status}`);

    const data = await res.json();
    if (data.found && data.results) {
      currentSkipTimes = data.results.map((r) => ({
        type: r.skipType,
        start: r.interval.startTime,
        end: r.interval.endTime,
      }));
    }
  } catch (err) {}
}

function showSkipButton(skipData) {
  if (!skipButton) return;
  skipButton.classList.remove("hidden");

  if (skipData.type === "op") skipButton.textContent = "Skip Intro";
  else if (skipData.type === "ed") skipButton.textContent = "Skip Outro";
  else skipButton.textContent = "Skip";

  skipButton.onclick = () => {
    videoPlayer.currentTime = skipData.end;
    hideSkipButton();
  };
}

function hideSkipButton() {
  if (!skipButton) return;
  skipButton.classList.add("hidden");
  skipButton.onclick = null;
}

async function handleSearch(e) {
  e.preventDefault();
  const query = searchInput.value.trim();
  if (!query) return;

  if (isSyncEnabled && typeof socket !== "undefined") {
    socket.emit("search_action", { query: query });
  }

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

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getAnimeCacheInfo(nameOrId) {
  if (!nameOrId) return null;
  const raw = String(nameOrId).trim();
  const norm = raw.toLowerCase().replace(/\s+/g, " ");
  return cachedAnimeMap[raw] || cachedAnimeMap[norm] || null;
}

function isAnimeCached(nameOrId) {
  const info = getAnimeCacheInfo(nameOrId);
  return Boolean(info && info.total > 0);
}

function formatBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b <= 0) return "0 MB";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  const val = b / Math.pow(1024, i);
  return `${val >= 100 || i === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[i]}`;
}

function posterHtml(src, alt, showId = "", options = {}) {
  const safeAlt = escapeHtml(alt);
  const key = showId || alt || "";
  const cacheInfo = getAnimeCacheInfo(key);
  const isCached = Boolean(cacheInfo && cacheInfo.total > 0);

  let imgTag = `<div class="card-poster-placeholder">No Poster</div>`;
  if (options.posterUrl) {
    imgTag = `<img class="card-poster" src="${escapeHtml(options.posterUrl)}" alt="${safeAlt}" loading="lazy" decoding="async" onerror="this.remove()">`;
  } else if (src) {
    const proxiedSrc = `/api/image_proxy?url=${encodeURIComponent(src)}`;
    imgTag = `<img class="card-poster" src="${proxiedSrc}" alt="${safeAlt}" loading="lazy" decoding="async" onerror="this.remove()">`;
  } else if (isCached && key) {
    const libPoster = `/api/library/poster/${encodeURIComponent(key)}`;
    imgTag = `<img class="card-poster" src="${libPoster}" alt="${safeAlt}" loading="lazy" decoding="async" onerror="this.remove()">`;
  }

  const cachedTagHtml = isCached
    ? `<span class="cached-badge" title="${cacheInfo.total} episode(s) cached for offline playback">✓ CACHED</span>`
    : "";

  const delBtnHtml = options.showDeleteBtn
    ? `<button type="button" class="card-hover-del-btn" title="Delete from offline cache">🗑</button>`
    : "";

  return `
    <div class="card-poster-wrap">
      ${imgTag}
      <div class="card-top-badges" data-cache-badge-for="${escapeHtml(key)}">
        ${cachedTagHtml}
      </div>
      <div class="card-hover-actions">
        <button type="button" class="card-hover-dl-btn" title="Download or Cache Anime">
          ⬇ Download
        </button>
        ${delBtnHtml}
      </div>
    </div>
  `;
}

function bindCardHoverActions(card, showId, showName, showImage, onDelete = null) {
  const dlBtn = card.querySelector(".card-hover-dl-btn");
  if (dlBtn) {
    dlBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openDownloadModal(showId, showName, showImage);
    });
  }
  const delBtn = card.querySelector(".card-hover-del-btn");
  if (delBtn && onDelete) {
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      onDelete();
    });
  }
}

function renderSearchResults(shows) {
  if (!shows || shows.length === 0) {
    resultsGrid.innerHTML = "<p>No shows found.</p>";
    return;
  }

  if (
    shows.length === 1 &&
    shows[0].name &&
    shows[0].name.startsWith("Error:")
  ) {
    resultsGrid.innerHTML = `<p class="text-danger" style="color: #ff4c4c; font-weight: bold; text-align: center; margin-top: 2rem;">Backend Server Issue: ${escapeHtml(shows[0].name)}</p>`;
    return;
  }

  shows.forEach((show) => {
    const card = document.createElement("div");
    card.className = "card";
    const id = show.name || show._id || show.id || show.url;

    const subCount = show.availableEpisodes?.sub;
    const dubCount = show.availableEpisodes?.dub;

    const totalEps =
      subCount !== "?" ? subCount : dubCount !== "?" ? dubCount : null;
    const epsText = totalEps
      ? `${escapeHtml(totalEps)} Episodes Available`
      : "View Episodes";

    const cachedTagInline = isAnimeCached(id)
      ? `<span class="cached-badge">✓ CACHED</span>`
      : "";

    card.innerHTML = `
      ${posterHtml(show.image, show.name, id)}
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.4rem; margin-bottom: 0.4rem;">
        <h3 style="margin-bottom: 0; font-size: 1.1rem; flex: 1;">${escapeHtml(show.name)}</h3>
        <span data-inline-cache-for="${escapeHtml(id)}">${cachedTagInline}</span>
      </div>
      <p class="eps-text" style="color: var(--primary); font-size: 0.9rem;">${epsText}</p>
    `;

    bindCardHoverActions(card, id, show.name, show.image || "");

    card.addEventListener("click", () => {
      if (!id) {
        alert("Sorry, this show has a broken ID and cannot be loaded.");
        return;
      }

      let targetEp = 1;
      const history = JSON.parse(localStorage.getItem("watchHistory") || "[]");
      const savedShow = history.find(
        (item) => item.name === show.name || item.id === id,
      );
      if (savedShow && savedShow.ep) {
        targetEp = savedShow.ep;
      }

      loadEpisodes(id, show.name, targetEp, false, show.image || "");
    });

    resultsGrid.appendChild(card);
  });
}

async function loadEpisodes(
  showId,
  showName,
  targetEpNum = 1,
  isRemote = false,
  showImage = "",
) {
  if (!showId || showId === "undefined" || showId === "null") {
    console.error("loadEpisodes called with invalid showId:", showId);
    showSearchView();
    return;
  }

  videoPlayer.pause();

  if (!isRemote && isSyncEnabled && typeof socket !== "undefined") {
    socket.emit("load_show_action", { showId, showName, targetEpNum });
  }

  currentShowId = showId;
  currentShowName = showName;
  if (showImage) currentShowImage = showImage;
  currentEpNum = targetEpNum;

  // Exit selection mode when switching shows
  exitPlayerEpisodeSelectionMode();

  const savedMode = localStorage.getItem(`langPref_${showId}`);
  if (savedMode && (savedMode === "sub" || savedMode === "dub")) {
    modeToggle.value = savedMode;
  }

  updateWatchHistory(showId, showName, targetEpNum);

  showTitleEl.textContent = showName;
  updateWatchHeaderBadges(false);
  showWatchView();
  updateURL(showId, showName, targetEpNum);

  episodeGrid.innerHTML = "<p>Loading episodes...</p>";

  try {
    const res = await fetch(`/api/${encodeURIComponent(showId)}/episodes`);
    if (!res.ok) throw new Error("Failed to fetch episodes");

    const episodeData = await res.json();
    currentAllEpisodesData = {
      sub: episodeData.sub || [],
      dub: episodeData.dub || [],
      cached: episodeData.cached || { sub: [], dub: [] },
    };

    const mode = modeToggle.value;
    currentEpisodeList = episodeData[mode] || [];

    // If current mode has no episodes but the other mode has cached/available episodes, switch automatically
    if (currentEpisodeList.length === 0) {
      const altMode = mode === "sub" ? "dub" : "sub";
      if ((episodeData[altMode] || []).length > 0) {
        modeToggle.value = altMode;
        currentEpisodeList = episodeData[altMode];
      }
    }

    renderEpisodeButtons(currentEpisodeList, targetEpNum);

    if (
      currentEpisodeList.includes(targetEpNum.toString()) ||
      currentEpisodeList.includes(Number(targetEpNum))
    ) {
      playVideo(targetEpNum, isRemote);
    } else if (currentEpisodeList.length > 0) {
      playVideo(currentEpisodeList[0], isRemote);
    }
  } catch (err) {
    console.error(err);
    episodeGrid.innerHTML =
      "<p>Error loading episodes. Please go back and try again.</p>";
  }
}

function isEpisodeCachedInCurrentShow(epNum, mode) {
  const epStr = String(epNum);
  const m = mode || modeToggle.value;
  if (
    currentAllEpisodesData.cached &&
    Array.isArray(currentAllEpisodesData.cached[m]) &&
    currentAllEpisodesData.cached[m].includes(epStr)
  ) {
    return true;
  }
  const cInfo = getAnimeCacheInfo(currentShowId) || getAnimeCacheInfo(currentShowName);
  if (cInfo && Array.isArray(cInfo[m]) && cInfo[m].includes(epStr)) {
    return true;
  }
  return false;
}

function renderEpisodeButtons(episodes, activeEpNum) {
  episodeGrid.innerHTML = "";
  if (episodes.length === 0) {
    episodeGrid.innerHTML = "<p>No episodes found for this mode.</p>";
    return;
  }

  const mode = modeToggle.value;

  episodes.forEach((epNum) => {
    const epStr = String(epNum);
    const btn = document.createElement("button");
    const isCachedEp = isEpisodeCachedInCurrentShow(epStr, mode);
    const isSelected = selectedPlayerEpisodes.has(epStr);
    btn.className = `ep-btn ${epStr == String(activeEpNum) ? "active" : ""} ${isCachedEp ? "cached-ep" : ""} ${isSelected ? "selected-for-dl" : ""}`;
    btn.dataset.ep = epStr;
    btn.textContent = epStr;
    if (isCachedEp) {
      btn.title = `Episode ${epStr} (Cached for offline playback)`;
    }

    btn.addEventListener("click", () => {
      if (isSelectingEpisodesForDownload) {
        if (selectedPlayerEpisodes.has(epStr)) {
          selectedPlayerEpisodes.delete(epStr);
          btn.classList.remove("selected-for-dl");
        } else {
          selectedPlayerEpisodes.add(epStr);
          btn.classList.add("selected-for-dl");
        }
        updatePlayerSelectedEpCounter();
        return;
      }

      document
        .querySelectorAll("#episode-grid .ep-btn")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      playVideo(epStr);
    });

    episodeGrid.appendChild(btn);
  });
}

function updateWatchHeaderBadges(isPlayingCachedStream = false) {
  const showCached =
    isAnimeCached(currentShowId) || isAnimeCached(currentShowName) || isPlayingCachedStream;
  if (watchCachedBadge) {
    watchCachedBadge.classList.toggle("hidden", !showCached);
  }
  if (watchOfflinePlayingBadge) {
    watchOfflinePlayingBadge.classList.toggle("hidden", !isPlayingCachedStream);
  }
}

async function playVideo(epNum, isRemote = false) {
  if (!currentShowId) return;

  videoPlayer.pause();

  currentStreamFetchId++;
  const fetchId = currentStreamFetchId;

  if (!isRemote && isSyncEnabled && typeof socket !== "undefined") {
    socket.emit("load_episode_action", { epNum });
  }

  currentEpNum = epNum;
  const dlCurrentEpLabel = document.getElementById("dl-current-ep-label");
  if (dlCurrentEpLabel) dlCurrentEpLabel.textContent = epNum;

  updateWatchHistory(currentShowId, currentShowName, epNum);
  updateURL(currentShowId, currentShowName, epNum);

  currentSkipTimes = [];
  activeSkip = null;
  hideSkipButton();

  const currentIndex = currentEpisodeList.indexOf(epNum.toString());
  const hasNextEp =
    currentIndex !== -1 && currentIndex < currentEpisodeList.length - 1;
  if (controlsContainer) {
    controlsContainer.classList.toggle("hidden", !hasNextEp);
  }
  if (playerNextEpBtn) {
    playerNextEpBtn.classList.toggle("hidden", !hasNextEp);
  }

  videoOverlay.classList.remove("hidden");
  videoOverlay.innerHTML = "Loading Stream...";

  try {
    const mode = modeToggle.value;
    const res = await fetch(
      `/api/stream/${encodeURIComponent(currentShowId)}/${encodeURIComponent(epNum)}?mode=${mode}`,
    );
    const data = await res.json();

    if (fetchId !== currentStreamFetchId) {
      console.log("Aborted stale stream fetch for episode:", epNum);
      return;
    }

    if (data.status !== "success" || !data.stream_url) {
      throw new Error("Stream not found");
    }

    const isFromCache = Boolean(data.cached);
    updateWatchHeaderBadges(isFromCache);

    // Populate skip times from stream payload (ZokoAnime embed or cached skip_json) or via AniSkip if mal_id is present
    if (data.skip) {
      const skips = [];
      if (
        data.skip.intro &&
        data.skip.intro.end > data.skip.intro.start
      ) {
        skips.push({
          type: "op",
          start: data.skip.intro.start,
          end: data.skip.intro.end,
        });
      }
      if (
        data.skip.outro &&
        data.skip.outro.end > data.skip.outro.start
      ) {
        skips.push({
          type: "ed",
          start: data.skip.outro.start,
          end: data.skip.outro.end,
        });
      }
      if (skips.length > 0) {
        currentSkipTimes = skips;
      } else if (data.mal_id && !isFromCache) {
        fetchSkipTimes(data.mal_id, epNum);
      }
    } else if (data.mal_id && !isFromCache) {
      fetchSkipTimes(data.mal_id, epNum);
    }

    let proxyUrl = data.stream_url;
    if (!isFromCache) {
      proxyUrl = `/proxy?url=${encodeURIComponent(data.stream_url)}`;
      if (data.referrer) {
        proxyUrl += `&ref=${encodeURIComponent(data.referrer)}`;
      }
    }

    if (currentHlsInstance) {
      currentHlsInstance.destroy();
      currentHlsInstance = null;
    }

    // Attach subtitles track if provided by the server
    videoPlayer.querySelectorAll("track").forEach((t) => t.remove());
    if (data.sub_url) {
      let subProxyUrl = data.sub_url;
      if (!isFromCache) {
        subProxyUrl = `/proxy?url=${encodeURIComponent(data.sub_url)}`;
        if (data.referrer) {
          subProxyUrl += `&ref=${encodeURIComponent(data.referrer)}`;
        }
      }
      const track = document.createElement("track");
      track.kind = "subtitles";
      track.label = "English";
      track.srclang = "en";
      track.src = subProxyUrl;
      track.default = true;
      videoPlayer.appendChild(track);
    }

    const resumePlayback = () => {
      if (videoPlayer.textTracks && videoPlayer.textTracks.length > 0) {
        videoPlayer.textTracks[0].mode = data.sub_url ? "showing" : "disabled";
      }

      const savedTime = localStorage.getItem(`save_${currentShowId}_${epNum}`);
      if (savedTime) {
        const parsedTime = parseFloat(savedTime);
        const applySavedTime = () => {
          if (
            videoPlayer.duration &&
            parsedTime >= videoPlayer.duration - 60
          ) {
            localStorage.removeItem(`save_${currentShowId}_${epNum}`);
            videoPlayer.currentTime = 0;
          } else {
            videoPlayer.currentTime = parsedTime;
          }
        };
        if (videoPlayer.duration) {
          applySavedTime();
        } else {
          videoPlayer.addEventListener("loadedmetadata", applySavedTime, {
            once: true,
          });
        }
      } else {
        videoPlayer.currentTime = 0;
      }

      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: `Episode ${epNum}`,
          artist: currentShowName,
          album: "Watch Together",
        });
      }

      if (isSyncEnabled) {
        videoPlayer.pause();
        videoOverlay.innerHTML = "Waiting for friend to buffer...";
        videoOverlay.classList.remove("hidden");
      } else {
        videoPlayer
          .play()
          .then(() => {
            videoOverlay.classList.add("hidden");
          })
          .catch((error) => {
            console.warn("Autoplay blocked by browser:", error);
            videoOverlay.innerHTML =
              "Browser Blocked Autoplay.<br><br><b>Click Here to Play</b>";
            videoOverlay.classList.remove("hidden");
            videoWrapper.classList.add("paused");
          });
      }
    };

    if (
      !isFromCache &&
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

function stopPlayerMedia() {
  videoPlayer.pause();
  videoPlayer.removeAttribute("src");
  if (currentHlsInstance) {
    currentHlsInstance.destroy();
    currentHlsInstance = null;
  }
  videoPlayer.load();
}

function showSearchView() {
  lastBrowseWindow = "main";
  searchView.classList.remove("hidden");
  if (libraryView) libraryView.classList.add("hidden");
  watchView.classList.add("hidden");
  if (navMainBtn) navMainBtn.classList.add("active");
  if (navLibraryBtn) navLibraryBtn.classList.remove("active");
  stopPlayerMedia();

  // Clear search input so home page features (schedule, continue watching) reappear
  searchInput.value = "";

  renderContinueWatching();

  if (searchInput.value.trim() === "") {
    if (scheduleContainer) scheduleContainer.classList.remove("hidden");
    resultsGrid.innerHTML = "";
  }
}

function showLibraryView() {
  lastBrowseWindow = "library";
  searchView.classList.add("hidden");
  if (libraryView) libraryView.classList.remove("hidden");
  watchView.classList.add("hidden");
  if (navMainBtn) navMainBtn.classList.remove("active");
  if (navLibraryBtn) navLibraryBtn.classList.add("active");
  stopPlayerMedia();
  fetchLibraryData();
}

function showWatchView() {
  searchView.classList.add("hidden");
  if (libraryView) libraryView.classList.add("hidden");
  watchView.classList.remove("hidden");
  if (backBtn) {
    backBtn.textContent =
      lastBrowseWindow === "library" ? "← Back to Library" : "← Back to Search";
  }
  if (document.activeElement && document.activeElement !== document.body) {
    document.activeElement.blur();
  }
}

// ==========================================
// Socket.IO State Machine & Sync Protocol
// ==========================================
const socket = typeof io !== "undefined" ? io() : null;

videoPlayer.addEventListener("waiting", () => {
  videoPlayer.dataset.isBuffering = "true";
});
videoPlayer.addEventListener("playing", () => {
  videoPlayer.dataset.isBuffering = "false";
});
videoPlayer.addEventListener("canplay", () => {
  videoPlayer.dataset.isBuffering = "false";
});

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

  socket.on("receive_play", (data) => {
    if (!isSyncEnabled) return;
    isRemoteAction = true;
    if (Math.abs(videoPlayer.currentTime - data.time) > 1) {
      videoPlayer.currentTime = data.time;
    }

    videoPlayer
      .play()
      .then(() => {
        videoOverlay.classList.add("hidden");
      })
      .catch((e) => {
        console.warn("Autoplay blocked:", e);
        videoOverlay.innerHTML =
          "Browser Blocked Autoplay.<br><br><b>Click Here to Sync</b>";
        videoOverlay.classList.remove("hidden");
      });
  });

  socket.on("receive_pause", (data) => {
    if (!isSyncEnabled) return;
    isRemoteAction = true;
    videoPlayer.pause();
    if (Math.abs(videoPlayer.currentTime - data.time) > 1) {
      videoPlayer.currentTime = data.time;
    }
  });

  socket.on("receive_seek", (data) => {
    if (!isSyncEnabled) return;
    isRemoteAction = true;
    videoPlayer.currentTime = data.time;
  });

  socket.on("request_heartbeat", () => {
    if (!isSyncEnabled) return;

    let currentStatus = watchView.classList.contains("hidden")
      ? "browsing"
      : "watching";
    let vidState = "paused";

    if (currentStatus === "watching") {
      if (
        videoPlayer.dataset.isBuffering === "true" ||
        videoPlayer.readyState < 3
      ) {
        vidState = "buffering";
      } else if (!videoPlayer.paused) {
        vidState = "playing";
      }
    }

    socket.emit("report_state", {
      status: currentStatus,
      video_state: vidState,
      time: videoPlayer.currentTime || 0,
      showId: currentShowId,
      epNum: currentEpNum,
    });
  });

  socket.on("force_load", (data) => {
    if (!isSyncEnabled) return;
    if (currentShowId !== data.showId || currentEpNum !== data.epNum) {
      console.log("Sync: Pulled into friend's watch party.");
      loadEpisodes(data.showId, "Watch Party", data.epNum, true);
    }
  });

  socket.on("sync_correction", (cmd) => {
    if (!isSyncEnabled) return;

    if (cmd.action === "pause_for_buffer") {
      if (!videoPlayer.paused) {
        isRemoteAction = true;
        videoPlayer.pause();
        videoOverlay.innerHTML = "Waiting for friend to buffer...";
        videoOverlay.classList.remove("hidden");
      }
    } else if (cmd.action === "pause_timeout") {
      if (!videoPlayer.paused) {
        isRemoteAction = true;
        videoPlayer.pause();
        videoOverlay.innerHTML = "Syncing... Waiting for friend to catch up.";
        videoOverlay.classList.remove("hidden");

        setTimeout(() => {
          videoOverlay.classList.add("hidden");
          isRemoteAction = true;
          videoPlayer.play().catch((e) => {
            console.warn("Autoplay blocked:", e);
            videoOverlay.innerHTML =
              "Browser Blocked Autoplay.<br><br><b>Click Here to Sync</b>";
            videoOverlay.classList.remove("hidden");
          });
        }, cmd.timeout_ms);
      }
    } else if (cmd.action === "all_ready_play") {
      if (videoPlayer.paused) {
        isRemoteAction = true;
        videoPlayer
          .play()
          .then(() => {
            videoOverlay.classList.add("hidden");
          })
          .catch((e) => {
            console.warn("Autoplay blocked:", e);
            videoOverlay.innerHTML =
              "Browser Blocked Autoplay.<br><br><b>Click Here to Start Sync</b>";
            videoOverlay.classList.remove("hidden");
          });
      } else if (cmd.action === "resync_time") {
        isRemoteAction = true;
        videoPlayer.currentTime = cmd.target_time;
      } else {
        videoOverlay.classList.add("hidden");
      }
    }
  });
}

// ==========================================
// anipy-api Seasonal Releases Integration
// ==========================================
const scheduleGrid = document.getElementById("schedule-grid");
const scheduleTitle = document.getElementById("schedule-title");
const scheduleControls = document.getElementById("schedule-controls");

function getCurrentSeasonInfo() {
  const now = new Date();
  const month = now.getMonth(); // 0 (Jan) to 11 (Dec)
  const year = now.getFullYear();

  let season = "WINTER";
  if (month >= 2 && month <= 4) season = "SPRING"; // March to May
  else if (month >= 5 && month <= 7) season = "SUMMER"; // June to August
  else if (month >= 8 && month <= 10) season = "FALL"; // September to November

  return { season, year };
}

document.addEventListener("DOMContentLoaded", () => {
  if (scheduleControls) {
    buildSeasonalFilters();
  }
});

function buildSeasonalFilters() {
  // FIX: Define 'current' so the UI knows what the current season and year are
  const current = getCurrentSeasonInfo();

  scheduleControls.innerHTML = `
    <select id="season-select" class="ep-btn" style="padding: 0.5rem; background: var(--bg-card); color: var(--text-light); border: 1px solid var(--border-color);">
      <option value="WINTER" ${current.season === "WINTER" ? "selected" : ""}>Winter</option>
      <option value="SPRING" ${current.season === "SPRING" ? "selected" : ""}>Spring</option>
      <option value="SUMMER" ${current.season === "SUMMER" ? "selected" : ""}>Summer</option>
      <option value="FALL" ${current.season === "FALL" ? "selected" : ""}>Fall</option>
    </select>
    <select id="year-select" class="ep-btn" style="padding: 0.5rem; background: var(--bg-card); color: var(--text-light); border: 1px solid var(--border-color);">
      <option value="${current.year + 1}">${current.year + 1}</option>
      <option value="${current.year}" selected>${current.year}</option>
      <option value="${current.year - 1}">${current.year - 1}</option>
      <option value="${current.year - 2}">${current.year - 2}</option>
    </select>
    <button id="seasonal-search-btn" class="ep-btn active" style="padding: 0.5rem 1rem;">Load Season</button>
    <button id="force-update-btn" class="ep-btn" style="padding: 0.5rem 1rem; background: var(--primary); color: white;">Force Update</button>
  `;

  document.getElementById("seasonal-search-btn").addEventListener("click", () => {
    const year = document.getElementById("year-select").value;
    const season = document.getElementById("season-select").value;
    fetchSeasonal(year, season);
  });

  document.getElementById("force-update-btn").addEventListener("click", async (e) => {
    e.target.disabled = true;
    const originalText = e.target.textContent;
    e.target.textContent = "Updating...";
    const year = document.getElementById("year-select").value;
    const season = document.getElementById("season-select").value;
    try {
      const res = await fetch(
        `/api/seasonal/force_update?year=${encodeURIComponent(year)}&season=${encodeURIComponent(season)}`,
        { method: "POST" },
      );
      if (res.ok) {
        e.target.textContent = "Updated!";
        await fetchSeasonal(year, season);
      } else {
        throw new Error("Update failed");
      }
    } catch (err) {
      console.error(err);
      e.target.textContent = "Error";
    } finally {
      setTimeout(() => {
        e.target.textContent = originalText;
        e.target.disabled = false;
      }, 3000);
    }
  });

  // FIX: Automatically load the calculated current season on first load
  fetchSeasonal(current.year, current.season);
}

async function fetchSeasonal(year, season) {
  if (!scheduleTitle || !scheduleGrid) return;

  scheduleTitle.textContent = `Loading ${season} ${year}...`;
  scheduleGrid.innerHTML = "";

  try {
    const res = await fetch(`/api/seasonal?year=${year}&season=${season}`);
    const json = await res.json();

    if (json.data && json.data.length > 0) {
      let animeList = json.data;

      // --- TRACKER LOGIC: Diff current fetch against local storage ---
      const trackerKey = `season_tracker_${season}_${year}`;
      let tracker = JSON.parse(localStorage.getItem(trackerKey) || "{}");
      let updatedTracker = {};

      animeList = animeList.map(anime => {
        const id = anime._id || anime.name;
        // Parse ints safely, default to 0 if API returns "?" or undefined
        const subCount = parseInt(anime.availableEpisodes?.sub) || 0;
        const dubCount = parseInt(anime.availableEpisodes?.dub) || 0;

        let isNew = false;

        // If we have seen this show before, check if counts increased
        if (tracker[id]) {
           if (subCount > tracker[id].sub || dubCount > tracker[id].dub) {
               isNew = true;
           } else if (tracker[id].isNew) {
               isNew = true;
           }
        }

        // Build the new snapshot to save
        updatedTracker[id] = { sub: subCount, dub: dubCount, isNew: isNew };

        return { ...anime, isNew };
      });

      // Save the updated snapshot
      localStorage.setItem(trackerKey, JSON.stringify(updatedTracker));

      // Sort array: Push 'isNew = true' items to the top
      animeList.sort((a, b) => (b.isNew === true ? 1 : 0) - (a.isNew === true ? 1 : 0));

      scheduleTitle.textContent = `${season.charAt(0).toUpperCase() + season.slice(1).toLowerCase()} ${year} Releases`;
      renderSeasonal(animeList, trackerKey);
    } else {
      scheduleTitle.textContent = `${season} ${year}`;
      scheduleGrid.innerHTML = "<p>No releases found for this season.</p>";
    }
  } catch (err) {
    console.error("Failed to load seasonal data", err);
    scheduleTitle.textContent = "Error Loading Season";
  }
}

function renderSeasonal(animeList, trackerKey) {
  scheduleGrid.innerHTML = "";

  animeList.forEach((anime) => {
    const card = document.createElement("div");
    card.className = "card";

    const title = anime.name || "Unknown Title";
    const id = anime._id || anime.name;

    // Create a NEW badge if the tracker flagged it
    const badgeHtml = anime.isNew
      ? `<span class="new-badge" style="background: var(--primary); color: white; padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; margin-left: 8px;">NEW</span>`
      : "";

    const cachedTagInline = isAnimeCached(id)
      ? `<span class="cached-badge" style="margin-left: 6px;">✓ CACHED</span>`
      : "";

    // FIX: Remove the falsy trap. Explicitly check for undefined, null, and "?"
    const subVal = anime.availableEpisodes?.sub;
    const dubVal = anime.availableEpisodes?.dub;

    const subCount = (subVal !== undefined && subVal !== null && subVal !== "?") ? subVal : "-";
    const dubCount = (dubVal !== undefined && dubVal !== null && dubVal !== "?") ? dubVal : "-";

    card.innerHTML = `
      ${posterHtml(anime.image, title, id)}
      <div style="padding: 0.5rem;">
          <h4 style="margin-bottom: 0.3rem; font-size: 1rem; display: flex; align-items: center; justify-content: space-between; gap: 4px;">
             <span style="flex: 1;">${escapeHtml(title)}</span>
             <span class="badge-container" style="display: flex; align-items: center;">
               <span data-inline-cache-for="${escapeHtml(id)}">${cachedTagInline}</span>
               ${badgeHtml}
             </span>
          </h4>
          <p class="ep-count-text" style="color: var(--primary); font-weight: bold; font-size: 0.85rem;">
              Sub: ${escapeHtml(subCount)} | Dub: ${escapeHtml(dubCount)}
          </p>
      </div>
    `;

    bindCardHoverActions(card, id, title, anime.image || "");

    card.addEventListener("click", () => {
      // Clear the "NEW" status in local storage when the user clicks the card
      let tracker = JSON.parse(localStorage.getItem(trackerKey) || "{}");
      if (tracker[id]) {
          tracker[id].isNew = false;
          localStorage.setItem(trackerKey, JSON.stringify(tracker));
      }
      const badge = card.querySelector('.new-badge');
      if (badge) badge.remove();

      // Load episode or search
      if (anime._id) {
          loadEpisodes(anime._id, title, 1, false, anime.image || "");
      } else {
          searchInput.value = title;
          searchForm.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      }
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

function deleteFromWatchHistory(item) {
  if (!item) return;

  let history = JSON.parse(localStorage.getItem("watchHistory") || "[]");
  history = history.filter(
    (h) =>
      h.id !== item.id &&
      !(item.name && h.name && h.name === item.name),
  );
  localStorage.setItem("watchHistory", JSON.stringify(history));

  const prefixes = [];
  if (item.id) prefixes.push(`save_${item.id}_`);
  if (item.name && item.name !== item.id) prefixes.push(`save_${item.name}_`);

  const keysToRemove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && prefixes.some((prefix) => key.startsWith(prefix))) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach((key) => localStorage.removeItem(key));

  renderContinueWatching();
}

function renderContinueWatching() {
  if (!cwContainer || !cwControls) return;

  let history = JSON.parse(localStorage.getItem("watchHistory") || "[]");
  const validHistory = history.filter(
    (item) => item && item.id && item.id !== "undefined" && item.id !== "null",
  );

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
    const showKey = item.name || item.id;
    const cachedBadgeHtml = isAnimeCached(showKey)
      ? `<span class="cached-badge" style="margin-left: 6px;">✓ CACHED</span>`
      : "";
    card.innerHTML = `
            <button type="button" class="history-delete-btn" title="Remove from watch history" aria-label="Remove from watch history">&times;</button>
            <div>
                <h4>${escapeHtml(item.name)}</h4>
                <p style="font-size: 0.85rem; color: var(--text-muted);">Resume watching</p>
            </div>
            <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 4px; margin-top: 0.8rem;">
                <span class="ep-badge" style="margin-top: 0;">Episode ${escapeHtml(item.ep)}</span>
                <span data-inline-cache-for="${escapeHtml(showKey)}">${cachedBadgeHtml}</span>
            </div>
        `;

    const deleteBtn = card.querySelector(".history-delete-btn");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (
          window.confirm(
            `Are you sure you want to remove "${item.name}" from your watch history?`,
          )
        ) {
          deleteFromWatchHistory(item);
        }
      });
    }

    card.addEventListener("click", () => {
      if (isSyncEnabled && socket) {
        socket.emit("load_show_action", {
          showId: showKey,
          showName: item.name,
          targetEpNum: item.ep,
        });
      }
      loadEpisodes(showKey, item.name, item.ep);
    });

    cwControls.appendChild(card);
  });
}

// ==========================================
// 3. Update Progress Bar, Buffer, & Time Display
// ==========================================

let isDraggingProgress = false;

progressBar.addEventListener("mousedown", () => (isDraggingProgress = true));
progressBar.addEventListener("touchstart", () => (isDraggingProgress = true));

progressBar.addEventListener("mouseup", () => (isDraggingProgress = false));
progressBar.addEventListener("touchend", () => (isDraggingProgress = false));

videoPlayer.addEventListener("progress", () => {
  if (videoPlayer.duration > 0 && videoPlayer.buffered.length > 0) {
    const bufferedEnd = videoPlayer.buffered.end(
      videoPlayer.buffered.length - 1,
    );
    const bufferPercent = (bufferedEnd / videoPlayer.duration) * 100;
    progressBar.style.setProperty("--buffered-pct", `${bufferPercent}%`);
  }
});

videoPlayer.addEventListener("timeupdate", () => {
  if (!videoOverlay.classList.contains("hidden")) return;
  if (!videoPlayer.duration) return;

  const currentTime = videoPlayer.currentTime;

  if (!isDraggingProgress) {
    const progressPercent = (currentTime / videoPlayer.duration) * 100;
    progressBar.value = progressPercent;
    progressBar.style.setProperty("--played-pct", `${progressPercent}%`);
  }

  timeDisplay.textContent = `${formatTime(currentTime)} / ${formatTime(videoPlayer.duration)}`;

  if (currentShowId && currentEpNum && currentTime > 0) {
    if (
      videoPlayer.ended ||
      (videoPlayer.duration && videoPlayer.duration - currentTime <= 5)
    ) {
      localStorage.removeItem(`save_${currentShowId}_${currentEpNum}`);
    } else {
      localStorage.setItem(`save_${currentShowId}_${currentEpNum}`, currentTime);
    }
  }

  if (currentSkipTimes.length > 0) {
    const matchingSkip = currentSkipTimes.find(
      (skip) => currentTime >= skip.start && currentTime <= skip.end,
    );

    if (matchingSkip) {
      if (activeSkip !== matchingSkip) {
        activeSkip = matchingSkip;
        showSkipButton(matchingSkip);
      }
    } else {
      if (activeSkip !== null) {
        activeSkip = null;
        hideSkipButton();
      }
    }
  }
});

// ==========================================
// 4. Seek via Custom Progress Bar
// ==========================================

progressBar.addEventListener("input", (e) => {
  progressBar.style.setProperty("--played-pct", `${e.target.value}%`);
});

progressBar.addEventListener("change", (e) => {
  const newTime = (e.target.value / 100) * videoPlayer.duration;
  videoPlayer.currentTime = newTime;
});

// ==========================================
// 5. Offline Library, Storage Status & Download System
// ==========================================

async function fetchLibraryData() {
  try {
    const res = await fetch("/api/library");
    if (!res.ok) return;
    const data = await res.json();
    cachedAnimeMap = data.cached_map || {};
    libraryAnimeList = data.anime || [];

    if (libraryCountBadge) {
      const count = libraryAnimeList.length;
      libraryCountBadge.textContent = count;
      libraryCountBadge.classList.toggle("hidden", count === 0);
    }

    renderStorageStatus(data.storage);
    renderLibraryGrid();
    refreshCachedBadgesInDOM();
  } catch (err) {
    console.warn("Could not fetch library data:", err);
  }
}

function renderStorageStatus(storage) {
  if (!storage) return;
  const freeEl = document.getElementById("storage-free-value");
  const cacheEl = document.getElementById("storage-cache-value");
  const totalEl = document.getElementById("storage-total-value");
  const subtextEl = document.getElementById("storage-detail-subtext");
  const barSystem = document.getElementById("storage-bar-system");
  const barCache = document.getElementById("storage-bar-cache");

  if (freeEl) {
    freeEl.textContent = `${formatBytes(storage.free_bytes)} Free`;
  }
  if (cacheEl) {
    cacheEl.textContent = `${formatBytes(storage.cache_bytes)} (${storage.cached_episodes_count || 0} ep${storage.cached_episodes_count === 1 ? "" : "s"})`;
  }
  if (totalEl) {
    totalEl.textContent = `${formatBytes(storage.used_bytes)} / ${formatBytes(storage.total_bytes)} (${storage.used_percent || 0}%)`;
  }
  if (subtextEl) {
    subtextEl.textContent = `${formatBytes(storage.free_bytes)} space left on device • ${storage.cached_anime_count || 0} cached anime (${storage.cached_episodes_count || 0} cached episodes)`;
  }

  if (barSystem && barCache && storage.total_bytes > 0) {
    const cachePct = Math.min(
      100,
      Math.max(0, (storage.cache_bytes / storage.total_bytes) * 100),
    );
    const otherUsedBytes = Math.max(0, storage.used_bytes - storage.cache_bytes);
    const systemPct = Math.min(
      100 - cachePct,
      Math.max(0, (otherUsedBytes / storage.total_bytes) * 100),
    );
    barSystem.style.width = `${systemPct.toFixed(2)}%`;
    barCache.style.width = `${cachePct.toFixed(2)}%`;
  }
}

function renderLibraryGrid() {
  if (!libraryGrid) return;
  const filterQ = (librarySearchInput?.value || "").trim().toLowerCase();

  const filtered = libraryAnimeList.filter((item) => {
    if (!filterQ) return true;
    const nameMatch = (item.name || "").toLowerCase().includes(filterQ);
    const altMatch = (item.alt_names || []).some((a) =>
      String(a).toLowerCase().includes(filterQ),
    );
    return nameMatch || altMatch;
  });

  libraryGrid.innerHTML = "";

  if (libraryEmptyState) {
    libraryEmptyState.classList.toggle("hidden", libraryAnimeList.length > 0);
  }

  if (libraryAnimeList.length > 0 && filtered.length === 0) {
    libraryGrid.innerHTML = "<p>No cached anime match your filter.</p>";
    return;
  }

  filtered.forEach((anime) => {
    const card = document.createElement("div");
    card.className = "card";
    const id = anime._id || anime.name;
    const title = anime.name || id;
    const subCached = anime.cached_episodes?.sub || [];
    const dubCached = anime.cached_episodes?.dub || [];
    const sizeText = formatBytes(anime.total_size_bytes || 0);

    card.innerHTML = `
      ${posterHtml(anime.image, title, id, {
        posterUrl: anime.poster_url,
        showDeleteBtn: true,
      })}
      <div style="padding: 0.5rem;">
        <h4 style="margin-bottom: 0.35rem; font-size: 1rem; display: flex; align-items: center; justify-content: space-between; gap: 6px;">
          <span style="flex: 1;">${escapeHtml(title)}</span>
          <span class="cached-badge">✓ CACHED</span>
        </h4>
        <p class="ep-count-text" style="color: var(--primary); font-weight: bold; font-size: 0.85rem; margin-bottom: 0.25rem;">
          Cached Sub: ${subCached.length} | Dub: ${dubCached.length}
        </p>
        <p style="color: var(--text-muted); font-size: 0.78rem;">
          Disk Size: ${escapeHtml(sizeText)} • Ready Offline
        </p>
      </div>
    `;

    bindCardHoverActions(card, id, title, anime.image || "", async () => {
      if (
        window.confirm(
          `Remove "${title}" (${anime.cached_count} cached episode${anime.cached_count === 1 ? "" : "s"}, ${sizeText}) from your offline library?`,
        )
      ) {
        await deleteCachedAnime(id);
      }
    });

    card.addEventListener("click", () => {
      let targetEp = 1;
      if (subCached.length > 0) {
        targetEp = subCached[0];
        localStorage.setItem(`langPref_${id}`, "sub");
      } else if (dubCached.length > 0) {
        targetEp = dubCached[0];
        localStorage.setItem(`langPref_${id}`, "dub");
      }
      const history = JSON.parse(localStorage.getItem("watchHistory") || "[]");
      const savedShow = history.find(
        (item) => item.name === title || item.id === id,
      );
      if (savedShow && savedShow.ep) {
        targetEp = savedShow.ep;
      }
      loadEpisodes(id, title, targetEp, false, anime.image || "");
    });

    libraryGrid.appendChild(card);
  });
}

async function deleteCachedAnime(animeId) {
  try {
    const res = await fetch(
      `/api/library/anime/${encodeURIComponent(animeId)}`,
      { method: "DELETE" },
    );
    if (res.ok) {
      await fetchLibraryData();
    }
  } catch (err) {
    console.error("Failed to delete cached anime:", err);
  }
}

function refreshCachedBadgesInDOM() {
  document.querySelectorAll("[data-cache-badge-for]").forEach((el) => {
    const key = el.getAttribute("data-cache-badge-for");
    const info = getAnimeCacheInfo(key);
    if (info && info.total > 0) {
      el.innerHTML = `<span class="cached-badge" title="${info.total} episode(s) cached for offline playback">✓ CACHED</span>`;
    } else {
      el.innerHTML = "";
    }
  });

  document.querySelectorAll("[data-inline-cache-for]").forEach((el) => {
    const key = el.getAttribute("data-inline-cache-for");
    if (isAnimeCached(key)) {
      el.innerHTML = `<span class="cached-badge">✓ CACHED</span>`;
    } else {
      el.innerHTML = "";
    }
  });

  if (currentShowId && !watchView.classList.contains("hidden")) {
    updateWatchHeaderBadges(
      !watchOfflinePlayingBadge?.classList.contains("hidden"),
    );
    const mode = modeToggle.value;
    document.querySelectorAll("#episode-grid .ep-btn").forEach((btn) => {
      const epStr = btn.dataset.ep || btn.textContent;
      const cached = isEpisodeCachedInCurrentShow(epStr, mode);
      btn.classList.toggle("cached-ep", cached);
      if (cached) {
        btn.title = `Episode ${epStr} (Cached for offline playback)`;
      }
    });
  }
}

// ==========================================
// Player Screen Download & Episode Selection Controls
// ==========================================
const playerTargetCacheBtn = document.getElementById("player-target-cache-btn");
const playerTargetLocalBtn = document.getElementById("player-target-local-btn");
const dlAllEpsBtn = document.getElementById("dl-all-eps-btn");
const dlCurrentEpBtn = document.getElementById("dl-current-ep-btn");
const toggleSelectEpsBtn = document.getElementById("toggle-select-eps-btn");
const epSelectionBar = document.getElementById("ep-selection-bar");
const selAllEpsBtn = document.getElementById("sel-all-eps-btn");
const selUncachedEpsBtn = document.getElementById("sel-uncached-eps-btn");
const selClearEpsBtn = document.getElementById("sel-clear-eps-btn");
const dlSelectedConfirmBtn = document.getElementById("dl-selected-confirm-btn");
const selEpCountEl = document.getElementById("sel-ep-count");

function setPlayerDownloadTarget(target) {
  playerDownloadTarget = target === "local" ? "local" : "cache";
  if (playerTargetCacheBtn) {
    playerTargetCacheBtn.classList.toggle(
      "active",
      playerDownloadTarget === "cache",
    );
  }
  if (playerTargetLocalBtn) {
    playerTargetLocalBtn.classList.toggle(
      "active",
      playerDownloadTarget === "local",
    );
  }
}

if (playerTargetCacheBtn) {
  playerTargetCacheBtn.addEventListener("click", () =>
    setPlayerDownloadTarget("cache"),
  );
}
if (playerTargetLocalBtn) {
  playerTargetLocalBtn.addEventListener("click", () =>
    setPlayerDownloadTarget("local"),
  );
}

function exitPlayerEpisodeSelectionMode() {
  isSelectingEpisodesForDownload = false;
  selectedPlayerEpisodes.clear();
  if (toggleSelectEpsBtn) {
    toggleSelectEpsBtn.classList.remove("selecting-active");
    toggleSelectEpsBtn.textContent = "☑ Choose Episodes";
  }
  if (epSelectionBar) {
    epSelectionBar.classList.add("hidden");
  }
  document.querySelectorAll("#episode-grid .ep-btn").forEach((b) => {
    b.classList.remove("selected-for-dl");
  });
  updatePlayerSelectedEpCounter();
}

function updatePlayerSelectedEpCounter() {
  if (selEpCountEl) {
    selEpCountEl.textContent = selectedPlayerEpisodes.size;
  }
}

if (toggleSelectEpsBtn) {
  toggleSelectEpsBtn.addEventListener("click", () => {
    if (isSelectingEpisodesForDownload) {
      exitPlayerEpisodeSelectionMode();
    } else {
      isSelectingEpisodesForDownload = true;
      toggleSelectEpsBtn.classList.add("selecting-active");
      toggleSelectEpsBtn.textContent = "✕ Cancel Selection";
      if (epSelectionBar) epSelectionBar.classList.remove("hidden");
      updatePlayerSelectedEpCounter();
    }
  });
}

if (selAllEpsBtn) {
  selAllEpsBtn.addEventListener("click", () => {
    currentEpisodeList.forEach((ep) => selectedPlayerEpisodes.add(String(ep)));
    document.querySelectorAll("#episode-grid .ep-btn").forEach((b) => {
      b.classList.add("selected-for-dl");
    });
    updatePlayerSelectedEpCounter();
  });
}

if (selUncachedEpsBtn) {
  selUncachedEpsBtn.addEventListener("click", () => {
    selectedPlayerEpisodes.clear();
    const mode = modeToggle.value;
    document.querySelectorAll("#episode-grid .ep-btn").forEach((b) => {
      const epStr = String(b.dataset.ep || b.textContent);
      if (!isEpisodeCachedInCurrentShow(epStr, mode)) {
        selectedPlayerEpisodes.add(epStr);
        b.classList.add("selected-for-dl");
      } else {
        b.classList.remove("selected-for-dl");
      }
    });
    updatePlayerSelectedEpCounter();
  });
}

if (selClearEpsBtn) {
  selClearEpsBtn.addEventListener("click", () => {
    selectedPlayerEpisodes.clear();
    document.querySelectorAll("#episode-grid .ep-btn").forEach((b) => {
      b.classList.remove("selected-for-dl");
    });
    updatePlayerSelectedEpCounter();
  });
}

if (dlAllEpsBtn) {
  dlAllEpsBtn.addEventListener("click", async () => {
    if (!currentShowId || !currentEpisodeList.length) return;
    await startDownloadRequest({
      anime_id: currentShowId,
      anime_name: currentShowName || currentShowId,
      image: currentShowImage || "",
      episodes: currentEpisodeList.map(String),
      mode: modeToggle.value,
      target: playerDownloadTarget,
    });
  });
}

if (dlCurrentEpBtn) {
  dlCurrentEpBtn.addEventListener("click", async () => {
    if (!currentShowId || !currentEpNum) return;
    await startDownloadRequest({
      anime_id: currentShowId,
      anime_name: currentShowName || currentShowId,
      image: currentShowImage || "",
      episodes: [String(currentEpNum)],
      mode: modeToggle.value,
      target: playerDownloadTarget,
    });
  });
}

if (dlSelectedConfirmBtn) {
  dlSelectedConfirmBtn.addEventListener("click", async () => {
    if (!currentShowId || selectedPlayerEpisodes.size === 0) return;
    const epsToDl = Array.from(selectedPlayerEpisodes);
    exitPlayerEpisodeSelectionMode();
    await startDownloadRequest({
      anime_id: currentShowId,
      anime_name: currentShowName || currentShowId,
      image: currentShowImage || "",
      episodes: epsToDl,
      mode: modeToggle.value,
      target: playerDownloadTarget,
    });
  });
}

// ==========================================
// Quick Download Modal (From Home / Library Hover)
// ==========================================
const dlModalBackdrop = document.getElementById("download-modal-backdrop");
const dlModalTitle = document.getElementById("dl-modal-title");
const closeDlModalBtn = document.getElementById("close-dl-modal-btn");
const modalOptCacheCard = document.getElementById("modal-opt-cache-card");
const modalOptLocalCard = document.getElementById("modal-opt-local-card");
const modalLangSelect = document.getElementById("modal-lang-select");
const modalEpisodesStatus = document.getElementById("modal-episodes-status");
const modalEpisodeGrid = document.getElementById("modal-episode-grid");
const modalSelAllBtn = document.getElementById("modal-sel-all-btn");
const modalSelUncachedBtn = document.getElementById("modal-sel-uncached-btn");
const modalSelNoneBtn = document.getElementById("modal-sel-none-btn");
const modalDlSelectedBtn = document.getElementById("modal-dl-selected-btn");
const modalDlAllBtn = document.getElementById("modal-dl-all-btn");
const modalSelCountEl = document.getElementById("modal-sel-count");

let modalState = {
  animeId: "",
  animeName: "",
  animeImage: "",
  target: "cache",
  episodesData: { sub: [], dub: [], cached: { sub: [], dub: [] } },
  selectedEps: new Set(),
};

function setModalTargetOption(targetVal) {
  modalState.target = targetVal === "local" ? "local" : "cache";
  if (modalOptCacheCard) {
    modalOptCacheCard.classList.toggle("active", modalState.target === "cache");
    const r = modalOptCacheCard.querySelector("input[type='radio']");
    if (r) r.checked = modalState.target === "cache";
  }
  if (modalOptLocalCard) {
    modalOptLocalCard.classList.toggle("active", modalState.target === "local");
    const r = modalOptLocalCard.querySelector("input[type='radio']");
    if (r) r.checked = modalState.target === "local";
  }
}

if (modalOptCacheCard) {
  modalOptCacheCard.addEventListener("click", () =>
    setModalTargetOption("cache"),
  );
}
if (modalOptLocalCard) {
  modalOptLocalCard.addEventListener("click", () =>
    setModalTargetOption("local"),
  );
}

if (closeDlModalBtn) {
  closeDlModalBtn.addEventListener("click", closeDownloadModal);
}
if (dlModalBackdrop) {
  dlModalBackdrop.addEventListener("click", (e) => {
    if (e.target === dlModalBackdrop) closeDownloadModal();
  });
}

function closeDownloadModal() {
  if (dlModalBackdrop) dlModalBackdrop.classList.add("hidden");
}

async function openDownloadModal(animeId, animeName, animeImage = "") {
  if (!dlModalBackdrop) return;
  modalState.animeId = animeId;
  modalState.animeName = animeName || animeId;
  modalState.animeImage = animeImage || "";
  modalState.selectedEps.clear();
  setModalTargetOption("cache");

  if (dlModalTitle) {
    dlModalTitle.textContent = `Download: ${modalState.animeName}`;
  }
  if (modalEpisodesStatus) {
    modalEpisodesStatus.textContent = "Loading available episodes...";
  }
  if (modalEpisodeGrid) {
    modalEpisodeGrid.innerHTML = "";
  }
  if (modalSelCountEl) {
    modalSelCountEl.textContent = "0";
  }

  dlModalBackdrop.classList.remove("hidden");

  try {
    const res = await fetch(`/api/${encodeURIComponent(animeId)}/episodes`);
    if (!res.ok) throw new Error("Failed to fetch episodes");
    const epData = await res.json();
    modalState.episodesData = {
      sub: (epData.sub || []).map(String),
      dub: (epData.dub || []).map(String),
      cached: epData.cached || { sub: [], dub: [] },
    };

    if (
      modalState.episodesData.sub.length === 0 &&
      modalState.episodesData.dub.length > 0 &&
      modalLangSelect
    ) {
      modalLangSelect.value = "dub";
    } else if (modalLangSelect) {
      modalLangSelect.value = "sub";
    }

    renderModalEpisodes();
  } catch (err) {
    if (modalEpisodesStatus) {
      modalEpisodesStatus.textContent =
        "Could not load episode list, but you can still click Download All.";
    }
  }
}

function renderModalEpisodes() {
  if (!modalEpisodeGrid) return;
  const mode = modalLangSelect ? modalLangSelect.value : "sub";
  const eps = modalState.episodesData[mode] || [];
  const cachedInMode = new Set(
    (modalState.episodesData.cached?.[mode] || []).map(String),
  );
  modalState.selectedEps.clear();
  modalEpisodeGrid.innerHTML = "";

  if (modalEpisodesStatus) {
    modalEpisodesStatus.textContent =
      eps.length > 0
        ? `${eps.length} ${mode.toUpperCase()} episode(s) available (${cachedInMode.size} cached). Click episodes to select or click Download All:`
        : `No ${mode.toUpperCase()} episodes found.`;
  }

  if (modalDlAllBtn) {
    modalDlAllBtn.textContent =
      eps.length > 0
        ? `⬇ Download All (${eps.length})`
        : "⬇ Download All Episodes";
  }

  eps.forEach((epStr) => {
    const btn = document.createElement("button");
    btn.type = "button";
    const isCached = cachedInMode.has(epStr);
    btn.className = `ep-btn ${isCached ? "cached-ep" : ""}`;
    btn.dataset.ep = epStr;
    btn.textContent = epStr;
    if (isCached) {
      btn.title = `Episode ${epStr} is already cached`;
    }

    btn.addEventListener("click", () => {
      if (modalState.selectedEps.has(epStr)) {
        modalState.selectedEps.delete(epStr);
        btn.classList.remove("selected-for-dl");
      } else {
        modalState.selectedEps.add(epStr);
        btn.classList.add("selected-for-dl");
      }
      if (modalSelCountEl) {
        modalSelCountEl.textContent = modalState.selectedEps.size;
      }
    });

    modalEpisodeGrid.appendChild(btn);
  });

  if (modalSelCountEl) {
    modalSelCountEl.textContent = "0";
  }
}

if (modalLangSelect) {
  modalLangSelect.addEventListener("change", () => {
    renderModalEpisodes();
  });
}

if (modalSelAllBtn) {
  modalSelAllBtn.addEventListener("click", () => {
    const mode = modalLangSelect ? modalLangSelect.value : "sub";
    const eps = modalState.episodesData[mode] || [];
    eps.forEach((ep) => modalState.selectedEps.add(String(ep)));
    modalEpisodeGrid.querySelectorAll(".ep-btn").forEach((b) => {
      b.classList.add("selected-for-dl");
    });
    if (modalSelCountEl) modalSelCountEl.textContent = modalState.selectedEps.size;
  });
}

if (modalSelUncachedBtn) {
  modalSelUncachedBtn.addEventListener("click", () => {
    const mode = modalLangSelect ? modalLangSelect.value : "sub";
    const cachedInMode = new Set(
      (modalState.episodesData.cached?.[mode] || []).map(String),
    );
    modalState.selectedEps.clear();
    modalEpisodeGrid.querySelectorAll(".ep-btn").forEach((b) => {
      const epStr = String(b.dataset.ep || b.textContent);
      if (!cachedInMode.has(epStr)) {
        modalState.selectedEps.add(epStr);
        b.classList.add("selected-for-dl");
      } else {
        b.classList.remove("selected-for-dl");
      }
    });
    if (modalSelCountEl) modalSelCountEl.textContent = modalState.selectedEps.size;
  });
}

if (modalSelNoneBtn) {
  modalSelNoneBtn.addEventListener("click", () => {
    modalState.selectedEps.clear();
    modalEpisodeGrid.querySelectorAll(".ep-btn").forEach((b) => {
      b.classList.remove("selected-for-dl");
    });
    if (modalSelCountEl) modalSelCountEl.textContent = "0";
  });
}

if (modalDlAllBtn) {
  modalDlAllBtn.addEventListener("click", async () => {
    if (!modalState.animeId) return;
    const mode = modalLangSelect ? modalLangSelect.value : "sub";
    const eps = modalState.episodesData[mode] || [];
    closeDownloadModal();
    await startDownloadRequest({
      anime_id: modalState.animeId,
      anime_name: modalState.animeName,
      image: modalState.animeImage,
      episodes: eps.length > 0 ? eps : "all",
      mode: mode,
      target: modalState.target,
    });
  });
}

if (modalDlSelectedBtn) {
  modalDlSelectedBtn.addEventListener("click", async () => {
    if (!modalState.animeId || modalState.selectedEps.size === 0) {
      alert("Please select at least one episode first, or click Download All.");
      return;
    }
    const mode = modalLangSelect ? modalLangSelect.value : "sub";
    const eps = Array.from(modalState.selectedEps);
    closeDownloadModal();
    await startDownloadRequest({
      anime_id: modalState.animeId,
      anime_name: modalState.animeName,
      image: modalState.animeImage,
      episodes: eps,
      mode: mode,
      target: modalState.target,
    });
  });
}

// ==========================================
// Downloads Queue Drawer & Real-Time Progress
// ==========================================
const downloadsDrawer = document.getElementById("downloads-drawer");
const downloadsListEl = document.getElementById("downloads-list");
const closeDrawerBtn = document.getElementById("close-drawer-btn");
const clearCompletedDlBtn = document.getElementById("clear-completed-dl-btn");
const clearAllDlBtn = document.getElementById("clear-all-dl-btn");

if (navDownloadsBtn && downloadsDrawer) {
  navDownloadsBtn.addEventListener("click", () => {
    downloadsDrawer.classList.toggle("hidden");
    if (!downloadsDrawer.classList.contains("hidden")) {
      pollDownloadJobsStatus();
    }
  });
}
if (closeDrawerBtn && downloadsDrawer) {
  closeDrawerBtn.addEventListener("click", () => {
    downloadsDrawer.classList.add("hidden");
  });
}
if (clearCompletedDlBtn) {
  clearCompletedDlBtn.addEventListener("click", async () => {
    await fetch("/api/downloads/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: false }),
    });
    Object.keys(activeDownloadJobs).forEach((jid) => {
      if (
        ["completed", "failed", "cancelled"].includes(
          activeDownloadJobs[jid]?.status,
        )
      ) {
        delete activeDownloadJobs[jid];
      }
    });
    renderDownloadJobsList();
  });
}
if (clearAllDlBtn) {
  clearAllDlBtn.addEventListener("click", async () => {
    await fetch("/api/downloads/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
    activeDownloadJobs = {};
    renderDownloadJobsList();
  });
}

async function startDownloadRequest(payload) {
  try {
    if (downloadsDrawer) downloadsDrawer.classList.remove("hidden");
    const res = await fetch("/api/downloads/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || "Failed to start download.");
      return;
    }
    (data.jobs || []).forEach((j) => {
      activeDownloadJobs[j.job_id] = j;
      maybeTriggerBrowserDownload(j);
    });
    renderDownloadJobsList();
  } catch (err) {
    console.error("Failed to start download:", err);
  }
}

async function fetchDownloadJobs() {
  try {
    const res = await fetch("/api/downloads/status");
    if (!res.ok) return;
    const data = await res.json();
    activeDownloadJobs = {};
    (data.jobs || []).forEach((j) => {
      activeDownloadJobs[j.job_id] = j;
      if (j.status === "completed") {
        // Don't re-trigger old completed downloads on page reload
        triggeredLocalDownloads.add(j.job_id);
      }
    });
    renderDownloadJobsList();
  } catch (err) {}
}

async function pollDownloadJobsStatus() {
  try {
    const res = await fetch("/api/downloads/status");
    if (!res.ok) return;
    const data = await res.json();
    let newlyCompletedCache = false;
    const nextJobs = {};
    (data.jobs || []).forEach((j) => {
      const prev = activeDownloadJobs[j.job_id];
      if (
        prev &&
        prev.status !== "completed" &&
        j.status === "completed" &&
        j.target === "cache"
      ) {
        newlyCompletedCache = true;
      }
      nextJobs[j.job_id] = j;
      maybeTriggerBrowserDownload(j);
    });
    activeDownloadJobs = nextJobs;
    renderDownloadJobsList();
    if (newlyCompletedCache) {
      fetchLibraryData();
    }
  } catch (err) {}
}

// Poll every 1.5s whenever there are active jobs or the drawer is open
setInterval(() => {
  const hasRunning = Object.values(activeDownloadJobs).some((j) =>
    ["queued", "downloading", "remuxing"].includes(j.status),
  );
  const drawerOpen =
    downloadsDrawer && !downloadsDrawer.classList.contains("hidden");
  if (hasRunning || drawerOpen) {
    pollDownloadJobsStatus();
  }
}, 1500);

function maybeTriggerBrowserDownload(job) {
  if (
    job &&
    job.target === "local" &&
    job.status === "completed" &&
    job.download_url &&
    !triggeredLocalDownloads.has(job.job_id)
  ) {
    triggeredLocalDownloads.add(job.job_id);
    const a = document.createElement("a");
    a.href = job.download_url;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

function renderDownloadJobsList() {
  if (!downloadsListEl) return;
  const jobs = Object.values(activeDownloadJobs).sort(
    (a, b) => (b.created_at || 0) - (a.created_at || 0),
  );

  const runningCount = jobs.filter((j) =>
    ["queued", "downloading", "remuxing"].includes(j.status),
  ).length;

  if (downloadsActiveBadge) {
    downloadsActiveBadge.textContent = runningCount;
    downloadsActiveBadge.classList.toggle("hidden", runningCount === 0);
  }

  if (jobs.length === 0) {
    downloadsListEl.innerHTML = `<p class="empty-dl-msg">No active downloads.</p>`;
    return;
  }

  downloadsListEl.innerHTML = "";

  jobs.forEach((job) => {
    const card = document.createElement("div");
    card.className = "dl-job-card";

    const targetLabel =
      job.target === "local" ? "💻 Local Player" : "🌐 Website Cache";
    const pct = Math.round(job.progress || 0);
    const sizeStr = formatBytes(job.downloaded_bytes || 0);

    let statusText = job.status;
    if (job.status === "downloading") {
      statusText =
        job.total_segments > 0
          ? `Downloading (${job.completed_segments}/${job.total_segments} segs) • ${sizeStr}`
          : `Downloading • ${sizeStr}`;
    } else if (job.status === "queued") {
      statusText = "Queued...";
    } else if (job.status === "completed") {
      statusText = `Completed • ${sizeStr}`;
    } else if (job.status === "failed") {
      statusText = `Failed: ${job.error || "Error"}`;
    } else if (job.status === "cancelled") {
      statusText = "Cancelled";
    }

    const canCancel = ["queued", "downloading", "remuxing"].includes(job.status);
    const canRetry = ["failed", "cancelled"].includes(job.status);
    const canSaveLocal =
      job.target === "local" && job.status === "completed" && job.download_url;

    card.innerHTML = `
      <div class="dl-job-top">
        <div>
          <div class="dl-job-title">${escapeHtml(job.display_name || job.anime_name)} — Ep ${escapeHtml(job.episode_num)} (${escapeHtml((job.mode || "sub").toUpperCase())})</div>
          <div style="font-size: 0.73rem; color: var(--primary); font-weight: 600;">${targetLabel}</div>
        </div>
        <div style="display: flex; gap: 4px; align-items: center;">
          ${
            canSaveLocal
              ? `<a href="${escapeHtml(job.download_url)}" download class="mini-link-btn" style="text-decoration: none; color: #34d399; border-color: #10b981;">💾 Save MP4</a>`
              : ""
          }
          ${
            canRetry
              ? `<button type="button" class="mini-link-btn retry-job-btn" style="color: #60a5fa; border-color: rgba(96, 165, 250, 0.4);" title="Retry download">↻ Retry</button>`
              : ""
          }
          ${
            canCancel
              ? `<button type="button" class="mini-link-btn cancel-job-btn" title="Cancel download">Cancel</button>`
              : ""
          }
          <button type="button" class="mini-link-btn remove-job-btn" style="color: #f87171; border-color: rgba(239, 68, 68, 0.35); padding: 0.2rem 0.45rem;" title="Remove from queue">✕</button>
        </div>
      </div>
      <div class="dl-job-bar-bg">
        <div class="dl-job-bar-fill ${job.status === "completed" ? "completed" : ""} ${job.status === "failed" ? "failed" : ""}" style="width: ${pct}%"></div>
      </div>
      <div class="dl-job-meta">
        <span>${escapeHtml(statusText)}</span>
        <span>${pct}%</span>
      </div>
    `;

    const cancelBtn = card.querySelector(".cancel-job-btn");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", async () => {
        await fetch(`/api/downloads/cancel/${encodeURIComponent(job.job_id)}`, {
          method: "POST",
        });
        await pollDownloadJobsStatus();
      });
    }

    const retryBtn = card.querySelector(".retry-job-btn");
    if (retryBtn) {
      retryBtn.addEventListener("click", async () => {
        await fetch(`/api/downloads/retry/${encodeURIComponent(job.job_id)}`, {
          method: "POST",
        });
        await pollDownloadJobsStatus();
      });
    }

    const removeBtn = card.querySelector(".remove-job-btn");
    if (removeBtn) {
      removeBtn.addEventListener("click", async () => {
        delete activeDownloadJobs[job.job_id];
        renderDownloadJobsList();
        await fetch(`/api/downloads/${encodeURIComponent(job.job_id)}`, {
          method: "DELETE",
        });
      });
    }

    downloadsListEl.appendChild(card);
  });
}

if (socket) {
  socket.on("download_job_updated", (job) => {
    if (!job || !job.job_id) return;
    activeDownloadJobs[job.job_id] = job;
    maybeTriggerBrowserDownload(job);
    renderDownloadJobsList();
  });

  socket.on("library_updated", async () => {
    await fetchLibraryData();
    if (currentShowId && !watchView.classList.contains("hidden")) {
      try {
        const res = await fetch(
          `/api/${encodeURIComponent(currentShowId)}/episodes`,
        );
        if (res.ok) {
          const epData = await res.json();
          currentAllEpisodesData.cached = epData.cached || { sub: [], dub: [] };
          refreshCachedBadgesInDOM();
        }
      } catch (e) {}
    }
  });
}
