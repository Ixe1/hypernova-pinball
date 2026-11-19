/**
 * HYPERNOVA — Main 480 Hz Fixed-Timestep Rapier3D Physics World
 *
 * Orchestrates Rapier3D initialization, 480 Hz sub-stepping, EventQueue
 * collision/sensor dispatching, electromechanical solenoids (pop bumpers,
 * slingshots, drop targets, kickback, spinner, one-way shooter gate),
 * Warp Ramp <-> Wireform Rail transitions, and clean immutable snapshots
 * for Three.js rendering and Web Audio.
 */

import RAPIER from '@dimforge/rapier3d-compat';
import {
  BALL_MASS,
  BALL_RADIUS,
  BUMPER_IMPULSE_SPEED,
  FIXED_DT,
  GRAVITY,
  KICKBACK_IMPULSE_SPEED,
  MAX_BALLS,
  MAX_FRAME_DT,
  SLINGSHOT_IMPULSE_SPEED,
} from '../config/constants';
import { TABLE_LAYOUT, type TableLayout } from '../config/tableLayout';
import type {
  BallState,
  BallZone,
  ColliderTag,
  FlipperSide,
  InputState,
  PhysicsEvent,
  Vec3,
} from '../config/types';
import { BallManager, type ManagedBall } from './BallManager';
import { FlipperPhysics } from './FlipperPhysics';
import { PlungerPhysics } from './PlungerPhysics';
import {
  buildTableColliders,
  type BuiltTableColliders,
  signedDistanceAlong,
} from './TableColliders';
import { WireformRail } from './WireformRail';

export interface PhysicsWorldOptions {
  /** Custom parametric table layout (defaults to TABLE_LAYOUT). */
  readonly layout?: TableLayout;
  /** Optional deterministic RNG in [0, 1) for plunger spring jitter (defaults to Math.random). */
  readonly rng?: () => number;
  /** Spawn 1 initial ball in the shooter lane on construction (default false). */
  readonly spawnInitialBall?: boolean;
}

export interface PhysicsSnapshot {
  readonly balls: readonly BallState[];
  readonly flipperAngles: Readonly<Record<FlipperSide, number>>;
  readonly dropTargetsDropped: readonly [boolean, boolean, boolean];
  readonly plungerTension: number;
  readonly plungerOffset: number;
  readonly spinnerAngle: number;
  readonly spinnerAngularVel: number;
  readonly gateOpenAngle: number;
  readonly bumperFlashTimers: readonly [number, number, number];
  readonly slingshotFlashTimers: readonly [number, number];
  readonly kickbackArmed: boolean;
  readonly saucerOccupied: boolean;
  readonly hasBallInShooter: boolean;
  readonly flippersEnabled: boolean;
  readonly playfieldRollingSpeed: number;
  readonly wireformRollingSpeed: number;
}

const DEFAULT_INPUT: InputState = {
  leftFlipper: false,
  rightFlipper: false,
  plungerHeld: false,
  plungerDragTension: null,
  nudgeLeft: false,
  nudgeRight: false,
  nudgeUp: false,
};

const BUMPER_COOLDOWN_SEC = 0.06;
const SLINGSHOT_COOLDOWN_SEC = 0.07;
const STANDUP_COOLDOWN_SEC = 0.12;
const KICKBACK_COOLDOWN_SEC = 0.5;
const FLIPPER_EVENT_COOLDOWN_SEC = 0.06;
const SPINNER_DAMPING_RATE = 1.85;
const MAX_NUDGE_DELTA_SPEED = 12.0;

let rapierInitPromise: Promise<void> | null = null;

export class PhysicsWorld {
  public readonly layout: TableLayout;
  public readonly wireformRail: WireformRail;

  private readonly world: RAPIER.World;
  private readonly eventQueue: RAPIER.EventQueue;
  private readonly colliderTags = new Map<number, ColliderTag>();
  private readonly tableColliders: BuiltTableColliders;
  private readonly flippers: FlipperPhysics;
  private readonly plunger: PlungerPhysics;
  private readonly ballManager: BallManager;

  private accumulator = 0;
  private simTime = 0;
  private disposed = false;

  // Electromechanical table state
  private solenoidsEnabled = true;
  private kickbackArmed = false;
  private kickbackCooldown = 0;
  private dropTargetsDropped: [boolean, boolean, boolean] = [false, false, false];

  private bumperCooldowns: [number, number, number] = [0, 0, 0];
  private bumperFlashTimers: [number, number, number] = [0, 0, 0];

  private slingshotCooldowns: [number, number] = [0, 0];
  private slingshotFlashTimers: [number, number] = [0, 0];

  private standupCooldowns: [number, number, number] = [0, 0, 0];

  private spinnerAngle = 0;
  private spinnerAngularVel = 0;
  private spinnerHalfRevAccum = 0;
  private lastSpinnerBallId = 0;

  private gateOpenAngle = 0;

  // Per-(ball, sensor/entity) cooldown expiration timestamps in simTime seconds
  private readonly pairCooldownUntil = new Map<string, number>();

  // Reusable per-substep pair buffer to avoid mutating Rapier inside drainCollisionEvents
  private readonly pendingCollisionPairs: Array<[number, number]> = [];

  private constructor(options: PhysicsWorldOptions = {}) {
    this.layout = options.layout ?? TABLE_LAYOUT;
    this.wireformRail = new WireformRail(this.layout.wireformRail);

    this.world = new RAPIER.World({ x: GRAVITY.x, y: GRAVITY.y, z: GRAVITY.z });
    this.world.timestep = FIXED_DT;
    this.world.numSolverIterations = 8;
    this.world.numInternalPgsIterations = 2;
    this.world.maxCcdSubsteps = 4;

    this.eventQueue = new RAPIER.EventQueue(true);

    this.tableColliders = buildTableColliders(this.world, this.layout, this.colliderTags);
    this.flippers = new FlipperPhysics(this.world, this.layout.flippers, this.colliderTags);
    this.plunger = new PlungerPhysics(
      this.world,
      this.layout.plunger,
      this.colliderTags,
      options.rng,
    );
    this.ballManager = new BallManager(
      this.world,
      this.layout,
      this.colliderTags,
      this.wireformRail,
    );

    if (options.spawnInitialBall) {
      this.ballManager.spawnBallInShooter();
    }
  }

  /** Idempotently initializes the `@dimforge/rapier3d-compat` WASM module. */
  public static async init(): Promise<void> {
    if (!rapierInitPromise) {
      rapierInitPromise = RAPIER.init();
    }
    await rapierInitPromise;
  }

  /** Creates a ready-to-step PhysicsWorld after initializing Rapier3D WASM. */
  public static async create(options?: PhysicsWorldOptions): Promise<PhysicsWorld> {
    await PhysicsWorld.init();
    return new PhysicsWorld(options);
  }

  /**
   * Advances physics by `dt` seconds (clamped to `MAX_FRAME_DT`) using the
   * 480 Hz fixed-timestep accumulator and returns all emitted PhysicsEvents.
   */
  public step(dt: number, input?: Partial<InputState>): PhysicsEvent[] {
    if (this.disposed || dt <= 0) {
      return [];
    }

    const clampedDt = Math.min(dt, MAX_FRAME_DT);
    this.accumulator += clampedDt;

    const mergedInput: InputState = input
      ? {
          leftFlipper: input.leftFlipper ?? false,
          rightFlipper: input.rightFlipper ?? false,
          plungerHeld: input.plungerHeld ?? false,
          plungerDragTension: input.plungerDragTension ?? null,
          nudgeLeft: input.nudgeLeft ?? false,
          nudgeRight: input.nudgeRight ?? false,
          nudgeUp: input.nudgeUp ?? false,
        }
      : DEFAULT_INPUT;

    const events: PhysicsEvent[] = [];
    while (this.accumulator >= FIXED_DT - 1e-9) {
      this.accumulator = Math.max(0, this.accumulator - FIXED_DT);
      this.stepSingleSubstep(mergedInput, events);
    }

    return events;
  }

  /**
   * Runs an exact integer number of 480 Hz substeps (ideal for deterministic
   * simulation tests and frame-exact verification).
   */
  public stepSubsteps(count: number, input?: Partial<InputState>): PhysicsEvent[] {
    if (this.disposed || count <= 0) {
      return [];
    }

    const mergedInput: InputState = input
      ? {
          leftFlipper: input.leftFlipper ?? false,
          rightFlipper: input.rightFlipper ?? false,
          plungerHeld: input.plungerHeld ?? false,
          plungerDragTension: input.plungerDragTension ?? null,
          nudgeLeft: input.nudgeLeft ?? false,
          nudgeRight: input.nudgeRight ?? false,
          nudgeUp: input.nudgeUp ?? false,
        }
      : DEFAULT_INPUT;

    const events: PhysicsEvent[] = [];
    for (let i = 0; i < count; i++) {
      this.stepSingleSubstep(mergedInput, events);
    }
    return events;
  }

  private stepSingleSubstep(input: InputState, events: PhysicsEvent[]): void {
    const dt = FIXED_DT;
    this.simTime += dt;

    // 1. Decay electromechanical cooldowns & flash timers
    this.decayTimers(dt);

    // 2. Step kinematic flippers & spring plunger
    this.flippers.stepSubstep(dt, input.leftFlipper, input.rightFlipper);

    const ballInPlunger = this.ballManager.findBallInPlungerZone();
    const ballInPlungerZ = ballInPlunger
      ? this.ballManager.getBallPosition(ballInPlunger).z
      : null;
    const plungerRes = this.plunger.stepSubstep(
      dt,
      input.plungerHeld,
      input.plungerDragTension,
      ballInPlungerZ,
    );
    if (plungerRes.launched && ballInPlunger) {
      this.launchBallWithPlunger(ballInPlunger, plungerRes.tension, plungerRes.launchSpeed, events);
    }

    // 3. Update one-way shooter gate before physics integration
    this.updateOneWayGate(dt);

    // 4. Cache pre-step linear velocities for accurate impact speed & direction checks
    this.ballManager.cachePreStepVelocities();

    // 5. Step Rapier3D world & drain collision/sensor events safely
    this.world.step(this.eventQueue);

    this.pendingCollisionPairs.length = 0;
    this.eventQueue.drainCollisionEvents((h1, h2, started) => {
      if (started) {
        this.pendingCollisionPairs.push([h1, h2]);
      }
    });

    // 6. Process collision & sensor events (mutating bodies/colliders safely outside drain callback)
    for (let i = 0; i < this.pendingCollisionPairs.length; i++) {
      const [h1, h2] = this.pendingCollisionPairs[i];
      this.handleCollisionPair(h1, h2, events);
    }

    // 7. Active upward flipper contact lever-arm strike transfer
    //    (covers both new impacts AND balls already resting/rolling on a flipper!)
    this.processActiveFlipperStrikes(events);

    // 8. Step spinner angular physics & emit half-revolution ticks
    this.stepSpinner(dt, events);

    // 9. Step wireform balls, saucer timers, ramp rollback/apex guards & anti-stuck watchdog
    const ballEvents = this.ballManager.stepSubstep(dt, this.flippers);
    for (let i = 0; i < ballEvents.length; i++) {
      events.push(ballEvents[i]);
    }
  }

  private decayTimers(dt: number): void {
    if (this.kickbackCooldown > 0) {
      this.kickbackCooldown = Math.max(0, this.kickbackCooldown - dt);
    }
    for (let i = 0; i < 3; i++) {
      if (this.bumperCooldowns[i] > 0) {
        this.bumperCooldowns[i] = Math.max(0, this.bumperCooldowns[i] - dt);
      }
      if (this.bumperFlashTimers[i] > 0) {
        this.bumperFlashTimers[i] = Math.max(0, this.bumperFlashTimers[i] - dt / 0.18);
      }
      if (this.standupCooldowns[i] > 0) {
        this.standupCooldowns[i] = Math.max(0, this.standupCooldowns[i] - dt);
      }
    }
    for (let i = 0; i < 2; i++) {
      if (this.slingshotCooldowns[i] > 0) {
        this.slingshotCooldowns[i] = Math.max(0, this.slingshotCooldowns[i] - dt);
      }
      if (this.slingshotFlashTimers[i] > 0) {
        this.slingshotFlashTimers[i] = Math.max(0, this.slingshotFlashTimers[i] - dt / 0.15);
      }
    }

    // Periodic pruning of expired pair cooldown entries
    if (this.pairCooldownUntil.size > 48) {
      for (const [key, until] of this.pairCooldownUntil.entries()) {
        if (until <= this.simTime) {
          this.pairCooldownUntil.delete(key);
        }
      }
    }
  }

  private isPairReady(key: string, cooldownSec: number): boolean {
    const until = this.pairCooldownUntil.get(key) ?? 0;
    if (this.simTime < until) {
      return false;
    }
    this.pairCooldownUntil.set(key, this.simTime + cooldownSec);
    return true;
  }

  private updateOneWayGate(dt: number): void {
    const gate = this.layout.oneWayGate;
    const gdx = gate.end.x - gate.start.x;
    const gdz = gate.end.z - gate.start.z;
    const gLen = Math.max(1e-5, Math.hypot(gdx, gdz));
    const tx = gdx / gLen;
    const tz = gdz / gLen;

    let shouldOpen = false;
    const balls = this.ballManager.getAllBalls();

    for (const ball of balls) {
      if (ball.zone !== 'shooter' && ball.zone !== 'playfield') {
        ball.exitingShooterGate = false;
        continue;
      }

      const pos = ball.body.translation();
      const vel = ball.body.linvel();
      const rx = pos.x - gate.center.x;
      const rz = pos.z - gate.center.z;
      const dist = Math.hypot(rx, rz);
      const lateral = Math.abs(rx * tx + rz * tz);
      const signedAlong = signedDistanceAlong(
        { x: pos.x, z: pos.z },
        gate.center,
        gate.allowedDirection,
      );
      const velAlong = vel.x * gate.allowedDirection.x + vel.z * gate.allowedDirection.z;

      if (dist < 1.35 && lateral < 0.72) {
        if (signedAlong < 0 && velAlong > -1.0) {
          ball.exitingShooterGate = true;
        } else if (ball.exitingShooterGate && (signedAlong > 0.34 || signedAlong < -1.1)) {
          ball.exitingShooterGate = false;
        }
      } else {
        ball.exitingShooterGate = false;
      }

      if (ball.exitingShooterGate) {
        shouldOpen = true;
      }
    }

    this.tableColliders.oneWayGateCollider.setEnabled(!shouldOpen);

    const targetAngle = shouldOpen ? 1.15 : 0;
    const blend = Math.min(1, dt * (shouldOpen ? 28 : 12));
    this.gateOpenAngle += (targetAngle - this.gateOpenAngle) * blend;
  }

  private launchBallWithPlunger(
    ball: ManagedBall,
    tension: number,
    launchSpeed: number,
    events: PhysicsEvent[],
  ): void {
    // A real spring plunger delivers a pure translational impulse; playfield friction
    // naturally spins the ball up to rolling speed along the shooter lane.
    ball.body.setLinvel({ x: 0, y: 0, z: -launchSpeed }, true);
    ball.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    ball.body.wakeUp();
    ball.stuckTimer = 0;

    events.push({
      type: 'plungerLaunch',
      ballId: ball.id,
      tension,
      speed: launchSpeed,
    });
  }

  private processActiveFlipperStrikes(events: PhysicsEvent[]): void {
    const balls = this.ballManager.getAllBalls();
    const runtimes = this.flippers.getAllRuntimes();

    for (const fl of runtimes) {
      if (!fl.isSwingingUp) {
        continue;
      }

      for (const ball of balls) {
        if (!ball.active || ball.zone !== 'playfield') {
          continue;
        }

        let inContact = false;
        this.world.contactPair(ball.collider, fl.collider, (manifold) => {
          if (manifold.numContacts() > 0) {
            inContact = true;
          }
        });

        if (!inContact) {
          continue;
        }

        const pos = ball.body.translation();
        const vel = ball.body.linvel();
        const ballPos: Vec3 = { x: pos.x, y: pos.y, z: pos.z };
        const ballVel: Vec3 = { x: vel.x, y: vel.y, z: vel.z };

        const strike = this.flippers.computeStrikeVelocity(fl.def.side, ballPos, ballVel);
        if (!strike.applied) {
          continue;
        }

        ball.body.setLinvel(
          {
            x: strike.vx,
            y: Math.min(0.35, Math.max(0, vel.y)),
            z: strike.vz,
          },
          true,
        );
        ball.body.setAngvel(
          {
            x: (strike.vz / BALL_RADIUS) * 0.35,
            y: 0,
            z: (-strike.vx / BALL_RADIUS) * 0.35,
          },
          true,
        );
        ball.body.wakeUp();

        const key = `flipper_${ball.id}_${fl.def.side}`;
        if (this.isPairReady(key, FLIPPER_EVENT_COOLDOWN_SEC)) {
          events.push({
            type: 'flipperHit',
            side: fl.def.side,
            ballId: ball.id,
            impactSpeed: strike.impactSpeed,
            position: ballPos,
          });
        }
      }
    }
  }

  private handleCollisionPair(h1: number, h2: number, events: PhysicsEvent[]): void {
    const tag1 = this.colliderTags.get(h1);
    const tag2 = this.colliderTags.get(h2);
    if (!tag1 || !tag2) {
      return;
    }

    // Ball-to-ball collision
    if (tag1.kind === 'ball' && tag2.kind === 'ball') {
      const ballA = this.ballManager.getBallByCollider(h1);
      const ballB = this.ballManager.getBallByCollider(h2);
      if (!ballA || !ballB || !ballA.active || !ballB.active) {
        return;
      }
      const dvx = ballA.preStepVel.x - ballB.preStepVel.x;
      const dvy = ballA.preStepVel.y - ballB.preStepVel.y;
      const dvz = ballA.preStepVel.z - ballB.preStepVel.z;
      const relSpeed = Math.hypot(dvx, dvy, dvz);
      if (relSpeed < 2.0) {
        return;
      }
      const lo = Math.min(ballA.id, ballB.id);
      const hi = Math.max(ballA.id, ballB.id);
      if (!this.isPairReady(`bb_${lo}_${hi}`, 0.06)) {
        return;
      }
      const posA = ballA.body.translation();
      const posB = ballB.body.translation();
      events.push({
        type: 'ballCollision',
        ballIdA: ballA.id,
        ballIdB: ballB.id,
        impactSpeed: relSpeed,
        position: {
          x: (posA.x + posB.x) * 0.5,
          y: (posA.y + posB.y) * 0.5,
          z: (posA.z + posB.z) * 0.5,
        },
      });
      return;
    }

    // Identify ball vs feature collider
    let ball: ManagedBall | undefined;
    let otherTag: ColliderTag;
    if (tag1.kind === 'ball') {
      ball = this.ballManager.getBallByCollider(h1);
      otherTag = tag2;
    } else if (tag2.kind === 'ball') {
      ball = this.ballManager.getBallByCollider(h2);
      otherTag = tag1;
    } else {
      return;
    }

    if (!ball || !ball.active || ball.zone === 'wireform' || ball.zone === 'saucer') {
      return;
    }

    const pos = ball.body.translation();
    const postVel = ball.body.linvel();
    const ballPos: Vec3 = { x: pos.x, y: pos.y, z: pos.z };
    const preSpeed = Math.hypot(ball.preStepVel.x, ball.preStepVel.y, ball.preStepVel.z);
    const postSpeed = Math.hypot(postVel.x, postVel.y, postVel.z);
    const impactSpeed = Math.max(preSpeed, postSpeed);

    switch (otherTag.kind) {
      case 'bumper': {
        const idx = otherTag.index ?? 0;
        if (!this.solenoidsEnabled || this.bumperCooldowns[idx] > 0) {
          return;
        }
        const bumperDef = this.layout.popBumpers[idx];
        if (!bumperDef) {
          return;
        }
        const dx = pos.x - bumperDef.position.x;
        const dz = pos.z - bumperDef.position.z;
        const dist = Math.hypot(dx, dz);
        const nx = dist > 1e-5 ? dx / dist : 0;
        const nz = dist > 1e-5 ? dz / dist : 1;
        const tx = -nz;
        const tz = nx;
        const vTan = ball.preStepVel.x * tx + ball.preStepVel.z * tz;

        const outVx = nx * BUMPER_IMPULSE_SPEED + tx * (vTan * 0.22);
        const outVz = nz * BUMPER_IMPULSE_SPEED + tz * (vTan * 0.22);

        ball.body.setLinvel(
          { x: outVx, y: Math.min(0.4, Math.max(0, postVel.y)), z: outVz },
          true,
        );
        ball.body.wakeUp();

        this.bumperCooldowns[idx] = BUMPER_COOLDOWN_SEC;
        this.bumperFlashTimers[idx] = 1.0;

        events.push({
          type: 'bumper',
          id: otherTag.id,
          index: idx,
          ballId: ball.id,
          position: ballPos,
          impactSpeed,
        });
        break;
      }

      case 'slingshot': {
        if (!this.solenoidsEnabled || !otherTag.normal) {
          return;
        }
        const side: 'left' | 'right' = otherTag.side === 'right' ? 'right' : 'left';
        const slingIdx = side === 'left' ? 0 : 1;
        if (this.slingshotCooldowns[slingIdx] > 0) {
          return;
        }
        const n = otherTag.normal;
        const approachingDot = ball.preStepVel.x * n.x + ball.preStepVel.z * n.z;
        // Require the ball to be hitting the active face rather than already flying away from it.
        if (approachingDot > 5.0) {
          return;
        }
        const tx = -n.z;
        const tz = n.x;
        const vTan = ball.preStepVel.x * tx + ball.preStepVel.z * tz;

        const outVx = n.x * SLINGSHOT_IMPULSE_SPEED + tx * (vTan * 0.45);
        const outVz = n.z * SLINGSHOT_IMPULSE_SPEED + tz * (vTan * 0.45);

        ball.body.setLinvel(
          { x: outVx, y: Math.min(0.35, Math.max(0, postVel.y)), z: outVz },
          true,
        );
        ball.body.wakeUp();

        this.slingshotCooldowns[slingIdx] = SLINGSHOT_COOLDOWN_SEC;
        this.slingshotFlashTimers[slingIdx] = 1.0;

        events.push({
          type: 'slingshot',
          id: otherTag.id,
          side,
          ballId: ball.id,
          position: ballPos,
          impactSpeed,
        });
        break;
      }

      case 'dropTarget': {
        const idx = otherTag.index ?? 0;
        if (idx < 0 || idx >= this.dropTargetsDropped.length || this.dropTargetsDropped[idx]) {
          return;
        }
        this.dropTargetsDropped[idx] = true;
        const collider = this.tableColliders.dropTargetColliders.get(idx);
        if (collider) {
          collider.setEnabled(false);
        }
        events.push({
          type: 'dropTarget',
          id: otherTag.id,
          index: idx,
          label: otherTag.label ?? '',
          ballId: ball.id,
          position: ballPos,
        });
        break;
      }

      case 'standup': {
        const idx = otherTag.index ?? 0;
        if (idx < 0 || idx >= this.standupCooldowns.length || this.standupCooldowns[idx] > 0) {
          return;
        }
        this.standupCooldowns[idx] = STANDUP_COOLDOWN_SEC;
        events.push({
          type: 'standup',
          id: otherTag.id,
          index: idx,
          ballId: ball.id,
          position: ballPos,
        });
        break;
      }

      case 'rollover': {
        if (ball.zone !== 'playfield' && ball.zone !== 'shooter') {
          return;
        }
        if (!this.isPairReady(`roll_${ball.id}_${otherTag.id}`, 0.3)) {
          return;
        }
        events.push({
          type: 'rollover',
          id: otherTag.id,
          index: otherTag.index ?? 0,
          label: otherTag.label ?? '',
          ballId: ball.id,
          position: ballPos,
        });
        break;
      }

      case 'inlaneLeft':
      case 'inlaneRight':
      case 'outlaneLeft':
      case 'outlaneRight': {
        if (ball.zone !== 'playfield') {
          return;
        }
        if (!this.isPairReady(`lane_${ball.id}_${otherTag.id}`, 0.35)) {
          return;
        }
        events.push({
          type: 'lane',
          id: otherTag.id,
          lane: otherTag.kind,
          ballId: ball.id,
          position: ballPos,
        });
        break;
      }

      case 'orbitLeft':
      case 'orbitRight': {
        if (ball.zone !== 'playfield') {
          return;
        }
        if (!this.isPairReady(`orbit_${ball.id}_${otherTag.id}`, 0.35)) {
          return;
        }
        events.push({
          type: 'orbit',
          id: otherTag.id,
          side: otherTag.kind === 'orbitLeft' ? 'left' : 'right',
          ballId: ball.id,
          speed: preSpeed,
          position: ballPos,
        });
        break;
      }

      case 'spinner': {
        if (ball.zone !== 'playfield') {
          return;
        }
        if (!this.isPairReady(`spin_${ball.id}`, 0.15)) {
          return;
        }
        const kickVel = -ball.preStepVel.z * 2.1;
        if (Math.abs(kickVel) > 2.5) {
          if (Math.abs(kickVel) > Math.abs(this.spinnerAngularVel)) {
            this.spinnerAngularVel = kickVel;
          } else {
            this.spinnerAngularVel += kickVel * 0.45;
          }
          this.lastSpinnerBallId = ball.id;
        }
        break;
      }

      case 'kickback': {
        if (
          ball.zone !== 'playfield' ||
          !this.kickbackArmed ||
          !this.solenoidsEnabled ||
          this.kickbackCooldown > 0 ||
          !otherTag.normal
        ) {
          return;
        }
        const n = otherTag.normal;
        ball.body.setLinvel(
          {
            x: n.x * KICKBACK_IMPULSE_SPEED,
            y: 0,
            z: n.z * KICKBACK_IMPULSE_SPEED,
          },
          true,
        );
        ball.body.wakeUp();
        this.kickbackArmed = false;
        this.kickbackCooldown = KICKBACK_COOLDOWN_SEC;

        events.push({
          type: 'kickback',
          id: otherTag.id,
          ballId: ball.id,
          position: ballPos,
        });
        break;
      }

      case 'saucer': {
        if (ball.zone !== 'playfield') {
          return;
        }
        const captureEvent = this.ballManager.captureInSaucer(ball);
        if (captureEvent) {
          events.push(captureEvent);
        }
        break;
      }

      case 'rampEntry': {
        const entryDir = otherTag.normal ?? this.layout.warpRamp.entrySensor.entryDirection;
        const vDotEntry = ball.preStepVel.x * entryDir.x + ball.preStepVel.z * entryDir.z;
        if (ball.zone === 'playfield' && vDotEntry > 3.5 && ballPos.y < 0.7) {
          const entryEvt = this.ballManager.enterRamp(ball, true);
          if (entryEvt) {
            events.push(entryEvt);
          }
        } else if (
          ball.zone === 'ramp' &&
          vDotEntry < -1.5 &&
          ballPos.y < 0.7 &&
          ballPos.z > -2.85 &&
          ball.rampCooldown <= 0
        ) {
          const rollbackEvt = this.ballManager.rollbackFromRamp(ball);
          if (rollbackEvt) {
            events.push(rollbackEvt);
          }
        }
        break;
      }

      case 'rampApex': {
        if (ball.zone === 'ramp') {
          const completeEvt = this.ballManager.enterWireform(ball);
          if (completeEvt) {
            events.push(completeEvt);
          }
        }
        break;
      }

      case 'drain': {
        const drainEvt = this.ballManager.drainBall(ball.id);
        if (drainEvt) {
          events.push(drainEvt);
        }
        break;
      }

      case 'flipper': {
        if (!otherTag.side) {
          return;
        }
        const key = `flipper_${ball.id}_${otherTag.side}`;
        if (impactSpeed >= 2.0 && this.isPairReady(key, FLIPPER_EVENT_COOLDOWN_SEC)) {
          events.push({
            type: 'flipperHit',
            side: otherTag.side,
            ballId: ball.id,
            impactSpeed,
            position: ballPos,
          });
        }
        break;
      }

      case 'wall':
      case 'post':
      case 'oneWayGate': {
        const dv = Math.hypot(
          postVel.x - ball.preStepVel.x,
          postVel.y - ball.preStepVel.y,
          postVel.z - ball.preStepVel.z,
        );
        if (dv >= 4.0 && ball.wallHitCooldown <= 0) {
          ball.wallHitCooldown = 0.05;
          events.push({
            type: 'wallHit',
            ballId: ball.id,
            impactSpeed: dv,
            position: ballPos,
          });
        }
        break;
      }

      default:
        break;
    }
  }

  private stepSpinner(dt: number, events: PhysicsEvent[]): void {
    if (Math.abs(this.spinnerAngularVel) > 1e-4) {
      this.spinnerAngularVel *= Math.exp(-SPINNER_DAMPING_RATE * dt);
      const deltaAngle = this.spinnerAngularVel * dt;
      this.spinnerAngle += deltaAngle;
      this.spinnerHalfRevAccum += Math.abs(deltaAngle);

      if (this.spinnerHalfRevAccum >= Math.PI) {
        const ticks = Math.floor(this.spinnerHalfRevAccum / Math.PI);
        this.spinnerHalfRevAccum -= ticks * Math.PI;
        const sp = this.layout.spinner;
        events.push({
          type: 'spinner',
          id: sp.id,
          ballId: this.lastSpinnerBallId,
          angularVelocity: this.spinnerAngularVel,
          halfRevolutions: ticks,
          position: { x: sp.position.x, y: sp.pivotY, z: sp.position.z },
        });
      }

      if (Math.abs(this.spinnerAngularVel) < 0.35) {
        this.spinnerAngularVel *= 0.92;
        if (Math.abs(this.spinnerAngularVel) < 0.05) {
          this.spinnerAngularVel = 0;
        }
      }
    } else {
      // Gently settle blade back to hanging vertical (nearest multiple of PI)
      const restAngle = Math.round(this.spinnerAngle / Math.PI) * Math.PI;
      const err = restAngle - this.spinnerAngle;
      if (Math.abs(err) > 1e-3) {
        this.spinnerAngle += err * Math.min(1, dt * 8);
      } else {
        this.spinnerAngle = restAngle;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public Control API
  // -------------------------------------------------------------------------

  /**
   * Applies a table nudge velocity impulse `(ix, iz)` (world units/s, clamped
   * to `MAX_NUDGE_DELTA_SPEED`) to all active dynamic playfield/ramp balls.
   */
  public applyNudgeImpulse(ix: number, iz: number): void {
    const mag = Math.hypot(ix, iz);
    if (mag <= 1e-6) {
      return;
    }
    const scale = mag > MAX_NUDGE_DELTA_SPEED ? MAX_NUDGE_DELTA_SPEED / mag : 1;
    const impulseX = ix * scale * BALL_MASS;
    const impulseZ = iz * scale * BALL_MASS;

    for (const ball of this.ballManager.getAllBalls()) {
      if (ball.zone === 'playfield' || ball.zone === 'ramp') {
        ball.body.applyImpulse({ x: impulseX, y: 0, z: impulseZ }, true);
        ball.body.wakeUp();
      }
    }
  }

  public setFlippersEnabled(enabled: boolean): void {
    this.flippers.setEnabled(enabled);
  }

  public setSolenoidsEnabled(enabled: boolean): void {
    this.solenoidsEnabled = enabled;
  }

  public setTilted(tilted: boolean): void {
    this.flippers.setEnabled(!tilted);
    this.solenoidsEnabled = !tilted;
  }

  public setKickbackArmed(armed: boolean): void {
    this.kickbackArmed = armed;
  }

  public isKickbackArmed(): boolean {
    return this.kickbackArmed;
  }

  /**
   * Programmatically launches a ball sitting in the shooter lane (returns true if launched).
   */
  public triggerBallLaunch(tension = 0.96): PhysicsEvent | null {
    const ball = this.ballManager.findBallInPlungerZone();
    if (!ball) {
      return null;
    }
    const res = this.plunger.triggerLaunch(tension);
    const events: PhysicsEvent[] = [];
    this.launchBallWithPlunger(ball, res.tension, res.launchSpeed, events);
    return events[0] ?? null;
  }

  /** Immediately ejects any ball held in the Hypercore Saucer. */
  public releaseSaucerBall(): PhysicsEvent | null {
    return this.ballManager.releaseSaucerBall();
  }

  /** Spawns a ball in the shooter lane (up to MAX_BALLS). Returns ballId or null. */
  public spawnBallInShooter(): number | null {
    return this.ballManager.spawnBallInShooter();
  }

  /** Spawns a ball at a specific position/velocity/zone (useful for testing & multiball). */
  public spawnBallAt(
    position: Vec3,
    velocity: Vec3 = { x: 0, y: 0, z: 0 },
    zone: BallZone = 'playfield',
  ): number | null {
    return this.ballManager.spawnBallAt(position, velocity, zone);
  }

  /** Ensures `targetCount` (up to MAX_BALLS = 3) active balls are launched into play. */
  public spawnMultiball(targetCount = MAX_BALLS): number[] {
    return this.ballManager.spawnMultiball(targetCount);
  }

  /** Restores all 3 R-A-Y drop targets to upright and re-enables their colliders. */
  public resetDropTargets(): void {
    this.dropTargetsDropped = [false, false, false];
    const balls = this.ballManager.getAllBalls();

    for (const target of this.layout.dropTargets) {
      const collider = this.tableColliders.dropTargetColliders.get(target.index);
      if (collider) {
        collider.setEnabled(true);
      }

      // Gently clear any ball sitting right inside a rising target slot
      for (const ball of balls) {
        if (ball.zone !== 'playfield') {
          continue;
        }
        const p = ball.body.translation();
        const dist = Math.hypot(p.x - target.position.x, p.z - target.position.z);
        if (dist < BALL_RADIUS + target.depth + 0.1) {
          ball.body.setTranslation(
            {
              x: p.x + target.normal.x * 0.22,
              y: p.y,
              z: p.z + target.normal.z * 0.22,
            },
            true,
          );
          ball.body.wakeUp();
        }
      }
    }
  }

  /** Resets all table mechanisms, clears active balls, and optionally spawns a fresh ball in the shooter lane. */
  public resetTable(spawnInitialBall = true): void {
    this.ballManager.removeAllBalls();
    this.resetDropTargets();
    this.flippers.reset();
    this.plunger.reset();

    this.solenoidsEnabled = true;
    this.kickbackArmed = false;
    this.kickbackCooldown = 0;
    this.bumperCooldowns = [0, 0, 0];
    this.bumperFlashTimers = [0, 0, 0];
    this.slingshotCooldowns = [0, 0];
    this.slingshotFlashTimers = [0, 0];
    this.standupCooldowns = [0, 0, 0];

    this.spinnerAngle = 0;
    this.spinnerAngularVel = 0;
    this.spinnerHalfRevAccum = 0;
    this.lastSpinnerBallId = 0;

    this.gateOpenAngle = 0;
    this.tableColliders.oneWayGateCollider.setEnabled(true);
    this.pairCooldownUntil.clear();
    this.accumulator = 0;

    if (spawnInitialBall) {
      this.ballManager.spawnBallInShooter();
    }
  }

  public getSnapshot(): PhysicsSnapshot {
    const balls = this.ballManager.getBallStates();
    let playfieldRollingSpeed = 0;
    let wireformRollingSpeed = 0;

    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (b.zone === 'wireform') {
        if (b.speed > wireformRollingSpeed) {
          wireformRollingSpeed = b.speed;
        }
      } else if (b.zone === 'playfield' || b.zone === 'ramp' || b.zone === 'shooter') {
        if (b.speed > playfieldRollingSpeed) {
          playfieldRollingSpeed = b.speed;
        }
      }
    }

    return {
      balls,
      flipperAngles: this.flippers.getAngles(),
      dropTargetsDropped: [
        this.dropTargetsDropped[0],
        this.dropTargetsDropped[1],
        this.dropTargetsDropped[2],
      ],
      plungerTension: this.plunger.getTension(),
      plungerOffset: this.plunger.getOffset(),
      spinnerAngle: this.spinnerAngle,
      spinnerAngularVel: this.spinnerAngularVel,
      gateOpenAngle: this.gateOpenAngle,
      bumperFlashTimers: [
        this.bumperFlashTimers[0],
        this.bumperFlashTimers[1],
        this.bumperFlashTimers[2],
      ],
      slingshotFlashTimers: [
        this.slingshotFlashTimers[0],
        this.slingshotFlashTimers[1],
      ],
      kickbackArmed: this.kickbackArmed,
      saucerOccupied: this.ballManager.isSaucerOccupied(),
      hasBallInShooter: this.ballManager.hasBallInShooter(),
      flippersEnabled: this.flippers.isEnabled(),
      playfieldRollingSpeed,
      wireformRollingSpeed,
    };
  }

  /** Releases underlying Rapier3D WASM resources cleanly. */
  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.ballManager.removeAllBalls();
    this.eventQueue.free();
    this.world.free();
  }
}
