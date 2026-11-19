/// <reference types="vite/client" />

/**
 * HYPERNOVA — Application Bootstrap & Decoupled Simulation / Render Loop
 *
 * Integrates:
 *   - 480 Hz Rapier3D physics (`PhysicsWorld`)
 *   - Deterministic pinball ruleset (`GameState`), damped pendulum (`TiltSystem`),
 *     and 47-channel playfield lamp matrix (`LampController`)
 *   - Three.js PBR cabinet, playfield mechanisms, GLSL Hypercore reactor,
 *     pooled spark particles, 128x32 amber DMD, dark arcade HDRI & selective bloom
 *   - Pure Web Audio electromechanical foley, rolling beds & 90s sci-fi synth engine
 *   - Translucent glassmorphic arcade HUD, pause/settings drawer & touch controls
 */

import './style.css';

import { SoundEngine, type MusicMode } from './audio/SoundEngine';
import {
  MAX_BALLS,
  MAX_FRAME_DT,
  PLAYFIELD_MAX_X,
  SAUCER_HOLD_DURATION,
  SHOOTER_LANE_MIN_X,
} from './config/constants';
import { PLUNGER } from './config/tableLayout';
import type {
  CameraMode,
  GameSnapshot,
  GlassMode,
  InputState,
  PhysicsEvent,
  QualityLevel,
  SettingsState,
} from './config/types';
import { GameState, type GameCommand } from './game/GameState';
import { LampController } from './game/LampController';
import { TiltSystem, type NudgeDirection } from './game/TiltSystem';
import { createBackboxTransliteTexture } from './graphics/BackboxTextures';
import { buildCabinet } from './graphics/CabinetBuilder';
import { CameraController } from './graphics/CameraController';
import { DmdRenderer } from './graphics/DmdRenderer';
import { buildArcadeEnvironment } from './graphics/EnvironmentBuilder';
import { HypercoreToy } from './graphics/HypercoreToy';
import { ParticleSystem } from './graphics/ParticleSystem';
import { buildPlayfieldMeshes } from './graphics/PlayfieldMeshBuilder';
import { createPlayfieldTextures } from './graphics/PlayfieldTextures';
import { SceneManager } from './graphics/SceneManager';
import { PhysicsWorld } from './physics/PhysicsWorld';
import { HudController } from './ui/HudController';

const SETTINGS_STORAGE_KEY = 'hypernova_settings_v1';

const DEFAULT_SETTINGS: SettingsState = {
  quality: 'high',
  glassMode: 'subtle',
  cameraMode: 'classic',
  muted: false,
  masterVolume: 0.85,
  sfxVolume: 0.9,
  musicVolume: 0.55,
  musicEnabled: true,
  showDmdMirror: true,
};

const VALID_QUALITIES = new Set<QualityLevel>(['high', 'medium']);
const VALID_GLASS_MODES = new Set<GlassMode>(['off', 'subtle', 'realistic']);
const VALID_CAMERA_MODES = new Set<CameraMode>(['classic', 'dynamic', 'lowAction', 'overhead']);

const LEFT_FLIPPER_CODES = new Set(['ShiftLeft', 'KeyZ', 'KeyA', 'ArrowLeft']);
const RIGHT_FLIPPER_CODES = new Set(['ShiftRight', 'Slash', 'KeyD', 'ArrowRight']);
const PLUNGER_CODES = new Set(['Space', 'Enter', 'ArrowDown']);
const START_CODES = new Set(['Space', 'Enter']);
const SCROLL_PREVENT_CODES = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function loadSettings(): SettingsState {
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<SettingsState>;
    return {
      quality: parsed.quality && VALID_QUALITIES.has(parsed.quality)
        ? parsed.quality
        : DEFAULT_SETTINGS.quality,
      glassMode: parsed.glassMode && VALID_GLASS_MODES.has(parsed.glassMode)
        ? parsed.glassMode
        : DEFAULT_SETTINGS.glassMode,
      cameraMode: parsed.cameraMode && VALID_CAMERA_MODES.has(parsed.cameraMode)
        ? parsed.cameraMode
        : DEFAULT_SETTINGS.cameraMode,
      muted: typeof parsed.muted === 'boolean' ? parsed.muted : DEFAULT_SETTINGS.muted,
      masterVolume: typeof parsed.masterVolume === 'number'
        ? clamp01(parsed.masterVolume)
        : DEFAULT_SETTINGS.masterVolume,
      sfxVolume: typeof parsed.sfxVolume === 'number'
        ? clamp01(parsed.sfxVolume)
        : DEFAULT_SETTINGS.sfxVolume,
      musicVolume: typeof parsed.musicVolume === 'number'
        ? clamp01(parsed.musicVolume)
        : DEFAULT_SETTINGS.musicVolume,
      musicEnabled: typeof parsed.musicEnabled === 'boolean'
        ? parsed.musicEnabled
        : DEFAULT_SETTINGS.musicEnabled,
      showDmdMirror: typeof parsed.showDmdMirror === 'boolean'
        ? parsed.showDmdMirror
        : DEFAULT_SETTINGS.showDmdMirror,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings: SettingsState): void {
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage quota or private-browsing errors cleanly.
  }
}

interface PendingAutoLaunch {
  delay: number;
  spawned: boolean;
}

interface BootstrapSignal {
  aborted: boolean;
}

async function bootstrap(signal: BootstrapSignal): Promise<() => void> {
  const canvas = document.getElementById('pinball-canvas') as HTMLCanvasElement | null;
  const hudRoot = document.getElementById('hud-root') as HTMLElement | null;

  if (!canvas || !hudRoot) {
    throw new Error('HYPERNOVA mount elements (#pinball-canvas / #hud-root) not found.');
  }

  let settings: SettingsState = loadSettings();
  let paused = false;
  let disposed = false;
  let desiredMusicMode: MusicMode = 'off';

  // -------------------------------------------------------------------------
  // 1. Core Simulation & Audio Subsystems
  // -------------------------------------------------------------------------
  const physics = await PhysicsWorld.create({ spawnInitialBall: false });
  if (signal.aborted) {
    physics.dispose();
    return () => {};
  }

  const gameState = new GameState();
  const tiltSystem = new TiltSystem();
  const lampController = new LampController();
  const sound = new SoundEngine({
    muted: settings.muted,
    masterVolume: settings.masterVolume,
    sfxVolume: settings.sfxVolume,
    musicVolume: settings.musicVolume,
  });
  if (document.hidden) {
    sound.setSuspended(true);
  }

  // -------------------------------------------------------------------------
  // 2. Three.js Renderer, Arcade Environment, Textures, DMD & 3D Cabinet
  // -------------------------------------------------------------------------
  const initialWidth = window.innerWidth || canvas.clientWidth || 1280;
  const initialHeight = window.innerHeight || canvas.clientHeight || 720;

  const sceneManager = new SceneManager({
    canvas,
    width: initialWidth,
    height: initialHeight,
    quality: settings.quality,
  });

  const arcadeEnv = buildArcadeEnvironment(sceneManager.renderer, sceneManager.scene);
  sceneManager.setEnvironment(arcadeEnv.envMap);

  let playfieldTextures = createPlayfieldTextures(settings.quality === 'high' ? 1 : 0.5);
  const transliteTexture = createBackboxTransliteTexture();
  const dmd = new DmdRenderer();
  dmd.setHighScores([...gameState.getHighScores()]);

  const playfieldVisuals = buildPlayfieldMeshes(playfieldTextures);
  const hypercoreToy = new HypercoreToy();
  const particles = new ParticleSystem(240);

  const cabinet = buildCabinet({
    transliteTexture,
    dmdTexture: dmd.getTexture(),
    playfieldGroup: playfieldVisuals.group,
    initialGlassMode: settings.glassMode,
  });

  // Mount playfield-local accessories directly into the tilted playfieldGroup
  // so every object shares exact 1:1 coordinates with Rapier3D and cabinet shake.
  cabinet.playfieldGroup.add(hypercoreToy.group);
  cabinet.playfieldGroup.add(particles.mesh);
  sceneManager.attachFlashersTo(cabinet.playfieldGroup);
  sceneManager.scene.add(cabinet.rootGroup);

  const cameraController = new CameraController(sceneManager.camera, settings.cameraMode);
  cameraController.setCabinetRoot(cabinet.rootGroup);

  // WebGL context loss / restore handling
  let contextLostBanner: HTMLDivElement | null = null;
  let wasPausedBeforeContextLoss = false;
  let pendingQualityTextureRebuild = false;
  let hudRef: HudController | null = null;

  function showContextLostBanner(): void {
    hudRef?.setContextLostBlocked(true);
    if (contextLostBanner) return;
    const banner = document.createElement('div');
    banner.setAttribute('role', 'alertdialog');
    banner.setAttribute('aria-modal', 'true');
    banner.setAttribute('aria-label', 'Graphics Context Lost');
    banner.tabIndex = -1;
    banner.style.cssText =
      'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(5,7,18,0.82);color:#e6f2ff;font-family:monospace;z-index:999;pointer-events:auto;outline:none;';
    const card = document.createElement('div');
    card.style.cssText =
      'padding:18px 24px;border:1px solid #00f0ff;border-radius:10px;background:#0c1126;text-align:center;max-width:420px;';
    const title = document.createElement('div');
    title.style.cssText = 'color:#00f0ff;font-weight:700;letter-spacing:0.12em;margin-bottom:6px;';
    title.textContent = 'GRAPHICS CONTEXT LOST';
    const msg = document.createElement('div');
    msg.style.cssText = 'color:#b8c8e6;font-size:12px;line-height:1.5;';
    msg.textContent = 'Simulation paused cleanly. Waiting for WebGL recovery...';
    card.append(title, msg);
    banner.appendChild(card);
    hudRoot!.appendChild(banner);
    contextLostBanner = banner;
    banner.focus({ preventScroll: true });
  }

  function hideContextLostBanner(): void {
    if (contextLostBanner) {
      contextLostBanner.remove();
      contextLostBanner = null;
    }
    hudRef?.setContextLostBlocked(false);
  }

  function rebuildPlayfieldTexturesForQuality(quality: QualityLevel): void {
    const nextTextures = createPlayfieldTextures(quality === 'high' ? 1 : 0.5);
    playfieldVisuals.setPlayfieldTextures(nextTextures);
    playfieldTextures.dispose();
    playfieldTextures = nextTextures;
  }

  sceneManager.setContextCallbacks({
    onLost: () => {
      if (disposed) return;
      wasPausedBeforeContextLoss = paused;
      setPaused(true);
      sound.setSuspended(true);
      showContextLostBanner();
    },
    onRestored: () => {
      if (disposed) return;
      hideContextLostBanner();
      const restoredEnv = arcadeEnv.rebuildEnvironment(
        sceneManager.renderer,
        sceneManager.scene,
        { skipDisposeOld: true },
      );
      sceneManager.setEnvironment(restoredEnv);

      if (pendingQualityTextureRebuild) {
        pendingQualityTextureRebuild = false;
        rebuildPlayfieldTexturesForQuality(settings.quality);
      } else {
        playfieldTextures.map.needsUpdate = true;
        playfieldTextures.roughnessMap.needsUpdate = true;
        playfieldTextures.bumpMap.needsUpdate = true;
      }
      transliteTexture.needsUpdate = true;
      dmd.getTexture().needsUpdate = true;

      const phase = gameState.getSnapshot().phase;
      if (
        !wasPausedBeforeContextLoss &&
        (phase === 'ATTRACT' || phase === 'GAME_OVER' || phase === 'HIGH_SCORE_ENTRY')
      ) {
        setPaused(false);
      }
    },
  });

  // -------------------------------------------------------------------------
  // 3. Input State & Synchronization Trackers
  // -------------------------------------------------------------------------
  const kbLeftKeys = new Set<string>();
  const kbRightKeys = new Set<string>();
  const kbPlungerKeys = new Set<string>();
  const ignorePlungerUntilKeyUp = new Set<string>();

  let touchLeftFlipper = false;
  let touchRightFlipper = false;
  let uiPlungerHeld = false;
  let uiPlungerDragTension: number | null = null;

  let prevLeftFlipperActive = false;
  let prevRightFlipperActive = false;
  let prevGateOpenAngle = 0;
  let giDimFactor = 1.0;

  // Saucer hold/eject sync:
  // BallManager naturally runs the SAUCER_HOLD_DURATION (1.1s) timer (and shortens
  // to 0.25s on multiball). `pendingSaucerEjectTimer` handles shorter delays (e.g.
  // 0.35s tilted eject) and acts as a safety fallback if a captured ball ever lingers.
  let pendingSaucerEjectTimer: number | null = null;
  let pendingAutoLaunches: PendingAutoLaunch[] = [];
  let emptyPlayfieldTimer = 0;

  // Reusable per-frame physics input struct (zero per-frame allocations)
  const frameInput: InputState = {
    leftFlipper: false,
    rightFlipper: false,
    plungerHeld: false,
    plungerDragTension: null,
    nudgeLeft: false,
    nudgeRight: false,
    nudgeUp: false,
  };

  function syncMusic(): void {
    const effectiveMode: MusicMode =
      settings.musicEnabled && !paused ? desiredMusicMode : 'off';
    sound.setMusicMode(effectiveMode);
  }

  function releaseAllInputs(): void {
    kbLeftKeys.clear();
    kbRightKeys.clear();
    kbPlungerKeys.clear();
    ignorePlungerUntilKeyUp.clear();
    touchLeftFlipper = false;
    touchRightFlipper = false;
    uiPlungerHeld = false;
    uiPlungerDragTension = null;
    frameInput.leftFlipper = false;
    frameInput.rightFlipper = false;
    frameInput.plungerHeld = false;
    frameInput.plungerDragTension = null;
  }

  function applySettingsPatch(patch: Partial<SettingsState>): void {
    const prev = settings;
    settings = {
      ...settings,
      ...patch,
      masterVolume: patch.masterVolume !== undefined ? clamp01(patch.masterVolume) : settings.masterVolume,
      sfxVolume: patch.sfxVolume !== undefined ? clamp01(patch.sfxVolume) : settings.sfxVolume,
      musicVolume: patch.musicVolume !== undefined ? clamp01(patch.musicVolume) : settings.musicVolume,
    };
    saveSettings(settings);

    if (settings.cameraMode !== prev.cameraMode) {
      cameraController.setMode(settings.cameraMode, false);
    }
    if (settings.glassMode !== prev.glassMode) {
      cabinet.setGlassMode(settings.glassMode);
    }
    if (settings.quality !== prev.quality) {
      sceneManager.setQuality(settings.quality);
      if (sceneManager.isContextLost()) {
        pendingQualityTextureRebuild = true;
      } else {
        rebuildPlayfieldTexturesForQuality(settings.quality);
      }
    }
    if (settings.muted !== prev.muted) {
      sound.setMuted(settings.muted);
    }
    if (settings.masterVolume !== prev.masterVolume) {
      sound.setMasterVolume(settings.masterVolume);
    }
    if (settings.sfxVolume !== prev.sfxVolume) {
      sound.setSfxVolume(settings.sfxVolume);
    }
    if (settings.musicVolume !== prev.musicVolume) {
      sound.setMusicVolume(settings.musicVolume);
    }
    if (settings.musicEnabled !== prev.musicEnabled) {
      syncMusic();
    }
  }

  function setPaused(nextPaused: boolean): void {
    // Never allow unpausing simulation while WebGL graphics context is lost (MINOR #3)
    if (!nextPaused && sceneManager.isContextLost()) {
      return;
    }
    if (paused === nextPaused) return;
    paused = nextPaused;
    gameState.setPaused(paused);
    if (paused) {
      releaseAllInputs();
      prevLeftFlipperActive = false;
      prevRightFlipperActive = false;
      emptyPlayfieldTimer = 0;
      sound.updateRolling(0, 0);
    }
    sound.setSuspended(document.hidden || paused || sceneManager.isContextLost());
    syncMusic();
  }

  function triggerStartGame(): void {
    if (sceneManager.isContextLost()) return;
    sound.unlock();
    desiredMusicMode = 'off';
    sound.setMusicMode('off');
    setPaused(false);
    sound.setSuspended(document.hidden || sceneManager.isContextLost());
    releaseAllInputs();
    prevLeftFlipperActive = false;
    prevRightFlipperActive = false;
    pendingSaucerEjectTimer = null;
    pendingAutoLaunches = [];
    emptyPlayfieldTimer = 0;

    tiltSystem.resetForNewBall();
    physics.resetTable(false);
    lampController.reset();
    dmd.clearBanner();

    gameState.startNewGame();
    drainGameCommands();
  }

  function triggerNudge(dir: NudgeDirection): void {
    if (paused || hud.isHighScoreModalOpen()) return;
    const snap = gameState.getSnapshot();
    if (snap.phase !== 'PLAYING') return;

    sound.unlock();
    const res = tiltSystem.nudge(dir);
    if (!res.accepted) return;

    physics.applyNudgeImpulse(res.impulseX, res.impulseZ);
    cameraController.addNudgeShake(res.impulseX * 0.38, res.impulseZ * 0.38);
    sound.playNudge(0.85);

    if (res.tilted) {
      physics.setTilted(true);
      gameState.onTilt();
      drainGameCommands();
    } else if (res.dangerTriggered) {
      gameState.onTiltWarning(res.warnings);
      drainGameCommands();
    }
  }

  // -------------------------------------------------------------------------
  // 4. Physics Event -> GameState & Visual/Audio FX Pipeline
  // -------------------------------------------------------------------------
  function processPhysicsEvent(event: PhysicsEvent): void {
    // Immediate 3D mechanism animations driven directly by physical contacts
    switch (event.type) {
      case 'bumper':
        playfieldVisuals.triggerBumperKick(event.index);
        break;
      case 'slingshot':
        playfieldVisuals.triggerSlingshotKick(event.side);
        break;
      case 'standup':
        playfieldVisuals.triggerStandupHit(event.index);
        break;
      case 'saucerEject':
        pendingSaucerEjectTimer = null;
        break;
      case 'flipperHit':
        if (event.impactSpeed > 10.0) {
          const pan = Math.max(-1, Math.min(1, event.position.x / PLAYFIELD_MAX_X));
          sound.playWallBounce(Math.min(11, event.impactSpeed * 0.35), pan);
        }
        break;
      default:
        break;
    }

    gameState.handlePhysicsEvent(event);
  }

  // -------------------------------------------------------------------------
  // 5. GameCommand Executor (GameState -> Physics / Audio / DMD / Lamps / FX)
  // -------------------------------------------------------------------------
  function executeSoundCommand(cmd: Extract<GameCommand, { type: 'sound' }>): void {
    const pan = cmd.pan ?? 0;
    switch (cmd.sound) {
      case 'startGame':
        sound.playStartGame();
        break;
      case 'popBumper':
        sound.playPopBumper(cmd.index ?? 0, pan);
        break;
      case 'slingshot':
        sound.playSlingshot(pan);
        break;
      case 'dropTarget':
        sound.playDropTarget(cmd.index ?? 0, cmd.pan ?? -0.5);
        break;
      case 'dropTargetBankReset':
        sound.playDropTargetBankReset();
        break;
      case 'standupTarget':
        sound.playStandupTarget(cmd.index ?? 0, cmd.pan ?? 0.5);
        break;
      case 'rollover':
        sound.playRollover(cmd.index ?? 0, pan);
        break;
      case 'rolloverComplete':
        sound.playRolloverComplete();
        break;
      case 'spinnerTick':
        sound.playSpinnerTick(cmd.intensity ?? 18, cmd.pan ?? -0.55);
        break;
      case 'plungerRelease':
        sound.playPlungerRelease(cmd.intensity ?? 0.8);
        break;
      case 'saucerCapture':
        sound.playSaucerCapture();
        break;
      case 'saucerEject':
        sound.playSaucerEject();
        break;
      case 'kickback':
        sound.playKickback();
        break;
      case 'wallBounce':
        sound.playWallBounce(cmd.intensity ?? 6, pan);
        break;
      case 'ballCollision':
        sound.playBallCollision(cmd.intensity ?? 6, pan);
        break;
      case 'drain':
        sound.playDrain();
        break;
      case 'ballSave':
        sound.playBallSave();
        break;
      case 'tiltWarning':
        sound.playTiltWarning();
        break;
      case 'tilt':
        sound.playTilt();
        break;
      case 'skillShot':
        sound.playSkillShot();
        break;
      case 'rampCombo':
        sound.playRampCombo(cmd.count ?? 1);
        break;
      case 'ballLocked':
        sound.playBallLocked(cmd.count ?? 1);
        break;
      case 'multiballStart':
        sound.playMultiballStart();
        break;
      case 'jackpot':
        sound.playJackpot(cmd.isSuper ?? false);
        break;
      case 'extraBall':
        sound.playExtraBall();
        break;
      case 'bonusTick':
        sound.playBonusTick(cmd.index ?? 0);
        break;
      case 'gameOver':
        sound.playGameOver();
        break;
    }
  }

  function drainGameCommands(): void {
    const commands = gameState.consumeCommands();
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      switch (cmd.type) {
        case 'spawnBall':
          if (cmd.reason === 'ballSave' || cmd.reason === 'lockReplacement') {
            // Auto-plunge saved/replacement balls cleanly back into active play
            pendingAutoLaunches.push({
              delay: 0.22,
              spawned: false,
            });
          } else {
            physics.spawnBallInShooter();
          }
          break;

        case 'spawnMultiball':
          // Multiball fills up to MAX_BALLS directly; clear any stale queued ballSave launches
          // so they cannot linger at MAX_BALLS and spawn a phantom ball after a later drain.
          pendingAutoLaunches = [];
          physics.spawnMultiball(cmd.targetBallCount);
          // BallManager shortens saucer hold to 0.25s on multiball; keep safety fallback synced.
          pendingSaucerEjectTimer = 0.45;
          break;

        case 'ejectSaucer': {
          const requestedDelay = cmd.delaySec ?? SAUCER_HOLD_DURATION;
          if (requestedDelay <= 0) {
            const ejectEvt = physics.releaseSaucerBall();
            pendingSaucerEjectTimer = null;
            if (ejectEvt) {
              processPhysicsEvent(ejectEvt);
            }
          } else if (requestedDelay < SAUCER_HOLD_DURATION - 0.05) {
            // Shorter delay than BallManager's default 1.1s (e.g. tilted saucer release)
            pendingSaucerEjectTimer =
              pendingSaucerEjectTimer === null
                ? requestedDelay
                : Math.min(pendingSaucerEjectTimer, requestedDelay);
          } else {
            // Normal hold: let BallManager's exact 480 Hz timer eject cleanly,
            // armed with a small safety margin so a ball can never stay trapped.
            const safetyDeadline = requestedDelay + 0.15;
            pendingSaucerEjectTimer =
              pendingSaucerEjectTimer === null
                ? safetyDeadline
                : Math.min(pendingSaucerEjectTimer, safetyDeadline);
          }
          break;
        }

        case 'resetDropTargets':
          physics.resetDropTargets();
          break;

        case 'setKickbackArmed':
          physics.setKickbackArmed(cmd.armed);
          break;

        case 'setFlippersEnabled':
          physics.setFlippersEnabled(cmd.enabled);
          if (!cmd.enabled && gameState.getSnapshot().isTilted) {
            physics.setTilted(true);
          }
          break;

        case 'resetTilt':
          tiltSystem.resetForNewBall();
          physics.setTilted(false);
          break;

        case 'dmdBanner':
          dmd.triggerBanner(cmd.banner);
          break;

        case 'sound':
          executeSoundCommand(cmd);
          break;

        case 'setMusicMode':
          desiredMusicMode = cmd.mode;
          syncMusic();
          break;

        case 'lampShow':
          lampController.triggerShow(cmd.show, cmd.duration);
          break;

        case 'flashLamp':
          lampController.flashLamp(cmd.lampId, cmd.duration);
          break;

        case 'sparkBurst':
          particles.emitBurst(cmd.position, cmd.color, cmd.count, cmd.speed);
          break;

        case 'hypercorePulse':
          hypercoreToy.triggerPulse();
          break;
      }
    }
  }

  function stepScheduledPhysicsActions(dt: number): void {
    // 1. Scheduled saucer eject (early tilted release or safety net)
    if (pendingSaucerEjectTimer !== null) {
      pendingSaucerEjectTimer -= dt;
      if (pendingSaucerEjectTimer <= 0) {
        pendingSaucerEjectTimer = null;
        if (physics.getSnapshot().saucerOccupied) {
          const ejectEvt = physics.releaseSaucerBall();
          if (ejectEvt) {
            processPhysicsEvent(ejectEvt);
          }
        }
      }
    }

    // 2. Scheduled HYPER SAVE / lock-replacement auto-relaunch balls (MAJOR #3)
    if (pendingAutoLaunches.length > 0) {
      const activePhase = gameState.getSnapshot().phase;
      if (activePhase !== 'PLAYING' && activePhase !== 'LAUNCH_READY') {
        pendingAutoLaunches = [];
        return;
      }

      const remaining: PendingAutoLaunch[] = [];
      let unblockedShooterThisStep = false;

      for (const item of pendingAutoLaunches) {
        item.delay -= dt;
        if (item.delay > 0) {
          remaining.push(item);
          continue;
        }

        if (!item.spawned) {
          const snap = physics.getSnapshot();
          if (snap.balls.length >= MAX_BALLS) {
            // Table is already at MAX_BALLS capacity — drop redundant queued launch cleanly.
            continue;
          }

          const spawnedId = physics.spawnBallInShooter();
          if (spawnedId !== null) {
            item.spawned = true;
            const launchEvt = physics.triggerBallLaunch(0.94);
            if (launchEvt) {
              processPhysicsEvent(launchEvt);
            }
          } else {
            // Never silently drop a replacement ball when capacity remains: if an idle ball
            // (in either 'shooter' or rebounded 'playfield' zone) sits in the shooter lane
            // blocking the plunger tip, auto-launch it to clear the lane and retry.
            if (!unblockedShooterThisStep && snap.hasBallInShooter) {
              const blockingIdleBall = snap.balls.some(
                (b) =>
                  (b.zone === 'shooter' ||
                    (b.zone === 'playfield' &&
                      b.position.x >= SHOOTER_LANE_MIN_X - 0.18 &&
                      b.position.z >= 6.5)) &&
                  b.speed < 3.0,
              );
              if (blockingIdleBall) {
                unblockedShooterThisStep = true;
                const unblockEvt = physics.triggerBallLaunch(0.94);
                if (unblockEvt) {
                  processPhysicsEvent(unblockEvt);
                }
              }
            }
            item.delay = 0.18;
            remaining.push(item);
          }
        }
      }
      pendingAutoLaunches = remaining;
    }
  }

  // -------------------------------------------------------------------------
  // 6. HUD Controller Wiring
  // -------------------------------------------------------------------------
  const hud = new HudController(hudRoot, {
    onStartGame: () => {
      triggerStartGame();
    },
    onCycleCamera: () => {
      sound.unlock();
      const nextMode = cameraController.cycleMode();
      applySettingsPatch({ cameraMode: nextMode });
    },
    onToggleMute: () => {
      sound.unlock();
      applySettingsPatch({ muted: !settings.muted });
    },
    onTogglePause: () => {
      if (hud.isHighScoreModalOpen() || sceneManager.isContextLost()) return;
      sound.unlock();
      setPaused(!paused);
    },
    onSettingsChange: (patch) => {
      sound.unlock();
      applySettingsPatch(patch);
    },
    onFlipperInput: (side, pressed) => {
      sound.unlock();
      if (side === 'left') {
        touchLeftFlipper = pressed;
      } else {
        touchRightFlipper = pressed;
      }
    },
    onPlungerChange: (pressed, manualTension) => {
      sound.unlock();
      uiPlungerHeld = pressed;
      uiPlungerDragTension = pressed && manualTension !== undefined ? clamp01(manualTension) : null;
    },
    onNudge: (dir) => {
      triggerNudge(dir);
    },
    onSubmitHighScore: (initials) => {
      sound.unlock();
      const updatedScores = gameState.submitHighScore(initials);
      dmd.setHighScores([...updatedScores]);
      drainGameCommands();
    },
    onResetHighScores: () => {
      sound.unlock();
      const resetScores = gameState.resetLeaderboard();
      dmd.setHighScores([...resetScores]);
    },
  });
  hudRef = hud;
  if (sceneManager.isContextLost()) {
    hud.setContextLostBlocked(true);
  }

  // -------------------------------------------------------------------------
  // 7. Keyboard, Pointer Unlock, Focus & Resize Event Listeners
  // -------------------------------------------------------------------------
  const handleFirstGestureUnlock = (): void => {
    sound.unlock();
  };

  const isInteractiveHudFocus = (): boolean => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !hudRoot.contains(active)) {
      return false;
    }
    const tag = active.tagName;
    return (
      tag === 'BUTTON' ||
      tag === 'INPUT' ||
      tag === 'SELECT' ||
      tag === 'TEXTAREA' ||
      tag === 'A'
    );
  };

  const handleKeyDown = (e: KeyboardEvent): void => {
    if (disposed) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    sound.unlock();

    // Never intercept keys while the 3-letter High Score Entry modal is open
    if (hud.isHighScoreModalOpen()) {
      return;
    }

    const code = e.code;

    // Global utility shortcuts
    if (!e.repeat) {
      if (code === 'Escape' || code === 'KeyP') {
        e.preventDefault();
        if (sceneManager.isContextLost()) {
          return;
        }
        setPaused(!paused);
        return;
      }
      if (code === 'KeyM') {
        e.preventDefault();
        applySettingsPatch({ muted: !settings.muted });
        return;
      }
      if (code === 'KeyC') {
        e.preventDefault();
        const nextMode = cameraController.cycleMode();
        applySettingsPatch({ cameraMode: nextMode });
        return;
      }
    }

    // Ignore gameplay keys while paused
    if (paused) {
      return;
    }

    // Let keyboard-focused HUD buttons/inputs handle Space/Enter natively without
    // simultaneously starting a game or triggering the plunger (NIT #11).
    if (START_CODES.has(code) && isInteractiveHudFocus()) {
      return;
    }

    if (SCROLL_PREVENT_CODES.has(code)) {
      e.preventDefault();
    }

    const phase = gameState.getSnapshot().phase;

    // Start game on Space / Enter in ATTRACT or GAME_OVER (without immediately arming plunger)
    if (START_CODES.has(code) && (phase === 'ATTRACT' || phase === 'GAME_OVER')) {
      if (!e.repeat) {
        ignorePlungerUntilKeyUp.add(code);
        triggerStartGame();
      }
      return;
    }

    // Left / Right Flippers
    if (LEFT_FLIPPER_CODES.has(code)) {
      kbLeftKeys.add(code);
      return;
    }
    if (RIGHT_FLIPPER_CODES.has(code)) {
      kbRightKeys.add(code);
      return;
    }

    // Plunger Hold
    if (PLUNGER_CODES.has(code)) {
      if (!ignorePlungerUntilKeyUp.has(code) && (phase === 'LAUNCH_READY' || phase === 'PLAYING')) {
        kbPlungerKeys.add(code);
      }
      return;
    }

    // Table Nudge (single pulse per physical key press)
    if (!e.repeat) {
      if (code === 'KeyQ' || code === 'KeyX') {
        triggerNudge('left');
      } else if (code === 'KeyE' || code === 'Period') {
        triggerNudge('right');
      } else if (code === 'KeyW' || code === 'ArrowUp') {
        triggerNudge('up');
      }
    }
  };

  const handleKeyUp = (e: KeyboardEvent): void => {
    const code = e.code;
    ignorePlungerUntilKeyUp.delete(code);
    kbLeftKeys.delete(code);
    kbRightKeys.delete(code);
    kbPlungerKeys.delete(code);
  };

  const handleWindowBlur = (): void => {
    releaseAllInputs();
  };

  const handleVisibilityChange = (): void => {
    if (document.hidden) {
      releaseAllInputs();
      sound.updateRolling(0, 0);
      const phase = gameState.getSnapshot().phase;
      if (phase === 'PLAYING' || phase === 'LAUNCH_READY' || phase === 'BALL_BONUS') {
        setPaused(true);
      }
      sound.setSuspended(true);
    } else {
      lastFrameTime = performance.now();
      sound.setSuspended(paused || sceneManager.isContextLost());
    }
  };

  const handleResize = (): void => {
    if (disposed) return;
    const width = window.innerWidth || canvas.clientWidth || 1280;
    const height = window.innerHeight || canvas.clientHeight || 720;
    sceneManager.resize(width, height);
  };

  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);
  window.addEventListener('pointerdown', handleFirstGestureUnlock, { passive: true });
  window.addEventListener('pointerup', handleFirstGestureUnlock, { passive: true });
  window.addEventListener('touchend', handleFirstGestureUnlock, { passive: true });
  window.addEventListener('blur', handleWindowBlur);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('resize', handleResize);

  // -------------------------------------------------------------------------
  // 8. Main Animation Loop (Fixed-Step Physics + Smooth Visual Interpolation)
  // -------------------------------------------------------------------------
  let rafId = 0;
  let lastFrameTime = performance.now();
  let envClock = 0;

  // Trigger initial attract wave so playfield illuminates immediately on frame 1
  lampController.triggerShow('ATTRACT_WAVE');

  const tick = (now: number): void => {
    if (disposed) return;
    rafId = window.requestAnimationFrame(tick);

    const rawDt = Math.max(0, (now - lastFrameTime) / 1000);
    lastFrameTime = now;
    const dt = Math.min(rawDt, MAX_FRAME_DT);

    if (!paused) {
      envClock += dt;

      // Read pre-step gameplay/physics flags for responsive flipper edge detection
      const preGameSnap = gameState.getSnapshot();
      const modalOpen = hud.isHighScoreModalOpen();
      const canFlip =
        !modalOpen &&
        !preGameSnap.isTilted &&
        (preGameSnap.phase === 'LAUNCH_READY' || preGameSnap.phase === 'PLAYING');

      const rawLeftHeld = !modalOpen && (kbLeftKeys.size > 0 || touchLeftFlipper);
      const rawRightHeld = !modalOpen && (kbRightKeys.size > 0 || touchRightFlipper);
      const effectiveLeft = canFlip && rawLeftHeld;
      const effectiveRight = canFlip && rawRightHeld;

      if (effectiveLeft !== prevLeftFlipperActive) {
        if (effectiveLeft) {
          sound.playFlipperUp(-0.45);
          gameState.onFlipperPressed('left');
        } else {
          sound.playFlipperDown(-0.45);
        }
        prevLeftFlipperActive = effectiveLeft;
      }

      if (effectiveRight !== prevRightFlipperActive) {
        if (effectiveRight) {
          sound.playFlipperUp(0.45);
          gameState.onFlipperPressed('right');
        } else {
          sound.playFlipperDown(0.45);
        }
        prevRightFlipperActive = effectiveRight;
      }

      const canPlunge =
        !modalOpen &&
        (preGameSnap.phase === 'LAUNCH_READY' || preGameSnap.phase === 'PLAYING');

      frameInput.leftFlipper = effectiveLeft;
      frameInput.rightFlipper = effectiveRight;
      frameInput.plungerHeld = canPlunge && (kbPlungerKeys.size > 0 || uiPlungerHeld);
      frameInput.plungerDragTension = canPlunge ? uiPlungerDragTension : null;

      // 1. Step 480 Hz Rapier3D physics & dispatch emitted events
      const physicsEvents = physics.step(dt, frameInput);
      for (let i = 0; i < physicsEvents.length; i++) {
        processPhysicsEvent(physicsEvents[i]);
      }

      // 2. Step Tilt plumb-bob pendulum ODE
      const tiltUpdate = tiltSystem.update(dt);
      if (tiltUpdate.tilted && !gameState.getSnapshot().isTilted) {
        physics.setTilted(true);
        gameState.onTilt();
      } else if (tiltUpdate.dangerTriggered) {
        gameState.onTiltWarning(tiltUpdate.warnings);
      }

      // 3. Step Gameplay ruleset timers & bonus tally
      gameState.update(dt);

      // 4. Execute all queued GameCommands & scheduled auto-launches / saucer releases
      drainGameCommands();
      stepScheduledPhysicsActions(dt);
      drainGameCommands();

      // 5. Defensive empty-playfield reconciliation (MAJOR #3)
      const postGameSnap = gameState.getSnapshot();
      const postPhysSnap = physics.getSnapshot();
      if (postGameSnap.phase !== 'PLAYING' && postGameSnap.phase !== 'LAUNCH_READY') {
        pendingAutoLaunches = [];
        emptyPlayfieldTimer = 0;
      } else if (
        postGameSnap.phase === 'PLAYING' &&
        postPhysSnap.balls.length === 0 &&
        pendingAutoLaunches.length === 0
      ) {
        emptyPlayfieldTimer += dt;
        if (emptyPlayfieldTimer > 0.5) {
          emptyPlayfieldTimer = 0;
          gameState.reconcileActiveBallCount(0);
          drainGameCommands();
        }
      } else {
        emptyPlayfieldTimer = 0;
      }
    }

    // -----------------------------------------------------------------------
    // 9. Sync 3D Visuals, Lighting, DMD, Camera, Audio Rolling Bed & HUD
    // -----------------------------------------------------------------------
    const gameSnap: GameSnapshot = gameState.getSnapshot();
    const physSnap = physics.getSnapshot();

    // Balls, flippers, drop targets, spinner, plunger & one-way gate visuals
    playfieldVisuals.syncBalls(physSnap.balls);
    playfieldVisuals.setFlipperAngle('left', physSnap.flipperAngles.left);
    playfieldVisuals.setFlipperAngle('right', physSnap.flipperAngles.right);
    playfieldVisuals.setFlipperAngle('upperRight', physSnap.flipperAngles.upperRight);
    playfieldVisuals.setDropTargetDropped(0, physSnap.dropTargetsDropped[0]);
    playfieldVisuals.setDropTargetDropped(1, physSnap.dropTargetsDropped[1]);
    playfieldVisuals.setDropTargetDropped(2, physSnap.dropTargetsDropped[2]);
    playfieldVisuals.setSpinnerAngle(physSnap.spinnerAngle);

    if (physSnap.gateOpenAngle > 0.12 && prevGateOpenAngle <= 0.12) {
      playfieldVisuals.triggerGateSwing();
    }
    prevGateOpenAngle = physSnap.gateOpenAngle;

    cabinet.setPlungerCompression(physSnap.plungerOffset / PLUNGER.maxPullDistance);

    // Tactile plunger ratchet sound & continuous wooden/wireform rolling audio bed
    if (!paused) {
      if (physSnap.plungerTension > 0.01) {
        sound.playPlungerPull(physSnap.plungerTension);
      }
      sound.updateRolling(physSnap.playfieldRollingSpeed, physSnap.wireformRollingSpeed);
    }

    // Advance playfield animations, particles, arcade glow, lamps & Hypercore reactor
    const visualDt = paused ? 0 : dt;
    playfieldVisuals.update(visualDt);
    particles.update(visualDt);
    arcadeEnv.update(envClock);

    const lampStates = lampController.update(dt, gameSnap);
    playfieldVisuals.applyLamps(lampStates);
    sceneManager.applyFlashers(lampStates);

    const hyperFlash = lampStates.get('flasher_hypercore')?.intensity ?? 0;
    hypercoreToy.update(visualDt, {
      lockCount: gameSnap.lockedBalls,
      isMultiball: gameSnap.multiballActive,
      isCapturing: physSnap.saucerOccupied,
      isTilted: gameSnap.isTilted,
      flashIntensity: hyperFlash,
    });

    // Smooth GI blackout dimming on TILT
    const targetGi = gameSnap.isTilted ? 0.22 : 1.0;
    giDimFactor += (targetGi - giDimFactor) * (1 - Math.exp(-8 * dt));
    cabinet.setGiDimFactor(giDimFactor);
    sceneManager.setGiDimFactor(giDimFactor);

    // Update 128x32 amber DMD (backbox CanvasTexture + optional HUD mirror)
    dmd.update(
      visualDt,
      gameSnap,
      hud.isHighScoreModalOpen() ? hud.getHighScoreInitialsState() : undefined,
    );
    hud.syncDmd(dmd.getCanvas());

    // Update camera (smooth mode transitions, attract orbit, dynamic ball track, nudge shake)
    const aspect = (window.innerWidth || 1280) / Math.max(1, window.innerHeight || 720);
    cameraController.update(dt, {
      phase: gameSnap.phase,
      balls: physSnap.balls,
      aspect,
    });

    // Render 3D scene through selective-bloom EffectComposer
    sceneManager.render();

    // Update diffed HUD overlay (includes hasBallInShooter so plunger widget stays
    // visible/interactive after weak pulls or whenever a ball rests in the shooter lane)
    hud.update(
      gameSnap,
      settings,
      physSnap.plungerTension,
      gameState.getHighScores(),
      paused,
      physSnap.hasBallInShooter,
    );
  };

  rafId = window.requestAnimationFrame(tick);

  // -------------------------------------------------------------------------
  // 10. Clean Teardown
  // -------------------------------------------------------------------------
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;

    window.cancelAnimationFrame(rafId);
    window.removeEventListener('beforeunload', dispose);
    window.removeEventListener('keydown', handleKeyDown);
    window.removeEventListener('keyup', handleKeyUp);
    window.removeEventListener('pointerdown', handleFirstGestureUnlock);
    window.removeEventListener('pointerup', handleFirstGestureUnlock);
    window.removeEventListener('touchend', handleFirstGestureUnlock);
    window.removeEventListener('blur', handleWindowBlur);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('resize', handleResize);

    hideContextLostBanner();
    hud.dispose();
    sound.dispose();
    physics.dispose();
    particles.dispose();
    hypercoreToy.dispose();
    playfieldVisuals.dispose();
    cabinet.dispose();
    dmd.dispose();
    playfieldTextures.dispose();
    transliteTexture.dispose();
    arcadeEnv.dispose();
    sceneManager.dispose();
  };

  window.addEventListener('beforeunload', dispose, { once: true });
  return dispose;
}

const bootstrapSignal: BootstrapSignal = { aborted: false };
let disposeApp: (() => void) | null = null;

bootstrap(bootstrapSignal)
  .then((cleanup) => {
    if (bootstrapSignal.aborted) {
      cleanup();
      return;
    }
    disposeApp = cleanup;
  })
  .catch((err: unknown) => {
    if (bootstrapSignal.aborted) return;
    console.error('[HYPERNOVA] Failed to initialize 3D pinball engine:', err);
    const hudRoot = document.getElementById('hud-root');
    if (hudRoot) {
      const msg = err instanceof Error ? err.message : String(err);
      hudRoot.innerHTML = '';
      const box = document.createElement('div');
      box.style.cssText =
        'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#050712;color:#e6f2ff;font-family:monospace;padding:24px;pointer-events:auto;';
      const card = document.createElement('div');
      card.style.cssText =
        'max-width:480px;padding:20px 24px;border:1px solid #ff2bd6;border-radius:10px;background:#0c1126;';
      const heading = document.createElement('h2');
      heading.style.cssText = 'margin:0 0 8px;color:#00f0ff;letter-spacing:0.12em;';
      heading.textContent = 'HYPERNOVA // INITIALIZATION ERROR';
      const detail = document.createElement('p');
      detail.style.cssText = 'margin:0;color:#b8c8e6;font-size:13px;line-height:1.5;';
      detail.textContent = msg;
      card.append(heading, detail);
      box.appendChild(card);
      hudRoot.appendChild(box);
    }
  });

// Clean Vite HMR teardown if reloaded during local development (guards async bootstrap race)
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    bootstrapSignal.aborted = true;
    disposeApp?.();
    disposeApp = null;
  });
}
