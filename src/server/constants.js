function intFromEnv(name, fallback, min = 1) {
  const value = Number(process.env[name]);
  if (Number.isFinite(value) && value >= min) {
    return Math.round(value);
  }
  return fallback;
}

export const TRACK_CACHE_TTL_MS = intFromEnv("TRACK_CACHE_TTL_MS", 60_000, 1_000);
export const MAX_TRACK_CACHE_ENTRIES = intFromEnv("MAX_TRACK_CACHE_ENTRIES", 120, 10);
export const DOWNLOAD_PIPELINE_TIMEOUT_MS = intFromEnv(
  "DOWNLOAD_PIPELINE_TIMEOUT_MS",
  300_000,
  60_000
);
export const MAX_STORED_DOWNLOAD_JOBS = intFromEnv("MAX_STORED_DOWNLOAD_JOBS", 120, 20);
export const DOWNLOADED_FILE_TTL_MS = intFromEnv(
  "DOWNLOADED_FILE_TTL_MS",
  5 * 60_000,
  30_000
);
export const DOWNLOADED_FILE_CLEANUP_INTERVAL_MS = intFromEnv(
  "DOWNLOADED_FILE_CLEANUP_INTERVAL_MS",
  60_000,
  15_000
);
