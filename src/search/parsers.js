import {SELECTORS} from "../config.js";
import {
  BULLET,
  extractTrackIdFromUrl,
  getSubtitleFromLines,
  normalizeText,
  parseDuration,
} from "./utils.js";

async function getAttributeFast(locator, name, timeoutMs = 350) {
  return locator.getAttribute(name, {timeout: timeoutMs}).catch(() => null);
}

async function getTextFast(locator, timeoutMs = 350) {
  return locator.textContent({timeout: timeoutMs}).catch(() => "");
}

async function getTrackHrefFromCard(card) {
  try {
    return await card.evaluate(node => {
      if (!node || typeof node.querySelector !== "function") {
        return null;
      }

      const directHref = node.getAttribute?.("href");
      if (directHref && /\/tracks?\//i.test(directHref)) {
        return directHref;
      }

      const link = node.querySelector('a[href*="/track/"], a[href*="/tracks/"]');
      return link?.getAttribute("href") || null;
    });
  } catch {
    return null;
  }
}

export async function parseTrackResults(page, maxResults = 60) {
  const downloadButtons = page.locator(SELECTORS.downloadButton);
  const buttonCount = await downloadButtons.count();
  const limit = Math.min(buttonCount, maxResults);
  const results = [];

  for (let i = 0; i < limit; i += 1) {
    const button = downloadButtons.nth(i);
    const card = button.locator("xpath=ancestor::*[@role='button'][1]");

    const ariaLabel = normalizeText(await button.getAttribute("aria-label").catch(() => ""));
    const titleFromAria = ariaLabel.replace(/^Download\s+/i, "").trim();
    const titleRaw = titleFromAria
      ? ""
      : await getTextFast(card.locator("h3").first(), 320);
    const title = titleFromAria || normalizeText(titleRaw) || "Unknown";

    const lines = (await card.locator("p").allTextContents().catch(() => []))
      .map(normalizeText)
      .filter(Boolean);

    const meta = lines.find(line => line.includes(BULLET)) || "";
    const artist = lines.find(line => line !== meta) || "Unknown";
    const album = meta ? normalizeText(meta.split(BULLET)[0]) : "";
    const duration = parseDuration(meta);
    const artwork = await getAttributeFast(card.locator("img").first(), "src");
    const href = await getTrackHrefFromCard(card);
    const tidalId = extractTrackIdFromUrl(href);

    results.push({
      index: results.length,
      type: "track",
      title,
      artist,
      album,
      subtitle: meta || artist,
      duration,
      artwork: artwork || null,
      url: href || null,
      tidalId,
      downloadable: true,
      element: card,
    });
  }

  return results;
}

export async function parseAlbumTrackResults(page, albumPath, maxResults = 200, meta = {}) {
  const albumTitle =
    normalizeText(
      await getTextFast(page.locator(".album-page .album-title").first(), 420)
    ) ||
    normalizeText(meta?.albumTitle || "") ||
    "Unknown Album";
  const albumArtist =
    normalizeText(
      await getTextFast(page.locator(".album-page .album-artist-row").first(), 420)
    ) || normalizeText(meta?.albumArtist || "");
  const albumArtwork =
    (await getAttributeFast(page.locator(".album-page img").first(), "src")) ||
    meta?.albumArtwork ||
    null;

  const downloadButtons = page.locator('button[aria-label="Download track"]');
  const buttonCount = await downloadButtons.count().catch(() => 0);
  const limit = Math.min(buttonCount, Math.max(1, Number(maxResults) || 200));
  const results = [];

  for (let i = 0; i < limit; i += 1) {
    const button = downloadButtons.nth(i);
    const row = button.locator(
      'xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " track-row ")][1]'
    );

    const title = normalizeText(
      await getTextFast(row.locator('button[class*="track-row__title"]').first(), 320)
    );
    if (!title) {
      continue;
    }

    const artist =
      normalizeText(
        await getTextFast(row.locator('[class*="track-row__artist"]').first(), 320)
      ) || albumArtist || "Unknown";
    const trackNumber = normalizeText(
      await getTextFast(row.locator('[class*="track-row__number"]').first(), 280)
    );
    const tagText = normalizeText(
      await getTextFast(row.locator('[class*="track-row__tags"]').first(), 280)
    ).replace(new RegExp(`^\\s*${BULLET}\\s*`), "");
    const durationText = normalizeText(
      await getTextFast(row.locator('[class*="track-row__duration"]').first(), 280)
    );
    const duration = parseDuration(durationText);
    const artwork = await getAttributeFast(row.locator("img").first(), "src");
    const subtitleParts = [artist, tagText ? `${BULLET} ${tagText}` : ""].filter(Boolean);

    results.push({
      index: results.length,
      type: "track",
      title,
      artist,
      album: albumTitle,
      subtitle: subtitleParts.join(" "),
      duration,
      artwork: artwork || albumArtwork || null,
      url: trackNumber ? `${albumPath}#${trackNumber}` : albumPath || null,
      tidalId: null,
      downloadable: true,
      element: row,
    });
  }

  return results;
}

export async function parseAlbumResults(page, maxResults = 60) {
  const downloadButtons = page.locator(SELECTORS.downloadButton);
  const buttonCount = await downloadButtons.count();
  const limit = Math.min(buttonCount, maxResults);
  const results = [];

  for (let i = 0; i < limit; i += 1) {
    const button = downloadButtons.nth(i);
    const card = button.locator("xpath=ancestor::*[.//a[starts-with(@href,'/album/')]][1]");

    const ariaLabel = normalizeText(await button.getAttribute("aria-label").catch(() => ""));
    const titleFromAria = ariaLabel.replace(/^Download\s+/i, "").trim();
    const titleRaw = titleFromAria
      ? ""
      : await getTextFast(card.locator("h3").first(), 320);
    const title = titleFromAria || normalizeText(titleRaw) || "Unknown";

    const lines = (await card.locator("p").allTextContents().catch(() => []))
      .map(normalizeText)
      .filter(Boolean);
    const subtitle = getSubtitleFromLines(lines);

    const artwork = await getAttributeFast(card.locator("img").first(), "src");
    const href = await getAttributeFast(
      card.locator('a[href^="/album/"]').first(),
      "href"
    );
    const artist = lines[0] || "Unknown";

    results.push({
      index: results.length,
      type: "album",
      title,
      artist,
      album: title,
      subtitle,
      duration: 0,
      artwork: artwork || null,
      url: href || null,
      downloadable: true,
      element: card,
    });
  }

  return results;
}

export async function parsePlaylistResults(page, maxResults = 60) {
  const cards = page.locator('a[href^="/playlist/"], a[href*="/playlist/"]');
  const count = await cards.count();
  const limit = Math.min(count, maxResults);
  const results = [];

  for (let i = 0; i < limit; i += 1) {
    const card = cards.nth(i);
    const title =
      normalizeText(await getTextFast(card.locator("h3").first(), 320)) ||
      "Unknown";
    const lines = (await card.locator("p").allTextContents().catch(() => []))
      .map(normalizeText)
      .filter(Boolean);
    const subtitle = getSubtitleFromLines(lines);
    const artwork = await getAttributeFast(card.locator("img").first(), "src");
    const href = await getAttributeFast(card, "href");

    results.push({
      index: results.length,
      type: "playlist",
      title,
      artist: "",
      album: "",
      subtitle,
      duration: 0,
      artwork: artwork || null,
      url: href || null,
      downloadable: false,
      element: null,
    });
  }

  return results;
}
