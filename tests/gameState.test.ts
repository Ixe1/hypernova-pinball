import { describe, expect, it } from 'vitest';
import {
  BALL_SAVE_DURATION_SEC,
  EXTRA_BALL_SCORE_THRESHOLD,
  MAX_BONUS_MULTIPLIER,
  MULTIBALL_BALL_SAVE_SEC,
  PLAYFIELD_MULT_DURATION_SEC,
  RAMP_COMBO_WINDOW_SEC,
  SKILL_SHOT_WINDOW_SEC,
} from '../src/config/constants';
import type { LampId, PhysicsEvent, Vec3 } from '../src/config/types';
import {
  DROP_TARGET_RESET_DELAY_SEC,
  GameState,
  SCORE_DROP_BANK_COMPLETE,
  SCORE_DROP_TARGET,
  SCORE_ION_COMPLETE,
  SCORE_JACKPOT,
  SCORE_KICKBACK,
  SCORE_LOCK_STEP,
  SCORE_POP_BUMPER,
  SCORE_REACTOR_BONUS,
  SCORE_ROLLOVER,
  SCORE_SKILL_SHOT,
  SCORE_SLINGSHOT,
  SCORE_SPINNER_COMBO_TICK,
  SCORE_SPINNER_TICK,
  SCORE_STANDUP_BANK_COMPLETE,
  SCORE_STANDUP_TARGET,
  SCORE_SUPER_JACKPOT,
  SCORE_SUPER_JET_BUMPER,
  SCORE_WARP_RAMP_BASE,
  SUPER_JETS_THRESHOLD,
} from '../src/game/GameState';
import {
  DEFAULT_HIGH_SCORES,
  HIGH_SCORES_STORAGE_KEY,
  insertHighScore,
  isHighScore,
  loadHighScores,
  resetHighScores,
  sanitizeInitials,
  type StorageLike,
} from '../src/game/HighScores';
import { LampController, type LampShowName } from '../src/game/LampController';

const ORIGIN: Vec3 = { x: 0, y: 0.27, z: 0 };

function createMemoryStorage(initial?: Record<string, string>): StorageLike {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function shooterExitEvent(ballId = 1, speed = 34): PhysicsEvent {
  return {
    type: 'shooterExit',
    ballId,
    speed,
  };
}

function createLaunchedGame(storage = createMemoryStorage()): GameState {
  const game = new GameState({ storage });
  game.startNewGame();
  game.consumeCommands();
  game.onPlungerLaunched();
  game.handlePhysicsEvent(shooterExitEvent(1));
  game.consumeCommands();
  return game;
}

function rolloverEvent(index: number): PhysicsEvent {
  const labels = ['I', 'O', 'N'];
  return {
    type: 'rollover',
    id: `rollover_${index}`,
    index,
    label: labels[index] ?? 'I',
    ballId: 1,
    position: ORIGIN,
  };
}

function dropTargetEvent(index: number): PhysicsEvent {
  const labels = ['R', 'A', 'Y'];
  return {
    type: 'dropTarget',
    id: `drop_${index}`,
    index,
    label: labels[index] ?? 'R',
    ballId: 1,
    position: { x: -4.7, y: 0.27, z: 1.0 },
  };
}

function standupEvent(index: number): PhysicsEvent {
  return {
    type: 'standup',
    id: `standup_${index}`,
    index,
    ballId: 1,
    position: { x: 3.8, y: 0.27, z: 1.9 },
  };
}

function bumperEvent(index = 0): PhysicsEvent {
  return {
    type: 'bumper',
    id: `bumper_${index}`,
    index,
    ballId: 1,
    position: { x: 1.5, y: 0.27, z: -5.0 },
    impactSpeed: 18,
  };
}

function rampCompleteEvent(ballId = 1): PhysicsEvent {
  return {
    type: 'rampComplete',
    id: 'warp_ramp',
    ballId,
    position: { x: -3.8, y: 1.72, z: -8.1 },
  };
}

function saucerCaptureEvent(ballId = 1): PhysicsEvent {
  return {
    type: 'saucerCapture',
    id: 'hypercore_saucer',
    ballId,
    position: { x: -0.525, y: 0.27, z: -4.2 },
  };
}

function drainEvent(ballId = 1): PhysicsEvent {
  return {
    type: 'drain',
    ballId,
    position: { x: -0.525, y: 0.27, z: 10.35 },
  };
}

describe('GameState — Core Pinball Ruleset', () => {
  it('initializes in ATTRACT, starts a game in LAUNCH_READY with Shield Kickback lit, keeps LAUNCH_READY on weak plunge, and enters PLAYING on shooterExit', () => {
    const game = new GameState({ storage: createMemoryStorage() });
    expect(game.getSnapshot().phase).toBe('ATTRACT');
    expect(game.getSnapshot().highScore).toBe(DEFAULT_HIGH_SCORES[0].score);

    game.startNewGame();
    const startSnap = game.getSnapshot();
    expect(startSnap.phase).toBe('LAUNCH_READY');
    expect(startSnap.ballNumber).toBe(1);
    expect(startSnap.totalBalls).toBe(3);
    expect(startSnap.score).toBe(0);
    expect(startSnap.lockLit).toBe(true); // Lock 1 immediately lit at game start
    expect(startSnap.kickbackLit).toBe(true); // Shield Kickback armed at start of every ball
    expect(startSnap.skillShotActive).toBe(true);
    expect(startSnap.ballSaveActive).toBe(true);

    const startCmds = game.consumeCommands();
    expect(startCmds.some((c) => c.type === 'spawnBall' && c.reason === 'newBall')).toBe(true);
    expect(startCmds.some((c) => c.type === 'setFlippersEnabled' && c.enabled)).toBe(true);
    expect(startCmds.some((c) => c.type === 'resetDropTargets')).toBe(true);
    expect(startCmds.some((c) => c.type === 'setKickbackArmed' && c.armed)).toBe(true);

    // Weak plunge keeps LAUNCH_READY and does NOT burn Skill Shot or Ball Save timers
    game.handlePhysicsEvent({
      type: 'plungerLaunch',
      ballId: 1,
      tension: 0.35,
      speed: 24,
    });
    game.onPlungerLaunched();
    game.update(10.0);
    expect(game.getSnapshot().phase).toBe('LAUNCH_READY');
    expect(game.getSnapshot().skillShotActive).toBe(true);
    expect(game.getSnapshot().ballSaveActive).toBe(true);
    expect(game.getSnapshot().ballSaveTimer).toBeCloseTo(BALL_SAVE_DURATION_SEC, 5);

    // Clearing the shooter gate transitions LAUNCH_READY -> PLAYING and starts timers
    game.handlePhysicsEvent(shooterExitEvent(1, 36));
    expect(game.getSnapshot().phase).toBe('PLAYING');
    expect(game.getSnapshot().ballSaveTimer).toBeCloseTo(BALL_SAVE_DURATION_SEC, 5);

    game.update(2.0);
    expect(game.getSnapshot().ballSaveTimer).toBeCloseTo(BALL_SAVE_DURATION_SEC - 2.0, 5);

    // Subsequent shooterExit during PLAYING (e.g. multiball/save ball) does not reset timers
    game.handlePhysicsEvent(shooterExitEvent(2, 38));
    expect(game.getSnapshot().ballSaveTimer).toBeCloseTo(BALL_SAVE_DURATION_SEC - 2.0, 5);
  });

  it('awards Skill Shot (+25,000) for hitting the flashing I-O-N lane within 5s and expires after 5s', () => {
    const game = createLaunchedGame();
    const targetLane = game.getSnapshot().skillShotLaneIndex;
    const wrongLane = (targetLane + 1) % 3;

    // Hitting wrong lane awards standard rollover, not Skill Shot
    game.handlePhysicsEvent(rolloverEvent(wrongLane));
    expect(game.getSnapshot().score).toBe(SCORE_ROLLOVER);
    expect(game.getSnapshot().skillShotActive).toBe(true);

    // Hitting flashing target lane within 5s awards Skill Shot (+25,000)
    game.update(2.0);
    game.handlePhysicsEvent(rolloverEvent(targetLane));
    expect(game.getSnapshot().score).toBe(SCORE_ROLLOVER + SCORE_SKILL_SHOT);
    expect(game.getSnapshot().skillShotActive).toBe(false);
    const cmds = game.consumeCommands();
    expect(cmds.some((c) => c.type === 'sound' && c.sound === 'skillShot')).toBe(true);
    expect(cmds.some((c) => c.type === 'lampShow' && c.show === 'SKILL_SHOT_PULSE')).toBe(true);

    // Separate game: letting 5s elapse expires Skill Shot
    const expiredGame = createLaunchedGame();
    const expiredLane = expiredGame.getSnapshot().skillShotLaneIndex;
    expiredGame.update(SKILL_SHOT_WINDOW_SEC + 0.1);
    expect(expiredGame.getSnapshot().skillShotActive).toBe(false);
    expiredGame.handlePhysicsEvent(rolloverEvent(expiredLane));
    expect(expiredGame.getSnapshot().score).toBe(SCORE_ROLLOVER);
  });

  it('rotates Skill Shot target lane with flippers during LAUNCH_READY and PLAYING (before any I-O-N hit)', () => {
    const game = new GameState({ storage: createMemoryStorage() });
    game.startNewGame();
    game.consumeCommands();

    // Ball 1 starts targeting lane 0 ('I')
    expect(game.getSnapshot().phase).toBe('LAUNCH_READY');
    expect(game.getSnapshot().skillShotLaneIndex).toBe(0);

    // Flipper lane-change works in LAUNCH_READY before launch
    game.onFlipperPressed('right');
    expect(game.getSnapshot().skillShotLaneIndex).toBe(1); // 'O'
    game.onFlipperPressed('right');
    expect(game.getSnapshot().skillShotLaneIndex).toBe(2); // 'N'
    game.onFlipperPressed('right');
    expect(game.getSnapshot().skillShotLaneIndex).toBe(0); // wraps back to 'I'
    game.onFlipperPressed('left');
    expect(game.getSnapshot().skillShotLaneIndex).toBe(2); // 'N'

    // Launch into PLAYING: before any I-O-N hit, flippers can still shift Skill Shot target
    game.handlePhysicsEvent(shooterExitEvent(1));
    expect(game.getSnapshot().phase).toBe('PLAYING');
    expect(game.getSnapshot().skillShotLaneIndex).toBe(2);
    game.onFlipperPressed('left');
    expect(game.getSnapshot().skillShotLaneIndex).toBe(1); // shifted to 'O'

    // Once a wrong I-O-N lane is hit, flipper presses shift ionLanes without shifting skillShotLaneIndex
    game.handlePhysicsEvent(rolloverEvent(0));
    expect(game.getSnapshot().ionLanes).toEqual([true, false, false]);
    expect(game.getSnapshot().skillShotLaneIndex).toBe(1);
    game.onFlipperPressed('right');
    expect(game.getSnapshot().ionLanes).toEqual([false, true, false]);
    expect(game.getSnapshot().skillShotLaneIndex).toBe(1);

    // Hitting the active Skill Shot lane ('O') awards +25,000
    const preScore = game.getSnapshot().score;
    game.handlePhysicsEvent(rolloverEvent(1));
    expect(game.getSnapshot().score).toBe(preScore + SCORE_SKILL_SHOT);
    expect(game.getSnapshot().skillShotActive).toBe(false);
  });

  it('rotates I-O-N rollover lanes via left/right flipper presses and advances Bonus Multiplier 1X -> 6X', () => {
    const game = createLaunchedGame();
    game.update(SKILL_SHOT_WINDOW_SEC + 0.5); // expire skill shot for clean math

    game.handlePhysicsEvent(rolloverEvent(0)); // [true, false, false]
    expect(game.getSnapshot().ionLanes).toEqual([true, false, false]);

    game.onFlipperPressed('right');
    expect(game.getSnapshot().ionLanes).toEqual([false, true, false]);

    game.onFlipperPressed('right');
    expect(game.getSnapshot().ionLanes).toEqual([false, false, true]);

    game.onFlipperPressed('left');
    expect(game.getSnapshot().ionLanes).toEqual([false, true, false]);

    // Complete remaining 2 lanes -> +10,000 and bonus multiplier 1X -> 2X
    const scoreBefore = game.getSnapshot().score;
    game.handlePhysicsEvent(rolloverEvent(0));
    game.handlePhysicsEvent(rolloverEvent(2));

    expect(game.getSnapshot().ionLanes).toEqual([false, false, false]);
    expect(game.getSnapshot().bonusMultiplier).toBe(2);
    expect(game.getSnapshot().score).toBe(scoreBefore + 2 * SCORE_ROLLOVER + SCORE_ION_COMPLETE);

    // Repeat completions up to cap (6X)
    for (let cycle = 0; cycle < 7; cycle++) {
      game.handlePhysicsEvent(rolloverEvent(0));
      game.handlePhysicsEvent(rolloverEvent(1));
      game.handlePhysicsEvent(rolloverEvent(2));
    }
    expect(game.getSnapshot().bonusMultiplier).toBe(MAX_BONUS_MULTIPLIER);
  });

  it('arms Shield Kickback at ball start, disarms on save, and re-lights Shield Kickback & Lock via R-A-Y drop bank', () => {
    const game = createLaunchedGame();

    // Shield Kickback starts armed on every ball
    expect(game.getSnapshot().kickbackLit).toBe(true);

    // Triggering kickback saves ball, awards +5,000, and disarms kickback
    game.handlePhysicsEvent({
      type: 'kickback',
      id: 'shield_kickback',
      ballId: 1,
      position: { x: -4.75, y: 0.27, z: 6.55 },
    });
    expect(game.getSnapshot().kickbackLit).toBe(false);
    expect(game.getSnapshot().score).toBe(SCORE_KICKBACK);
    expect(
      game.consumeCommands().some((c) => c.type === 'setKickbackArmed' && !c.armed),
    ).toBe(true);

    // Consume initial Lock 1 first so we can verify R-A-Y re-lights BOTH Lock 2 and Shield Kickback
    game.handlePhysicsEvent(saucerCaptureEvent());
    expect(game.getSnapshot().lockedBalls).toBe(1);
    expect(game.getSnapshot().lockLit).toBe(false);
    game.consumeCommands();

    const startScore = game.getSnapshot().score;
    game.handlePhysicsEvent(dropTargetEvent(0));
    // Duplicate hit on already-dropped target should be ignored
    game.handlePhysicsEvent(dropTargetEvent(0));
    expect(game.getSnapshot().score).toBe(startScore + SCORE_DROP_TARGET);
    expect(game.getSnapshot().dropTargets).toEqual([true, false, false]);

    game.handlePhysicsEvent(dropTargetEvent(1));
    game.handlePhysicsEvent(dropTargetEvent(2));

    const snap = game.getSnapshot();
    expect(snap.score).toBe(startScore + 3 * SCORE_DROP_TARGET + SCORE_DROP_BANK_COMPLETE);
    expect(snap.kickbackLit).toBe(true);
    expect(snap.lockLit).toBe(true);
    // All 3 targets remain visibly dropped during the ~0.45s bank-reset hold
    expect(snap.dropTargets).toEqual([true, true, true]);

    const immediateCmds = game.consumeCommands();
    expect(immediateCmds.some((c) => c.type === 'setKickbackArmed' && c.armed)).toBe(true);
    expect(immediateCmds.some((c) => c.type === 'resetDropTargets')).toBe(false);
    expect(immediateCmds.some((c) => c.type === 'sound' && c.sound === 'dropTargetBankReset')).toBe(
      false,
    );

    // Mid-hold: still dropped, duplicate hit ignored, no reset emitted yet
    game.update(DROP_TARGET_RESET_DELAY_SEC * 0.5);
    game.handlePhysicsEvent(dropTargetEvent(2));
    expect(game.getSnapshot().dropTargets).toEqual([true, true, true]);
    expect(game.consumeCommands().some((c) => c.type === 'resetDropTargets')).toBe(false);

    // Once 0.45s hold elapses: bank pops back up and emits resetDropTargets + bank reset sound
    game.update(DROP_TARGET_RESET_DELAY_SEC * 0.6);
    expect(game.getSnapshot().dropTargets).toEqual([false, false, false]);
    const resetCmds = game.consumeCommands();
    expect(resetCmds.some((c) => c.type === 'resetDropTargets')).toBe(true);
    expect(resetCmds.some((c) => c.type === 'sound' && c.sound === 'dropTargetBankReset')).toBe(
      true,
    );

    // Pending drop-target reset timer is canceled cleanly on returnToAttract() & startNewGame()
    game.handlePhysicsEvent(dropTargetEvent(0));
    game.handlePhysicsEvent(dropTargetEvent(1));
    game.handlePhysicsEvent(dropTargetEvent(2));
    game.consumeCommands();
    game.returnToAttract();
    game.consumeCommands();
    game.update(DROP_TARGET_RESET_DELAY_SEC + 0.2);
    expect(game.consumeCommands().some((c) => c.type === 'resetDropTargets')).toBe(false);

    game.startNewGame();
    game.handlePhysicsEvent(shooterExitEvent(1));
    game.handlePhysicsEvent(dropTargetEvent(0));
    game.handlePhysicsEvent(dropTargetEvent(1));
    game.handlePhysicsEvent(dropTargetEvent(2));
    game.startNewGame(); // cancels pending timer from prior game
    game.handlePhysicsEvent(shooterExitEvent(1));
    game.consumeCommands();
    game.update(DROP_TARGET_RESET_DELAY_SEC + 0.2);
    expect(game.consumeCommands().some((c) => c.type === 'resetDropTargets')).toBe(false);
  });

  it('steps timed Playfield Multiplier (1X -> 2X -> 3X -> 5X) via Right Standups and expires after 20s', () => {
    const game = createLaunchedGame();

    const completeStandups = () => {
      game.handlePhysicsEvent(standupEvent(0));
      game.handlePhysicsEvent(standupEvent(1));
      game.handlePhysicsEvent(standupEvent(2));
    };

    completeStandups();
    expect(game.getSnapshot().score).toBe(3 * SCORE_STANDUP_TARGET + SCORE_STANDUP_BANK_COMPLETE);
    expect(game.getSnapshot().playfieldMultiplier).toBe(2);
    expect(game.getSnapshot().playfieldMultiplierTimer).toBeCloseTo(PLAYFIELD_MULT_DURATION_SEC, 5);

    // Slingshot should now pay 2X
    const preSling = game.getSnapshot().score;
    game.handlePhysicsEvent({
      type: 'slingshot',
      id: 'sling_left',
      side: 'left',
      ballId: 1,
      position: ORIGIN,
      impactSpeed: 12,
    });
    expect(game.getSnapshot().score).toBe(preSling + SCORE_SLINGSHOT * 2);

    // Advance 2X -> 3X -> 5X -> stays 5X
    completeStandups();
    expect(game.getSnapshot().playfieldMultiplier).toBe(3);
    completeStandups();
    expect(game.getSnapshot().playfieldMultiplier).toBe(5);
    completeStandups();
    expect(game.getSnapshot().playfieldMultiplier).toBe(5);

    // Pop bumper at 5X pays 5 * 1,500 = 7,500
    const preBump = game.getSnapshot().score;
    game.handlePhysicsEvent(bumperEvent(0));
    expect(game.getSnapshot().score).toBe(preBump + SCORE_POP_BUMPER * 5);

    // Expire timer -> returns to 1X
    game.update(PLAYFIELD_MULT_DURATION_SEC + 0.1);
    expect(game.getSnapshot().playfieldMultiplier).toBe(1);
    expect(game.getSnapshot().playfieldMultiplierTimer).toBe(0);
  });

  it('activates Super Jets (+5,000/hit) after 15 pop bumper hits and boosts spinner during ramp combos', () => {
    const game = createLaunchedGame();

    // First 15 pop bumper hits pay +1,500 each
    for (let i = 0; i < SUPER_JETS_THRESHOLD; i++) {
      game.handlePhysicsEvent(bumperEvent(i % 3));
    }
    expect(game.getSnapshot().score).toBe(SUPER_JETS_THRESHOLD * SCORE_POP_BUMPER);
    expect(game.isSuperJetsActive()).toBe(true);

    // 16th hit pays Super Jets +5,000
    game.handlePhysicsEvent(bumperEvent(0));
    expect(game.getSnapshot().score).toBe(
      SUPER_JETS_THRESHOLD * SCORE_POP_BUMPER + SCORE_SUPER_JET_BUMPER,
    );

    // Normal spinner tick pays +500
    const preSpin = game.getSnapshot().score;
    game.handlePhysicsEvent({
      type: 'spinner',
      id: 'left_orbit_spinner',
      ballId: 1,
      angularVelocity: 30,
      halfRevolutions: 3,
      position: ORIGIN,
    });
    expect(game.getSnapshot().score).toBe(preSpin + 3 * SCORE_SPINNER_TICK);

    // Activate ramp combo -> spinner pays +2,000 per tick!
    game.handlePhysicsEvent(rampCompleteEvent());
    const postRampScore = game.getSnapshot().score;
    game.handlePhysicsEvent({
      type: 'spinner',
      id: 'left_orbit_spinner',
      ballId: 1,
      angularVelocity: 35,
      halfRevolutions: 2,
      position: ORIGIN,
    });
    expect(game.getSnapshot().score).toBe(postRampScore + 2 * SCORE_SPINNER_COMBO_TICK);
  });

  it('chains Warp Ramp combos up to 5X within 6.5s and resets on timeout', () => {
    const game = createLaunchedGame();

    const expectedMultipliers = [1, 2, 3, 4, 5, 5];
    let runningScore = 0;
    for (const mult of expectedMultipliers) {
      game.update(2.0); // within 6.5s window
      game.handlePhysicsEvent(rampCompleteEvent());
      runningScore += SCORE_WARP_RAMP_BASE * mult;
      expect(game.getSnapshot().rampComboCount).toBe(mult);
      expect(game.getSnapshot().score).toBe(runningScore);
    }

    // Timeout resets combo chain back to 0
    game.update(RAMP_COMBO_WINDOW_SEC + 0.1);
    expect(game.getSnapshot().rampComboCount).toBe(0);

    // Next ramp shot restarts at 1X (+15,000)
    game.handlePhysicsEvent(rampCompleteEvent());
    expect(game.getSnapshot().rampComboCount).toBe(1);
    expect(game.getSnapshot().score).toBe(runningScore + SCORE_WARP_RAMP_BASE);
  });

  it('runs full 3-ball Hypercore Lock -> Multiball -> alternating Jackpot / Super Jackpot -> Multiball end', () => {
    const game = createLaunchedGame();

    // Lock 1 (lit at start)
    game.handlePhysicsEvent(saucerCaptureEvent(1));
    expect(game.getSnapshot().lockedBalls).toBe(1);
    expect(game.getSnapshot().lockLit).toBe(false);
    expect(game.getSnapshot().score).toBe(SCORE_LOCK_STEP);
    expect(game.consumeCommands().some((c) => c.type === 'ejectSaucer')).toBe(true);

    // Shooting saucer when lock is NOT lit awards Reactor Bonus (+10,000) and ejects cleanly
    game.handlePhysicsEvent(saucerCaptureEvent(1));
    expect(game.getSnapshot().lockedBalls).toBe(1);
    expect(game.getSnapshot().score).toBe(SCORE_LOCK_STEP + SCORE_REACTOR_BONUS);
    expect(game.consumeCommands().some((c) => c.type === 'ejectSaucer')).toBe(true);

    // Light Lock 2 via Warp Ramp
    game.handlePhysicsEvent(rampCompleteEvent(1));
    expect(game.getSnapshot().lockLit).toBe(true);
    game.handlePhysicsEvent(saucerCaptureEvent(1));
    expect(game.getSnapshot().lockedBalls).toBe(2);
    expect(game.getSnapshot().lockLit).toBe(false);

    // Light Lock 3 via Warp Ramp -> Lock 3 launches HYPERNOVA MULTIBALL!
    game.handlePhysicsEvent(rampCompleteEvent(1));
    expect(game.getSnapshot().lockLit).toBe(true);
    game.consumeCommands();

    game.handlePhysicsEvent(saucerCaptureEvent(1));
    const mbSnap = game.getSnapshot();
    expect(mbSnap.lockedBalls).toBe(3);
    expect(mbSnap.multiballActive).toBe(true);
    expect(mbSnap.activeBallCount).toBe(3);
    expect(mbSnap.ballSaveActive).toBe(true);
    expect(mbSnap.ballSaveTimer).toBeCloseTo(MULTIBALL_BALL_SAVE_SEC, 5);
    expect(mbSnap.jackpotLit).toBe(true);
    expect(mbSnap.superJackpotLit).toBe(false);

    const mbCmds = game.consumeCommands();
    expect(mbCmds.some((c) => c.type === 'spawnMultiball' && c.targetBallCount === 3)).toBe(true);
    expect(mbCmds.some((c) => c.type === 'setMusicMode' && c.mode === 'multiball')).toBe(true);
    expect(mbCmds.some((c) => c.type === 'lampShow' && c.show === 'MULTIBALL_STROBE')).toBe(true);

    // Drain during 15s Multiball Ball Save auto-relaunches without losing ball count
    game.update(4.0);
    game.handlePhysicsEvent(drainEvent(2));
    expect(game.getSnapshot().activeBallCount).toBe(3);
    expect(
      game.consumeCommands().some((c) => c.type === 'spawnBall' && c.reason === 'ballSave'),
    ).toBe(true);

    // Jackpot on Warp Ramp (+100,000) flips to Super Jackpot Lit (score < 500k -> no Extra Ball yet)
    const preJackpot = game.getSnapshot().score;
    game.handlePhysicsEvent(rampCompleteEvent(1));
    expect(game.getSnapshot().score).toBe(preJackpot + SCORE_JACKPOT);
    expect(game.getSnapshot().jackpotLit).toBe(false);
    expect(game.getSnapshot().superJackpotLit).toBe(true);
    expect(game.getSnapshot().extraBalls).toBe(0);
    game.consumeCommands();

    // 2nd Multiball Jackpot (Super Jackpot +250,000, total still < 500,000) grants Extra Ball
    // specifically via the '2ND JACKPOT' path, emitting SUPER JACKPOT! before EXTRA BALL!
    const preSuper = game.getSnapshot().score;
    game.handlePhysicsEvent(saucerCaptureEvent(2));
    expect(game.getSnapshot().score).toBe(preSuper + SCORE_SUPER_JACKPOT);
    expect(game.getSnapshot().score).toBeLessThan(EXTRA_BALL_SCORE_THRESHOLD);
    expect(game.getSnapshot().jackpotLit).toBe(true);
    expect(game.getSnapshot().superJackpotLit).toBe(false);
    expect(game.getSnapshot().extraBalls).toBe(1);
    expect(game.getSnapshot().extraBallLit).toBe(true);

    const superBanners = game
      .consumeCommands()
      .filter((c): c is Extract<typeof c, { type: 'dmdBanner' }> => c.type === 'dmdBanner')
      .map((c) => ({ title: c.banner.title, subtitle: c.banner.subtitle }));
    expect(superBanners.map((b) => b.title)).toEqual(['SUPER JACKPOT!', 'EXTRA BALL!']);
    expect(superBanners[1].subtitle).toBe('2ND JACKPOT');

    // Crossing 500,000 on subsequent Jackpot + Super Jackpot must NOT award a second Extra Ball
    game.handlePhysicsEvent(rampCompleteEvent(1));
    game.handlePhysicsEvent(saucerCaptureEvent(1));
    expect(game.getSnapshot().score).toBeGreaterThanOrEqual(EXTRA_BALL_SCORE_THRESHOLD);
    expect(game.getSnapshot().extraBalls).toBe(1);

    // Expire multiball ball save, drain 2 balls -> Multiball ends with 1 ball still playing
    game.update(MULTIBALL_BALL_SAVE_SEC + 1.0);
    game.handlePhysicsEvent(drainEvent(2));
    expect(game.getSnapshot().activeBallCount).toBe(2);
    expect(game.getSnapshot().multiballActive).toBe(true);

    game.handlePhysicsEvent(drainEvent(3));
    expect(game.getSnapshot().activeBallCount).toBe(1);
    expect(game.getSnapshot().multiballActive).toBe(false);
    expect(game.getSnapshot().jackpotLit).toBe(false);
    expect(game.getSnapshot().lockedBalls).toBe(0);
    expect(game.getSnapshot().phase).toBe('PLAYING');
  });

  it('auto-relaunches drained ball during 12s HYPER SAVE and ends ball once expired', () => {
    const game = createLaunchedGame();

    game.update(5.0);
    expect(game.getSnapshot().ballSaveActive).toBe(true);
    game.handlePhysicsEvent(drainEvent(1));

    expect(game.getSnapshot().phase).toBe('PLAYING');
    expect(game.getSnapshot().ballNumber).toBe(1);
    expect(game.getSnapshot().activeBallCount).toBe(1);
    const cmds = game.consumeCommands();
    expect(cmds.some((c) => c.type === 'spawnBall' && c.reason === 'ballSave')).toBe(true);
    expect(cmds.some((c) => c.type === 'sound' && c.sound === 'ballSave')).toBe(true);

    // Expire remaining ball save timer -> drain enters BALL_BONUS
    game.update(BALL_SAVE_DURATION_SEC);
    expect(game.getSnapshot().ballSaveActive).toBe(false);
    game.handlePhysicsEvent(drainEvent(1));
    expect(game.getSnapshot().phase).toBe('BALL_BONUS');
  });

  it('awards Extra Ball at 500,000 points ("500,000 PTS"), credits "2ND JACKPOT" first on simultaneous cross, and sequences BALL_BONUS Extra Ball banners cleanly', () => {
    // 1. Score-threshold path (no Multiball jackpots) -> '500,000 PTS'
    const game = createLaunchedGame();
    expect(EXTRA_BALL_SCORE_THRESHOLD).toBe(500_000);

    const banners: Array<{ title: string; subtitle?: string }> = [];
    while (game.getSnapshot().score < EXTRA_BALL_SCORE_THRESHOLD) {
      game.handlePhysicsEvent(rampCompleteEvent(1));
      for (const c of game.consumeCommands()) {
        if (c.type === 'dmdBanner') {
          banners.push({ title: c.banner.title, subtitle: c.banner.subtitle });
        }
      }
    }
    expect(game.getSnapshot().extraBalls).toBe(1);
    expect(game.getSnapshot().extraBallLit).toBe(true);
    const ebBanner = banners.find((b) => b.title === 'EXTRA BALL!');
    expect(ebBanner?.subtitle).toBe('500,000 PTS');

    // Drain after ball save expires and finish BALL_BONUS -> Same Player Shoots Again (Ball 1)
    game.update(BALL_SAVE_DURATION_SEC + 1.0);
    game.handlePhysicsEvent(drainEvent(1));
    expect(game.getSnapshot().phase).toBe('BALL_BONUS');
    game.update(5.0);

    const snap = game.getSnapshot();
    expect(snap.phase).toBe('LAUNCH_READY');
    expect(snap.ballNumber).toBe(1);
    expect(snap.extraBalls).toBe(0);
    expect(snap.extraBallLit).toBe(false);

    // 2. Simultaneous 2nd Jackpot + 500,000 crossing credits '2ND JACKPOT' before score threshold
    const mbGame = createLaunchedGame();
    // Build score to ~240k before Multiball (still < 500k)
    for (let i = 0; i < 4; i++) {
      mbGame.handlePhysicsEvent(rampCompleteEvent(1));
    }
    mbGame.handlePhysicsEvent(saucerCaptureEvent(1)); // Lock 1
    mbGame.handlePhysicsEvent(rampCompleteEvent(1)); // Light Lock 2
    mbGame.handlePhysicsEvent(saucerCaptureEvent(1)); // Lock 2
    mbGame.handlePhysicsEvent(rampCompleteEvent(1)); // Light Lock 3
    mbGame.handlePhysicsEvent(saucerCaptureEvent(1)); // Lock 3 -> Multiball
    mbGame.handlePhysicsEvent(rampCompleteEvent(1)); // Jackpot #1 (+100k, still < 500k)
    expect(mbGame.getSnapshot().score).toBeLessThan(EXTRA_BALL_SCORE_THRESHOLD);
    expect(mbGame.getSnapshot().extraBalls).toBe(0);
    mbGame.consumeCommands();

    // Jackpot #2 (+250k) crosses 500k AND hits 2nd multiball jackpot on the exact same shot
    mbGame.handlePhysicsEvent(saucerCaptureEvent(1));
    expect(mbGame.getSnapshot().score).toBeGreaterThanOrEqual(EXTRA_BALL_SCORE_THRESHOLD);
    expect(mbGame.getSnapshot().extraBalls).toBe(1);
    const simBanners = mbGame
      .consumeCommands()
      .filter((c): c is Extract<typeof c, { type: 'dmdBanner' }> => c.type === 'dmdBanner')
      .map((c) => ({ title: c.banner.title, subtitle: c.banner.subtitle }));
    expect(simBanners.map((b) => b.title)).toEqual(['SUPER JACKPOT!', 'EXTRA BALL!']);
    expect(simBanners[1].subtitle).toBe('2ND JACKPOT');

    // 3. Crossing 500,000 inside BALL_BONUS emits TOTAL BONUS -> EXTRA BALL! -> SHOOT AGAIN! in order
    const bonusGame = createLaunchedGame();
    bonusGame.update(BALL_SAVE_DURATION_SEC + 1.0);
    // Advance score near 490k with sizable baseBonus so end-of-ball bonus crosses 500k
    while (bonusGame.getSnapshot().score < 425_000) {
      bonusGame.handlePhysicsEvent(rampCompleteEvent(1));
    }
    // Bump bonus multiplier to 2X via I-O-N
    bonusGame.handlePhysicsEvent(rolloverEvent(0));
    bonusGame.handlePhysicsEvent(rolloverEvent(1));
    bonusGame.handlePhysicsEvent(rolloverEvent(2));
    expect(bonusGame.getSnapshot().score).toBeLessThan(EXTRA_BALL_SCORE_THRESHOLD);
    expect(
      bonusGame.getSnapshot().score +
        bonusGame.getSnapshot().bonusPoints * bonusGame.getSnapshot().bonusMultiplier,
    ).toBeGreaterThanOrEqual(EXTRA_BALL_SCORE_THRESHOLD);
    bonusGame.consumeCommands();

    bonusGame.handlePhysicsEvent(drainEvent(1));
    bonusGame.update(4.0);
    const bonusTitles = bonusGame
      .consumeCommands()
      .filter((c): c is Extract<typeof c, { type: 'dmdBanner' }> => c.type === 'dmdBanner')
      .map((c) => c.banner.title);
    expect(bonusTitles).toContain('TOTAL BONUS');
    expect(bonusTitles).toContain('EXTRA BALL!');
    expect(bonusTitles).toContain('SHOOT AGAIN!');
    expect(bonusTitles.indexOf('TOTAL BONUS')).toBeLessThan(bonusTitles.indexOf('EXTRA BALL!'));
    expect(bonusTitles.indexOf('EXTRA BALL!')).toBeLessThan(bonusTitles.indexOf('SHOOT AGAIN!'));
    expect(bonusGame.getSnapshot().ballNumber).toBe(1);
  });

  it('caches getHighScores() with referential stability across reads until mutated', () => {
    const storage = createMemoryStorage();
    const game = new GameState({ storage });

    const refA = game.getHighScores();
    const refB = game.getHighScores();
    expect(refA).toBe(refB);
    expect(Object.isFrozen(refA)).toBe(true);
    expect(Object.isFrozen(refA[0])).toBe(true);

    // After resetting leaderboard to identical defaults, cache remains stable
    const refC = game.resetLeaderboard();
    expect(refC).toBe(refA);

    // Submitting a new qualifying high score updates the cached array cleanly
    game.startNewGame();
    for (let ball = 1; ball <= 3; ball++) {
      game.handlePhysicsEvent(shooterExitEvent(1));
      if (ball === 1) {
        game.handlePhysicsEvent(rampCompleteEvent(1));
        game.handlePhysicsEvent(rampCompleteEvent(1));
        game.handlePhysicsEvent(rampCompleteEvent(1));
      }
      game.update(BALL_SAVE_DURATION_SEC + 1.0);
      game.handlePhysicsEvent(drainEvent(1));
      game.update(4.0);
    }
    expect(game.getSnapshot().phase).toBe('HIGH_SCORE_ENTRY');
    const updated = game.submitHighScore('ZEN');
    expect(updated).not.toBe(refA);
    expect(game.getHighScores()).toBe(updated);
    expect(updated.some((e) => e.initials === 'ZEN')).toBe(true);
  });

  it('calculates End-of-Ball Bonus (baseBonus * bonusMultiplier) accurately and forfeits bonus on TILT', () => {
    // 1. Clean end-of-ball bonus tally
    const game = createLaunchedGame();
    game.update(BALL_SAVE_DURATION_SEC + 1.0); // expires skill shot & ball save

    // Complete I-O-N -> bonusMultiplier = 2X
    game.handlePhysicsEvent(rolloverEvent(0));
    game.handlePhysicsEvent(rolloverEvent(1));
    game.handlePhysicsEvent(rolloverEvent(2));
    expect(game.getSnapshot().bonusMultiplier).toBe(2);

    const preDrainScore = game.getSnapshot().score;
    const baseBonus = game.getSnapshot().bonusPoints;
    expect(baseBonus).toBeGreaterThan(0);

    game.handlePhysicsEvent(drainEvent(1));
    expect(game.getSnapshot().phase).toBe('BALL_BONUS');
    expect(game.getSnapshot().bonusBreakdown?.totalBonus).toBe(baseBonus * 2);

    // Step through animated tally at 60 Hz so TOTAL BONUS ('high') overlaps BALL 2 transition
    for (let i = 0; i < 180 && game.getSnapshot().phase === 'BALL_BONUS'; i++) {
      game.update(1 / 60);
    }
    expect(game.getSnapshot().phase).toBe('LAUNCH_READY');
    expect(game.getSnapshot().ballNumber).toBe(2);
    expect(game.getSnapshot().score).toBe(preDrainScore + baseBonus * 2);
    expect(game.getSnapshot().activeBanner?.title).toBe('BALL 2');
    expect(game.getSnapshot().activeBanner?.priority).toBe('high');

    // 2. Tilt warning & full TILT forfeits bonus and disables scoring/flippers/ball-save
    game.handlePhysicsEvent(shooterExitEvent(1));
    game.handlePhysicsEvent(bumperEvent(0));
    game.handlePhysicsEvent(bumperEvent(1));
    const scoreBeforeTilt = game.getSnapshot().score;
    expect(game.getSnapshot().bonusPoints).toBeGreaterThan(0);

    game.onTiltWarning();
    expect(game.getSnapshot().tiltWarnings).toBe(1);
    expect(game.getSnapshot().isTilted).toBe(false);

    game.onTiltWarning();
    expect(game.getSnapshot().tiltWarnings).toBe(2);
    expect(game.getSnapshot().isTilted).toBe(false);

    game.consumeCommands();
    game.onTiltWarning(); // 3rd warning triggers full TILT
    expect(game.getSnapshot().isTilted).toBe(true);
    expect(game.getSnapshot().ballSaveActive).toBe(false);

    const tiltCmds = game.consumeCommands();
    expect(tiltCmds.some((c) => c.type === 'setFlippersEnabled' && !c.enabled)).toBe(true);
    expect(tiltCmds.some((c) => c.type === 'lampShow' && c.show === 'TILT_BLACKOUT')).toBe(true);

    // Hits while tilted award 0 points, and saucer still ejects cleanly
    game.handlePhysicsEvent(bumperEvent(0));
    game.handlePhysicsEvent(saucerCaptureEvent(1));
    expect(game.getSnapshot().score).toBe(scoreBeforeTilt);
    expect(game.consumeCommands().some((c) => c.type === 'ejectSaucer')).toBe(true);

    // Draining while tilted forfeits end-of-ball bonus (score unchanged!) and advances to Ball 3
    game.handlePhysicsEvent(drainEvent(1));
    expect(game.getSnapshot().phase).toBe('BALL_BONUS');
    expect(game.getSnapshot().bonusBreakdown?.totalBonus).toBe(0);
    game.update(2.0);
    expect(game.getSnapshot().phase).toBe('LAUNCH_READY');
    expect(game.getSnapshot().ballNumber).toBe(3);
    expect(game.getSnapshot().score).toBe(scoreBeforeTilt);
    expect(game.getSnapshot().isTilted).toBe(false);
  });

  it('transitions to GAME_OVER on low score and HIGH_SCORE_ENTRY -> GAME_OVER on qualifying score', () => {
    // Low score -> GAME_OVER
    const lowStorage = createMemoryStorage();
    const lowGame = new GameState({ storage: lowStorage });
    lowGame.startNewGame();
    for (let ball = 1; ball <= 3; ball++) {
      lowGame.handlePhysicsEvent(shooterExitEvent(1));
      lowGame.update(BALL_SAVE_DURATION_SEC + 1.0);
      lowGame.handlePhysicsEvent(drainEvent(1));
      lowGame.update(4.0);
    }
    expect(lowGame.getSnapshot().phase).toBe('GAME_OVER');
    expect(lowGame.getSnapshot().qualifiesForHighScore).toBe(false);

    // Qualifying score (> 50,000, < 250,000 so no extra ball) -> HIGH_SCORE_ENTRY
    const hiStorage = createMemoryStorage();
    const hiGame = new GameState({ storage: hiStorage });
    hiGame.startNewGame();
    for (let ball = 1; ball <= 3; ball++) {
      hiGame.handlePhysicsEvent(shooterExitEvent(1));
      if (ball === 1) {
        // Score 90,000 (15k + 30k + 45k)
        hiGame.handlePhysicsEvent(rampCompleteEvent(1));
        hiGame.handlePhysicsEvent(rampCompleteEvent(1));
        hiGame.handlePhysicsEvent(rampCompleteEvent(1));
      }
      hiGame.update(BALL_SAVE_DURATION_SEC + 1.0);
      hiGame.handlePhysicsEvent(drainEvent(1));
      hiGame.update(4.0);
    }
    expect(hiGame.getSnapshot().phase).toBe('HIGH_SCORE_ENTRY');
    expect(hiGame.getSnapshot().qualifiesForHighScore).toBe(true);

    const saved = hiGame.submitHighScore('hy9!');
    expect(hiGame.getSnapshot().phase).toBe('GAME_OVER');
    expect(saved.length).toBe(5);
    expect(saved.some((e) => e.initials === 'HY9' && e.score === hiGame.getSnapshot().score)).toBe(
      true,
    );
    expect(loadHighScores(hiStorage).some((e) => e.initials === 'HY9')).toBe(true);
  });

  it('freezes timers and ignores events while paused, and transitions via shooterExit physics event', () => {
    const game = new GameState({ storage: createMemoryStorage() });
    game.startNewGame();
    game.consumeCommands();

    // Weak plunger release emits sound but does not transition out of LAUNCH_READY
    game.handlePhysicsEvent({
      type: 'plungerLaunch',
      ballId: 1,
      tension: 0.4,
      speed: 25,
    });
    expect(game.getSnapshot().phase).toBe('LAUNCH_READY');
    expect(
      game.consumeCommands().some((c) => c.type === 'sound' && c.sound === 'plungerRelease'),
    ).toBe(true);

    // Ball clearing shooter gate enters PLAYING
    game.handlePhysicsEvent(shooterExitEvent(1, 42));
    expect(game.getSnapshot().phase).toBe('PLAYING');

    const timerBeforePause = game.getSnapshot().ballSaveTimer;
    game.setPaused(true);
    game.update(10.0);
    game.handlePhysicsEvent(bumperEvent(0));
    expect(game.getSnapshot().ballSaveTimer).toBe(timerBeforePause);
    expect(game.getSnapshot().score).toBe(0);

    game.setPaused(false);
    game.update(2.0);
    expect(game.getSnapshot().ballSaveTimer).toBeCloseTo(timerBeforePause - 2.0, 5);

    game.returnToAttract();
    expect(game.getSnapshot().phase).toBe('ATTRACT');
    expect(game.getSnapshot().activeBallCount).toBe(0);
  });

  it('reconciles activeBallCount safely if physical balls drop to 0 or leave multiball during PLAYING', () => {
    const game = createLaunchedGame();

    // Reconcile 0 during LAUNCH_READY or paused must be a safe no-op
    const readyGame = new GameState({ storage: createMemoryStorage() });
    readyGame.startNewGame();
    readyGame.reconcileActiveBallCount(0);
    expect(readyGame.getSnapshot().phase).toBe('LAUNCH_READY');

    // Trigger 3-ball Multiball
    game.handlePhysicsEvent(saucerCaptureEvent(1)); // Lock 1
    game.handlePhysicsEvent(rampCompleteEvent(1)); // Light Lock 2
    game.handlePhysicsEvent(saucerCaptureEvent(1)); // Lock 2
    game.handlePhysicsEvent(rampCompleteEvent(1)); // Light Lock 3
    game.handlePhysicsEvent(saucerCaptureEvent(1)); // Lock 3 -> Multiball
    expect(game.getSnapshot().multiballActive).toBe(true);
    expect(game.getSnapshot().activeBallCount).toBe(3);
    game.consumeCommands();

    // Physical count drops to 1 -> exits Multiball cleanly and restores normal music
    game.reconcileActiveBallCount(1);
    expect(game.getSnapshot().activeBallCount).toBe(1);
    expect(game.getSnapshot().multiballActive).toBe(false);
    expect(game.getSnapshot().jackpotLit).toBe(false);
    expect(
      game.consumeCommands().some((c) => c.type === 'setMusicMode' && c.mode === 'normal'),
    ).toBe(true);

    // Physical count drops to 0 during PLAYING (even while ballSaveActive) -> recovers to BALL_BONUS
    expect(game.getSnapshot().ballSaveActive).toBe(true);
    game.reconcileActiveBallCount(0);
    expect(game.getSnapshot().activeBallCount).toBe(0);
    expect(game.getSnapshot().phase).toBe('BALL_BONUS');
  });

  it('keeps all emitted DMD banner subtitles within 19 characters to prevent 128-col DMD overflow', () => {
    const game = new GameState({ storage: createMemoryStorage() });
    const subtitles: string[] = [];
    const collectSubtitles = () => {
      for (const cmd of game.consumeCommands()) {
        if (cmd.type === 'dmdBanner' && cmd.banner.subtitle) {
          subtitles.push(cmd.banner.subtitle);
        }
      }
    };

    game.startNewGame();
    collectSubtitles();
    game.handlePhysicsEvent(shooterExitEvent(1));
    collectSubtitles();

    // Ramp up Playfield Multiplier to 5X to stress-test the largest possible numeric banner strings
    for (let k = 0; k < 3; k++) {
      game.handlePhysicsEvent(standupEvent(0));
      game.handlePhysicsEvent(standupEvent(1));
      game.handlePhysicsEvent(standupEvent(2));
      collectSubtitles();
    }
    expect(game.getSnapshot().playfieldMultiplier).toBe(5);

    // I-O-N completion at 5X (+50,000)
    game.handlePhysicsEvent(rolloverEvent(0));
    game.handlePhysicsEvent(rolloverEvent(1));
    game.handlePhysicsEvent(rolloverEvent(2));
    collectSubtitles();

    // Lock 1, Warp Ramp Lock 2 lit (at 5X!), Lock 2 (+100K!), Warp Ramp Lock 3, Lock 3 Multiball
    game.handlePhysicsEvent(saucerCaptureEvent(1));
    collectSubtitles();
    game.handlePhysicsEvent(rampCompleteEvent(1));
    collectSubtitles();
    game.handlePhysicsEvent(saucerCaptureEvent(1));
    collectSubtitles();
    game.handlePhysicsEvent(rampCompleteEvent(1));
    collectSubtitles();
    game.handlePhysicsEvent(saucerCaptureEvent(1));
    collectSubtitles();

    // Jackpot & Super Jackpot at 5X
    game.handlePhysicsEvent(rampCompleteEvent(1));
    collectSubtitles();
    game.handlePhysicsEvent(saucerCaptureEvent(1));
    collectSubtitles();

    expect(subtitles.length).toBeGreaterThan(8);
    for (const sub of subtitles) {
      expect(sub.length, `DMD subtitle too wide: "${sub}"`).toBeLessThanOrEqual(19);
    }
  });
});

describe('HighScores — Persistence & Safe Fallbacks', () => {
  it('loads seeded sci-fi defaults and inserts/sorts top-5 entries cleanly', () => {
    const storage = createMemoryStorage();
    const defaults = loadHighScores(storage);
    expect(defaults.map((e) => e.initials)).toEqual(['NOV', 'ZAP', 'REX', 'ION', 'ACE']);
    expect(isHighScore(0, defaults)).toBe(false);
    expect(isHighScore(50_000, defaults)).toBe(false);
    expect(isHighScore(50_001, defaults)).toBe(true);

    const updated = insertHighScore('q!', 400_000, storage);
    expect(updated.length).toBe(5);
    expect(updated[0].initials).toBe('QAA');
    expect(updated[0].score).toBe(400_000);
    expect(updated[4].initials).toBe('ION');
    expect(sanitizeInitials('ab')).toBe('ABA');

    const restored = resetHighScores(storage);
    expect(restored.map((e) => e.initials)).toEqual(['NOV', 'ZAP', 'REX', 'ION', 'ACE']);
  });

  it('recovers gracefully from corrupt JSON and unavailable/throwing storage', () => {
    const corruptStorage = createMemoryStorage({
      [HIGH_SCORES_STORAGE_KEY]: '{not valid json',
    });
    expect(loadHighScores(corruptStorage).map((e) => e.initials)).toEqual([
      'NOV',
      'ZAP',
      'REX',
      'ION',
      'ACE',
    ]);

    const throwingStorage: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    resetHighScores(null);
    const afterInsert = insertHighScore('MAX', 999_000, throwingStorage);
    expect(afterInsert[0].initials).toBe('MAX');
    expect(loadHighScores(null)[0].initials).toBe('MAX');
    resetHighScores(null);
  });
});

describe('LampController — Full Lamp Matrix & Scripted Lightshows', () => {
  it('drives all 47 LampIds across reactive gameplay states, flashes, shows, and tilt blackout', () => {
    const game = createLaunchedGame();
    const lamps = new LampController();

    const initialMap = lamps.update(0.05, game.getSnapshot());
    expect(initialMap.size).toBe(47);

    // Every LampId produces finite, non-negative intensity
    for (const state of initialMap.values()) {
      expect(Number.isFinite(state.intensity)).toBe(true);
      expect(state.intensity).toBeGreaterThanOrEqual(0);
    }

    // Reactive state: light Kickback and step Playfield 2X
    game.handlePhysicsEvent(dropTargetEvent(0));
    game.handlePhysicsEvent(dropTargetEvent(1));
    game.handlePhysicsEvent(dropTargetEvent(2));
    game.handlePhysicsEvent(standupEvent(0));
    game.handlePhysicsEvent(standupEvent(1));
    game.handlePhysicsEvent(standupEvent(2));

    for (let i = 0; i < 20; i++) {
      lamps.update(0.05, game.getSnapshot());
    }
    expect(lamps.getLampState('shield_kickback').intensity).toBeGreaterThan(0.8);
    expect(lamps.getLampState('pf_2x').intensity).toBeGreaterThan(0.8);
    expect(lamps.getLampState('hyper_save').intensity).toBeGreaterThan(0.5);

    // Crisp impact flash on bumper & flasher dome
    lamps.flashLamp('flasher_hypercore', 0.3);
    lamps.update(0.02, game.getSnapshot());
    expect(lamps.getLampState('flasher_hypercore').intensity).toBeGreaterThan(1.0);

    // Every scripted show runs cleanly without NaN
    const shows: LampShowName[] = [
      'ATTRACT_WAVE',
      'SKILL_SHOT_PULSE',
      'RAMP_CHASE',
      'LOCK_CHARGE',
      'MULTIBALL_STROBE',
      'JACKPOT_BURST',
    ];
    for (const show of shows) {
      lamps.triggerShow(show, 0.5);
      expect(lamps.getActiveShow()).toBe(show);
      const out = lamps.update(0.1, game.getSnapshot());
      for (const s of out.values()) {
        expect(Number.isFinite(s.intensity)).toBe(true);
        expect(s.intensity).toBeGreaterThanOrEqual(0);
      }
    }

    // Tilt blackout drives all lamps smoothly to 0
    game.onTilt();
    lamps.triggerShow('TILT_BLACKOUT', 999);
    for (let i = 0; i < 40; i++) {
      lamps.update(0.05, game.getSnapshot());
    }
    const sampleLamps: LampId[] = [
      'shield_kickback',
      'pf_2x',
      'hyper_save',
      'bumper_1',
      'flasher_hypercore',
    ];
    for (const id of sampleLamps) {
      expect(lamps.getLampState(id).intensity).toBe(0);
    }
  });
});
