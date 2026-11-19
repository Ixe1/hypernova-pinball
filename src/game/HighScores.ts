/**
 * HYPERNOVA — Arcade Top-5 High Score Leaderboard
 *
 * Pure TypeScript persistence with `localStorage` primary storage and safe
 * in-memory fallback when storage is unavailable, blocked, or corrupt.
 */

import type { HighScoreEntry } from '../config/types';

export const HIGH_SCORES_STORAGE_KEY = 'hypernova_high_scores_v1';
export const MAX_HIGH_SCORES = 5;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/** Seeded 1990s sci-fi arcade leaderboard defaults. */
export const DEFAULT_HIGH_SCORES: readonly HighScoreEntry[] = Object.freeze([
  Object.freeze({ initials: 'NOV', score: 350_000 }),
  Object.freeze({ initials: 'ZAP', score: 250_000 }),
  Object.freeze({ initials: 'REX', score: 175_000 }),
  Object.freeze({ initials: 'ION', score: 100_000 }),
  Object.freeze({ initials: 'ACE', score: 50_000 }),
]);

/** In-memory fallback used when `localStorage` is unavailable or throws. */
let memoryFallbackScores: HighScoreEntry[] = cloneScores(DEFAULT_HIGH_SCORES);

function cloneScores(entries: readonly HighScoreEntry[]): HighScoreEntry[] {
  return entries.map((entry) =>
    entry.date !== undefined
      ? { initials: entry.initials, score: entry.score, date: entry.date }
      : { initials: entry.initials, score: entry.score },
  );
}

function getDefaultStorage(): StorageLike | null {
  try {
    const candidate = (globalThis as { localStorage?: StorageLike }).localStorage;
    if (
      candidate &&
      typeof candidate.getItem === 'function' &&
      typeof candidate.setItem === 'function'
    ) {
      return candidate;
    }
  } catch {
    // Blocked by browser privacy / sandbox policies.
  }
  return null;
}

function resolveStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage === undefined) {
    return getDefaultStorage();
  }
  return storage;
}

/**
 * Normalizes player-entered arcade initials into exactly 3 uppercase
 * alphanumeric characters (`A-Z`, `0-9`), padding short inputs with `'A'`.
 */
export function sanitizeInitials(raw: string): string {
  const cleaned = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 3);
  return cleaned.padEnd(3, 'A');
}

function normalizeScore(score: number): number {
  if (!Number.isFinite(score) || score <= 0) {
    return 0;
  }
  return Math.floor(score);
}

function parseStoredEntries(raw: string): HighScoreEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) {
    return null;
  }

  const valid: HighScoreEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.initials !== 'string' || typeof candidate.score !== 'number') {
      continue;
    }
    const score = normalizeScore(candidate.score);
    if (score <= 0) {
      continue;
    }
    const entry: HighScoreEntry =
      typeof candidate.date === 'string' && candidate.date.length > 0
        ? {
            initials: sanitizeInitials(candidate.initials),
            score,
            date: candidate.date,
          }
        : {
            initials: sanitizeInitials(candidate.initials),
            score,
          };
    valid.push(entry);
  }

  if (valid.length === 0) {
    return null;
  }

  valid.sort((a, b) => b.score - a.score);
  return valid.slice(0, MAX_HIGH_SCORES);
}

/**
 * Loads the Top-5 arcade leaderboard. Falls back gracefully to seeded defaults
 * when storage is empty or corrupt, or to the in-memory table when storage is
 * unavailable.
 */
export function loadHighScores(storage?: StorageLike | null): HighScoreEntry[] {
  const target = resolveStorage(storage);
  if (!target) {
    return cloneScores(memoryFallbackScores);
  }

  try {
    const raw = target.getItem(HIGH_SCORES_STORAGE_KEY);
    if (raw === null) {
      return cloneScores(DEFAULT_HIGH_SCORES);
    }
    const parsed = parseStoredEntries(raw);
    if (!parsed) {
      return cloneScores(DEFAULT_HIGH_SCORES);
    }
    memoryFallbackScores = cloneScores(parsed);
    return cloneScores(parsed);
  } catch {
    return cloneScores(memoryFallbackScores);
  }
}

function persistHighScores(
  entries: readonly HighScoreEntry[],
  storage?: StorageLike | null,
): void {
  const cloned = cloneScores(entries);
  memoryFallbackScores = cloned;

  const target = resolveStorage(storage);
  if (!target) {
    return;
  }

  try {
    target.setItem(HIGH_SCORES_STORAGE_KEY, JSON.stringify(cloned));
  } catch {
    // Ignore quota / private-browsing storage errors; memory fallback remains updated.
  }
}

/**
 * Returns true if `score` qualifies for the Top-5 leaderboard.
 * Requires a positive score strictly beating the 5th-place score when full.
 */
export function isHighScore(
  score: number,
  existingScores?: readonly HighScoreEntry[],
  storage?: StorageLike | null,
): boolean {
  const cleanScore = normalizeScore(score);
  if (cleanScore <= 0) {
    return false;
  }

  const board = existingScores ?? loadHighScores(storage);
  if (board.length < MAX_HIGH_SCORES) {
    return true;
  }

  const lowestScore = board[MAX_HIGH_SCORES - 1]?.score ?? 0;
  return cleanScore > lowestScore;
}

/**
 * Inserts a new high score entry into the Top-5 leaderboard, sorts descending,
 * persists it, and returns the updated leaderboard.
 */
export function insertHighScore(
  initials: string,
  score: number,
  storage?: StorageLike | null,
): HighScoreEntry[] {
  const current = loadHighScores(storage);
  const cleanScore = normalizeScore(score);
  if (cleanScore <= 0) {
    return current;
  }

  const entry: HighScoreEntry = {
    initials: sanitizeInitials(initials),
    score: cleanScore,
    date: new Date().toISOString().slice(0, 10),
  };

  const merged = [...current, entry];
  merged.sort((a, b) => b.score - a.score);
  const topFive = merged.slice(0, MAX_HIGH_SCORES);

  persistHighScores(topFive, storage);
  return cloneScores(topFive);
}

/** Returns the #1 high score currently on the board. */
export function getTopHighScore(storage?: StorageLike | null): number {
  const board = loadHighScores(storage);
  return board[0]?.score ?? 0;
}

/** Restores the leaderboard to the default sci-fi arcade entries. */
export function resetHighScores(storage?: StorageLike | null): HighScoreEntry[] {
  const defaults = cloneScores(DEFAULT_HIGH_SCORES);
  memoryFallbackScores = cloneScores(defaults);

  const target = resolveStorage(storage);
  if (target) {
    try {
      if (typeof target.removeItem === 'function') {
        target.removeItem(HIGH_SCORES_STORAGE_KEY);
      } else {
        target.setItem(HIGH_SCORES_STORAGE_KEY, JSON.stringify(defaults));
      }
    } catch {
      // Ignore storage errors; memory fallback is already reset.
    }
  }

  return defaults;
}
