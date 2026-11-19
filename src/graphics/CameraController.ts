/**
 * HYPERNOVA — Multi-Mode Pinball Camera Controller & Physical Nudge Shake
 *
 * Drives `THREE.PerspectiveCamera` across 4 curated arcade views:
 *   - 'classic'   : Standing arcade player view framing full playfield + lower backbox/DMD
 *   - 'dynamic'   : Subtle clamped ball-follow (pulls back smoothly near flippers — zero nausea)
 *   - 'lowAction' : Dramatic low showcase highlighting Warp Ramp, Hypercore Orb & towering backbox
 *   - 'overhead'  : Clean near-top-down competitive shot-aiming perspective
 *
 * Features smooth exponential critically-damped transitions, slow Attract Mode breathing orbit,
 * aspect-ratio safe framing, and a snappy damped physical nudge-shake oscillator.
 */

import * as THREE from 'three';
import {
  PLAYFIELD_LENGTH,
  PLAYFIELD_WIDTH,
  TABLE_PITCH_RAD,
} from '../config/constants';
import type { BallState, CameraMode, GamePhase } from '../config/types';
import { CABINET_PLAYFIELD_CENTER_Y } from './CabinetBuilder';

export const CAMERA_MODE_ORDER: readonly CameraMode[] = [
  'classic',
  'dynamic',
  'lowAction',
  'overhead',
] as const;

export interface CameraPreset {
  readonly position: THREE.Vector3;
  readonly target: THREE.Vector3;
  readonly fov: number;
}

export interface CameraUpdateState {
  readonly phase: GamePhase;
  readonly balls?: readonly BallState[];
  readonly aspect?: number;
}

/** Curated world-space presets framed around the cabinet (floor = Y=0, playfield center = Y=17.5). */
const CAMERA_PRESETS: Record<CameraMode, CameraPreset> = {
  // Standing player view: full playfield + flippers + speaker panel/DMD + glowing lower translite
  classic: {
    position: new THREE.Vector3(0, 35.4, 24.0),
    target: new THREE.Vector3(0, 18.6, 0.15),
    fov: 45,
  },
  // Intimate active play view with subtle clamped ball tracking in upper/midfield
  dynamic: {
    position: new THREE.Vector3(0, 33.8, 22.4),
    target: new THREE.Vector3(0, 18.3, 0.5),
    fov: 44,
  },
  // Dramatic low-angle showcase showing Warp Ramp elevation, Hypercore Orb, and full towering backbox
  lowAction: {
    position: new THREE.Vector3(0, 27.8, 25.8),
    target: new THREE.Vector3(0, 21.8, -2.5),
    fov: 50.5,
  },
  // Near-top-down competitive shot-aiming angle with crisp lane & flipper clarity
  overhead: {
    position: new THREE.Vector3(0, 45.6, 12.2),
    target: new THREE.Vector3(-0.15, 17.6, 0.2),
    fov: 43,
  },
};

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** Converts a playfield-local (x, y, z) point into cabinet world space. */
function playfieldLocalToWorld(
  lx: number,
  ly: number,
  lz: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const c = Math.cos(TABLE_PITCH_RAD);
  const s = Math.sin(TABLE_PITCH_RAD);
  out.set(
    lx,
    CABINET_PLAYFIELD_CENTER_Y + ly * c - lz * s,
    ly * s + lz * c,
  );
  return out;
}

export class CameraController {
  private readonly camera: THREE.PerspectiveCamera;
  private mode: CameraMode;
  private cabinetRoot: THREE.Object3D | null = null;
  private readonly cabinetBasePos = new THREE.Vector3();

  // Smoothly damped current camera state
  private readonly currentPos = new THREE.Vector3();
  private readonly currentTarget = new THREE.Vector3();
  private currentFov: number;

  // Dynamic ball-follow smoothed offsets
  private readonly ballOffsetPos = new THREE.Vector3();
  private readonly ballOffsetTarget = new THREE.Vector3();

  // Attract-mode slow breathing timer & blend weight (0..1)
  private attractTime = 0;
  private attractBlend = 0;

  // Underdamped physical spring-damper oscillator for table nudge shake (X & Z)
  private shakeX = 0;
  private shakeZ = 0;
  private shakeVelX = 0;
  private shakeVelZ = 0;

  // Scratch vectors (zero per-frame allocations)
  private readonly desiredPos = new THREE.Vector3();
  private readonly desiredTarget = new THREE.Vector3();
  private readonly finalPos = new THREE.Vector3();
  private readonly finalTarget = new THREE.Vector3();
  private readonly scratchBallWorld = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera, initialMode: CameraMode = 'classic') {
    this.camera = camera;
    this.mode = initialMode;

    const preset = CAMERA_PRESETS[initialMode];
    this.currentPos.copy(preset.position);
    this.currentTarget.copy(preset.target);
    this.currentFov = preset.fov;

    this.applyCameraTransform(this.currentPos, this.currentTarget, this.currentFov);
  }

  /** Attaches the cabinet root group so physical nudge shakes visibly jolt the arcade machine. */
  setCabinetRoot(root: THREE.Object3D | null): void {
    if (this.cabinetRoot) {
      this.cabinetRoot.position.copy(this.cabinetBasePos);
    }
    this.cabinetRoot = root;
    if (root) {
      this.cabinetBasePos.copy(root.position);
    }
  }

  getMode(): CameraMode {
    return this.mode;
  }

  setMode(mode: CameraMode, instant = false): void {
    const resolved: CameraMode = mode in CAMERA_PRESETS ? mode : 'classic';
    this.mode = resolved;

    if (instant) {
      const preset = CAMERA_PRESETS[resolved];
      this.currentPos.copy(preset.position);
      this.currentTarget.copy(preset.target);
      this.currentFov = preset.fov;
      this.ballOffsetPos.set(0, 0, 0);
      this.ballOffsetTarget.set(0, 0, 0);
      this.applyCameraTransform(this.currentPos, this.currentTarget, this.currentFov);
    }
  }

  cycleMode(): CameraMode {
    const idx = CAMERA_MODE_ORDER.indexOf(this.mode);
    const next = CAMERA_MODE_ORDER[(idx + 1) % CAMERA_MODE_ORDER.length];
    this.setMode(next, false);
    return next;
  }

  /**
   * Injects a physical nudge impulse (ix, iz) into the damped cabinet/camera shake oscillator.
   * Typical nudge magnitudes: +/- 0.5 to +/- 2.5.
   */
  addNudgeShake(ix: number, iz: number): void {
    const clampedX = clamp(ix, -3.5, 3.5);
    const clampedZ = clamp(iz, -3.5, 3.5);
    // Snappy initial velocity kick in the nudge direction
    this.shakeVelX = clamp(this.shakeVelX + clampedX * 3.4, -14, 14);
    this.shakeVelZ = clamp(this.shakeVelZ + clampedZ * 3.0, -14, 14);
  }

  reset(): void {
    this.shakeX = 0;
    this.shakeZ = 0;
    this.shakeVelX = 0;
    this.shakeVelZ = 0;
    this.ballOffsetPos.set(0, 0, 0);
    this.ballOffsetTarget.set(0, 0, 0);
    this.attractBlend = 0;
    if (this.cabinetRoot) {
      this.cabinetRoot.position.copy(this.cabinetBasePos);
    }
    this.setMode(this.mode, true);
  }

  update(dt: number, state: CameraUpdateState): void {
    const safeDt = clamp(dt, 0, 0.05);
    const preset = CAMERA_PRESETS[this.mode];

    // 1. Base preset coordinates + responsive narrow-viewport framing boost
    this.desiredPos.copy(preset.position);
    this.desiredTarget.copy(preset.target);
    let desiredFov = preset.fov;

    const aspect = state.aspect ?? this.camera.aspect;
    if (aspect > 0 && aspect < 1.18) {
      // Gently pull camera back along view ray on narrow/portrait displays so cabinet edges stay framed
      const narrowFactor = clamp((1.18 - aspect) / 0.68, 0, 1);
      const pullback = 1.0 + narrowFactor * 0.42;
      this.desiredPos
        .sub(this.desiredTarget)
        .multiplyScalar(pullback)
        .add(this.desiredTarget);
    }

    // 2. Subtle clamped ball-follow in 'dynamic' mode (only during active play)
    const followWeight =
      this.mode === 'dynamic' &&
      (state.phase === 'PLAYING' || state.phase === 'LAUNCH_READY')
        ? 1
        : 0;

    let targetBallPosOffsetX = 0;
    let targetBallPosOffsetY = 0;
    let targetBallPosOffsetZ = 0;
    let targetLookOffsetX = 0;
    let targetLookOffsetY = 0;
    let targetLookOffsetZ = 0;

    if (followWeight > 0 && state.balls && state.balls.length > 0) {
      const focusBall = this.selectFocusBall(state.balls);
      if (focusBall) {
        const normX = clamp(focusBall.position.x / (PLAYFIELD_WIDTH * 0.5), -1, 1);
        const normZ = clamp(focusBall.position.z / (PLAYFIELD_LENGTH * 0.5), -1, 1);

        // Smoothly pull back to stable flipper lock when ball nears the lower flipper zone (z > 2.5)
        const upperPlayWeight = clamp((4.8 - focusBall.position.z) / 8.5, 0, 1);

        // Gentle horizontal tracking & mild zoom-in when ball is high in upper orbits/ramp
        targetLookOffsetX = normX * 1.15 * (0.35 + 0.65 * upperPlayWeight);
        targetLookOffsetZ = clamp(normZ * 2.4 - 0.5, -2.8, 0.6) * upperPlayWeight;
        targetLookOffsetY = upperPlayWeight * 0.45;

        targetBallPosOffsetX = normX * 0.85 * (0.35 + 0.65 * upperPlayWeight);
        targetBallPosOffsetY = -upperPlayWeight * 0.95;
        targetBallPosOffsetZ = -upperPlayWeight * 1.55;

        // Slight elevation follow when ball rides high on the Warp Ramp / Wireform
        if (focusBall.zone === 'ramp' || focusBall.zone === 'wireform') {
          playfieldLocalToWorld(
            focusBall.position.x,
            focusBall.position.y,
            focusBall.position.z,
            this.scratchBallWorld,
          );
          targetLookOffsetY += clamp((this.scratchBallWorld.y - 18.2) * 0.25, 0, 0.65);
        }
      }
    }

    const ballAlpha = 1 - Math.exp(-3.6 * safeDt);
    this.ballOffsetPos.x += (targetBallPosOffsetX - this.ballOffsetPos.x) * ballAlpha;
    this.ballOffsetPos.y += (targetBallPosOffsetY - this.ballOffsetPos.y) * ballAlpha;
    this.ballOffsetPos.z += (targetBallPosOffsetZ - this.ballOffsetPos.z) * ballAlpha;

    this.ballOffsetTarget.x += (targetLookOffsetX - this.ballOffsetTarget.x) * ballAlpha;
    this.ballOffsetTarget.y += (targetLookOffsetY - this.ballOffsetTarget.y) * ballAlpha;
    this.ballOffsetTarget.z += (targetLookOffsetZ - this.ballOffsetTarget.z) * ballAlpha;

    this.desiredPos.add(this.ballOffsetPos);
    this.desiredTarget.add(this.ballOffsetTarget);

    // 3. Gentle Slow Breathing Orbit during ATTRACT (and soft idle drift on GAME_OVER)
    const wantAttract = state.phase === 'ATTRACT' ? 1 : state.phase === 'GAME_OVER' ? 0.35 : 0;
    const blendRate = wantAttract > this.attractBlend ? 1.4 : 4.8;
    this.attractBlend += (wantAttract - this.attractBlend) * (1 - Math.exp(-blendRate * safeDt));

    if (this.attractBlend > 0.001) {
      this.attractTime += safeDt;
      const swayX = Math.sin(this.attractTime * 0.24) * 4.2;
      const swayY = Math.sin(this.attractTime * 0.17) * 1.05 - 1.15;
      const swayZ = (Math.cos(this.attractTime * 0.24) - 1) * 1.1 + 1.2;

      this.desiredPos.x += swayX * this.attractBlend;
      this.desiredPos.y += swayY * this.attractBlend;
      this.desiredPos.z += swayZ * this.attractBlend;

      // Tilt gaze gently upward toward Hypercore + DMD + Backbox during attract showcase
      this.desiredTarget.x += Math.sin(this.attractTime * 0.24) * 0.45 * this.attractBlend;
      this.desiredTarget.y += 1.4 * this.attractBlend;
      this.desiredTarget.z -= 1.35 * this.attractBlend;
      desiredFov += 1.5 * this.attractBlend;
    }

    // 4. Critically-damped exponential smoothing between presets & dynamic offsets
    const transitionAlpha = 1 - Math.exp(-5.8 * safeDt);
    this.currentPos.lerp(this.desiredPos, transitionAlpha);
    this.currentTarget.lerp(this.desiredTarget, transitionAlpha);
    this.currentFov += (desiredFov - this.currentFov) * transitionAlpha;

    // 5. Snappy Underdamped Physical Nudge Shake Oscillator
    // Natural frequency w0 = 30 rad/s, damping ratio zeta = 0.34 -> crisp ~0.35s arcade jolt
    const stiffness = 900; // w0^2
    const damping = 20.4; // 2 * zeta * w0
    if (
      Math.abs(this.shakeX) > 1e-4 ||
      Math.abs(this.shakeZ) > 1e-4 ||
      Math.abs(this.shakeVelX) > 1e-4 ||
      Math.abs(this.shakeVelZ) > 1e-4
    ) {
      const subSteps = 2;
      const subDt = safeDt / subSteps;
      for (let i = 0; i < subSteps; i++) {
        const ax = -stiffness * this.shakeX - damping * this.shakeVelX;
        const az = -stiffness * this.shakeZ - damping * this.shakeVelZ;
        this.shakeVelX += ax * subDt;
        this.shakeVelZ += az * subDt;
        this.shakeX += this.shakeVelX * subDt;
        this.shakeZ += this.shakeVelZ * subDt;
      }
      this.shakeX = clamp(this.shakeX, -0.35, 0.35);
      this.shakeZ = clamp(this.shakeZ, -0.35, 0.35);
    } else {
      this.shakeX = 0;
      this.shakeZ = 0;
      this.shakeVelX = 0;
      this.shakeVelZ = 0;
    }

    // Apply physical nudge displacement directly to the 3D cabinet root (if attached)
    if (this.cabinetRoot) {
      this.cabinetRoot.position.set(
        this.cabinetBasePos.x + this.shakeX * 0.72,
        this.cabinetBasePos.y,
        this.cabinetBasePos.z + this.shakeZ * 0.65,
      );
    }

    // Apply complementary micro-shake to camera so table nudges feel unmistakable & visceral
    this.finalPos.set(
      this.currentPos.x - this.shakeX * 0.45,
      this.currentPos.y + Math.abs(this.shakeZ) * 0.08,
      this.currentPos.z - this.shakeZ * 0.38,
    );
    this.finalTarget.set(
      this.currentTarget.x + this.shakeX * 0.3,
      this.currentTarget.y,
      this.currentTarget.z + this.shakeZ * 0.25,
    );

    this.applyCameraTransform(this.finalPos, this.finalTarget, this.currentFov);
  }

  /** Picks the highest-priority active ball for Dynamic mode tracking (closest to flippers during multiball). */
  private selectFocusBall(balls: readonly BallState[]): BallState | null {
    let best: BallState | null = null;
    for (const b of balls) {
      if (!b.active || b.zone === 'drained') continue;
      if (!best || b.position.z > best.position.z) {
        best = b;
      }
    }
    return best;
  }

  private applyCameraTransform(
    pos: THREE.Vector3,
    target: THREE.Vector3,
    fov: number,
  ): void {
    this.camera.position.copy(pos);
    this.camera.lookAt(target);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
