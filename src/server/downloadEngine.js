import fs from "fs";
import {downloadSong} from "../downloader.js";
import {
  DOWNLOADED_FILE_CLEANUP_INTERVAL_MS,
  DOWNLOADED_FILE_TTL_MS,
  DOWNLOAD_PIPELINE_TIMEOUT_MS,
  MAX_STORED_DOWNLOAD_JOBS,
} from "./constants.js";
import {
  applyFilenameMetadataFallback,
  clampProgress,
  extractTrackIdFromValue,
  mergeSongMetadata,
  upscaleArtworkUrl,
  withTimeout,
} from "./helpers.js";

const ERRORS = {
  notFound: "Download job not found",
  inProgress: "Download is already in progress.",
  retryData: "Retry data unavailable for this job.",
  missingSong: "Song not found in current search context. Search first, then download by index.",
  notDownloadable: "Selected item is not downloadable.",
};
const ACTIVE_STATUSES = new Set(["queued", "preparing", "downloading"]);
const DOWNLOADING_PHASES = new Set(["downloading", "saving", "done"]);
const DEFAULT_SETTING = "Hi-Res";
const PROGRESS_LOG_STEP = 20;
const fsStat = fs.promises.stat;
const fsUnlink = fs.promises.unlink;

function normalizeSong(song) {
  if (!song || typeof song !== "object") {
    return null;
  }
  const title = String(song.title || "").trim();
  if (!title) {
    return null;
  }
  const normalized = {
    title,
    artist: String(song.artist || "").trim(),
    album: String(song.album || "").trim(),
    subtitle: String(song.subtitle || "").trim(),
    artwork: upscaleArtworkUrl(song.artwork),
    duration: Number(song.duration) || 0,
    downloadable: song.downloadable !== false,
  };
  if (Number.isInteger(song.index)) {
    normalized.index = song.index;
  }
  const tidalId = extractTrackIdFromValue(song.tidalId || song.url);
  if (tidalId) {
    normalized.tidalId = tidalId;
  }
  const url = String(song.url || "").trim();
  if (url) {
    normalized.url = url;
  }
  return normalized;
}

export function createDownloadEngine({state, browserController, searchEngine}) {
  const resolveSongFromRequest = request =>
    searchEngine.getSongFromRequest(request.index, request.song) || request.song || null;

  function logDownload(message, payload = null) {
    if (payload) {
      console.log(`[download-engine] ${message}`, payload);
      return;
    }
    console.log(`[download-engine] ${message}`);
  }

  function summarizeRequest(request = {}) {
    return {
      index: Number.isInteger(request.index) ? request.index : null,
      downloadSetting: request.downloadSetting || DEFAULT_SETTING,
      title: request.song?.title || null,
      artist: request.song?.artist || null,
      tidalId: request.song?.tidalId || null,
      url: request.song?.url || null,
    };
  }

  function toProgressBucket(progress) {
    if (!Number.isFinite(progress)) {
      return -1;
    }
    const clamped = clampProgress(progress, 0);
    if (clamped === 100) {
      return 100;
    }
    return Math.floor(clamped / PROGRESS_LOG_STEP) * PROGRESS_LOG_STEP;
  }

  function pruneExpiredDownloadedSongs() {
    const now = Date.now();
    for (const [songId, entry] of state.downloadedSongs) {
      if (!entry?.expiresAt || entry.expiresAt >= now) {
        continue;
      }
      state.downloadedSongs.delete(songId);
      if (entry.filePath) {
        void fsUnlink(entry.filePath).catch(() => {});
      }
    }
  }

  async function releaseDownloadedFile(songId) {
    const key = String(songId || "").trim();
    if (!key) {
      return false;
    }

    const entry = state.downloadedSongs.get(key);
    if (!entry) {
      return false;
    }

    state.downloadedSongs.delete(key);
    if (!entry.filePath) {
      return true;
    }

    await fsUnlink(entry.filePath).catch(() => {});
    return true;
  }

  function saveDownloadedFile(songId, fileMeta = {}) {
    const key = String(songId || "").trim();
    const filePath = String(fileMeta.filePath || "").trim();
    const filename = String(fileMeta.filename || "").trim();
    if (!key || !filePath || !filename) {
      return;
    }

    pruneExpiredDownloadedSongs();
    state.downloadedSongs.set(key, {
      filename,
      filePath,
      createdAt: Date.now(),
      expiresAt: Date.now() + DOWNLOADED_FILE_TTL_MS,
    });

    while (state.downloadedSongs.size > MAX_STORED_DOWNLOAD_JOBS) {
      const oldestSongId = state.downloadedSongs.keys().next().value;
      if (typeof oldestSongId === "undefined") {
        break;
      }
      void releaseDownloadedFile(oldestSongId);
    }
  }

  pruneExpiredDownloadedSongs();
  const cleanupTimer = setInterval(
    pruneExpiredDownloadedSongs,
    DOWNLOADED_FILE_CLEANUP_INTERVAL_MS
  );
  if (typeof cleanupTimer.unref === "function") {
    cleanupTimer.unref();
  }

  function toPublicItem(song) {
    return {
      index: song.index,
      type: song.type || "track",
      title: song.title,
      artist: song.artist || "",
      album: song.album || "",
      subtitle: song.subtitle || "",
      artwork: upscaleArtworkUrl(song.artwork),
      duration: song.duration || 0,
      downloadable: Boolean(song.downloadable),
      tidalId: song.tidalId || null,
      url: song.url || null,
    };
  }

  function toPublicDownloadJob(job) {
    return {
      id: job.id,
      requestIndex: Number.isInteger(job.requestIndex) ? job.requestIndex : null,
      status: job.status,
      phase: job.phase,
      progress: job.progress,
      title: job.title,
      artist: job.artist,
      album: job.album,
      artwork: upscaleArtworkUrl(job.artwork),
      duration: job.duration,
      downloadSetting: job.downloadSetting,
      downloadedBytes: job.downloadedBytes,
      totalBytes: job.totalBytes,
      error: job.error,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      song: job.song,
    };
  }

  function trimDownloadJobs() {
    if (state.downloadJobs.size <= MAX_STORED_DOWNLOAD_JOBS) {
      return;
    }
    for (const [jobId, job] of state.downloadJobs) {
      if (state.downloadJobs.size <= MAX_STORED_DOWNLOAD_JOBS) {
        return;
      }
      if (job.status === "done" || job.status === "failed") {
        state.downloadJobs.delete(jobId);
      }
    }
    while (state.downloadJobs.size > MAX_STORED_DOWNLOAD_JOBS) {
      const oldestJobId = state.downloadJobs.keys().next().value;
      if (typeof oldestJobId === "undefined") {
        break;
      }
      state.downloadJobs.delete(oldestJobId);
    }
  }

  function createDownloadRequest(payload = {}) {
    const song = normalizeSong(payload.song);
    const index = Number.isInteger(payload.index)
      ? payload.index
      : Number.isInteger(song?.index)
        ? song.index
        : null;
    return {
      index,
      song,
      downloadSetting: payload.downloadSetting || DEFAULT_SETTING,
    };
  }

  function canResolveRequest(request = {}) {
    const selectedSong = resolveSongFromRequest(request);
    if (!selectedSong?.title) {
      return {ok: false, selectedSong, error: ERRORS.missingSong};
    }
    if (selectedSong.downloadable === false) {
      return {ok: false, selectedSong, error: ERRORS.notDownloadable};
    }
    return {ok: true, selectedSong, error: null};
  }

  function createDownloadJob(request, seedSong = null) {
    const seed = seedSong || resolveSongFromRequest(request) || {};
    const now = Date.now();
    const id = `${now}_${Math.random().toString(36).slice(2, 8)}`;
    const job = {
      id,
      requestIndex: Number.isInteger(request.index) ? request.index : null,
      status: "queued",
      phase: "queued",
      progress: 0,
      title: seed.title || "Preparing download",
      artist: seed.artist || "",
      album: seed.album || "",
      artwork: upscaleArtworkUrl(seed.artwork),
      duration: seed.duration || 0,
      downloadSetting: request.downloadSetting || DEFAULT_SETTING,
      downloadedBytes: 0,
      totalBytes: null,
      error: null,
      song: null,
      request,
      createdAt: now,
      updatedAt: now,
    };
    state.downloadJobs.set(id, job);
    trimDownloadJobs();
    return job;
  }

  function patchDownloadJob(jobId, patch = {}) {
    const job = state.downloadJobs.get(jobId);
    if (!job) {
      return null;
    }
    const previousProgress = job.progress;
    Object.assign(job, patch);
    job.updatedAt = Date.now();
    if (typeof patch.progress === "number") {
      const clamped = clampProgress(patch.progress, previousProgress);
      job.progress = job.status === "done"
        ? 100
        : patch.status === "queued"
          ? clamped
          : Math.max(previousProgress, clamped);
    } else if (job.status === "done") {
      job.progress = 100;
    }
    if ("error" in patch) {
      job.error = patch.error ? String(patch.error) : null;
    }
    return job;
  }

  async function runDownloadPipelineFromRequest(request, onProgress = () => {}, options = {}) {
    const {index, song, downloadSetting} = request;
    const taskLabel = String(options.taskLabel || "download-pipeline");
    return browserController.runBrowserTask(
      () =>
        withTimeout(
          (async () => {
            await browserController.initBrowser();
            onProgress({status: "preparing", phase: "preparing", progress: 4});
            const selectedSong = await searchEngine.resolveDownloadableSong(index, song, onProgress);
            const songMeta = searchEngine.toSongMeta(selectedSong);
            const {page} = browserController.getBrowserInstance();
            const downloadResult = await downloadSong(
              page,
              selectedSong.element,
              downloadSetting,
              progressUpdate => {
                const phase = progressUpdate?.phase || "downloading";
                onProgress({
                  ...songMeta,
                  status: DOWNLOADING_PHASES.has(phase) ? "downloading" : "preparing",
                  ...progressUpdate,
                });
              }
            );
            const id = Date.now().toString();
            saveDownloadedFile(id, downloadResult);
            return {
              id,
              filename: downloadResult.filename,
              filePath: downloadResult.filePath,
              bytes: downloadResult.bytes,
              selectedSong: applyFilenameMetadataFallback(
                mergeSongMetadata(selectedSong, song || {}),
                downloadResult.filename
              ),
            };
          })(),
          DOWNLOAD_PIPELINE_TIMEOUT_MS,
          "Download pipeline"
        ),
      taskLabel
    );
  }

  async function runDownloadPipeline(payload, onProgress = () => {}) {
    return runDownloadPipelineFromRequest(createDownloadRequest(payload), onProgress, {
      taskLabel: "direct-download",
    });
  }

  async function readDownloadedFileSize(filePath) {
    if (!filePath) {
      return null;
    }
    try {
      return (await fsStat(filePath)).size;
    } catch {
      return null;
    }
  }

  async function executeDownloadJob(jobId, request) {
    const startedAt = Date.now();
    const requestSummary = summarizeRequest(request);
    logDownload(`job ${jobId} started`, requestSummary);
    let lastLoggedPhase = "queued";
    let lastLoggedBucket = -1;

    const logJobProgress = progressPatch => {
      const phase = String(progressPatch?.phase || "").trim();
      const progress = Number(progressPatch?.progress);
      const nextBucket = toProgressBucket(progress);
      const phaseChanged = Boolean(phase) && phase !== lastLoggedPhase;
      const bucketChanged =
        nextBucket >= 0 &&
        nextBucket !== 100 &&
        nextBucket !== lastLoggedBucket;

      if (!phaseChanged && !bucketChanged) {
        return;
      }
      if (phaseChanged) {
        lastLoggedPhase = phase;
      }
      if (nextBucket >= 0) {
        lastLoggedBucket = nextBucket;
      }

      const meta = {
        phase: phase || lastLoggedPhase,
      };
      if (Number.isFinite(progress)) {
        meta.progress = clampProgress(progress, 0);
      }
      if (progressPatch?.status) {
        meta.status = progressPatch.status;
      }
      logDownload(`job ${jobId} progress`, meta);
    };

    try {
      const result = await runDownloadPipelineFromRequest(
        request,
        progressPatch => {
          patchDownloadJob(jobId, {...progressPatch, error: null});
          logJobProgress(progressPatch);
        },
        {taskLabel: `download-job:${jobId}`}
      );
      const bytes =
        Number(result.bytes) || (await readDownloadedFileSize(result.filePath));
      patchDownloadJob(jobId, {
        status: "done",
        phase: "done",
        progress: 100,
        downloadedBytes: bytes || 0,
        totalBytes: bytes || null,
        ...searchEngine.toSongMeta(result.selectedSong),
        song: {
          id: result.id,
          filename: result.filename,
          ...toPublicItem(result.selectedSong),
        },
      });
      logDownload(`job ${jobId} completed`, {
        durationMs: Date.now() - startedAt,
        bytes: bytes || null,
        filename: result.filename,
      });
    } catch (error) {
      const message = error?.message || String(error);
      patchDownloadJob(jobId, {
        status: "failed",
        phase: "failed",
        error: message,
      });
      logDownload(`job ${jobId} failed`, {
        durationMs: Date.now() - startedAt,
        error: message,
      });
    }
  }

  function startDownloadRequest(request, seedSong = null) {
    const job = createDownloadJob(request, seedSong);
    logDownload(`job ${job.id} queued`, summarizeRequest(request));
    void executeDownloadJob(job.id, request);
    return state.downloadJobs.get(job.id);
  }

  function startDownloadJob(payload = {}) {
    return startDownloadRequest(createDownloadRequest(payload));
  }

  function enqueueDownload(payload = {}) {
    const request = createDownloadRequest(payload);
    const validation = canResolveRequest(request);
    if (!validation.ok) {
      return {ok: false, error: validation.error, job: null};
    }
    return {ok: true, error: null, job: startDownloadRequest(request, validation.selectedSong)};
  }

  function cancelDownloadJob(jobId) {
    const existing = state.downloadJobs.get(jobId);
    if (!existing) {
      throw new Error(ERRORS.notFound);
    }
    state.downloadJobs.delete(jobId);
    logDownload(`job ${jobId} canceled`);
    return existing;
  }

  function retryDownloadJob(jobId) {
    const existing = state.downloadJobs.get(jobId);
    if (!existing) {
      throw new Error(ERRORS.notFound);
    }
    if (ACTIVE_STATUSES.has(existing.status)) {
      throw new Error(ERRORS.inProgress);
    }
    const request = createDownloadRequest(
      existing.request || {
        song: {
          title: existing.title,
          artist: existing.artist,
          album: existing.album,
          artwork: existing.artwork,
          duration: existing.duration,
          downloadable: true,
        },
        downloadSetting: existing.downloadSetting,
      }
    );
    if (!request.song && !Number.isInteger(request.index)) {
      throw new Error(ERRORS.retryData);
    }
    patchDownloadJob(jobId, {
      status: "queued",
      phase: "queued",
      progress: 0,
      downloadedBytes: 0,
      totalBytes: null,
      error: null,
      song: null,
      downloadSetting: request.downloadSetting,
      request,
    });
    logDownload(`job ${jobId} retry queued`, summarizeRequest(request));
    void executeDownloadJob(jobId, request);
    return state.downloadJobs.get(jobId);
  }

  function getDownloadJobs(limit = 40) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 40, 200));
    return [...state.downloadJobs.values()].slice(-safeLimit).map(toPublicDownloadJob);
  }

  function getDownloadJob(jobId) {
    return state.downloadJobs.get(jobId) || null;
  }

  function getDownloadedFile(songId) {
    const key = String(songId || "").trim();
    if (!key) {
      return null;
    }

    pruneExpiredDownloadedSongs();
    const entry = state.downloadedSongs.get(key) || null;
    if (!entry) {
      return null;
    }

    // Keep a fresh short-lived window while clients prepare to stream.
    entry.expiresAt = Date.now() + DOWNLOADED_FILE_TTL_MS;
    return entry;
  }

  return {
    toPublicItem,
    toPublicDownloadJob,
    createDownloadRequest,
    runDownloadPipeline,
    startDownloadJob,
    enqueueDownload,
    cancelDownloadJob,
    retryDownloadJob,
    getDownloadJobs,
    getDownloadJob,
    getDownloadedFile,
    releaseDownloadedFile,
    canResolveRequest,
  };
}
