import {searchTracksFast} from "../fastSearch.js";
import {getAlbumTracks, searchSongs} from "../search.js";
import {createLookupStore} from "./search/lookup.js";
import {createTrackSearchCache} from "./search/trackSearchCache.js";
import {
  cleanSearchQueryPart,
  extractTrackIdFromValue,
  getTokenOverlapScore,
  mergeSongMetadata,
  normalizeDisplayText,
  normalizeText,
  normalizeUrlForCompare,
  tokenizeForSimilarity,
  upscaleArtworkUrl,
  withTimeout,
} from "./helpers.js";

const TIMEOUTS = {
  fastTrack: 12_000,
  browserInit: 10_000,
  trackFallback: 12_000,
  trackFallbackPipeline: 20_000,
  search: 18_000,
  searchPipeline: 30_000,
  resolveFast: 18_000,
  resolveSteady: 36_000,
};
const ALBUM_TRACKS_TIMEOUT_MS = 24_000;
const ALBUM_TRACKS_PIPELINE_TIMEOUT_MS = 34_000;
const RESOLVE_MAX_TRACK_RESULTS = 24;
const STRONG_MATCH_SCORE = 140;
const EXACT_MATCH_SCORE = 1000;
const LOG_SEARCH_PIPELINE = process.env.LOG_SEARCH_PIPELINE !== "false";

function buildResolveLogPrefix(context = {}) {
  const parts = [];
  if (context.jobId) {
    parts.push(`job=${context.jobId}`);
  }
  if (context.trackTitle) {
    parts.push(`track="${context.trackTitle}"`);
  }
  if (Number.isInteger(context.queryIndex) && Number.isInteger(context.queryTotal)) {
    parts.push(`query=${context.queryIndex}/${context.queryTotal}`);
  }
  return parts.length ? `[resolve ${parts.join(" ")}]` : "[resolve]";
}

function logResolve(context, message) {
  if (!LOG_SEARCH_PIPELINE) {
    return;
  }
  console.log(`${buildResolveLogPrefix(context)} ${message}`);
}

function addUniqueText(list, seen, value) {
  const display = normalizeDisplayText(value);
  if (!display) {
    return;
  }
  const key = normalizeText(display);
  if (!key || seen.has(key)) {
    return;
  }
  seen.add(key);
  list.push(display);
}

function scoreText(candidate, target, exact, partial) {
  if (!candidate || !target) {
    return 0;
  }
  if (candidate === target) {
    return exact;
  }
  return candidate.includes(target) || target.includes(candidate) ? partial : 0;
}

function buildTargetProfile(song) {
  const title = normalizeDisplayText(song?.title);
  const artist = normalizeDisplayText(song?.artist);
  const album = normalizeDisplayText(song?.album);
  return {
    trackId: extractTrackIdFromValue(song?.tidalId || song?.url),
    url: normalizeUrlForCompare(song?.url),
    titleNorm: normalizeText(title),
    artistNorm: normalizeText(artist),
    albumNorm: normalizeText(album),
    titleTokens: tokenizeForSimilarity(title),
    albumTokens: tokenizeForSimilarity(album),
    duration: Number(song?.duration) || 0,
  };
}

export function createSearchEngine(state, browserController) {
  const {getCachedTrackSearch, setCachedTrackSearch} = createTrackSearchCache(state);
  const {setLastSearchSongs, getSongFromRequest} = createLookupStore(state);

  async function runBrowserSearch(query, type, searchTimeout, pipelineTimeout, label) {
    return withTimeout(
      browserController.runBrowserTask(async () => {
        const {page} = await withTimeout(
          browserController.initBrowser(),
          TIMEOUTS.browserInit,
          "Browser initialization"
        );
        return withTimeout(searchSongs(page, query, type), searchTimeout, label);
      }),
      pipelineTimeout,
      `${label} pipeline`
    );
  }

  async function searchTracksWithFallback(query) {
    const cached = getCachedTrackSearch(query);
    if (cached) {
      if (LOG_SEARCH_PIPELINE) {
        console.log(`[search tracks] cache hit q="${query}" count=${cached.length}`);
      }
      return cached;
    }

    try {
      const fastStartedAt = Date.now();
      const songs = await withTimeout(
        searchTracksFast(query, 25),
        TIMEOUTS.fastTrack,
        "Fast track search"
      );
      if (LOG_SEARCH_PIPELINE) {
        console.log(
          `[search tracks] fast q="${query}" count=${songs.length} durationMs=${Date.now() - fastStartedAt}`
        );
      }
      setCachedTrackSearch(query, songs);
      return songs;
    } catch (fastSearchError) {
      if (LOG_SEARCH_PIPELINE) {
        console.log(
          `[search tracks] fast failed q="${query}" error="${fastSearchError?.message || fastSearchError}"`
        );
      }
      const fallbackStartedAt = Date.now();
      const songs = await runBrowserSearch(
        query,
        "tracks",
        TIMEOUTS.trackFallback,
        TIMEOUTS.trackFallbackPipeline,
        "Track fallback search"
      );
      if (LOG_SEARCH_PIPELINE) {
        console.log(
          `[search tracks] fallback q="${query}" count=${songs.length} durationMs=${Date.now() - fallbackStartedAt}`
        );
      }
      if (!songs.length) {
        throw fastSearchError;
      }
      setCachedTrackSearch(query, songs);
      return songs;
    }
  }

  async function searchAlbumTracks(albumPath, meta = {}) {
    const normalizedAlbumPath = String(albumPath || "").trim();
    if (!normalizedAlbumPath) {
      throw new Error("Album path is missing.");
    }

    return withTimeout(
      browserController.runBrowserTask(async () => {
        const {page} = await withTimeout(
          browserController.initBrowser(),
          TIMEOUTS.browserInit,
          "Browser initialization"
        );

        return withTimeout(
          getAlbumTracks(page, normalizedAlbumPath, {
            albumTitle: meta?.albumTitle || "",
            albumArtist: meta?.albumArtist || "",
            albumArtwork: meta?.albumArtwork || null,
          }),
          ALBUM_TRACKS_TIMEOUT_MS,
          "Album tracks request"
        );
      }),
      ALBUM_TRACKS_PIPELINE_TIMEOUT_MS,
      "Album tracks pipeline"
    );
  }

  async function searchByType(query, type = "tracks") {
    const normalizedType = String(type || "tracks").trim();
    const normalizedTypeKey = normalizedType.toLowerCase();
    if (normalizedTypeKey.startsWith("track")) {
      return searchTracksWithFallback(query);
    }

    return runBrowserSearch(
      query,
      normalizedType,
      TIMEOUTS.search,
      TIMEOUTS.searchPipeline,
      "Search request"
    );
  }

  function toSongMeta(song) {
    return {
      title: song?.title || "Unknown",
      artist: song?.artist || "",
      album: song?.album || "",
      artwork: upscaleArtworkUrl(song?.artwork),
      duration: song?.duration || 0,
    };
  }

  function buildResolveQueries(song) {
    const title = normalizeDisplayText(song?.title);
    const artist = normalizeDisplayText(song?.artist);
    const album = normalizeDisplayText(song?.album);
    const variants = [];
    const variantSeen = new Set();

    addUniqueText(variants, variantSeen, title);
    addUniqueText(variants, variantSeen, cleanSearchQueryPart(title));

    const fromMatch = title.match(/\(\s*from\s+["']?([^"')]+)["']?\s*\)/i);
    const fromLabel = fromMatch ? normalizeDisplayText(fromMatch[1]) : "";
    if (fromMatch) {
      const withoutFrom = normalizeDisplayText(title.replace(fromMatch[0], " "));
      addUniqueText(variants, variantSeen, withoutFrom);
      addUniqueText(variants, variantSeen, cleanSearchQueryPart(withoutFrom));
      addUniqueText(variants, variantSeen, fromLabel);
    }

    const dashParts = title
      .split(/\s+-\s+/)
      .map(part => normalizeDisplayText(part))
      .filter(Boolean);
    if (dashParts.length >= 2) {
      const left = dashParts[0];
      const right = normalizeDisplayText(dashParts.slice(1).join(" "));
      addUniqueText(variants, variantSeen, `${right} ${left}`);
      addUniqueText(variants, variantSeen, `${left} ${right}`);
      addUniqueText(
        variants,
        variantSeen,
        `${cleanSearchQueryPart(right)} ${cleanSearchQueryPart(left)}`
      );
      if (fromLabel) {
        addUniqueText(variants, variantSeen, `${right} ${fromLabel}`);
      }
    }

    const queries = [];
    const querySeen = new Set();
    for (const variant of variants) {
      addUniqueText(queries, querySeen, `${variant} ${artist}`);
      addUniqueText(queries, querySeen, `${artist} ${variant}`);
      addUniqueText(queries, querySeen, `${variant} ${album}`);
      addUniqueText(queries, querySeen, `${album} ${variant}`);
      addUniqueText(queries, querySeen, variant);
    }

    addUniqueText(queries, querySeen, `${title} ${artist} ${album}`);
    addUniqueText(queries, querySeen, `${artist} ${title} ${album}`);
    addUniqueText(queries, querySeen, `${album} ${title} ${artist}`);
    addUniqueText(queries, querySeen, `${artist} ${album}`);
    addUniqueText(queries, querySeen, `${album} ${artist}`);

    const maxQueries = extractTrackIdFromValue(song?.tidalId || song?.url) ? 3 : 5;
    return queries.slice(0, maxQueries);
  }

  function scoreCandidateMatch(candidate, target) {
    const candidateTrackId = extractTrackIdFromValue(candidate?.tidalId || candidate?.url);
    if (candidateTrackId && target.trackId && candidateTrackId === target.trackId) {
      return 1200;
    }

    const candidateUrl = normalizeUrlForCompare(candidate?.url);
    if (candidateUrl && target.url) {
      if (candidateUrl === target.url) {
        return EXACT_MATCH_SCORE;
      }
      if (candidateUrl.endsWith(target.url) || target.url.endsWith(candidateUrl)) {
        return 700;
      }
    }

    const titleNorm = normalizeText(candidate?.title);
    const artistNorm = normalizeText(candidate?.artist);
    const albumNorm = normalizeText(candidate?.album);
    const duration = Number(candidate?.duration) || 0;

    let score = candidateTrackId && target.trackId ? -35 : 0;
    score += scoreText(titleNorm, target.titleNorm, 140, 90);
    score += getTokenOverlapScore(tokenizeForSimilarity(candidate?.title), target.titleTokens, 80);
    score += scoreText(artistNorm, target.artistNorm, 45, 20);
    score += scoreText(albumNorm, target.albumNorm, 65, 30);
    score += getTokenOverlapScore(tokenizeForSimilarity(candidate?.album), target.albumTokens, 30);

    if (duration > 0 && target.duration > 0) {
      const delta = Math.abs(duration - target.duration);
      if (delta === 0) {
        score += 55;
      } else if (delta <= 2) {
        score += 40;
      } else if (delta <= 5) {
        score += 22;
      } else if (delta >= 20) {
        score -= 15;
      }
    }

    return score;
  }

  async function searchTrackCandidates(page, query, context = {}) {
    if (!query) {
      return [];
    }

    const attempts = [
      {
        label: "fast",
        timeoutMs: TIMEOUTS.resolveFast,
        options: {fastResolve: true, maxTrackResults: RESOLVE_MAX_TRACK_RESULTS},
      },
      {
        label: "steady",
        timeoutMs: TIMEOUTS.resolveSteady,
        options: {fastResolve: false, maxTrackResults: RESOLVE_MAX_TRACK_RESULTS},
      },
    ];

    let lastError = null;
    for (const attempt of attempts) {
      const startedAt = Date.now();
      try {
        const candidates = await withTimeout(
          searchSongs(page, query, "tracks", attempt.options),
          attempt.timeoutMs,
          `Resolve query "${query}" [${attempt.label}]`
        );
        logResolve(
          context,
          `strategy=${attempt.label} query="${query}" candidates=${candidates.length} durationMs=${Date.now() - startedAt}`
        );
        if (candidates.length > 0) {
          return candidates;
        }
      } catch (error) {
        lastError = error;
        logResolve(
          context,
          `strategy=${attempt.label} query="${query}" failed durationMs=${Date.now() - startedAt} error="${error?.message || error}"`
        );
      }
    }

    if (lastError) {
      throw lastError;
    }
    return [];
  }

  function emitResolveProgress(onProgress, selectedSong, phase, progress) {
    onProgress({status: "preparing", phase, progress, ...toSongMeta(selectedSong)});
  }

  async function resolveDownloadableSong(index, song, onProgress = () => {}, context = {}) {
    const resolveStartedAt = Date.now();
    let selectedSong = getSongFromRequest(index, song);
    if (!selectedSong && song?.title) {
      selectedSong = {...song, downloadable: song.downloadable !== false, element: null};
    }

    if (!selectedSong) {
      throw new Error(
        "Song not found in current search context. Search first, then download by index."
      );
    }
    if (!selectedSong.downloadable) {
      throw new Error("Selected item is not downloadable.");
    }

    emitResolveProgress(onProgress, selectedSong, "preparing", 10);
    if (selectedSong.element) {
      return selectedSong;
    }

    const originalMeta = {
      title: selectedSong.title,
      artist: selectedSong.artist,
      album: selectedSong.album,
      artwork: selectedSong.artwork,
      duration: selectedSong.duration,
    };
    const resolveContext = {
      ...context,
      trackTitle: originalMeta.title || selectedSong.title || "Unknown",
    };
    const target = buildTargetProfile(selectedSong);
    const {page} = browserController.getBrowserInstance();
    const resolveQueries = buildResolveQueries(selectedSong);
    logResolve(
      resolveContext,
      `start artist="${originalMeta.artist || ""}" album="${originalMeta.album || ""}" queries=${resolveQueries.length}`
    );

    emitResolveProgress(onProgress, selectedSong, "resolving", 22);

    let bestCandidate = null;
    let bestScore = -1;
    let resolveError = null;

    for (let i = 0; i < resolveQueries.length; i += 1) {
      emitResolveProgress(
        onProgress,
        selectedSong,
        "resolving",
        Math.min(34, 22 + Math.round(((i + 1) / resolveQueries.length) * 12))
      );

      let candidates = [];
      try {
        candidates = await searchTrackCandidates(page, resolveQueries[i], {
          ...resolveContext,
          queryIndex: i + 1,
          queryTotal: resolveQueries.length,
        });
      } catch (error) {
        resolveError = error;
        continue;
      }

      let foundExact = false;
      let queryBestScore = -1;
      for (const candidate of candidates) {
        const score = scoreCandidateMatch(candidate, target);
        queryBestScore = Math.max(queryBestScore, score);
        if (score > bestScore) {
          bestScore = score;
          bestCandidate = candidate;
        }
        if (score >= EXACT_MATCH_SCORE) {
          foundExact = true;
          break;
        }
      }
      logResolve(
        {
          ...resolveContext,
          queryIndex: i + 1,
          queryTotal: resolveQueries.length,
        },
        `evaluated candidates=${candidates.length} queryBestScore=${queryBestScore} overallBestScore=${bestScore}`
      );

      if (foundExact || bestScore >= STRONG_MATCH_SCORE) {
        break;
      }
    }

    if (!bestCandidate?.element) {
      if (resolveError) {
        logResolve(
          resolveContext,
          `failed durationMs=${Date.now() - resolveStartedAt} error="${resolveError?.message || resolveError}"`
        );
        throw resolveError;
      }
      logResolve(
        resolveContext,
        `failed durationMs=${Date.now() - resolveStartedAt} reason="no matching downloadable candidate"`
      );
      throw new Error(
        `Could not resolve downloadable track element for "${originalMeta.title}".`
      );
    }

    selectedSong = mergeSongMetadata(bestCandidate, originalMeta);
    logResolve(
      resolveContext,
      `resolved durationMs=${Date.now() - resolveStartedAt} bestScore=${bestScore} resolvedTitle="${selectedSong.title || ""}"`
    );
    emitResolveProgress(onProgress, selectedSong, "resolved", 36);
    return selectedSong;
  }

  return {
    searchByType,
    searchTracksWithFallback,
    searchAlbumTracks,
    setLastSearchSongs,
    getSongFromRequest,
    resolveDownloadableSong,
    toSongMeta,
  };
}
