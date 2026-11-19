/**
 * HYPERNOVA — Authentic 128x32 Amber LED Dot-Matrix Display (DMD) Renderer
 *
 * Renders an authentic 4-shade (0..3) 128x32 arcade DMD onto a 512x128 canvas
 * where each logical dot is a crisp 4x4 circular glowing amber LED with dark
 * unlit diode grid and warm phosphor edge bleed.
 *
 * Shares a single THREE.CanvasTexture mounted on the 3D backbox speaker panel
 * while also exposing getCanvas() for optional HUD mirroring.
 */

import * as THREE from 'three';
import type { DmdBanner, GameSnapshot, HighScoreEntry } from '../config/types';

export const DMD_COLS = 128;
export const DMD_ROWS = 32;
export const DMD_DOT_SIZE = 4;
export const DMD_CANVAS_WIDTH = DMD_COLS * DMD_DOT_SIZE; // 512
export const DMD_CANVAS_HEIGHT = DMD_ROWS * DMD_DOT_SIZE; // 128

export interface HighScoreInitialsState {
  chars: string[];
  cursor: number;
}

type Rgb = readonly [number, number, number];

// 4-shade authentic Williams plasma/amber LED cell palettes: [cornerHalo, rim, core]
const SHADE_CELL_RGB: readonly [readonly [Rgb, Rgb, Rgb], readonly [Rgb, Rgb, Rgb], readonly [Rgb, Rgb, Rgb], readonly [Rgb, Rgb, Rgb]] = [
  // Shade 0: unlit dark diode dot on matte charcoal matrix
  [
    [8, 4, 3],
    [22, 11, 6],
    [32, 16, 8],
  ],
  // Shade 1: dim 33% amber (starfields, frames, soft accents)
  [
    [26, 10, 3],
    [104, 42, 6],
    [164, 70, 10],
  ],
  // Shade 2: medium 66% amber (subtitles, borders, badges)
  [
    [46, 18, 4],
    [206, 92, 10],
    [248, 140, 22],
  ],
  // Shade 3: blazing 100% amber-gold LED (scores, hero callouts)
  [
    [88, 34, 6],
    [255, 136, 20],
    [255, 226, 112],
  ],
];

// 4x4 cell pixel role lookup: 0 = corner halo, 1 = circular rim, 2 = bright center core
const CELL_MASK: readonly (readonly [number, number, number, number])[] = [
  [0, 1, 1, 0],
  [1, 2, 2, 1],
  [1, 2, 2, 1],
  [0, 1, 1, 0],
];

// ---------------------------------------------------------------------------
// Custom 5x7 Arcade Pixel Bitmap Font (uppercase, digits, symbols)
// ---------------------------------------------------------------------------
const FONT_5X7: Record<string, readonly string[]> = {
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  '0': ['.###.', '#..##', '#.#.#', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '..##.', '.#...', '#....', '#####'],
  '3': ['.###.', '#...#', '....#', '..##.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['.###.', '#....', '####.', '#...#', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '#..#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
  '?': ['.###.', '#...#', '...#.', '..#..', '..#..', '.....', '..#..'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ',': ['.....', '.....', '.....', '.....', '..#..', '..#..', '.#...'],
  ':': ['.....', '..#..', '..#..', '.....', '..#..', '..#..', '.....'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  '/': ['....#', '...#.', '...#.', '..#..', '.#...', '.#...', '#....'],
  '%': ['##..#', '##.#.', '..#..', '.#...', '#..##', '...##', '.....'],
  '*': ['..#..', '#.#.#', '.###.', '#####', '.###.', '#.#.#', '..#..'],
  '(': ['...#.', '..#..', '.#...', '.#...', '.#...', '..#..', '...#.'],
  ')': ['.#...', '..#..', '...#.', '...#.', '...#.', '..#..', '.#...'],
  '[': ['.###.', '.#...', '.#...', '.#...', '.#...', '.#...', '.###.'],
  ']': ['.###.', '...#.', '...#.', '...#.', '...#.', '...#.', '.###.'],
  '<': ['...#.', '..#..', '.#...', '#....', '.#...', '..#..', '...#.'],
  '>': ['.#...', '..#..', '...#.', '....#', '...#.', '..#..', '.#...'],
  '#': ['.#.#.', '#####', '.#.#.', '.#.#.', '#####', '.#.#.', '.....'],
  '&': ['.##..', '#..#.', '.##..', '.#.#.', '#..#.', '#..#.', '.##.#'],
  "'": ['..#..', '..#..', '.#...', '.....', '.....', '.....', '.....'],
  '_': ['.....', '.....', '.....', '.....', '.....', '.....', '#####'],
  '^': ['..#..', '.###.', '#####', '..#..', '..#..', '.....', '.....'],
  '=': ['.....', '.....', '#####', '.....', '#####', '.....', '.....'],
};

interface GlyphMetric {
  readonly left: number;
  readonly width: number;
}

const FONT_5X7_METRICS: Record<string, GlyphMetric> = Object.fromEntries(
  Object.entries(FONT_5X7).map(([ch, rows]) => {
    if (ch === ' ') {
      return [ch, { left: 0, width: 2 }];
    }
    let minCol = 5;
    let maxCol = -1;
    for (let r = 0; r < rows.length; r++) {
      const line = rows[r];
      for (let c = 0; c < line.length; c++) {
        if (line[c] === '#') {
          if (c < minCol) minCol = c;
          if (c > maxCol) maxCol = c;
        }
      }
    }
    if (maxCol < minCol) {
      return [ch, { left: 0, width: 2 }];
    }
    return [ch, { left: minCol, width: maxCol - minCol + 1 }];
  }),
);

// ---------------------------------------------------------------------------
// Custom Bold 7x9 Arcade Display Font (scores, titles, banners, initials)
// ---------------------------------------------------------------------------
const FONT_7X9: Record<string, readonly string[]> = {
  ' ': ['.......', '.......', '.......', '.......', '.......', '.......', '.......', '.......', '.......'],
  '0': ['.#####.', '##...##', '##..###', '##.#.##', '###..##', '##...##', '##...##', '##...##', '.#####.'],
  '1': ['...##..', '..###..', '.####..', '...##..', '...##..', '...##..', '...##..', '...##..', '.######'],
  '2': ['.#####.', '##...##', '.....##', '....##.', '..###..', '.##....', '##.....', '##...##', '#######'],
  '3': ['.#####.', '##...##', '.....##', '..####.', '.....##', '.....##', '.....##', '##...##', '.#####.'],
  '4': ['....##.', '...###.', '..####.', '.##.##.', '##..##.', '#######', '....##.', '....##.', '....##.'],
  '5': ['#######', '##.....', '##.....', '######.', '.....##', '.....##', '.....##', '##...##', '.#####.'],
  '6': ['.#####.', '##...##', '##.....', '######.', '##...##', '##...##', '##...##', '##...##', '.#####.'],
  '7': ['#######', '##...##', '....##.', '...##..', '..##...', '..##...', '..##...', '..##...', '..##...'],
  '8': ['.#####.', '##...##', '##...##', '.#####.', '##...##', '##...##', '##...##', '##...##', '.#####.'],
  '9': ['.#####.', '##...##', '##...##', '##...##', '.######', '.....##', '.....##', '##...##', '.#####.'],
  A: ['..###..', '.#####.', '##...##', '##...##', '#######', '##...##', '##...##', '##...##', '##...##'],
  B: ['######.', '##...##', '##...##', '######.', '##...##', '##...##', '##...##', '##...##', '######.'],
  C: ['.#####.', '##...##', '##.....', '##.....', '##.....', '##.....', '##.....', '##...##', '.#####.'],
  D: ['#####..', '##..##.', '##...##', '##...##', '##...##', '##...##', '##...##', '##..##.', '#####..'],
  E: ['#######', '##.....', '##.....', '#####..', '##.....', '##.....', '##.....', '##.....', '#######'],
  F: ['#######', '##.....', '##.....', '#####..', '##.....', '##.....', '##.....', '##.....', '##.....'],
  G: ['.#####.', '##...##', '##.....', '##.....', '##.###.', '##...##', '##...##', '##...##', '.#####.'],
  H: ['##...##', '##...##', '##...##', '#######', '##...##', '##...##', '##...##', '##...##', '##...##'],
  I: ['.#####.', '...##..', '...##..', '...##..', '...##..', '...##..', '...##..', '...##..', '.#####.'],
  J: ['..#####', '....##.', '....##.', '....##.', '....##.', '##..##.', '##..##.', '##..##.', '.####..'],
  K: ['##...##', '##..##.', '##.##..', '####...', '####...', '##.##..', '##..##.', '##...##', '##...##'],
  L: ['##.....', '##.....', '##.....', '##.....', '##.....', '##.....', '##.....', '##.....', '#######'],
  M: ['##...##', '###.###', '#######', '##.#.##', '##...##', '##...##', '##...##', '##...##', '##...##'],
  N: ['##...##', '###..##', '####.##', '##.####', '##..###', '##...##', '##...##', '##...##', '##...##'],
  O: ['.#####.', '##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '.#####.'],
  P: ['######.', '##...##', '##...##', '######.', '##.....', '##.....', '##.....', '##.....', '##.....'],
  Q: ['.#####.', '##...##', '##...##', '##...##', '##...##', '##.#.##', '##..##.', '##..##.', '.####.#'],
  R: ['######.', '##...##', '##...##', '######.', '##.##..', '##..##.', '##...##', '##...##', '##...##'],
  S: ['.######', '##.....', '##.....', '.#####.', '.....##', '.....##', '.....##', '##...##', '######.'],
  T: ['#######', '...##..', '...##..', '...##..', '...##..', '...##..', '...##..', '...##..', '...##..'],
  U: ['##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '.#####.'],
  V: ['##...##', '##...##', '##...##', '##...##', '##...##', '.##.##.', '.##.##.', '..###..', '...#...'],
  W: ['##...##', '##...##', '##...##', '##...##', '##.#.##', '##.#.##', '#######', '###.###', '##...##'],
  X: ['##...##', '##...##', '.##.##.', '..###..', '...#...', '..###..', '.##.##.', '##...##', '##...##'],
  Y: ['##...##', '##...##', '.##.##.', '..###..', '...##..', '...##..', '...##..', '...##..', '...##..'],
  Z: ['#######', '.....##', '....##.', '...##..', '..##...', '.##....', '##.....', '##.....', '#######'],
  '!': ['..###..', '..###..', '..###..', '..###..', '..###..', '..###..', '.......', '..###..', '..###..'],
  ',': ['.......', '.......', '.......', '.......', '.......', '..###..', '..###..', '..##...', '.##....'],
  '.': ['.......', '.......', '.......', '.......', '.......', '.......', '.......', '..###..', '..###..'],
  '-': ['.......', '.......', '.......', '.......', '.#####.', '.......', '.......', '.......', '.......'],
  '+': ['.......', '...##..', '...##..', '.######', '.######', '...##..', '...##..', '.......', '.......'],
  '/': ['.....##', '....##.', '....##.', '...##..', '..##...', '..##...', '.##....', '##.....', '##.....'],
  ':': ['.......', '..###..', '..###..', '.......', '.......', '..###..', '..###..', '.......', '.......'],
  '*': ['...#...', '.#.#.#.', '..###..', '#######', '..###..', '.#.#.#.', '...#...', '.......', '.......'],
  '?': ['.#####.', '##...##', '....##.', '...##..', '...##..', '.......', '...##..', '...##..', '.......'],
  '%': ['##...##', '##..##.', '...##..', '..##...', '.##..##', '##...##', '.......', '.......', '.......'],
  '#': ['.#...#.', '#######', '.#...#.', '.#...#.', '#######', '.#...#.', '.......', '.......', '.......'],
};

const ROCKET_ICON: readonly string[] = [
  '.....###.....',
  '....#####....',
  '.##.#####.##.',
  '###########..',
  '.##.#####.##.',
  '....#####....',
  '.....###.....',
];

const STARBURST_FRAMES: readonly (readonly string[])[] = [
  [
    '...#...',
    '...#...',
    '.#.#.#.',
    '#######',
    '.#.#.#.',
    '...#...',
    '...#...',
  ],
  [
    '#.....#',
    '.#...#.',
    '..###..',
    '..###..',
    '..###..',
    '.#...#.',
    '#.....#',
  ],
];

const PRIORITY_RANK: Record<DmdBanner['priority'], number> = {
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
};

function formatScore(score: number): string {
  return Math.max(0, Math.floor(score)).toLocaleString('en-US');
}

interface ActiveBannerState {
  banner: DmdBanner;
  elapsed: number;
}

interface StarParticle {
  angle: number;
  dist: number;
  speed: number;
}

export class DmdRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly imageData: ImageData;
  private readonly texture: THREE.CanvasTexture;

  /** 128x32 4-shade (0..3) logical dot framebuffer. */
  private readonly dots = new Uint8Array(DMD_COLS * DMD_ROWS);
  /** Previous uploaded frame for dirty-check skip. */
  private readonly prevDots = new Uint8Array(DMD_COLS * DMD_ROWS);
  private forceUpload = true;

  private elapsed = 0;
  private attractTimer = 0;
  private renderAccum = 0;

  private highScores: HighScoreEntry[] = [
    { initials: 'NOV', score: 350_000 },
    { initials: 'ZAP', score: 250_000 },
    { initials: 'REX', score: 175_000 },
    { initials: 'ION', score: 100_000 },
    { initials: 'ACE', score: 50_000 },
  ];

  private activeBanner: ActiveBannerState | null = null;
  private readonly bannerQueue: DmdBanner[] = [];
  private readonly seenBannerIds: number[] = [];
  private lastSnapshotBannerId = -1;
  private lastPaused: boolean | null = null;
  private lastPhase: GameSnapshot['phase'] | null = null;
  private lastScore = -1;
  private lastIsTilted: boolean | null = null;
  private lastInitialsKey = '';
  private readonly warpStars: StarParticle[] = [];

  private static readonly MAX_BANNER_QUEUE = 4;
  private static readonly MAX_SEEN_BANNER_IDS = 32;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = DMD_CANVAS_WIDTH;
    this.canvas.height = DMD_CANVAS_HEIGHT;

    const ctx = this.canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to acquire 2D canvas context for DmdRenderer.');
    }
    this.ctx = ctx;
    this.imageData = ctx.createImageData(DMD_CANVAS_WIDTH, DMD_CANVAS_HEIGHT);

    // Seed deterministic cosmic star-warp particles for attract & warp banners
    for (let i = 0; i < 34; i++) {
      const a = (i / 34) * Math.PI * 2 + (i % 5) * 0.19;
      this.warpStars.push({
        angle: a,
        dist: 4 + ((i * 19) % 62),
        speed: 18 + (i % 7) * 6,
      });
    }

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;

    // Render initial standby frame
    this.clear(0);
    this.drawCenteredText7x9('HYPERNOVA', 7, 3);
    this.drawCenteredText5x7('READY TO LAUNCH', 21, 2);
    this.flushToCanvas();
  }

  public getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  public getTexture(): THREE.CanvasTexture {
    return this.texture;
  }

  public setHighScores(scores: readonly HighScoreEntry[]): void {
    if (scores.length > 0) {
      this.highScores = scores.map((s) => ({
        initials: s.initials.toUpperCase().slice(0, 3).padEnd(3, 'A'),
        score: s.score,
        date: s.date,
      }));
      this.forceUpload = true;
    }
  }

  private rememberBannerId(id: number): void {
    this.seenBannerIds.push(id);
    if (this.seenBannerIds.length > DmdRenderer.MAX_SEEN_BANNER_IDS) {
      this.seenBannerIds.shift();
    }
  }

  public triggerBanner(banner: DmdBanner): void {
    // Prevent re-queueing a banner already delivered via dmdBanner command & snapshot.activeBanner
    if (this.seenBannerIds.includes(banner.id)) {
      return;
    }

    const incomingTitle = banner.title.trim().toUpperCase();
    const nextRank = PRIORITY_RANK[banner.priority];

    if (!this.activeBanner) {
      this.rememberBannerId(banner.id);
      this.activeBanner = { banner, elapsed: 0 };
      this.forceUpload = true;
      return;
    }

    // Immediate emergency preemption for TILT! (clears lower-priority queued celebrations)
    if (banner.priority === 'critical' && incomingTitle.includes('TILT')) {
      this.rememberBannerId(banner.id);
      this.bannerQueue.length = 0;
      this.activeBanner = { banner, elapsed: 0 };
      this.forceUpload = true;
      return;
    }

    // Deduplicate identical consecutive titles against the latest pending/active banner
    const tail =
      this.bannerQueue.length > 0
        ? this.bannerQueue[this.bannerQueue.length - 1]
        : this.activeBanner.banner;
    if (tail.title.trim().toUpperCase() === incomingTitle) {
      this.rememberBannerId(banner.id);
      if (this.bannerQueue.length > 0) {
        this.bannerQueue[this.bannerQueue.length - 1] = banner;
      } else {
        this.activeBanner = { banner, elapsed: 0 };
        this.forceUpload = true;
      }
      return;
    }

    const curRank = PRIORITY_RANK[this.activeBanner.banner.priority];

    // High/critical banners arriving over low/normal banners preempt immediately for snappy feedback
    if (nextRank >= PRIORITY_RANK.high && curRank < PRIORITY_RANK.high) {
      this.rememberBannerId(banner.id);
      this.activeBanner = { banner, elapsed: 0 };
      this.forceUpload = true;
      return;
    }

    // High/critical banners arriving while another high/critical banner plays queue sequentially
    // so e.g. JACKPOT! -> EXTRA BALL! or EXTRA BALL! -> TOTAL BONUS -> SHOOT AGAIN! never clobber/drop.
    if (nextRank >= PRIORITY_RANK.high && curRank >= PRIORITY_RANK.high) {
      if (this.bannerQueue.length >= DmdRenderer.MAX_BANNER_QUEUE) {
        // Evict oldest non-critical entry first; if all queued are critical and incoming is critical, evict oldest
        const evictIdx = this.bannerQueue.findIndex((b) => b.priority !== 'critical');
        if (evictIdx >= 0) {
          this.bannerQueue.splice(evictIdx, 1);
        } else if (banner.priority === 'critical') {
          this.bannerQueue.shift();
        } else {
          return;
        }
      }
      this.rememberBannerId(banner.id);
      this.bannerQueue.push(banner);
      return;
    }

    // Minor/normal banners cannot interrupt or queue behind active high/critical celebrations
    if (curRank >= PRIORITY_RANK.high) {
      return;
    }

    // Both active and incoming are low/normal: replace active only if incoming is >= current priority
    if (nextRank < curRank) {
      return;
    }
    this.rememberBannerId(banner.id);
    this.activeBanner = { banner, elapsed: 0 };
    this.forceUpload = true;
  }

  public clearBanner(): void {
    this.activeBanner = null;
    this.bannerQueue.length = 0;
    this.seenBannerIds.length = 0;
    this.lastSnapshotBannerId = -1;
    this.forceUpload = true;
  }

  public update(
    dt: number,
    snapshot: GameSnapshot,
    highScoreInitials?: HighScoreInitialsState,
  ): void {
    const safeDt = Math.min(Math.max(dt, 0), 0.1);
    this.elapsed += safeDt;
    this.attractTimer += safeDt;

    // Clear stale gameplay banners when returning to attract mode
    if (snapshot.phase === 'ATTRACT' && (this.activeBanner !== null || this.bannerQueue.length > 0)) {
      this.activeBanner = null;
      this.bannerQueue.length = 0;
      this.forceUpload = true;
    }

    // Force an immediate redraw whenever discrete UI/state flags change
    // (critical when dt === 0, e.g., entering/exiting PAUSED or typing high-score initials)
    const initialsKey = highScoreInitials
      ? `${highScoreInitials.chars.join('')}:${highScoreInitials.cursor}`
      : '';
    if (
      snapshot.paused !== this.lastPaused ||
      snapshot.phase !== this.lastPhase ||
      snapshot.score !== this.lastScore ||
      snapshot.isTilted !== this.lastIsTilted ||
      initialsKey !== this.lastInitialsKey
    ) {
      this.lastPaused = snapshot.paused;
      this.lastPhase = snapshot.phase;
      this.lastScore = snapshot.score;
      this.lastIsTilted = snapshot.isTilted;
      this.lastInitialsKey = initialsKey;
      this.forceUpload = true;
    }

    // Advance warp star particles
    for (const st of this.warpStars) {
      st.dist += st.speed * safeDt;
      if (st.dist > 74) {
        st.dist = 3 + (st.dist % 6);
      }
    }

    // Advance active banner duration and pop next queued banner BEFORE ingesting
    // snapshot.activeBanner so newly emitted banners aren't dropped on an expiry boundary tick.
    if (this.activeBanner) {
      this.activeBanner.elapsed += safeDt;
      if (this.activeBanner.elapsed >= this.activeBanner.banner.duration) {
        const nextBanner = this.bannerQueue.shift();
        this.activeBanner = nextBanner ? { banner: nextBanner, elapsed: 0 } : null;
        this.forceUpload = true;
      }
    }

    // Sync banner triggered inside GameSnapshot automatically (deduplicated via seenBannerIds)
    if (snapshot.activeBanner && snapshot.activeBanner.id !== this.lastSnapshotBannerId) {
      this.lastSnapshotBannerId = snapshot.activeBanner.id;
      this.triggerBanner(snapshot.activeBanner);
    } else if (!snapshot.activeBanner) {
      this.lastSnapshotBannerId = -1;
    }

    // Rasterize DMD at crisp 30 Hz (or immediately on forced update)
    this.renderAccum += safeDt;
    if (!this.forceUpload && this.renderAccum < 1 / 30) {
      return;
    }
    this.renderAccum = 0;

    this.clear(0);

    // Render active view by priority:
    //   1. HIGH_SCORE_ENTRY
    //   2. TILT blackout banner (if tilted during gameplay)
    //   3. Active event banner (except during high score entry)
    //   4. Phase screens: ATTRACT, BALL_BONUS, GAME_OVER, LAUNCH_READY / PLAYING
    if (snapshot.phase === 'HIGH_SCORE_ENTRY') {
      this.renderHighScoreEntry(snapshot, highScoreInitials);
    } else if (this.activeBanner && snapshot.phase !== 'ATTRACT') {
      this.renderBanner(this.activeBanner);
    } else if (snapshot.isTilted && (snapshot.phase === 'PLAYING' || snapshot.phase === 'LAUNCH_READY')) {
      this.renderTiltedScreen();
    } else {
      switch (snapshot.phase) {
        case 'ATTRACT':
          this.renderAttractMode();
          break;
        case 'BALL_BONUS':
          this.renderBonusTally(snapshot);
          break;
        case 'GAME_OVER':
          this.renderGameOver(snapshot);
          break;
        case 'LAUNCH_READY':
        case 'PLAYING':
          this.renderGameplayHud(snapshot);
          break;
      }
    }

    // Subtle pause indicator overlay in top corners when paused
    if (snapshot.paused && snapshot.phase !== 'ATTRACT') {
      this.fillRect(36, 10, 56, 12, 0);
      this.drawRect(36, 10, 56, 12, 2);
      this.drawCenteredText5x7('PAUSED', 13, 3);
    }

    this.flushToCanvas();
  }

  public dispose(): void {
    this.texture.dispose();
  }

  // -------------------------------------------------------------------------
  // Screen Composers
  // -------------------------------------------------------------------------

  private renderAttractMode(): void {
    const cycleLen = 17.5;
    const t = this.attractTimer % cycleLen;

    if (t < 4.5) {
      // Scene 1: Cosmic star-warp + HYPERNOVA hero marquee
      this.drawStarWarp(1);
      const pulse = Math.sin(this.elapsed * 5.0) > -0.2 ? 3 : 2;
      this.drawHorizontalLine(6, 3, 116, 1);
      this.drawHorizontalLine(6, 28, 116, 1);
      this.drawCenteredText7x9('HYPERNOVA', 7, pulse);
      this.drawCenteredText5x7('COSMIC PINBALL', 19, 2);

      // Flanking twinkling pixel starbursts
      const starFrame = Math.floor(this.elapsed * 4) % 2;
      this.drawSprite(4, 8, STARBURST_FRAMES[starFrame], 3);
      this.drawSprite(117, 8, STARBURST_FRAMES[1 - starFrame], 3);
    } else if (t < 8.5) {
      // Scene 2: PRESS START / INSERT COIN with streaking pixel starship
      this.drawStarWarp(1);
      const shipX = Math.floor(((t - 4.5) / 4.0) * 150) - 16;
      this.drawSprite(shipX, 2, ROCKET_ICON, 2);
      // Exhaust trail dots behind rocket
      for (let i = 1; i <= 14; i++) {
        this.setDot(shipX - i, 5, i < 6 ? 2 : 1);
      }

      const blink = Math.floor(this.elapsed * 3.5) % 2 === 0;
      this.drawCenteredText7x9('PRESS START', 11, blink ? 3 : 2);
      this.drawCenteredText5x7('FREE PLAY  3 BALLS', 23, 1);
    } else if (t < 14.5) {
      // Scene 3: Paginated High Score Table covering all ranks (0..1, 2..3, 4)
      const sceneDuration = 6.0;
      const subT = t - 8.5;
      this.drawCenteredText5x7('* HIGH SCORES *', 1, 3);
      this.drawHorizontalLine(8, 9, 112, 1);

      const pageCount = Math.max(1, Math.ceil(this.highScores.length / 2));
      const pageDuration = sceneDuration / pageCount;
      const pageIdx = Math.min(pageCount - 1, Math.floor(subT / pageDuration));
      const pairIdx = pageIdx * 2;

      for (let row = 0; row < 2; row++) {
        const idx = pairIdx + row;
        const entry = this.highScores[idx];
        const y = 12 + row * 10;
        if (!entry) {
          if (row === 1 && this.highScores[pairIdx]) {
            this.drawCenteredText5x7('BEAT THE TOP SCORE!', y, 1);
          }
          continue;
        }
        const rankStr = `${idx + 1}. ${entry.initials}`;
        const scoreStr = formatScore(entry.score);
        this.drawText5x7(rankStr, 6, y, idx === 0 ? 3 : 2);
        this.drawRightAlignedText5x7(scoreStr, 122, y, idx === 0 ? 3 : 2);
      }
    } else {
      // Scene 4: Multiball Feature Teaser
      this.drawRect(1, 1, 126, 30, 1);
      const flash = Math.floor(this.elapsed * 6) % 2 === 0 ? 3 : 2;
      this.drawCenteredText5x7('LOCK 3 IN HYPERCORE', 5, flash);
      this.drawCenteredText5x7('FOR 3-BALL MULTIBALL', 14, 2);
      this.drawCenteredText5x7('SHOOT WARP RAMP!', 23, 1);
    }
  }

  private renderGameplayHud(snapshot: GameSnapshot): void {
    // Top subtle divider & status strip
    const scoreStr = formatScore(snapshot.score);
    const fits7x9 = this.measureText7x9(scoreStr) <= 122;

    if (snapshot.phase === 'LAUNCH_READY') {
      // Score on upper half, blinking LAUNCH / SKILL SHOT cue below
      if (fits7x9) {
        this.drawCenteredText7x9(scoreStr, 2, 3);
      } else {
        this.drawCenteredText5x7(scoreStr, 3, 3);
      }
      this.drawHorizontalLine(4, 13, 120, 1);

      const blink = Math.floor(this.elapsed * 4.5) % 2 === 0;
      const laneNames = ['I', 'O', 'N'];
      const targetLane = laneNames[snapshot.skillShotLaneIndex] ?? 'O';
      this.drawCenteredText5x7(
        blink ? `LAUNCH! HIT LANE ${targetLane}` : `BALL ${snapshot.ballNumber}  SKILL SHOT`,
        16,
        blink ? 3 : 2,
      );
      this.drawText5x7(`B${snapshot.ballNumber}/${snapshot.totalBalls}`, 3, 24, 1);
      this.drawRightAlignedText5x7(`HOLD SPACE`, 125, 24, 1);
      return;
    }

    // Active PLAYING screen: huge crisp score on top, compact telemetry bar on bottom
    if (fits7x9) {
      this.drawCenteredText7x9(scoreStr, 3, 3);
    } else {
      this.drawCenteredText5x7(scoreStr, 4, 3);
    }

    // Subtle glowing separator line
    this.drawHorizontalLine(2, 14, 124, 1);

    // Bottom Row 1 (y = 16): guaranteed >= 8px gaps between Left (x=2..24), Center (x=37..89), Right (x=97..125)
    this.drawText5x7(`B${snapshot.ballNumber}/${snapshot.totalBalls}`, 2, 16, 2);

    if (snapshot.multiballActive) {
      const pulse = Math.floor(this.elapsed * 7) % 2 === 0 ? 3 : 2;
      this.drawCenteredText5x7(
        snapshot.superJackpotLit ? 'SUPER JP!' : 'MULTIBALL',
        16,
        pulse,
      );
    } else if (snapshot.ballSaveActive) {
      const blink = Math.floor(this.elapsed * 6) % 2 === 0;
      this.drawCenteredText5x7(blink ? 'BALL SAVE' : 'SAVE LIT', 16, blink ? 3 : 1);
    } else if (snapshot.rampComboCount >= 2 && snapshot.rampComboTimer > 0) {
      this.drawCenteredText5x7(`${snapshot.rampComboCount}X RAMP`, 16, 3);
    } else if (snapshot.lockLit) {
      const blink = Math.floor(this.elapsed * 5) % 2 === 0 ? 3 : 2;
      this.drawCenteredText5x7('LOCK LIT', 16, blink);
    } else {
      this.drawCenteredText5x7(`BON ${snapshot.bonusMultiplier}X`, 16, 1);
    }

    // Right side multiplier readout (max 5 chars = 29px -> x=97..125)
    const multText =
      snapshot.playfieldMultiplier > 1
        ? `PF ${snapshot.playfieldMultiplier}X`
        : `${snapshot.bonusMultiplier}X`;
    this.drawRightAlignedText5x7(
      multText,
      125,
      16,
      snapshot.playfieldMultiplier > 1 ? 3 : 2,
    );

    // Bottom Row 2 (y = 24): Lock pips [●][●][○], I-O-N status, Shield/Status badge
    this.drawText5x7('LCK', 2, 24, 1);
    for (let i = 0; i < 3; i++) {
      const lx = 22 + i * 7;
      const locked = i < snapshot.lockedBalls;
      this.drawLockPip(lx, 25, locked);
    }

    // Center I-O-N lit indicators
    const ionChars = ['I', 'O', 'N'];
    for (let i = 0; i < 3; i++) {
      const lit = snapshot.ionLanes[i];
      this.drawText5x7(ionChars[i], 55 + i * 7, 24, lit ? 3 : 1);
    }

    // Right side status: EXTRA BALL, SHIELD, TILT WARN, or compact BALL label
    if (snapshot.extraBallLit) {
      this.drawRightAlignedText5x7('EX BALL', 125, 24, 3);
    } else if (snapshot.kickbackLit) {
      this.drawRightAlignedText5x7('SHIELD', 125, 24, 2);
    } else if (snapshot.tiltWarnings > 0) {
      this.drawRightAlignedText5x7(`WARN ${snapshot.tiltWarnings}`, 125, 24, 3);
    } else {
      this.drawRightAlignedText5x7(`BALL ${snapshot.ballNumber}`, 125, 24, 1);
    }
  }

  private renderBanner(state: ActiveBannerState): void {
    const { banner, elapsed } = state;
    const effect = banner.effect ?? 'flash';
    const titleUpper = banner.title.toUpperCase();
    const subUpper = banner.subtitle ? banner.subtitle.toUpperCase() : '';
    const progress = Math.min(1, elapsed / Math.max(0.1, banner.duration));

    // Safe inner text clipping box so banner copy never collides with borders or corner icons
    let innerMinX = 2;
    let innerMaxX = DMD_COLS - 3; // 125

    // Dynamic themed animated background per callout type
    if (
      titleUpper.includes('MULTIBALL') ||
      titleUpper.includes('WARP') ||
      titleUpper.includes('COMBO')
    ) {
      this.drawStarWarp(1);
    } else if (titleUpper.includes('JACKPOT') || titleUpper.includes('SKILL')) {
      const frame = Math.floor(elapsed * 8) % 2;
      this.drawSprite(1, 2, STARBURST_FRAMES[frame], 2);
      this.drawSprite(120, 2, STARBURST_FRAMES[1 - frame], 2);
      this.drawSprite(1, 23, STARBURST_FRAMES[1 - frame], 2);
      this.drawSprite(120, 23, STARBURST_FRAMES[frame], 2);
      innerMinX = 9;
      innerMaxX = 118;
    } else if (titleUpper.includes('DANGER') || titleUpper.includes('TILT')) {
      // Diagonal animated hazard bars along top & bottom edges
      const shift = Math.floor(elapsed * 24) % 8;
      for (let x = 0; x < DMD_COLS; x++) {
        const stripe = ((x + shift) & 7) < 4 ? 2 : 0;
        this.setDot(x, 0, stripe);
        this.setDot(x, 1, stripe);
        this.setDot(x, 30, stripe);
        this.setDot(x, 31, stripe);
      }
    } else if (titleUpper.includes('LOCK') || titleUpper.includes('EXTRA')) {
      this.drawRect(1, 1, 126, 30, Math.floor(elapsed * 8) % 2 === 0 ? 2 : 1);
      innerMinX = 3;
      innerMaxX = 124;
    }

    const innerW = innerMaxX - innerMinX + 1;

    // Choose font size & kerning dynamically to fit cleanly inside inner box
    const useBig = this.measureText7x9(titleUpper) <= innerW;
    const compactTitle = !useBig && this.measureText5x7(titleUpper, false) > innerW;
    const titleShade =
      effect === 'flash'
        ? Math.floor(elapsed * 10) % 2 === 0
          ? 3
          : 2
        : 3;

    const titleY = subUpper ? (useBig ? 5 : 7) : useBig ? 11 : 12;

    if (effect === 'scroll') {
      const textW = useBig
        ? this.measureText7x9(titleUpper)
        : this.measureText5x7(titleUpper, compactTitle);
      const startX = innerMaxX + 4;
      const endX = innerMinX - textW - 4;
      const x = Math.round(startX + (endX - startX) * progress);
      if (useBig) this.drawText7x9(titleUpper, x, titleY, titleShade, innerMinX, innerMaxX);
      else this.drawText5x7(titleUpper, x, titleY, titleShade, compactTitle, innerMinX, innerMaxX);
    } else {
      const yOffset =
        effect === 'zoom' ? Math.round((1 - Math.min(1, elapsed / 0.22)) * -10) : 0;
      if (useBig) {
        this.drawCenteredText7x9(titleUpper, titleY + yOffset, titleShade, innerMinX, innerMaxX);
      } else {
        this.drawCenteredText5x7(
          titleUpper,
          titleY + yOffset,
          titleShade,
          compactTitle,
          innerMinX,
          innerMaxX,
        );
      }
    }

    if (subUpper) {
      const subY = useBig ? 19 : 18;
      const compactSub = this.measureText5x7(subUpper, false) > innerW;
      this.drawCenteredText5x7(subUpper, subY, 2, compactSub, innerMinX, innerMaxX);
    }

    // Horizontal wipe reveal mask during initial 0.18s when effect === 'wipe'
    if (effect === 'wipe' && elapsed < 0.22) {
      const revealCols = Math.floor((elapsed / 0.22) * DMD_COLS);
      for (let y = 0; y < DMD_ROWS; y++) {
        for (let x = revealCols; x < DMD_COLS; x++) {
          this.setDot(x, y, 0);
        }
        if (revealCols < DMD_COLS) {
          this.setDot(revealCols, y, 3);
        }
      }
    }
  }

  private renderTiltedScreen(): void {
    const blink = Math.floor(this.elapsed * 5) % 2 === 0;
    this.drawRect(2, 2, 124, 28, blink ? 2 : 1);
    this.drawCenteredText7x9('TILT!', 7, blink ? 3 : 1);
    this.drawCenteredText5x7('FLIPPERS DISABLED', 20, 2);
  }

  private renderBonusTally(snapshot: GameSnapshot): void {
    const b = snapshot.bonusBreakdown;
    this.drawCenteredText5x7('*** BONUS ***', 2, 3);
    this.drawHorizontalLine(10, 10, 108, 1);

    if (b) {
      const line1 = `${formatScore(b.baseBonus)} X ${b.multiplier}`;
      this.drawCenteredText5x7(line1, 13, 2);
      this.drawCenteredText5x7(`TOTAL ${formatScore(b.totalBonus)}`, 22, 3);
    } else {
      const total = snapshot.bonusPoints * snapshot.bonusMultiplier;
      this.drawCenteredText5x7(
        `${formatScore(snapshot.bonusPoints)} X ${snapshot.bonusMultiplier}`,
        13,
        2,
      );
      this.drawCenteredText5x7(`TOTAL ${formatScore(total)}`, 22, 3);
    }
  }

  private renderGameOver(snapshot: GameSnapshot): void {
    const blink = Math.floor(this.elapsed * 3) % 2 === 0;
    this.drawCenteredText7x9('GAME OVER', 3, 3);
    this.drawCenteredText5x7(`SCORE ${formatScore(snapshot.score)}`, 15, 2);
    this.drawCenteredText5x7('PRESS START', 24, blink ? 3 : 1);
  }

  private renderHighScoreEntry(
    snapshot: GameSnapshot,
    initials?: HighScoreInitialsState,
  ): void {
    const chars = initials?.chars ?? ['A', 'A', 'A'];
    const cursor = Math.max(0, Math.min(2, initials?.cursor ?? 0));
    const blink = Math.floor(this.elapsed * 5) % 2 === 0;

    this.drawCenteredText5x7('NEW HIGH SCORE!', 1, 3);
    this.drawCenteredText5x7(formatScore(snapshot.score), 9, 2);

    // 3 big 7x9 arcade initial slots centered in lower half
    const startX = 43;
    const spacing = 16;
    for (let i = 0; i < 3; i++) {
      const ch = (chars[i] ?? 'A').toUpperCase();
      const x = startX + i * spacing;
      const isSelected = i === cursor;
      this.drawText7x9(ch, x, 18, isSelected ? 3 : 2);
      if (isSelected && blink) {
        this.drawHorizontalLine(x, 29, 7, 3);
        this.drawHorizontalLine(x + 1, 30, 5, 2);
      } else {
        this.drawHorizontalLine(x, 29, 7, 1);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Low-Level 128x32 Dot Framebuffer Primitives
  // -------------------------------------------------------------------------

  private clear(shade = 0): void {
    this.dots.fill(shade);
  }

  private setDot(x: number, y: number, shade: number): void {
    if (x < 0 || x >= DMD_COLS || y < 0 || y >= DMD_ROWS) return;
    const clamped = shade < 0 ? 0 : shade > 3 ? 3 : shade;
    const idx = y * DMD_COLS + x;
    if (clamped > this.dots[idx] || clamped === 0) {
      this.dots[idx] = clamped;
    }
  }

  private fillRect(x: number, y: number, w: number, h: number, shade: number): void {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(DMD_COLS, Math.floor(x + w));
    const y1 = Math.min(DMD_ROWS, Math.floor(y + h));
    for (let py = y0; py < y1; py++) {
      const rowOff = py * DMD_COLS;
      for (let px = x0; px < x1; px++) {
        this.dots[rowOff + px] = shade;
      }
    }
  }

  private drawHorizontalLine(x: number, y: number, w: number, shade: number): void {
    for (let i = 0; i < w; i++) {
      this.setDot(x + i, y, shade);
    }
  }

  private drawRect(x: number, y: number, w: number, h: number, shade: number): void {
    for (let i = 0; i < w; i++) {
      this.setDot(x + i, y, shade);
      this.setDot(x + i, y + h - 1, shade);
    }
    for (let j = 0; j < h; j++) {
      this.setDot(x, y + j, shade);
      this.setDot(x + w - 1, y + j, shade);
    }
  }

  private drawLockPip(x: number, y: number, filled: boolean): void {
    this.drawRect(x, y, 5, 5, filled ? 3 : 1);
    if (filled) {
      this.fillRect(x + 1, y + 1, 3, 3, 3);
    }
  }

  private drawStarWarp(shade: number): void {
    const cx = DMD_COLS * 0.5;
    const cy = DMD_ROWS * 0.5;
    for (const st of this.warpStars) {
      const x = Math.round(cx + Math.cos(st.angle) * st.dist);
      const y = Math.round(cy + Math.sin(st.angle) * (st.dist * 0.38));
      const dotShade = st.dist > 40 ? Math.min(2, shade + 1) : shade;
      this.setDot(x, y, dotShade);
      // Tiny speed streak behind outer stars
      if (st.dist > 30) {
        const tx = Math.round(cx + Math.cos(st.angle) * (st.dist - 2.5));
        const ty = Math.round(cy + Math.sin(st.angle) * ((st.dist - 2.5) * 0.38));
        this.setDot(tx, ty, 1);
      }
    }
  }

  private drawSprite(
    x: number,
    y: number,
    rows: readonly string[],
    shade: number,
    minX = 0,
    maxX = DMD_COLS - 1,
    colStart = 0,
    colCount?: number,
  ): void {
    for (let r = 0; r < rows.length; r++) {
      const line = rows[r];
      const end = colCount !== undefined ? Math.min(line.length, colStart + colCount) : line.length;
      for (let c = colStart; c < end; c++) {
        if (line[c] === '#') {
          const px = x + (c - colStart);
          if (px >= minX && px <= maxX) {
            this.setDot(px, y + r, shade);
          }
        }
      }
    }
  }

  private measureText5x7(text: string, compact = false): number {
    if (text.length === 0) return 0;
    if (!compact) {
      return text.length * 6 - 1;
    }
    const upper = text.toUpperCase();
    let total = 0;
    for (let i = 0; i < upper.length; i++) {
      const metric = FONT_5X7_METRICS[upper[i]] ?? FONT_5X7_METRICS[' '];
      total += metric.width + 1;
    }
    return Math.max(0, total - 1);
  }

  private drawText5x7(
    text: string,
    x: number,
    y: number,
    shade: number,
    compact = false,
    minX = 0,
    maxX = DMD_COLS - 1,
  ): void {
    let cursorX = Math.round(x);
    const upper = text.toUpperCase();
    for (let i = 0; i < upper.length; i++) {
      const ch = upper[i];
      const glyph = FONT_5X7[ch] ?? FONT_5X7[' '];
      if (compact) {
        const metric = FONT_5X7_METRICS[ch] ?? FONT_5X7_METRICS[' '];
        this.drawSprite(cursorX, y, glyph, shade, minX, maxX, metric.left, metric.width);
        cursorX += metric.width + 1;
      } else {
        this.drawSprite(cursorX, y, glyph, shade, minX, maxX);
        cursorX += 6;
      }
    }
  }

  private drawCenteredText5x7(
    text: string,
    y: number,
    shade: number,
    compact = false,
    minX = 0,
    maxX = DMD_COLS - 1,
  ): void {
    const w = this.measureText5x7(text, compact);
    const boxW = maxX - minX + 1;
    const startX = minX + Math.floor((boxW - w) / 2);
    this.drawText5x7(text, startX, y, shade, compact, minX, maxX);
  }

  private drawRightAlignedText5x7(text: string, rightX: number, y: number, shade: number): void {
    const w = this.measureText5x7(text);
    this.drawText5x7(text, rightX - w, y, shade);
  }

  private measureText7x9(text: string): number {
    if (text.length === 0) return 0;
    let total = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      // Narrower advance for comma/period/space so scores look authentic & tight
      total += ch === ',' || ch === '.' ? 5 : ch === ' ' ? 5 : 8;
    }
    return total - 1;
  }

  private drawText7x9(
    text: string,
    x: number,
    y: number,
    shade: number,
    minX = 0,
    maxX = DMD_COLS - 1,
  ): void {
    let cursorX = Math.round(x);
    const upper = text.toUpperCase();
    for (let i = 0; i < upper.length; i++) {
      const ch = upper[i];
      const glyph = FONT_7X9[ch] ?? FONT_7X9[' '];
      const offset = ch === ',' || ch === '.' ? -1 : 0;
      this.drawSprite(cursorX + offset, y, glyph, shade, minX, maxX);
      cursorX += ch === ',' || ch === '.' ? 5 : ch === ' ' ? 5 : 8;
    }
  }

  private drawCenteredText7x9(
    text: string,
    y: number,
    shade: number,
    minX = 0,
    maxX = DMD_COLS - 1,
  ): void {
    const w = this.measureText7x9(text);
    const boxW = maxX - minX + 1;
    const startX = minX + Math.floor((boxW - w) / 2);
    this.drawText7x9(text, startX, y, shade, minX, maxX);
  }

  // -------------------------------------------------------------------------
  // Rasterize 128x32 Dot Buffer -> 512x128 Circular Amber LED CanvasTexture
  // -------------------------------------------------------------------------

  private flushToCanvas(): void {
    // Dirty check: skip rasterization & GPU upload when frame is unchanged
    let changed = this.forceUpload;
    if (!changed) {
      for (let i = 0; i < this.dots.length; i++) {
        if (this.dots[i] !== this.prevDots[i]) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) return;

    this.prevDots.set(this.dots);
    this.forceUpload = false;

    const data = this.imageData.data;
    const stride = DMD_CANVAS_WIDTH * 4;

    for (let row = 0; row < DMD_ROWS; row++) {
      const basePy = row * DMD_DOT_SIZE;
      const dotRowOffset = row * DMD_COLS;

      for (let col = 0; col < DMD_COLS; col++) {
        const shade = this.dots[dotRowOffset + col];
        const cellPalette = SHADE_CELL_RGB[shade];
        const basePx = col * DMD_DOT_SIZE;

        for (let dy = 0; dy < DMD_DOT_SIZE; dy++) {
          const maskRow = CELL_MASK[dy];
          let pixelIdx = (basePy + dy) * stride + basePx * 4;

          for (let dx = 0; dx < DMD_DOT_SIZE; dx++) {
            const rgb = cellPalette[maskRow[dx]];
            data[pixelIdx] = rgb[0];
            data[pixelIdx + 1] = rgb[1];
            data[pixelIdx + 2] = rgb[2];
            data[pixelIdx + 3] = 255;
            pixelIdx += 4;
          }
        }
      }
    }

    this.ctx.putImageData(this.imageData, 0, 0);
    this.texture.needsUpdate = true;
  }
}
