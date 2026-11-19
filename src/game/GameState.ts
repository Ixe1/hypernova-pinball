/**
 * HYPERNOVA — Deterministic 1990s Pinball Ruleset & State Machine
 *
 * Pure TypeScript gameplay engine with zero WebGL/DOM dependencies.
 * Drives phases, scoring, Skill Shot, I-O-N lane change & bonus multiplier,
 * R-A-Y drop targets -> Shield Kickback & Lock, right standup playfield
 * multipliers, Warp Ramp combos, 3-ball Hypercore Multiball with alternating
 * Jackpot & Super Jackpot, Hyper Save, Extra Ball, Tilt forfeiture, animated
 * End-of-Ball Bonus Tally, and High Score entry.
 */

import {
  BALL_SAVE_DURATION_SEC,
  EXTRA_BALL_SCORE_THRESHOLD,
  MAX_BALLS,
  MAX_BONUS_MULTIPLIER,
  MULTIBALL_BALL_SAVE_SEC,
  PALETTE,
  PLAYFIELD_MAX_X,
  PLAYFIELD_MULT_DURATION_SEC,
  RAMP_COMBO_WINDOW_SEC,
  SAUCER_HOLD_DURATION,
  SKILL_SHOT_WINDOW_SEC,
  TOTAL_BALLS_PER_GAME,
} from '../config/constants';
import type {
  BonusBreakdown,
  DmdBanner,
  DmdBannerEffect,
  DmdBannerPriority,
  GamePhase,
  GameSnapshot,
  HighScoreEntry,
  LampId,
  PhysicsEvent,
  Vec3,
} from '../config/types';
import {
  insertHighScore,
  isHighScore,
  loadHighScores,
  resetHighScores,
  sanitizeInitials,
  type StorageLike,
} from './HighScores';
import type { LampShowName } from './LampController';

export type { LampShowName };

export type GameSoundId =
  | 'startGame'
  | 'popBumper'
  | 'slingshot'
  | 'dropTarget'
  | 'dropTargetBankReset'
  | 'standupTarget'
  | 'rollover'
  | 'rolloverComplete'
  | 'spinnerTick'
  | 'plungerRelease'
  | 'saucerCapture'
  | 'saucerEject'
  | 'kickback'
  | 'wallBounce'
  | 'ballCollision'
  | 'drain'
  | 'ballSave'
  | 'tiltWarning'
  | 'tilt'
  | 'skillShot'
  | 'rampCombo'
  | 'ballLocked'
  | 'multiballStart'
  | 'jackpot'
  | 'extraBall'
  | 'bonusTick'
  | 'gameOver';

export type GameCommand =
  | {
      readonly type: 'spawnBall';
      readonly reason: 'newBall' | 'ballSave' | 'lockReplacement';
    }
  | { readonly type: 'spawnMultiball'; readonly targetBallCount: number }
  | {
      readonly type: 'ejectSaucer';
      readonly ballId?: number;
      readonly delaySec?: number;
    }
  | { readonly type: 'resetDropTargets' }
  | { readonly type: 'setKickbackArmed'; readonly armed: boolean }
  | { readonly type: 'setFlippersEnabled'; readonly enabled: boolean }
  | { readonly type: 'dmdBanner'; readonly banner: DmdBanner }
  | {
      readonly type: 'sound';
      readonly sound: GameSoundId;
      readonly pan?: number;
      readonly intensity?: number;
      readonly index?: number;
      readonly count?: number;
      readonly isSuper?: boolean;
    }
  | { readonly type: 'setMusicMode'; readonly mode: 'off' | 'normal' | 'multiball' }
  | { readonly type: 'lampShow'; readonly show: LampShowName; readonly duration?: number }
  | { readonly type: 'flashLamp'; readonly lampId: LampId; readonly duration?: number }
  | {
      readonly type: 'sparkBurst';
      readonly position: Vec3;
      readonly color: number;
      readonly count?: number;
      readonly speed?: number;
    }
  | { readonly type: 'hypercorePulse' }
  | { readonly type: 'resetTilt' };

export interface GameStateOptions {
  /** Optional injected storage for HighScores persistence (useful in tests). */
  readonly storage?: StorageLike | null;
}

// ---------------------------------------------------------------------------
// Scoring Table Constants
// ---------------------------------------------------------------------------
export const SCORE_SKILL_SHOT = 25_000;
export const SCORE_ROLLOVER = 1_000;
export const SCORE_ION_COMPLETE = 10_000;
export const SCORE_DROP_TARGET = 3_000;
export const SCORE_DROP_BANK_COMPLETE = 15_000;
export const SCORE_STANDUP_TARGET = 2_500;
export const SCORE_STANDUP_BANK_COMPLETE = 12_000;
export const SCORE_POP_BUMPER = 1_500;
export const SCORE_SUPER_JET_BUMPER = 5_000;
export const SUPER_JETS_THRESHOLD = 15;
export const SCORE_SLINGSHOT = 750;
export const SCORE_SPINNER_TICK = 500;
export const SCORE_SPINNER_COMBO_TICK = 2_000;
export const SCORE_INLANE = 1_000;
export const SCORE_OUTLANE = 2_000;
export const SCORE_ORBIT = 5_000;
export const SCORE_KICKBACK = 5_000;
export const SCORE_WARP_RAMP_BASE = 15_000;
export const MAX_RAMP_COMBO = 5;
export const SCORE_REACTOR_BONUS = 10_000;
export const SCORE_LOCK_STEP = 10_000; // Lock 1: 10k, Lock 2: 20k, Lock 3: 30k
export const SCORE_JACKPOT = 100_000;
export const SCORE_SUPER_JACKPOT = 250_000;
export const DROP_TARGET_RESET_DELAY_SEC = 0.45;

const PLAYFIELD_MULT_TIERS = [1, 2, 3, 5] as const;
const BONUS_STEP_DURATION_SEC = 0.55;
const TILT_BONUS_HOLD_SEC = 1.0;

const PRIORITY_WEIGHT: Record<DmdBannerPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
};

const ION_LAMPS: readonly LampId[] = ['lane_i', 'lane_o', 'lane_n'];
const DROP_LAMPS: readonly LampId[] = ['drop_r', 'drop_a', 'drop_y'];
const STANDUP_LAMPS: readonly LampId[] = ['standup_1', 'standup_2', 'standup_3'];
const BUMPER_LAMPS: readonly LampId[] = ['bumper_1', 'bumper_2', 'bumper_3'];
const BUMPER_COLORS: readonly number[] = [PALETTE.magenta, PALETTE.cyan, PALETTE.amber];

function positionToPan(pos?: Vec3): number {
  if (!pos || !Number.isFinite(pos.x)) {
    return 0;
  }
  return Math.max(-1, Math.min(1, pos.x / PLAYFIELD_MAX_X));
}

function formatScore(value: number): string {
  return Math.floor(value).toLocaleString('en-US');
}

function formatCompactScore(value: number): string {
  const clean = Math.floor(value);
  if (clean >= 1_000_000) {
    return `${(clean / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (clean >= 1_000 && clean % 1_000 === 0) {
    return `${Math.floor(clean / 1_000)}K`;
  }
  return formatScore(clean);
}

export class GameState {
  private readonly storage?: StorageLike | null;
  private commands: GameCommand[] = [];
  private highScores: readonly HighScoreEntry[] = [];

  // Core game state
  private phase: GamePhase = 'ATTRACT';
  private score = 0;
  private highScore = 0;
  private ballNumber = 1;
  private readonly totalBalls = TOTAL_BALLS_PER_GAME;
  private extraBalls = 0;
  private extraBallLit = false;
  private extraBallAwardedThisGame = false;
  private paused = false;

  // End-of-ball bonus & tally animation
  private bonusPoints = 0;
  private bonusMultiplier = 1;
  private bonusBreakdown: BonusBreakdown | null = null;
  private bonusStepTimer = 0;
  private bonusApplied = false;

  // Playfield multipliers & combos
  private playfieldMultiplier = 1;
  private playfieldMultiplierTimer = 0;
  private rampComboCount = 0;
  private rampComboTimer = 0;

  // Skill shot & I-O-N rollovers
  private skillShotActive = false;
  private skillShotTimer = 0;
  private skillShotLaneIndex = 0;
  private ionLanes: [boolean, boolean, boolean] = [false, false, false];

  // Target banks & pop bumpers
  private dropTargets: [boolean, boolean, boolean] = [false, false, false];
  private dropTargetResetTimer = 0;
  private standupTargets: [boolean, boolean, boolean] = [false, false, false];
  private bumperHitCount = 0;

  // Utility, Lock & Multiball state
  private kickbackLit = false;
  private lockLit = false;
  private lockedBalls = 0;
  private multiballActive = false;
  private jackpotLit = false;
  private superJackpotLit = false;
  private multiballJackpotCount = 0;

  // Ball Save & active ball tracking
  private ballSaveActive = false;
  private ballSaveTimer = 0;
  private activeBallCount = 0;

  // Tilt state
  private tiltWarnings = 0;
  private isTilted = false;

  // High score qualification
  private qualifiesForHighScore = false;

  // Active DMD banner
  private nextBannerId = 1;
  private activeBanner: DmdBanner | null = null;
  private activeBannerTimer = 0;

  constructor(options?: GameStateOptions) {
    this.storage = options?.storage;
    this.setHighScores(loadHighScores(this.storage));
    this.highScore = this.highScores[0]?.score ?? 0;
  }

  // -------------------------------------------------------------------------
  // Public Lifecycle & Input Methods
  // -------------------------------------------------------------------------

  /** Starts a fresh 3-ball game from any phase. */
  startNewGame(): void {
    this.setHighScores(loadHighScores(this.storage));
    this.score = 0;
    this.highScore = this.highScores[0]?.score ?? 0;
    this.ballNumber = 1;
    this.extraBalls = 0;
    this.extraBallLit = false;
    this.extraBallAwardedThisGame = false;
    this.paused = false;
    this.qualifiesForHighScore = false;
    this.bumperHitCount = 0;

    // Lock 1 is immediately lit at game start so players discover Multiball quickly;
    // Lock 2 & Lock 3 require completing R-A-Y drop targets or the Warp Ramp.
    this.lockedBalls = 0;
    this.lockLit = true;
    this.multiballActive = false;
    this.jackpotLit = false;
    this.superJackpotLit = false;
    this.multiballJackpotCount = 0;

    this.activeBanner = null;
    this.activeBannerTimer = 0;
    this.dropTargetResetTimer = 0;

    this.emit({ type: 'sound', sound: 'startGame' });
    this.prepareBall(false);
  }

  /** Transitions back to ATTRACT mode (e.g. from GAME_OVER). */
  returnToAttract(): void {
    this.phase = 'ATTRACT';
    this.activeBallCount = 0;
    this.bonusBreakdown = null;
    this.activeBanner = null;
    this.activeBannerTimer = 0;
    this.dropTargetResetTimer = 0;
    this.paused = false;
    this.isTilted = false;
    this.tiltWarnings = 0;
    this.emit({ type: 'setFlippersEnabled', enabled: false });
    this.emit({ type: 'setMusicMode', mode: 'off' });
    this.emit({ type: 'lampShow', show: 'ATTRACT_WAVE' });
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /**
   * Called when the spring plunger releases a shot inside the shooter lane.
   * Intentionally keeps `LAUNCH_READY` active (without burning Skill Shot or
   * Ball Save timers) until the ball actually clears the shooter lane via
   * `shooterExit` (`onBallEnteredPlayfield()`), so weak plunges can be retried.
   */
  onPlungerLaunched(): void {
    // No-op phase transition: timers begin once the ball clears the shooter gate.
  }

  /**
   * Called when the launched ball physically clears the shooter lane / one-way
   * gate into the active playfield. Transitions `LAUNCH_READY -> PLAYING` and
   * starts the 5s Skill Shot and 12s Hyper Save timers.
   */
  onBallEnteredPlayfield(): void {
    if (this.phase !== 'LAUNCH_READY') {
      return;
    }

    this.phase = 'PLAYING';
    this.skillShotActive = true;
    this.skillShotTimer = SKILL_SHOT_WINDOW_SEC;
    this.ballSaveActive = true;
    this.ballSaveTimer = BALL_SAVE_DURATION_SEC;

    this.emit({ type: 'lampShow', show: 'SKILL_SHOT_PULSE', duration: 1.2 });
  }

  /**
   * Defensive reconciliation against physical ball count in `PhysicsWorld`.
   * If active play ever reaches 0 physical balls (with no pending launches),
   * ends Multiball and transitions cleanly to `BALL_BONUS` instead of soft-locking.
   */
  reconcileActiveBallCount(physicalCount: number): void {
    if (this.phase !== 'PLAYING' || this.paused) {
      return;
    }

    const cleanCount = Math.max(
      0,
      Math.min(MAX_BALLS, Math.floor(Number.isFinite(physicalCount) ? physicalCount : 0)),
    );

    if (cleanCount === 0) {
      this.activeBallCount = 0;
      if (this.multiballActive) {
        this.multiballActive = false;
        this.jackpotLit = false;
        this.superJackpotLit = false;
        this.lockedBalls = 0;
        this.lockLit = false;
      }
      this.beginBallBonus();
      return;
    }

    if (cleanCount === this.activeBallCount) {
      return;
    }

    this.activeBallCount = cleanCount;

    if (this.multiballActive && this.activeBallCount <= 1) {
      this.multiballActive = false;
      this.jackpotLit = false;
      this.superJackpotLit = false;
      this.lockedBalls = 0;
      this.lockLit = false;
      if (!this.isTilted) {
        this.emit({ type: 'setMusicMode', mode: 'normal' });
      }
    }
  }

  /**
   * Classic arcade lane change: left/right flipper rotates lit top `I-O-N` lanes,
   * and rotates the flashing Skill Shot target lane during `LAUNCH_READY` or
   * during `PLAYING` while `skillShotActive` (before any `I-O-N` rollover hit).
   */
  onFlipperPressed(side: 'left' | 'right'): void {
    if (this.paused || this.isTilted) {
      return;
    }

    if (this.phase === 'LAUNCH_READY') {
      if (this.skillShotActive) {
        this.skillShotLaneIndex =
          side === 'left'
            ? (this.skillShotLaneIndex + 2) % 3
            : (this.skillShotLaneIndex + 1) % 3;
      }
      return;
    }

    if (this.phase === 'PLAYING') {
      const noIonHitYet = !this.ionLanes[0] && !this.ionLanes[1] && !this.ionLanes[2];
      if (this.skillShotActive && noIonHitYet) {
        this.skillShotLaneIndex =
          side === 'left'
            ? (this.skillShotLaneIndex + 2) % 3
            : (this.skillShotLaneIndex + 1) % 3;
      }

      const [i, o, n] = this.ionLanes;
      if (side === 'left') {
        // Shift left: [I, O, N] -> [O, N, I]
        this.ionLanes = [o, n, i];
      } else {
        // Shift right: [I, O, N] -> [N, I, O]
        this.ionLanes = [n, i, o];
      }
    }
  }

  /** Registers a plumb-bob DANGER warning (strikes 1–2; strike 3 escalates to TILT). */
  onTiltWarning(warningNumber?: number): void {
    if (this.isTilted || this.phase !== 'PLAYING') {
      return;
    }

    const nextWarnings =
      warningNumber !== undefined && Number.isFinite(warningNumber)
        ? Math.max(this.tiltWarnings + 1, Math.floor(warningNumber))
        : this.tiltWarnings + 1;

    this.tiltWarnings = Math.min(3, nextWarnings);

    if (this.tiltWarnings >= 3) {
      this.onTilt();
      return;
    }

    this.emit({ type: 'sound', sound: 'tiltWarning' });
    this.emit({ type: 'flashLamp', lampId: 'flasher_left', duration: 0.35 });
    this.emit({ type: 'flashLamp', lampId: 'flasher_right', duration: 0.35 });
    this.triggerBanner(
      'DANGER!',
      `WARNING ${this.tiltWarnings} OF 2`,
      1.8,
      'high',
      'flash',
    );
  }

  /** Enters full TILT until the active ball(s) drain: disables flippers & forfeits bonus. */
  onTilt(): void {
    if (this.isTilted || (this.phase !== 'PLAYING' && this.phase !== 'LAUNCH_READY')) {
      return;
    }

    this.isTilted = true;
    this.tiltWarnings = 3;
    this.ballSaveActive = false;
    this.ballSaveTimer = 0;
    this.kickbackLit = false;
    this.skillShotActive = false;
    this.skillShotTimer = 0;
    this.rampComboCount = 0;
    this.rampComboTimer = 0;
    this.playfieldMultiplier = 1;
    this.playfieldMultiplierTimer = 0;
    this.dropTargetResetTimer = 0;

    this.emit({ type: 'setFlippersEnabled', enabled: false });
    this.emit({ type: 'setKickbackArmed', armed: false });
    this.emit({ type: 'setMusicMode', mode: 'off' });
    this.emit({ type: 'sound', sound: 'tilt' });
    this.emit({ type: 'lampShow', show: 'TILT_BLACKOUT', duration: 999 });
    this.triggerBanner('TILT!', 'BONUS FORFEITED', 4.0, 'critical', 'flash');
  }

  /** Saves 3-letter arcade initials during `HIGH_SCORE_ENTRY` and advances to `GAME_OVER`. */
  submitHighScore(initials: string): readonly HighScoreEntry[] {
    if (this.phase !== 'HIGH_SCORE_ENTRY') {
      return this.getHighScores();
    }

    const cleanInitials = sanitizeInitials(initials);
    this.setHighScores(insertHighScore(cleanInitials, this.score, this.storage));
    this.highScore = Math.max(this.score, this.highScores[0]?.score ?? 0);
    this.qualifiesForHighScore = false;
    this.phase = 'GAME_OVER';

    this.triggerBanner(
      'HIGH SCORE SAVED!',
      `${cleanInitials} ${formatScore(this.score)}`,
      3.5,
      'high',
      'zoom',
    );

    return this.getHighScores();
  }

  /** Resets persisted leaderboard to default sci-fi arcade entries. */
  resetLeaderboard(): readonly HighScoreEntry[] {
    this.setHighScores(resetHighScores(this.storage));
    this.highScore = Math.max(this.score, this.highScores[0]?.score ?? 0);
    return this.getHighScores();
  }

  // -------------------------------------------------------------------------
  // Fixed/Frame Time Update
  // -------------------------------------------------------------------------

  update(dt: number): void {
    if (this.paused || !Number.isFinite(dt) || dt <= 0) {
      return;
    }

    // Active DMD banner timer
    if (this.activeBanner) {
      this.activeBannerTimer -= dt;
      if (this.activeBannerTimer <= 0) {
        this.activeBanner = null;
        this.activeBannerTimer = 0;
      }
    }

    if (this.phase === 'PLAYING') {
      // Skill shot countdown
      if (this.skillShotActive) {
        this.skillShotTimer -= dt;
        if (this.skillShotTimer <= 0) {
          this.skillShotTimer = 0;
          this.skillShotActive = false;
        }
      }

      // Ball Save countdown
      if (this.ballSaveActive) {
        this.ballSaveTimer -= dt;
        if (this.ballSaveTimer <= 0) {
          this.ballSaveTimer = 0;
          this.ballSaveActive = false;
        }
      }

      // Timed Playfield Multiplier countdown
      if (this.playfieldMultiplier > 1) {
        this.playfieldMultiplierTimer -= dt;
        if (this.playfieldMultiplierTimer <= 0) {
          this.playfieldMultiplierTimer = 0;
          this.playfieldMultiplier = 1;
        }
      }

      // Warp Ramp Combo window countdown
      if (this.rampComboCount > 0) {
        this.rampComboTimer -= dt;
        if (this.rampComboTimer <= 0) {
          this.rampComboTimer = 0;
          this.rampComboCount = 0;
        }
      }

      // Delayed R-A-Y drop target bank reset (holds 3rd target down briefly for visual/audio clarity)
      if (!this.isTilted && this.dropTargetResetTimer > 0) {
        this.dropTargetResetTimer -= dt;
        if (this.dropTargetResetTimer <= 0) {
          this.dropTargetResetTimer = 0;
          this.dropTargets = [false, false, false];
          this.emit({ type: 'resetDropTargets' });
          this.emit({ type: 'sound', sound: 'dropTargetBankReset' });
        }
      }
    } else if (this.phase === 'BALL_BONUS') {
      this.updateBallBonus(dt);
    }
  }

  // -------------------------------------------------------------------------
  // Physics Event Dispatcher
  // -------------------------------------------------------------------------

  handlePhysicsEvent(event: PhysicsEvent): void {
    if (this.paused) {
      return;
    }

    switch (event.type) {
      case 'plungerLaunch':
        this.emit({
          type: 'sound',
          sound: 'plungerRelease',
          intensity: event.tension,
        });
        if (this.phase === 'LAUNCH_READY') {
          this.onPlungerLaunched();
        }
        break;

      case 'shooterExit':
        this.onBallEnteredPlayfield();
        break;

      case 'rollover':
        this.handleRollover(event.index, event.position);
        break;

      case 'bumper':
        this.handlePopBumper(event.index, event.position);
        break;

      case 'slingshot':
        this.handleSlingshot(event.side, event.position);
        break;

      case 'dropTarget':
        this.handleDropTarget(event.index, event.position);
        break;

      case 'standup':
        this.handleStandup(event.index, event.position);
        break;

      case 'spinner':
        this.handleSpinner(event.halfRevolutions, event.angularVelocity, event.position);
        break;

      case 'lane':
        this.handleLane(event.lane, event.position);
        break;

      case 'orbit':
        this.handleOrbit(event.side, event.position);
        break;

      case 'kickback':
        this.handleKickback(event.position);
        break;

      case 'rampEntry':
        if (this.phase === 'PLAYING' && !this.isTilted) {
          this.emit({ type: 'flashLamp', lampId: 'arrow_warp_ramp', duration: 0.3 });
          this.emit({ type: 'lampShow', show: 'RAMP_CHASE', duration: 1.1 });
          this.emit({
            type: 'sparkBurst',
            position: event.position,
            color: PALETTE.cyan,
            count: 10,
            speed: 8,
          });
        }
        break;

      case 'rampRollback':
        // Weak shot rolled back onto the playfield — no score or combo advance.
        break;

      case 'rampComplete':
        this.handleRampComplete(event.position);
        break;

      case 'wireformExit':
        if (this.phase === 'PLAYING' && !this.isTilted) {
          this.emit({ type: 'flashLamp', lampId: 'inlane_left', duration: 0.25 });
          this.emit({
            type: 'sparkBurst',
            position: event.position,
            color: PALETTE.cyan,
            count: 8,
            speed: 6,
          });
        }
        break;

      case 'saucerCapture':
        this.handleSaucerCapture(event.ballId, event.position);
        break;

      case 'saucerEject':
        this.emit({ type: 'sound', sound: 'saucerEject' });
        this.emit({ type: 'hypercorePulse' });
        this.emit({ type: 'flashLamp', lampId: 'flasher_hypercore', duration: 0.3 });
        break;

      case 'drain':
        this.handleDrain();
        break;

      case 'wallHit':
        if (event.impactSpeed > 4.0) {
          this.emit({
            type: 'sound',
            sound: 'wallBounce',
            intensity: event.impactSpeed,
            pan: positionToPan(event.position),
          });
        }
        break;

      case 'ballCollision':
        if (event.impactSpeed > 2.0) {
          this.emit({
            type: 'sound',
            sound: 'ballCollision',
            intensity: event.impactSpeed,
            pan: positionToPan(event.position),
          });
          this.emit({
            type: 'sparkBurst',
            position: event.position,
            color: PALETTE.chrome,
            count: 6,
            speed: 5,
          });
        }
        break;

      case 'flipperHit':
        if (event.impactSpeed > 24.0 && !this.isTilted) {
          this.emit({
            type: 'sparkBurst',
            position: event.position,
            color: PALETTE.cyanGlow,
            count: 6,
            speed: 6,
          });
        }
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Output Commands & Read-Only Snapshots
  // -------------------------------------------------------------------------

  /** Drains and returns all structured commands queued since the last call. */
  consumeCommands(): GameCommand[] {
    if (this.commands.length === 0) {
      return [];
    }
    const out = this.commands;
    this.commands = [];
    return out;
  }

  /** Returns the cached immutable Top-5 leaderboard (zero per-frame allocations). */
  getHighScores(): readonly HighScoreEntry[] {
    return this.highScores;
  }

  getBumperHitCount(): number {
    return this.bumperHitCount;
  }

  isSuperJetsActive(): boolean {
    return this.bumperHitCount >= SUPER_JETS_THRESHOLD;
  }

  getSnapshot(): GameSnapshot {
    return {
      phase: this.phase,
      score: this.score,
      highScore: this.highScore,
      ballNumber: this.ballNumber,
      totalBalls: this.totalBalls,
      extraBalls: this.extraBalls,
      bonusPoints: this.bonusPoints,
      bonusMultiplier: this.bonusMultiplier,
      playfieldMultiplier: this.playfieldMultiplier,
      playfieldMultiplierTimer: this.playfieldMultiplierTimer,
      rampComboCount: this.rampComboCount,
      rampComboTimer: this.rampComboTimer,
      skillShotActive: this.skillShotActive,
      skillShotLaneIndex: this.skillShotLaneIndex,
      ionLanes: [this.ionLanes[0], this.ionLanes[1], this.ionLanes[2]],
      dropTargets: [this.dropTargets[0], this.dropTargets[1], this.dropTargets[2]],
      standupTargets: [
        this.standupTargets[0],
        this.standupTargets[1],
        this.standupTargets[2],
      ],
      kickbackLit: this.kickbackLit,
      lockLit: this.lockLit,
      lockedBalls: this.lockedBalls,
      multiballActive: this.multiballActive,
      jackpotLit: this.jackpotLit,
      superJackpotLit: this.superJackpotLit,
      ballSaveActive: this.ballSaveActive,
      ballSaveTimer: this.ballSaveTimer,
      extraBallLit: this.extraBallLit,
      activeBallCount: this.activeBallCount,
      tiltWarnings: this.tiltWarnings,
      isTilted: this.isTilted,
      activeBanner: this.activeBanner ? { ...this.activeBanner } : null,
      bonusBreakdown: this.bonusBreakdown ? { ...this.bonusBreakdown } : null,
      qualifiesForHighScore: this.qualifiesForHighScore,
      paused: this.paused,
    };
  }

  // -------------------------------------------------------------------------
  // Individual Feature Rule Handlers
  // -------------------------------------------------------------------------

  private canScorePlayfield(): boolean {
    return this.phase === 'PLAYING' && !this.isTilted;
  }

  private handleRollover(index: number, position: Vec3): void {
    if (!this.canScorePlayfield() || index < 0 || index > 2) {
      return;
    }

    const pan = positionToPan(position);
    this.emit({ type: 'flashLamp', lampId: ION_LAMPS[index], duration: 0.25 });
    this.emit({ type: 'sound', sound: 'rollover', index, pan });

    if (this.skillShotActive && index === this.skillShotLaneIndex) {
      this.skillShotActive = false;
      this.skillShotTimer = 0;
      const awarded = this.awardScore(SCORE_SKILL_SHOT, 5_000);
      this.emit({ type: 'sound', sound: 'skillShot' });
      this.emit({ type: 'lampShow', show: 'SKILL_SHOT_PULSE', duration: 1.5 });
      this.emit({
        type: 'sparkBurst',
        position,
        color: PALETTE.gold,
        count: 20,
        speed: 12,
      });
      this.triggerBanner(
        'SKILL SHOT!',
        `+${formatScore(awarded)}`,
        2.2,
        'high',
        'flash',
      );
    } else {
      this.awardScore(SCORE_ROLLOVER, 500);
    }

    this.ionLanes[index] = true;

    if (this.ionLanes[0] && this.ionLanes[1] && this.ionLanes[2]) {
      this.ionLanes = [false, false, false];
      this.bonusMultiplier = Math.min(MAX_BONUS_MULTIPLIER, this.bonusMultiplier + 1);
      const bonusAward = this.awardScore(SCORE_ION_COMPLETE, 2_000);
      this.emit({ type: 'sound', sound: 'rolloverComplete' });
      this.emit({ type: 'flashLamp', lampId: 'flasher_right', duration: 0.4 });
      this.triggerBanner(
        `BONUS ${this.bonusMultiplier}X!`,
        `I-O-N +${formatScore(bonusAward)}`,
        2.0,
        'normal',
        'zoom',
      );
    }
  }

  private handlePopBumper(index: number, position: Vec3): void {
    if (!this.canScorePlayfield()) {
      return;
    }

    const safeIdx = Math.max(0, Math.min(2, index));
    const wasSuperJets = this.bumperHitCount >= SUPER_JETS_THRESHOLD;
    this.bumperHitCount += 1;

    const points = wasSuperJets ? SCORE_SUPER_JET_BUMPER : SCORE_POP_BUMPER;
    this.awardScore(points, 300);

    this.emit({
      type: 'sound',
      sound: 'popBumper',
      index: this.bumperHitCount,
      pan: positionToPan(position),
    });
    this.emit({ type: 'flashLamp', lampId: BUMPER_LAMPS[safeIdx], duration: 0.16 });
    this.emit({
      type: 'sparkBurst',
      position,
      color: BUMPER_COLORS[safeIdx],
      count: wasSuperJets ? 18 : 12,
      speed: wasSuperJets ? 12 : 9,
    });

    if (this.bumperHitCount === SUPER_JETS_THRESHOLD) {
      this.triggerBanner(
        'SUPER JETS LIT!',
        '5,000 PER BUMPER',
        2.2,
        'high',
        'flash',
      );
      this.emit({ type: 'flashLamp', lampId: 'flasher_right', duration: 0.45 });
    }
  }

  private handleSlingshot(side: 'left' | 'right', position: Vec3): void {
    if (!this.canScorePlayfield()) {
      return;
    }

    this.awardScore(SCORE_SLINGSHOT, 200);
    this.emit({
      type: 'sound',
      sound: 'slingshot',
      pan: positionToPan(position),
    });
    this.emit({
      type: 'flashLamp',
      lampId: side === 'left' ? 'sling_left' : 'sling_right',
      duration: 0.16,
    });
    this.emit({
      type: 'sparkBurst',
      position,
      color: side === 'left' ? PALETTE.cyan : PALETTE.magenta,
      count: 10,
      speed: 8,
    });
  }

  private handleDropTarget(index: number, position: Vec3): void {
    if (!this.canScorePlayfield() || index < 0 || index > 2) {
      return;
    }
    if (this.dropTargets[index]) {
      return;
    }

    this.dropTargets[index] = true;
    this.awardScore(SCORE_DROP_TARGET, 1_000);
    this.emit({
      type: 'sound',
      sound: 'dropTarget',
      index,
      pan: positionToPan(position),
    });
    this.emit({ type: 'flashLamp', lampId: DROP_LAMPS[index], duration: 0.25 });
    this.emit({
      type: 'sparkBurst',
      position,
      color: PALETTE.magenta,
      count: 14,
      speed: 9,
    });

    if (this.dropTargets[0] && this.dropTargets[1] && this.dropTargets[2]) {
      this.awardScore(SCORE_DROP_BANK_COMPLETE, 5_000);

      // Light Shield Kickback
      this.kickbackLit = true;
      this.emit({ type: 'setKickbackArmed', armed: true });

      // Light Hypercore Lock (when not already in Multiball and locks remain)
      let lockMessage = 'SHIELD ARMED!';
      if (!this.multiballActive && this.lockedBalls < MAX_BALLS) {
        this.lockLit = true;
        lockMessage = 'SHIELD & LOCK LIT!';
      }

      // Hold all 3 targets down briefly (~0.45s) so the 3rd target visibly drops & clicks
      // before the bank reset coil pops all 3 targets back up.
      this.dropTargetResetTimer = DROP_TARGET_RESET_DELAY_SEC;
      this.emit({ type: 'flashLamp', lampId: 'flasher_left', duration: 0.5 });
      this.triggerBanner('R-A-Y COMPLETE!', lockMessage, 2.2, 'high', 'wipe');
    }
  }

  private handleStandup(index: number, position: Vec3): void {
    if (!this.canScorePlayfield() || index < 0 || index > 2) {
      return;
    }

    this.awardScore(SCORE_STANDUP_TARGET, 750);
    this.emit({
      type: 'sound',
      sound: 'standupTarget',
      index,
      pan: positionToPan(position),
    });
    this.emit({ type: 'flashLamp', lampId: STANDUP_LAMPS[index], duration: 0.25 });
    this.emit({
      type: 'sparkBurst',
      position,
      color: PALETTE.emerald,
      count: 12,
      speed: 8,
    });

    this.standupTargets[index] = true;

    if (this.standupTargets[0] && this.standupTargets[1] && this.standupTargets[2]) {
      this.standupTargets = [false, false, false];
      this.awardScore(SCORE_STANDUP_BANK_COMPLETE, 3_000);

      // Step timed Playfield Multiplier: 1X -> 2X -> 3X -> 5X (for 20s)
      const currentIdx = PLAYFIELD_MULT_TIERS.indexOf(
        this.playfieldMultiplier as (typeof PLAYFIELD_MULT_TIERS)[number],
      );
      const nextIdx = Math.min(PLAYFIELD_MULT_TIERS.length - 1, Math.max(0, currentIdx) + 1);
      this.playfieldMultiplier = PLAYFIELD_MULT_TIERS[nextIdx];
      this.playfieldMultiplierTimer = PLAYFIELD_MULT_DURATION_SEC;

      this.emit({ type: 'flashLamp', lampId: 'flasher_right', duration: 0.5 });
      this.triggerBanner(
        `PLAYFIELD ${this.playfieldMultiplier}X!`,
        `FOR ${PLAYFIELD_MULT_DURATION_SEC} SECONDS`,
        2.2,
        'high',
        'zoom',
      );
    }
  }

  private handleSpinner(
    halfRevolutions: number,
    angularVelocity: number,
    position: Vec3,
  ): void {
    if (!this.canScorePlayfield()) {
      return;
    }

    const ticks = Math.max(1, Math.floor(halfRevolutions || 1));
    const comboActive = this.rampComboCount > 0 && this.rampComboTimer > 0;
    const perTick = comboActive ? SCORE_SPINNER_COMBO_TICK : SCORE_SPINNER_TICK;

    this.awardScore(perTick * ticks, 150 * ticks);
    this.emit({
      type: 'sound',
      sound: 'spinnerTick',
      intensity: Math.abs(angularVelocity),
      pan: positionToPan(position),
    });
    this.emit({ type: 'flashLamp', lampId: 'arrow_left_orbit', duration: 0.12 });
  }

  private handleLane(
    lane: 'inlaneLeft' | 'inlaneRight' | 'outlaneLeft' | 'outlaneRight',
    position: Vec3,
  ): void {
    if (!this.canScorePlayfield()) {
      return;
    }

    const isOutlane = lane === 'outlaneLeft' || lane === 'outlaneRight';
    this.awardScore(isOutlane ? SCORE_OUTLANE : SCORE_INLANE, isOutlane ? 500 : 250);

    const lampMap: Record<typeof lane, LampId> = {
      inlaneLeft: 'inlane_left',
      inlaneRight: 'inlane_right',
      outlaneLeft: 'shield_kickback',
      outlaneRight: 'outlane_right',
    };
    this.emit({ type: 'flashLamp', lampId: lampMap[lane], duration: 0.25 });
    this.emit({
      type: 'sound',
      sound: 'rollover',
      pan: positionToPan(position),
    });
  }

  private handleOrbit(side: 'left' | 'right', position: Vec3): void {
    if (!this.canScorePlayfield()) {
      return;
    }

    this.awardScore(SCORE_ORBIT, 1_000);
    this.emit({
      type: 'flashLamp',
      lampId: side === 'left' ? 'arrow_left_orbit' : 'arrow_right_orbit',
      duration: 0.3,
    });
    this.emit({
      type: 'sound',
      sound: 'rolloverComplete',
      pan: positionToPan(position),
    });
  }

  private handleKickback(position: Vec3): void {
    if (!this.canScorePlayfield()) {
      return;
    }

    if (this.kickbackLit) {
      this.kickbackLit = false;
      this.emit({ type: 'setKickbackArmed', armed: false });
      const awarded = this.awardScore(SCORE_KICKBACK, 1_000);
      this.emit({ type: 'sound', sound: 'kickback', pan: -0.9 });
      this.emit({ type: 'flashLamp', lampId: 'shield_kickback', duration: 0.55 });
      this.emit({
        type: 'sparkBurst',
        position,
        color: PALETTE.emerald,
        count: 18,
        speed: 12,
      });
      this.triggerBanner(
        'SHIELD SAVED!',
        `+${formatScore(awarded)}`,
        1.8,
        'high',
        'flash',
      );
    }
  }

  private handleRampComplete(position: Vec3): void {
    if (!this.canScorePlayfield()) {
      return;
    }

    // Advance Ramp Combo chain (up to 5x within 6.5s)
    if (this.rampComboTimer > 0 && this.rampComboCount > 0) {
      this.rampComboCount = Math.min(MAX_RAMP_COMBO, this.rampComboCount + 1);
    } else {
      this.rampComboCount = 1;
    }
    this.rampComboTimer = RAMP_COMBO_WINDOW_SEC;

    this.emit({ type: 'lampShow', show: 'RAMP_CHASE', duration: 1.5 });
    this.emit({ type: 'flashLamp', lampId: 'flasher_ramp', duration: 0.45 });
    this.emit({
      type: 'sparkBurst',
      position,
      color: PALETTE.gold,
      count: 20,
      speed: 12,
    });

    // During Multiball, Warp Ramp collects lit Jackpot / Super Jackpot!
    if (this.multiballActive && (this.jackpotLit || this.superJackpotLit)) {
      this.collectMultiballJackpot(position);
      return;
    }

    // Normal Warp Ramp scoring: 15,000 * comboCount
    const awarded = this.awardScore(SCORE_WARP_RAMP_BASE * this.rampComboCount, 4_000);
    this.emit({ type: 'sound', sound: 'rampCombo', count: this.rampComboCount });

    // Completing Warp Ramp also lights Hypercore Lock for Lock 2 & Lock 3
    let lockJustLit = false;
    if (!this.multiballActive && this.lockedBalls < MAX_BALLS && !this.lockLit) {
      this.lockLit = true;
      lockJustLit = true;
    }

    const title =
      this.rampComboCount > 1
        ? `${this.rampComboCount}X WARP COMBO!`
        : 'WARP RAMP!';
    const subtitle = lockJustLit
      ? `LOCK +${formatScore(awarded)}`
      : `+${formatScore(awarded)}`;

    this.triggerBanner(
      title,
      subtitle,
      2.0,
      this.rampComboCount >= 3 ? 'high' : 'normal',
      'zoom',
    );
  }

  private handleSaucerCapture(ballId: number, position: Vec3): void {
    // Always eject if tilted or outside active play so balls can never stay stuck
    if (!this.canScorePlayfield()) {
      this.emit({ type: 'ejectSaucer', ballId, delaySec: 0.35 });
      return;
    }

    this.emit({ type: 'sound', sound: 'saucerCapture' });
    this.emit({ type: 'hypercorePulse' });
    this.emit({ type: 'flashLamp', lampId: 'flasher_hypercore', duration: 0.65 });
    this.emit({
      type: 'sparkBurst',
      position,
      color: PALETTE.violet,
      count: 20,
      speed: 12,
    });

    // Case A: Multiball active -> Hypercore Saucer collects Jackpot / Super Jackpot
    if (this.multiballActive) {
      if (this.jackpotLit || this.superJackpotLit) {
        this.collectMultiballJackpot(position);
      } else {
        const awarded = this.awardScore(SCORE_REACTOR_BONUS, 2_500);
        this.triggerBanner('REACTOR BONUS!', `+${formatScore(awarded)}`, 1.8, 'normal', 'wipe');
      }
      this.emit({ type: 'ejectSaucer', ballId, delaySec: SAUCER_HOLD_DURATION });
      return;
    }

    // Case B: Lock is lit -> advance Hypercore Lock (1 -> 2 -> 3 -> MULTIBALL!)
    if (this.lockLit && this.lockedBalls < MAX_BALLS) {
      this.lockedBalls += 1;
      this.lockLit = false;
      this.emit({ type: 'lampShow', show: 'LOCK_CHARGE', duration: 1.5 });

      if (this.lockedBalls < MAX_BALLS) {
        const lockBonus = this.awardScore(SCORE_LOCK_STEP * this.lockedBalls, 5_000);
        this.emit({ type: 'sound', sound: 'ballLocked', count: this.lockedBalls });
        this.triggerBanner(
          `BALL ${this.lockedBalls} LOCKED!`,
          `+${formatCompactScore(lockBonus)} LOCK ${this.lockedBalls + 1} NEXT`,
          2.5,
          'high',
          'zoom',
        );
        this.emit({ type: 'ejectSaucer', ballId, delaySec: SAUCER_HOLD_DURATION });
        return;
      }

      // Lock 3 -> HYPERNOVA 3-BALL MULTIBALL!
      this.startMultiball(ballId);
      return;
    }

    // Case C: Lock not lit -> clean Reactor Bonus & eject
    const awarded = this.awardScore(SCORE_REACTOR_BONUS, 2_500);
    this.triggerBanner('REACTOR BONUS!', `+${formatScore(awarded)}`, 1.8, 'normal', 'wipe');
    this.emit({ type: 'ejectSaucer', ballId, delaySec: SAUCER_HOLD_DURATION });
  }

  private startMultiball(capturedBallId: number): void {
    this.multiballActive = true;
    this.jackpotLit = true;
    this.superJackpotLit = false;
    this.ballSaveActive = true;
    this.ballSaveTimer = MULTIBALL_BALL_SAVE_SEC;
    this.activeBallCount = MAX_BALLS;

    this.awardScore(SCORE_LOCK_STEP * MAX_BALLS, 10_000, { deferScoreExtraBall: true });

    this.emit({ type: 'ejectSaucer', ballId: capturedBallId, delaySec: SAUCER_HOLD_DURATION });
    this.emit({ type: 'spawnMultiball', targetBallCount: MAX_BALLS });
    this.emit({ type: 'setMusicMode', mode: 'multiball' });
    this.emit({ type: 'sound', sound: 'multiballStart' });
    this.emit({ type: 'lampShow', show: 'MULTIBALL_STROBE', duration: 3.0 });
    this.triggerBanner(
      'HYPERNOVA MULTIBALL!',
      'JACKPOTS LIT!',
      3.2,
      'critical',
      'flash',
    );
    this.checkScoreExtraBall();
  }

  private collectMultiballJackpot(position: Vec3): void {
    const isSuper = this.superJackpotLit;
    const basePoints = isSuper ? SCORE_SUPER_JACKPOT : SCORE_JACKPOT;
    const awarded = this.awardScore(basePoints, isSuper ? 15_000 : 8_000, {
      deferScoreExtraBall: true,
    });

    // Alternate Jackpot <-> Super Jackpot
    if (isSuper) {
      this.superJackpotLit = false;
      this.jackpotLit = true;
    } else {
      this.jackpotLit = false;
      this.superJackpotLit = true;
    }

    this.multiballJackpotCount += 1;

    this.emit({ type: 'sound', sound: 'jackpot', isSuper });
    this.emit({ type: 'lampShow', show: 'JACKPOT_BURST', duration: 2.2 });
    this.emit({ type: 'hypercorePulse' });
    this.emit({
      type: 'sparkBurst',
      position,
      color: isSuper ? PALETTE.magenta : PALETTE.gold,
      count: isSuper ? 36 : 26,
      speed: 14,
    });
    this.triggerBanner(
      isSuper ? 'SUPER JACKPOT!' : 'JACKPOT!',
      `+${formatScore(awarded)}`,
      2.8,
      'critical',
      'flash',
    );

    // Check 2nd multiball jackpot Extra Ball BEFORE score threshold so both Extra Ball
    // paths remain independently reachable and properly credited (strictly once per game).
    if (this.multiballJackpotCount >= 2 && !this.extraBallAwardedThisGame) {
      this.grantExtraBall('2ND JACKPOT');
    } else {
      this.checkScoreExtraBall();
    }
  }

  private handleDrain(): void {
    if (this.phase !== 'PLAYING' && this.phase !== 'LAUNCH_READY') {
      return;
    }

    this.emit({ type: 'sound', sound: 'drain' });

    // HYPER SAVE: auto-relaunch drained ball without losing ball (disabled when tilted)
    if (this.ballSaveActive && !this.isTilted) {
      this.activeBallCount = Math.max(1, this.activeBallCount);
      this.emit({ type: 'spawnBall', reason: 'ballSave' });
      this.emit({ type: 'sound', sound: 'ballSave' });
      this.emit({ type: 'flashLamp', lampId: 'hyper_save', duration: 0.8 });
      this.triggerBanner('HYPER SAVE!', 'BALL SAVED!', 1.8, 'high', 'flash');
      return;
    }

    this.activeBallCount = Math.max(0, this.activeBallCount - 1);

    // End Multiball once down to 1 (or 0) balls remaining
    if (this.multiballActive && this.activeBallCount <= 1) {
      this.multiballActive = false;
      this.jackpotLit = false;
      this.superJackpotLit = false;
      this.lockedBalls = 0;
      this.lockLit = false;
      if (this.activeBallCount > 0 && !this.isTilted) {
        this.emit({ type: 'setMusicMode', mode: 'normal' });
      }
    }

    if (this.activeBallCount > 0) {
      return;
    }

    // All balls drained -> enter End-of-Ball Bonus Tally
    this.beginBallBonus();
  }

  // -------------------------------------------------------------------------
  // End-of-Ball Bonus Tally & Ball Progression
  // -------------------------------------------------------------------------

  private beginBallBonus(): void {
    this.phase = 'BALL_BONUS';
    this.skillShotActive = false;
    this.skillShotTimer = 0;
    this.ballSaveActive = false;
    this.ballSaveTimer = 0;
    this.rampComboCount = 0;
    this.rampComboTimer = 0;
    this.playfieldMultiplier = 1;
    this.playfieldMultiplierTimer = 0;
    this.dropTargetResetTimer = 0;

    this.emit({ type: 'setFlippersEnabled', enabled: false });

    if (this.isTilted) {
      // Bonus forfeited on TILT
      this.bonusPoints = 0;
      this.bonusApplied = true;
      this.bonusStepTimer = TILT_BONUS_HOLD_SEC;
      this.bonusBreakdown = {
        baseBonus: 0,
        multiplier: this.bonusMultiplier,
        totalBonus: 0,
        step: 1,
        totalSteps: 1,
      };
      this.triggerBanner('NO BONUS', 'TILT FORFEITED', 1.2, 'high', 'static');
      return;
    }

    const baseBonus = Math.max(0, Math.floor(this.bonusPoints));
    const multiplier = this.bonusMultiplier;
    const totalBonus = baseBonus * multiplier;

    if (totalBonus <= 0) {
      this.bonusApplied = true;
      this.bonusStepTimer = 0.7;
      this.bonusBreakdown = {
        baseBonus: 0,
        multiplier,
        totalBonus: 0,
        step: 1,
        totalSteps: 1,
      };
      this.triggerBanner('END OF BALL', 'BONUS 0', 0.9, 'normal', 'static');
      return;
    }

    this.bonusApplied = false;
    this.bonusStepTimer = BONUS_STEP_DURATION_SEC;
    this.bonusBreakdown = {
      baseBonus,
      multiplier,
      totalBonus,
      step: 1,
      totalSteps: 4,
    };
    this.emit({ type: 'sound', sound: 'bonusTick', index: 1 });
    this.triggerBanner(
      'BALL BONUS',
      `BASE ${formatScore(baseBonus)}`,
      BONUS_STEP_DURATION_SEC + 0.1,
      'normal',
      'static',
    );
  }

  private updateBallBonus(dt: number): void {
    if (!this.bonusBreakdown) {
      this.finishBallBonus();
      return;
    }

    let remainingDt = dt;
    while (remainingDt > 0 && this.phase === 'BALL_BONUS' && this.bonusBreakdown) {
      const currentBreakdown: BonusBreakdown = this.bonusBreakdown;
      if (remainingDt < this.bonusStepTimer) {
        this.bonusStepTimer -= remainingDt;
        remainingDt = 0;
        break;
      }

      remainingDt -= this.bonusStepTimer;
      const nextStep: number = currentBreakdown.step + 1;

      if (nextStep > currentBreakdown.totalSteps) {
        this.applyPendingBonus();
        this.finishBallBonus();
        break;
      }

      this.bonusBreakdown = {
        ...currentBreakdown,
        step: nextStep,
      };
      this.bonusStepTimer = BONUS_STEP_DURATION_SEC;
      this.emit({ type: 'sound', sound: 'bonusTick', index: nextStep });

      if (nextStep === 2) {
        this.triggerBanner(
          'BONUS MULTIPLIER',
          `${formatScore(currentBreakdown.baseBonus)} X ${currentBreakdown.multiplier}`,
          BONUS_STEP_DURATION_SEC + 0.1,
          'normal',
          'static',
        );
      } else if (nextStep === 3) {
        this.triggerBanner(
          'TOTAL BONUS',
          `+${formatScore(currentBreakdown.totalBonus)}`,
          BONUS_STEP_DURATION_SEC * 2,
          'high',
          'zoom',
        );
        this.applyPendingBonus();
      }
    }
  }

  private applyPendingBonus(): void {
    if (this.bonusApplied || !this.bonusBreakdown) {
      return;
    }
    this.bonusApplied = true;
    const total = this.bonusBreakdown.totalBonus;
    if (total > 0) {
      this.score += total;
      if (this.score > this.highScore) {
        this.highScore = this.score;
      }
      this.checkScoreExtraBall();
    }
  }

  private finishBallBonus(): void {
    this.bonusBreakdown = null;

    if (this.extraBalls > 0) {
      this.extraBalls -= 1;
      this.extraBallLit = this.extraBalls > 0;
      this.prepareBall(true);
      return;
    }

    if (this.ballNumber < this.totalBalls) {
      this.ballNumber += 1;
      this.prepareBall(false);
      return;
    }

    // Game Over / High Score qualification check
    this.setHighScores(loadHighScores(this.storage));
    this.qualifiesForHighScore = isHighScore(this.score, this.highScores, this.storage);
    this.emit({ type: 'setFlippersEnabled', enabled: false });
    this.emit({ type: 'setMusicMode', mode: 'off' });
    this.emit({ type: 'sound', sound: 'gameOver' });

    if (this.qualifiesForHighScore) {
      this.phase = 'HIGH_SCORE_ENTRY';
      this.triggerBanner(
        'NEW HIGH SCORE!',
        'ENTER INITIALS',
        4.0,
        'critical',
        'flash',
      );
    } else {
      this.phase = 'GAME_OVER';
      this.triggerBanner(
        'GAME OVER',
        `SCORE ${formatScore(this.score)}`,
        4.0,
        'critical',
        'static',
      );
    }
  }

  private prepareBall(isExtraBall: boolean): void {
    this.phase = 'LAUNCH_READY';
    this.bonusPoints = 0;
    this.bonusMultiplier = 1;
    this.bonusBreakdown = null;
    this.bonusApplied = false;
    this.bonusStepTimer = 0;

    this.playfieldMultiplier = 1;
    this.playfieldMultiplierTimer = 0;
    this.rampComboCount = 0;
    this.rampComboTimer = 0;

    this.ionLanes = [false, false, false];
    this.dropTargets = [false, false, false];
    this.dropTargetResetTimer = 0;
    this.standupTargets = [false, false, false];

    this.kickbackLit = true;
    this.skillShotActive = true;
    this.skillShotTimer = SKILL_SHOT_WINDOW_SEC;
    this.skillShotLaneIndex = (this.ballNumber - 1) % 3;

    this.ballSaveActive = true;
    this.ballSaveTimer = BALL_SAVE_DURATION_SEC;
    this.activeBallCount = 1;

    this.tiltWarnings = 0;
    this.isTilted = false;

    this.emit({ type: 'resetTilt' });
    this.emit({ type: 'resetDropTargets' });
    this.emit({ type: 'setKickbackArmed', armed: true });
    this.emit({ type: 'setFlippersEnabled', enabled: true });
    this.emit({ type: 'setMusicMode', mode: 'normal' });
    this.emit({ type: 'spawnBall', reason: 'newBall' });

    if (isExtraBall) {
      this.triggerBanner(
        'SHOOT AGAIN!',
        `BALL ${this.ballNumber} EXTRA BALL`,
        2.4,
        'high',
        'flash',
      );
    } else {
      this.triggerBanner(
        `BALL ${this.ballNumber}`,
        'LAUNCH SKILL SHOT',
        2.2,
        'high',
        'wipe',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Scoring, Extra Ball & Banner Helpers
  // -------------------------------------------------------------------------

  private awardScore(
    basePoints: number,
    bonusIncrement = 0,
    options?: { readonly deferScoreExtraBall?: boolean },
  ): number {
    if (!this.canScorePlayfield()) {
      return 0;
    }

    const total = Math.round(basePoints * this.playfieldMultiplier);
    this.score += total;
    this.bonusPoints += bonusIncrement;

    if (this.score > this.highScore) {
      this.highScore = this.score;
    }

    if (!options?.deferScoreExtraBall) {
      this.checkScoreExtraBall();
    }

    return total;
  }

  private checkScoreExtraBall(): void {
    if (!this.extraBallAwardedThisGame && this.score >= EXTRA_BALL_SCORE_THRESHOLD) {
      this.grantExtraBall(`${formatScore(EXTRA_BALL_SCORE_THRESHOLD)} PTS`);
    }
  }

  private setHighScores(entries: readonly HighScoreEntry[]): void {
    if (
      this.highScores.length === entries.length &&
      this.highScores.every(
        (cur, i) =>
          cur.initials === entries[i].initials &&
          cur.score === entries[i].score &&
          cur.date === entries[i].date,
      )
    ) {
      return;
    }
    this.highScores = Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
  }

  private grantExtraBall(reason: string): void {
    if (this.extraBallAwardedThisGame) {
      return;
    }

    this.extraBallAwardedThisGame = true;
    this.extraBalls += 1;
    this.extraBallLit = true;

    this.emit({ type: 'sound', sound: 'extraBall' });
    this.emit({ type: 'lampShow', show: 'JACKPOT_BURST', duration: 1.8 });
    this.triggerBanner('EXTRA BALL!', reason, 2.8, 'critical', 'flash');
  }

  private triggerBanner(
    title: string,
    subtitle: string | undefined,
    duration: number,
    priority: DmdBannerPriority,
    effect: DmdBannerEffect,
  ): void {
    const banner: DmdBanner = {
      id: this.nextBannerId++,
      title,
      subtitle,
      duration,
      priority,
      effect,
    };

    if (
      !this.activeBanner ||
      PRIORITY_WEIGHT[priority] >= PRIORITY_WEIGHT[this.activeBanner.priority]
    ) {
      this.activeBanner = banner;
      this.activeBannerTimer = duration;
    }

    this.emit({ type: 'dmdBanner', banner });
  }

  private emit(command: GameCommand): void {
    this.commands.push(command);
  }
}
