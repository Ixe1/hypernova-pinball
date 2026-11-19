/**
 * HYPERNOVA — Playfield LED Insert, Mechanism Lamp & Flasher Controller
 *
 * Pure TypeScript lamp matrix controller driving all 47 `LampId`s from
 * `TABLE_LAYOUT` (`LED_INSERTS`, `POP_BUMPERS`, `SLINGSHOTS`, `FLASHER_LAMPS`).
 *
 * Combines three composable layers:
 *   1. Reactive gameplay state derived from `GameSnapshot`
 *   2. Timed scripted spatial lightshows (`ATTRACT_WAVE`, `SKILL_SHOT_PULSE`,
 *      `RAMP_CHASE`, `LOCK_CHARGE`, `MULTIBALL_STROBE`, `JACKPOT_BURST`,
 *      `TILT_BLACKOUT`)
 *   3. Crisp per-lamp impact flashes (`flashLamp(id, duration)`)
 */

import { ACTIVE_CENTER_X, PALETTE } from '../config/constants';
import {
  FLASHER_LAMPS,
  HYPERCORE_SAUCER,
  LED_INSERTS,
  POP_BUMPERS,
  SLINGSHOTS,
} from '../config/tableLayout';
import type { GameSnapshot, LampId, LampMode, LampState } from '../config/types';

export type LampShowName =
  | 'ATTRACT_WAVE'
  | 'SKILL_SHOT_PULSE'
  | 'RAMP_CHASE'
  | 'LOCK_CHARGE'
  | 'MULTIBALL_STROBE'
  | 'JACKPOT_BURST'
  | 'TILT_BLACKOUT';

interface LampMeta {
  readonly id: LampId;
  readonly x: number;
  readonly z: number;
  readonly baseColor: number;
  readonly isFlasher: boolean;
  readonly isMechanism: boolean;
}

interface FlashOverlay {
  remaining: number;
  duration: number;
  peakIntensity: number;
  colorOverride?: number;
}

interface ActiveShow {
  readonly name: LampShowName;
  elapsed: number;
  duration: number;
}

interface LampTarget {
  intensity: number;
  color: number;
  mode: LampMode;
}

const DEFAULT_SHOW_DURATIONS: Record<LampShowName, number> = {
  ATTRACT_WAVE: 8.0,
  SKILL_SHOT_PULSE: 1.5,
  RAMP_CHASE: 1.5,
  LOCK_CHARGE: 1.6,
  MULTIBALL_STROBE: 3.0,
  JACKPOT_BURST: 2.2,
  TILT_BLACKOUT: 999.0,
};

const RAMP_CHASE_IDS: readonly LampId[] = [
  'ramp_chase_1',
  'ramp_chase_2',
  'ramp_chase_3',
  'ramp_chase_4',
];

const ION_LANE_IDS: readonly LampId[] = ['lane_i', 'lane_o', 'lane_n'];
const DROP_LAMP_IDS: readonly LampId[] = ['drop_r', 'drop_a', 'drop_y'];
const STANDUP_LAMP_IDS: readonly LampId[] = ['standup_1', 'standup_2', 'standup_3'];
const LOCK_LAMP_IDS: readonly LampId[] = ['lock_1', 'lock_2', 'lock_3'];
const BONUS_LAMP_IDS: readonly LampId[] = [
  'bonus_2x',
  'bonus_3x',
  'bonus_4x',
  'bonus_5x',
  'bonus_6x',
];
const FLASHER_IDS: readonly LampId[] = [
  'flasher_left',
  'flasher_right',
  'flasher_hypercore',
  'flasher_ramp',
];

function buildLampCatalog(): readonly LampMeta[] {
  const map = new Map<LampId, LampMeta>();

  for (const ins of LED_INSERTS) {
    map.set(ins.lampId, {
      id: ins.lampId,
      x: ins.position.x,
      z: ins.position.z,
      baseColor: ins.color,
      isFlasher: false,
      isMechanism: false,
    });
  }

  for (const bumper of POP_BUMPERS) {
    map.set(bumper.lampId, {
      id: bumper.lampId,
      x: bumper.position.x,
      z: bumper.position.z,
      baseColor: bumper.color,
      isFlasher: false,
      isMechanism: true,
    });
  }

  for (const sling of SLINGSHOTS) {
    const cx = (sling.vertices[0].x + sling.vertices[1].x + sling.vertices[2].x) / 3;
    const cz = (sling.vertices[0].z + sling.vertices[1].z + sling.vertices[2].z) / 3;
    map.set(sling.lampId, {
      id: sling.lampId,
      x: cx,
      z: cz,
      baseColor: sling.color,
      isFlasher: false,
      isMechanism: true,
    });
  }

  for (const flasher of FLASHER_LAMPS) {
    map.set(flasher.lampId, {
      id: flasher.lampId,
      x: flasher.position.x,
      z: flasher.position.z,
      baseColor: flasher.color,
      isFlasher: true,
      isMechanism: false,
    });
  }

  return Array.from(map.values());
}

const LAMP_CATALOG: readonly LampMeta[] = buildLampCatalog();

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function sine01(phase: number): number {
  return 0.5 + 0.5 * Math.sin(phase);
}

function squareBlink(time: number, hz: number, duty = 0.5): number {
  const frac = (time * hz) % 1;
  return frac < duty ? 1 : 0.08;
}

export class LampController {
  private readonly metaById = new Map<LampId, LampMeta>();
  private readonly states = new Map<LampId, LampState>();
  private readonly smoothedIntensity = new Map<LampId, number>();
  private readonly flashes = new Map<LampId, FlashOverlay>();
  private readonly targets = new Map<LampId, LampTarget>();

  private clock = 0;
  private activeShow: ActiveShow | null = null;

  constructor() {
    for (const meta of LAMP_CATALOG) {
      this.metaById.set(meta.id, meta);
      this.smoothedIntensity.set(meta.id, 0);
      this.targets.set(meta.id, { intensity: 0, color: meta.baseColor, mode: 'off' });
      this.states.set(meta.id, {
        id: meta.id,
        intensity: 0,
        color: meta.baseColor,
        mode: 'off',
      });
    }
  }

  /** Triggers a scripted lightshow layered on top of reactive gameplay lamps. */
  triggerShow(show: LampShowName, duration?: number): void {
    const resolvedDuration =
      duration !== undefined && Number.isFinite(duration) && duration > 0
        ? duration
        : DEFAULT_SHOW_DURATIONS[show];
    this.activeShow = {
      name: show,
      elapsed: 0,
      duration: resolvedDuration,
    };
  }

  /** Stops any active scripted lightshow immediately. */
  clearShow(): void {
    this.activeShow = null;
  }

  /** Returns the currently playing scripted lightshow, or null if none. */
  getActiveShow(): LampShowName | null {
    return this.activeShow ? this.activeShow.name : null;
  }

  /**
   * Fires a crisp impact flash on a specific lamp (e.g. pop bumper hit,
   * slingshot kick, rollover pass, or flasher dome burst).
   */
  flashLamp(
    id: LampId,
    duration = 0.2,
    peakIntensity?: number,
    colorOverride?: number,
  ): void {
    const meta = this.metaById.get(id);
    if (!meta || this.activeShow?.name === 'TILT_BLACKOUT') {
      return;
    }

    const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0.2;
    const defaultPeak = meta.isFlasher ? 2.4 : meta.isMechanism ? 1.85 : 1.0;
    const peak =
      peakIntensity !== undefined && Number.isFinite(peakIntensity)
        ? clamp(peakIntensity, 0, meta.isFlasher ? 2.5 : 2.0)
        : defaultPeak;

    const existing = this.flashes.get(id);
    this.flashes.set(id, {
      remaining: Math.max(safeDuration, existing?.remaining ?? 0),
      duration: safeDuration,
      peakIntensity: Math.max(peak, existing?.peakIntensity ?? 0),
      colorOverride: colorOverride ?? existing?.colorOverride,
    });

    // Snap immediately upward so mechanical solenoid hits feel crisp
    const cur = this.smoothedIntensity.get(id) ?? 0;
    if (peak > cur) {
      this.smoothedIntensity.set(id, peak);
    }
  }

  /** Resets all lamp intensities, active shows, and impact flashes. */
  reset(): void {
    this.clock = 0;
    this.activeShow = null;
    this.flashes.clear();
    for (const meta of LAMP_CATALOG) {
      this.smoothedIntensity.set(meta.id, 0);
      this.states.set(meta.id, {
        id: meta.id,
        intensity: 0,
        color: meta.baseColor,
        mode: 'off',
      });
    }
  }

  /** Advances lamp animation, active lightshows, flashes, and smoothing by `dt` seconds. */
  update(dt: number, snapshot: GameSnapshot): ReadonlyMap<LampId, LampState> {
    const safeDt = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
    if (!snapshot.paused) {
      this.clock += safeDt;
    }

    // Advance or expire timed scripted lightshow
    if (this.activeShow && !snapshot.paused) {
      this.activeShow.elapsed += safeDt;
      if (this.activeShow.elapsed >= this.activeShow.duration) {
        this.activeShow = null;
      }
    }

    // Clear TILT_BLACKOUT automatically once no longer tilted
    if (this.activeShow?.name === 'TILT_BLACKOUT' && !snapshot.isTilted) {
      this.activeShow = null;
    }

    // Reset per-frame targets to off + base color
    for (const meta of LAMP_CATALOG) {
      const t = this.targets.get(meta.id)!;
      t.intensity = 0;
      t.color = meta.baseColor;
      t.mode = 'off';
    }

    // Layer 1: Reactive gameplay lighting (or attract choreography)
    if (snapshot.isTilted) {
      // Everything stays off during TILT
    } else if (
      snapshot.phase === 'ATTRACT' ||
      snapshot.phase === 'GAME_OVER' ||
      snapshot.phase === 'HIGH_SCORE_ENTRY'
    ) {
      this.applyAttractWave(this.clock);
    } else {
      this.applyGameplayState(snapshot);
    }

    // Layer 2: Scripted lightshow overlay
    if (this.activeShow) {
      this.applyScriptedShow(this.activeShow, snapshot);
    }

    // Layer 3: Impact flashes + exponential smoothing
    const tiltedNow = snapshot.isTilted || this.activeShow?.name === 'TILT_BLACKOUT';

    for (const meta of LAMP_CATALOG) {
      const target = this.targets.get(meta.id)!;
      let desiredIntensity = target.intensity;
      let desiredColor = target.color;
      let desiredMode = target.mode;

      const flash = this.flashes.get(meta.id);
      if (flash) {
        if (!snapshot.paused) {
          flash.remaining -= safeDt;
        }
        if (flash.remaining <= 0) {
          this.flashes.delete(meta.id);
        } else if (!tiltedNow) {
          const ratio = clamp(flash.remaining / flash.duration, 0, 1);
          const flashIntensity = flash.peakIntensity * ratio * ratio;
          if (flashIntensity > desiredIntensity) {
            desiredIntensity = flashIntensity;
            desiredMode = 'flash';
          }
          if (flash.colorOverride !== undefined) {
            desiredColor = flash.colorOverride;
          }
        }
      }

      const prev = this.smoothedIntensity.get(meta.id) ?? 0;
      let next: number;
      if (safeDt === 0) {
        next = desiredIntensity;
      } else {
        const rate = tiltedNow
          ? 24
          : desiredIntensity > prev
            ? meta.isFlasher
              ? 42
              : 28
            : meta.isFlasher
              ? 18
              : 14;
        const alpha = 1 - Math.exp(-rate * safeDt);
        next = prev + (desiredIntensity - prev) * alpha;
        if (Math.abs(next - desiredIntensity) < 0.002) {
          next = desiredIntensity;
        }
      }

      const maxCap = meta.isFlasher ? 2.5 : meta.isMechanism ? 2.0 : 1.25;
      next = clamp(next, 0, maxCap);
      this.smoothedIntensity.set(meta.id, next);

      this.states.set(meta.id, {
        id: meta.id,
        intensity: next,
        color: desiredColor,
        mode: desiredMode,
      });
    }

    return this.states;
  }

  getLampState(id: LampId): LampState {
    const state = this.states.get(id);
    if (state) {
      return state;
    }
    return {
      id,
      intensity: 0,
      color: PALETTE.cyan,
      mode: 'off',
    };
  }

  getAllStates(): ReadonlyMap<LampId, LampState> {
    return this.states;
  }

  // -------------------------------------------------------------------------
  // Layer 1: Reactive Gameplay State
  // -------------------------------------------------------------------------

  private setTarget(
    id: LampId,
    intensity: number,
    mode: LampMode,
    color?: number,
  ): void {
    const t = this.targets.get(id);
    if (!t) {
      return;
    }
    t.intensity = intensity;
    t.mode = mode;
    if (color !== undefined) {
      t.color = color;
    }
  }

  private blendMaxTarget(
    id: LampId,
    intensity: number,
    mode: LampMode,
    color?: number,
  ): void {
    const t = this.targets.get(id);
    if (!t) {
      return;
    }
    if (intensity > t.intensity) {
      t.intensity = intensity;
      t.mode = mode;
      if (color !== undefined) {
        t.color = color;
      }
    }
  }

  private applyGameplayState(s: GameSnapshot): void {
    const t = this.clock;
    const slowBlink = squareBlink(t, 2.2);
    const fastBlink = squareBlink(t, 6.5);
    const gentlePulse = 0.35 + 0.55 * sine01(t * 3.6);

    // 1. Top I-O-N rollover lanes (+ flashing Skill Shot cue)
    for (let i = 0; i < 3; i++) {
      const lampId = ION_LANE_IDS[i];
      if (s.skillShotActive && i === s.skillShotLaneIndex) {
        this.setTarget(lampId, fastBlink > 0.5 ? 1.0 : 0.15, 'blinkFast', PALETTE.gold);
      } else if (s.ionLanes[i]) {
        this.setTarget(lampId, 1.0, 'on');
      } else {
        this.setTarget(lampId, 0.12, 'off');
      }
    }

    // 2. R-A-Y drop target indicators (solid when knocked down, subtle invitation when up)
    const anyDropStanding = s.dropTargets.some((down) => !down);
    for (let i = 0; i < 3; i++) {
      const lampId = DROP_LAMP_IDS[i];
      if (s.dropTargets[i]) {
        this.setTarget(lampId, 1.0, 'on');
      } else {
        this.setTarget(lampId, 0.2 + 0.15 * sine01(t * 3.0 + i * 0.9), 'pulse');
      }
    }

    // 3. Right standup targets (solid when hit/lit)
    for (let i = 0; i < 3; i++) {
      const lampId = STANDUP_LAMP_IDS[i];
      if (s.standupTargets[i]) {
        this.setTarget(lampId, 1.0, 'on');
      } else {
        this.setTarget(lampId, 0.2 + 0.15 * sine01(t * 3.0 + i * 0.9), 'pulse');
      }
    }

    // 4. Playfield Multiplier inserts (2X / 3X / 5X; hurry-up blink under 4s remaining)
    const pfHurry = s.playfieldMultiplier > 1 && s.playfieldMultiplierTimer <= 4.0;
    const pfIntensity = pfHurry ? fastBlink : 1.0;
    const pfMode: LampMode = pfHurry ? 'blinkFast' : 'on';
    if (s.playfieldMultiplier >= 2) {
      this.setTarget('pf_2x', pfIntensity, pfMode);
    }
    if (s.playfieldMultiplier >= 3) {
      this.setTarget('pf_3x', pfIntensity, pfMode);
    }
    if (s.playfieldMultiplier >= 5) {
      this.setTarget('pf_5x', pfIntensity, pfMode);
    }

    // 5. End-of-ball Bonus Multiplier arc (2X..6X)
    for (let i = 0; i < BONUS_LAMP_IDS.length; i++) {
      const tier = i + 2; // 2..6
      const lampId = BONUS_LAMP_IDS[i];
      if (s.bonusMultiplier >= tier) {
        if (s.phase === 'BALL_BONUS') {
          this.setTarget(lampId, 0.45 + 0.55 * sine01(t * 9.0 - i * 0.5), 'pulse');
        } else {
          this.setTarget(lampId, 0.95, 'on');
        }
      }
    }

    // 6. Hypercore Lock progress (lock_1..3) & Jackpots
    for (let i = 0; i < 3; i++) {
      const lockTier = i + 1;
      const lampId = LOCK_LAMP_IDS[i];
      if (s.multiballActive) {
        const wave = 0.5 + 0.5 * sine01(t * 10.0 - i * 1.1);
        this.setTarget(lampId, wave, 'pulse');
      } else if (s.lockedBalls >= lockTier) {
        this.setTarget(lampId, 1.0, 'on');
      } else if (s.lockLit && s.lockedBalls + 1 === lockTier) {
        this.setTarget(lampId, slowBlink, 'blinkSlow');
      }
    }

    if (s.jackpotLit) {
      this.setTarget('jackpot', fastBlink, 'blinkFast', PALETTE.gold);
    }
    if (s.superJackpotLit) {
      this.setTarget('super_jackpot', fastBlink, 'blinkFast', PALETTE.magenta);
    }

    // 7. Major shot directional arrows
    const comboHot = s.rampComboCount > 0 && s.rampComboTimer > 0;
    const jackpotAny = s.jackpotLit || s.superJackpotLit;

    this.setTarget(
      'arrow_hypercore',
      jackpotAny
        ? fastBlink
        : s.lockLit
          ? slowBlink
          : 0.25 + 0.2 * sine01(t * 2.5),
      jackpotAny ? 'blinkFast' : s.lockLit ? 'blinkSlow' : 'pulse',
      s.superJackpotLit ? PALETTE.magenta : jackpotAny ? PALETTE.gold : PALETTE.violet,
    );

    this.setTarget(
      'arrow_warp_ramp',
      jackpotAny || comboHot ? fastBlink : gentlePulse,
      jackpotAny || comboHot ? 'blinkFast' : 'pulse',
      s.superJackpotLit ? PALETTE.magenta : jackpotAny ? PALETTE.gold : PALETTE.magenta,
    );

    this.setTarget(
      'arrow_upper_ramp',
      jackpotAny || comboHot ? fastBlink : 0.3 + 0.3 * sine01(t * 3.2 + 0.6),
      jackpotAny || comboHot ? 'blinkFast' : 'pulse',
    );

    this.setTarget(
      'arrow_upper_drop',
      anyDropStanding ? 0.35 + 0.45 * sine01(t * 3.0) : 0.15,
      anyDropStanding ? 'pulse' : 'off',
    );

    this.setTarget(
      'arrow_left_orbit',
      comboHot ? fastBlink : 0.3 + 0.35 * sine01(t * 3.4),
      comboHot ? 'blinkFast' : 'pulse',
    );

    this.setTarget(
      'arrow_right_orbit',
      0.28 + 0.32 * sine01(t * 3.4 + Math.PI),
      'pulse',
    );

    // 8. Warp Ramp sequential chevron chase (accelerates on combos & multiball)
    const chaseSpeed = s.multiballActive ? 10.0 : comboHot ? 7.5 : 3.8;
    const chaseHead = (t * chaseSpeed) % RAMP_CHASE_IDS.length;
    for (let i = 0; i < RAMP_CHASE_IDS.length; i++) {
      let dist = Math.abs(chaseHead - i);
      dist = Math.min(dist, RAMP_CHASE_IDS.length - dist);
      const glow = clamp(1 - dist * 0.72, 0.12, 1.0);
      this.setTarget(
        RAMP_CHASE_IDS[i],
        glow,
        'pulse',
        s.superJackpotLit ? PALETTE.gold : undefined,
      );
    }

    // 9. Lower playfield utility inserts: Kickback, Inlanes, Extra Ball, Hyper Save
    if (s.kickbackLit) {
      this.setTarget('shield_kickback', 1.0, 'on', PALETTE.emerald);
    }

    this.setTarget('inlane_left', 0.28, 'on');
    this.setTarget('inlane_right', 0.28, 'on');
    this.setTarget('outlane_right', 0.18, 'on');

    if (s.extraBallLit || s.extraBalls > 0) {
      this.setTarget('extra_ball', 0.4 + 0.6 * sine01(t * 5.2), 'pulse', PALETTE.amber);
    }

    if (s.ballSaveActive) {
      const saveHurry = s.ballSaveTimer <= 3.5;
      this.setTarget(
        'hyper_save',
        saveHurry ? fastBlink : 0.85 + 0.15 * sine01(t * 4.0),
        saveHurry ? 'blinkFast' : 'on',
        PALETTE.crimson,
      );
    }

    // 10. Pop bumpers & slingshots ambient illumination
    const mechBase = s.multiballActive ? 0.6 + 0.35 * sine01(t * 8.0) : 0.42;
    const mechMode: LampMode = s.multiballActive ? 'pulse' : 'on';
    this.setTarget('bumper_1', mechBase, mechMode);
    this.setTarget('bumper_2', mechBase, mechMode);
    this.setTarget('bumper_3', mechBase, mechMode);
    this.setTarget('sling_left', mechBase * 0.85, mechMode);
    this.setTarget('sling_right', mechBase * 0.85, mechMode);

    // Subtle multiball ambient flasher shimmer
    if (s.multiballActive) {
      const strobeIdx = Math.floor(t * 6.0) % FLASHER_IDS.length;
      this.setTarget(FLASHER_IDS[strobeIdx], 0.9, 'pulse');
    }
  }

  // -------------------------------------------------------------------------
  // Layer 2: Scripted Spatial Lightshows
  // -------------------------------------------------------------------------

  private applyAttractWave(time: number): void {
    for (const meta of LAMP_CATALOG) {
      if (meta.isFlasher) {
        // Periodic subtle marquee flasher glints during attract
        const idx = FLASHER_IDS.indexOf(meta.id);
        const glint = Math.pow(sine01(time * 1.4 + idx * 1.57), 10);
        this.setTarget(meta.id, glint * 0.95, glint > 0.25 ? 'pulse' : 'off');
        continue;
      }

      // Sweeping diagonal cosmic wave across real playfield coordinates
      const waveA = sine01(meta.x * 0.42 + meta.z * 0.34 - time * 3.6);
      const waveB = sine01(
        Math.hypot(meta.x - ACTIVE_CENTER_X, meta.z - HYPERCORE_SAUCER.position.z) * 0.55 -
          time * 2.8,
      );
      const combined = clamp(waveA * 0.65 + waveB * 0.45, 0.06, 1.0);
      this.setTarget(meta.id, combined, 'pulse');
    }

    // Crisp running chevron chase along the Warp Ramp during attract
    const head = (time * 5.0) % RAMP_CHASE_IDS.length;
    for (let i = 0; i < RAMP_CHASE_IDS.length; i++) {
      let dist = Math.abs(head - i);
      dist = Math.min(dist, RAMP_CHASE_IDS.length - dist);
      this.setTarget(RAMP_CHASE_IDS[i], clamp(1 - dist * 0.7, 0.1, 1.0), 'pulse');
    }
  }

  private applyScriptedShow(show: ActiveShow, snapshot: GameSnapshot): void {
    const t = show.elapsed;
    const progress = clamp(t / Math.max(show.duration, 0.001), 0, 1);

    switch (show.name) {
      case 'TILT_BLACKOUT': {
        for (const meta of LAMP_CATALOG) {
          this.setTarget(meta.id, 0, 'off');
        }
        break;
      }

      case 'ATTRACT_WAVE': {
        this.applyAttractWave(this.clock);
        break;
      }

      case 'SKILL_SHOT_PULSE': {
        // Radiant burst cascading downward from top I-O-N lanes
        const waveZ = -9.0 + progress * 19.0;
        for (const meta of LAMP_CATALOG) {
          if (meta.isFlasher) {
            const burst = sine01(t * 16.0) * (1 - progress * 0.5);
            this.blendMaxTarget(meta.id, burst * 1.9, 'flash', PALETTE.gold);
            continue;
          }
          const dist = Math.abs(meta.z - waveZ);
          if (dist < 2.6) {
            const v = clamp(1 - dist / 2.6, 0, 1);
            this.blendMaxTarget(meta.id, v, 'flash', PALETTE.gold);
          }
        }
        // Keep the active skill shot lane pulsing brightly
        const laneId = ION_LANE_IDS[snapshot.skillShotLaneIndex];
        if (laneId) {
          this.blendMaxTarget(laneId, 1.0, 'flash', PALETTE.gold);
        }
        break;
      }

      case 'RAMP_CHASE': {
        // High-speed upward chase along Warp Ramp chevrons & ramp flasher
        const speed = 14.0;
        const head = (t * speed) % RAMP_CHASE_IDS.length;
        for (let i = 0; i < RAMP_CHASE_IDS.length; i++) {
          let dist = Math.abs(head - i);
          dist = Math.min(dist, RAMP_CHASE_IDS.length - dist);
          const v = clamp(1.15 - dist * 0.6, 0.25, 1.15);
          this.blendMaxTarget(RAMP_CHASE_IDS[i], v, 'flash', PALETTE.cyan);
        }
        this.blendMaxTarget('arrow_warp_ramp', 1.1, 'flash', PALETTE.gold);
        this.blendMaxTarget('arrow_upper_ramp', 1.0, 'flash', PALETTE.gold);
        this.blendMaxTarget(
          'flasher_ramp',
          2.2 * (1 - progress * 0.6) * squareBlink(t, 8.0),
          'flash',
          PALETTE.gold,
        );
        break;
      }

      case 'LOCK_CHARGE': {
        // Concentric energy wave pulling into & surging out of Hypercore Saucer
        const cx = HYPERCORE_SAUCER.position.x;
        const cz = HYPERCORE_SAUCER.position.z;
        const ringRadius = progress < 0.5 ? (1 - progress * 2) * 11 : (progress - 0.5) * 2 * 12;
        for (const meta of LAMP_CATALOG) {
          if (meta.isFlasher) {
            const p = meta.id === 'flasher_hypercore' ? 2.4 : 1.4;
            this.blendMaxTarget(
              meta.id,
              p * sine01(t * 14.0),
              'flash',
              PALETTE.violet,
            );
            continue;
          }
          const r = Math.hypot(meta.x - cx, meta.z - cz);
          const band = clamp(1 - Math.abs(r - ringRadius) / 2.2, 0, 1);
          if (band > 0.05) {
            this.blendMaxTarget(meta.id, band, 'flash', PALETTE.violet);
          }
        }
        for (let i = 0; i < LOCK_LAMP_IDS.length; i++) {
          if (i < snapshot.lockedBalls) {
            this.blendMaxTarget(LOCK_LAMP_IDS[i], 1.15, 'flash');
          }
        }
        break;
      }

      case 'MULTIBALL_STROBE': {
        // Dramatic left/right alternating cyan/magenta strobe across entire playfield
        const phase = Math.floor(t * 10.0) % 2;
        for (const meta of LAMP_CATALOG) {
          const onLeft = meta.x < ACTIVE_CENTER_X;
          const active = (phase === 0 && onLeft) || (phase === 1 && !onLeft);
          const color = phase === 0 ? PALETTE.cyan : PALETTE.magenta;
          if (meta.isFlasher) {
            this.blendMaxTarget(meta.id, active ? 2.4 : 0.3, 'flash', color);
          } else {
            this.blendMaxTarget(meta.id, active ? 1.05 : 0.18, 'flash', color);
          }
        }
        break;
      }

      case 'JACKPOT_BURST': {
        // Golden/magenta radial shockwave exploding outward from playfield center
        const cx = ACTIVE_CENTER_X;
        const cz = -1.5;
        const shockR = (t * 14.0) % 13.5;
        const flashColor = Math.floor(t * 8.0) % 2 === 0 ? PALETTE.gold : PALETTE.magenta;
        for (const meta of LAMP_CATALOG) {
          if (meta.isFlasher) {
            const idx = FLASHER_IDS.indexOf(meta.id);
            const on = Math.floor(t * 12.0 + idx) % 2 === 0;
            this.blendMaxTarget(meta.id, on ? 2.5 : 0.25, 'flash', flashColor);
            continue;
          }
          const r = Math.hypot(meta.x - cx, meta.z - cz);
          const band = clamp(1 - Math.abs(r - shockR) / 2.8, 0, 1);
          if (band > 0.05) {
            this.blendMaxTarget(meta.id, band * 1.15, 'flash', flashColor);
          }
        }
        this.blendMaxTarget('jackpot', 1.2, 'flash', PALETTE.gold);
        this.blendMaxTarget('super_jackpot', 1.2, 'flash', PALETTE.magenta);
        break;
      }
    }
  }
}
