/**
 * HYPERNOVA — Multi-Ball Lifecycle, Collision Layer Switching & Anti-Stuck Manager
 *
 * Manages up to 3 simultaneous CCD-enabled dynamic steel pinballs, handles
 * seamless PLAYFIELD <-> RAMP collision group switching, WireformRail handoffs,
 * Hypercore Saucer capture/hold/eject, and the Anti-Stuck recovery watchdog.
 */

import RAPIER from '@dimforge/rapier3d-compat';
import {
  ACTIVE_CENTER_X,
  ANTI_STUCK_SPEED_THRESHOLD,
  ANTI_STUCK_TIMEOUT,
  BALL_ANGULAR_DAMPING,
  BALL_FRICTION,
  BALL_LINEAR_DAMPING,
  BALL_MASS,
  BALL_RADIUS,
  BALL_RESTITUTION,
  INTERACTION_BALL_PLAYFIELD,
  INTERACTION_BALL_RAMP,
  MAX_BALLS,
  MIN_WIREFORM_SPEED,
  PLAYFIELD_GLASS_Y,
  PLAYFIELD_MAX_X,
  PLAYFIELD_MAX_Z,
  PLAYFIELD_MIN_X,
  PLAYFIELD_MIN_Z,
  SAUCER_EJECT_SPEED,
  SAUCER_HOLD_DURATION,
  SHOOTER_LANE_MIN_X,
} from '../config/constants';
import type { TableLayout } from '../config/tableLayout';
import type { BallState, BallZone, ColliderTag, PhysicsEvent, Quat, Vec3 } from '../config/types';
import type { FlipperPhysics } from './FlipperPhysics';
import { signedDistanceAlong } from './TableColliders';
import { type WireformBallState, WireformRail } from './WireformRail';

const MAX_BALL_SPEED = 82.0;

export interface ManagedBall {
  readonly id: number;
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  zone: BallZone;
  active: boolean;
  preStepVel: { x: number; y: number; z: number };
  wireformState: WireformBallState | null;
  saucerHoldTimer: number;
  saucerCooldown: number;
  saucerPosition: Vec3;
  saucerRotation: Quat;
  rampCooldown: number;
  wallHitCooldown: number;
  stuckTimer: number;
  /** True while this ball is crossing out of the shooter lane through the one-way gate. */
  exitingShooterGate: boolean;
}

export class BallManager {
  private readonly world: RAPIER.World;
  private readonly layout: TableLayout;
  private readonly colliderTags: Map<number, ColliderTag>;
  private readonly wireformRail: WireformRail;

  private readonly balls = new Map<number, ManagedBall>();
  private readonly colliderToBallId = new Map<number, number>();
  private nextBallId = 1;

  constructor(
    world: RAPIER.World,
    layout: TableLayout,
    colliderTags: Map<number, ColliderTag>,
    wireformRail: WireformRail,
  ) {
    this.world = world;
    this.layout = layout;
    this.colliderTags = colliderTags;
    this.wireformRail = wireformRail;
  }

  public spawnBallInShooter(): number | null {
    if (this.balls.size >= MAX_BALLS) {
      return null;
    }
    const spawn = this.layout.plunger.ballSpawnPosition;
    // Avoid overlapping an existing ball sitting on or rolled back onto the plunger tip.
    for (const b of this.balls.values()) {
      const p = this.getBallPosition(b);
      if (
        Math.hypot(p.x - spawn.x, p.z - spawn.z) < BALL_RADIUS * 2.6 ||
        (Math.abs(p.x - spawn.x) < 0.45 && p.z >= 7.8)
      ) {
        return null;
      }
    }
    return this.spawnBallAt(spawn, { x: 0, y: 0, z: 0 }, 'shooter');
  }

  public spawnBallAt(
    position: Vec3,
    velocity: Vec3 = { x: 0, y: 0, z: 0 },
    zone: BallZone = 'playfield',
  ): number | null {
    if (this.balls.size >= MAX_BALLS) {
      return null;
    }

    const id = this.nextBallId++;
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z)
      .setLinvel(velocity.x, velocity.y, velocity.z)
      .setLinearDamping(BALL_LINEAR_DAMPING)
      .setAngularDamping(BALL_ANGULAR_DAMPING)
      .setCcdEnabled(true)
      .setSoftCcdPrediction(BALL_RADIUS)
      .setCanSleep(false)
      .setAdditionalSolverIterations(4);

    const body = this.world.createRigidBody(bodyDesc);
    const groups = zone === 'ramp' ? INTERACTION_BALL_RAMP : INTERACTION_BALL_PLAYFIELD;

    const colliderDesc = RAPIER.ColliderDesc.ball(BALL_RADIUS)
      .setMass(BALL_MASS)
      .setRestitution(BALL_RESTITUTION)
      .setFriction(BALL_FRICTION)
      .setCollisionGroups(groups)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

    const collider = this.world.createCollider(colliderDesc, body);

    this.colliderTags.set(collider.handle, {
      kind: 'ball',
      id: `ball_${id}`,
      index: id,
    });
    this.colliderToBallId.set(collider.handle, id);

    const managed: ManagedBall = {
      id,
      body,
      collider,
      zone,
      active: true,
      preStepVel: { x: velocity.x, y: velocity.y, z: velocity.z },
      wireformState: null,
      saucerHoldTimer: 0,
      saucerCooldown: 0,
      saucerPosition: { ...position },
      saucerRotation: { x: 0, y: 0, z: 0, w: 1 },
      rampCooldown: 0,
      wallHitCooldown: 0,
      stuckTimer: 0,
      exitingShooterGate: false,
    };

    this.balls.set(id, managed);
    return id;
  }

  /**
   * Ensures `targetCount` (up to MAX_BALLS = 3) balls are active by launching
   * additional staggered balls from clear shooter-lane / saucer slots.
   */
  public spawnMultiball(targetCount = MAX_BALLS): number[] {
    const desired = Math.max(1, Math.min(MAX_BALLS, targetCount));
    const spawned: number[] = [];

    // If a ball is resting in the saucer, shorten its hold so multiball erupts crisply.
    for (const b of this.balls.values()) {
      if (b.zone === 'saucer' && b.saucerHoldTimer > 0.25) {
        b.saucerHoldTimer = 0.25;
      }
    }

    const laneX = this.layout.plunger.laneCenterX;
    const candidates: ReadonlyArray<{ pos: Vec3; vel: Vec3; zone: BallZone }> = [
      {
        pos: { x: laneX, y: BALL_RADIUS, z: 8.8 },
        vel: { x: 0, y: 0, z: -60.0 },
        zone: 'shooter',
      },
      {
        pos: { x: laneX, y: BALL_RADIUS, z: 6.0 },
        vel: { x: 0, y: 0, z: -62.0 },
        zone: 'shooter',
      },
      {
        pos: { x: laneX, y: BALL_RADIUS, z: 3.2 },
        vel: { x: 0, y: 0, z: -64.0 },
        zone: 'shooter',
      },
      {
        pos: { x: ACTIVE_CENTER_X, y: BALL_RADIUS, z: -3.2 },
        vel: {
          x: this.layout.saucer.ejectDirection.x * SAUCER_EJECT_SPEED,
          y: 0,
          z: this.layout.saucer.ejectDirection.z * SAUCER_EJECT_SPEED,
        },
        zone: 'playfield',
      },
    ];

    for (const slot of candidates) {
      if (this.balls.size >= desired) {
        break;
      }
      let clear = true;
      for (const existing of this.balls.values()) {
        const p = this.getBallPosition(existing);
        if (Math.hypot(p.x - slot.pos.x, p.z - slot.pos.z) < 1.0) {
          clear = false;
          break;
        }
      }
      if (!clear) {
        continue;
      }
      const id = this.spawnBallAt(slot.pos, slot.vel, slot.zone);
      if (id !== null) {
        spawned.push(id);
      }
    }

    return spawned;
  }

  public removeBall(ballId: number): boolean {
    const ball = this.balls.get(ballId);
    if (!ball) {
      return false;
    }
    ball.active = false;
    this.colliderTags.delete(ball.collider.handle);
    this.colliderToBallId.delete(ball.collider.handle);
    this.balls.delete(ballId);
    if (ball.body.isValid()) {
      this.world.removeRigidBody(ball.body);
    }
    return true;
  }

  public drainBall(ballId: number): PhysicsEvent | null {
    const ball = this.balls.get(ballId);
    if (!ball) {
      return null;
    }
    const position = this.getBallPosition(ball);
    this.removeBall(ballId);
    return {
      type: 'drain',
      ballId,
      position,
    };
  }

  public removeAllBalls(): void {
    const ids = Array.from(this.balls.keys());
    for (const id of ids) {
      this.removeBall(id);
    }
  }

  public getBall(ballId: number): ManagedBall | undefined {
    return this.balls.get(ballId);
  }

  public getBallByCollider(handle: number): ManagedBall | undefined {
    const id = this.colliderToBallId.get(handle);
    if (id === undefined) {
      return undefined;
    }
    return this.balls.get(id);
  }

  public getAllBalls(): ManagedBall[] {
    return Array.from(this.balls.values());
  }

  public getActiveCount(): number {
    return this.balls.size;
  }

  public isSaucerOccupied(): boolean {
    for (const ball of this.balls.values()) {
      if (ball.zone === 'saucer') {
        return true;
      }
    }
    return false;
  }

  /**
   * True whenever any active ball is resting/stalled in the shooter lane (ignoring balls
   * already traveling swiftly upward out of the lane such as auto-launched multiball/ball-save balls).
   */
  public hasBallInShooter(): boolean {
    for (const ball of this.balls.values()) {
      if (!ball.active) {
        continue;
      }
      if (ball.zone === 'shooter') {
        const v = this.getBallVelocity(ball);
        if (v.z < -8.0) {
          continue;
        }
        return true;
      }
      if (ball.zone === 'playfield') {
        const p = this.getBallPosition(ball);
        const v = this.getBallVelocity(ball);
        if (p.x >= SHOOTER_LANE_MIN_X - 0.12 && p.z >= -6.0 && v.z >= -8.0) {
          return true;
        }
      }
    }
    return false;
  }

  public getBallPosition(ball: ManagedBall): Vec3 {
    if (ball.zone === 'wireform' && ball.wireformState) {
      return ball.wireformState.position;
    }
    if (ball.zone === 'saucer') {
      return ball.saucerPosition;
    }
    const t = ball.body.translation();
    return { x: t.x, y: t.y, z: t.z };
  }

  public getBallVelocity(ball: ManagedBall): Vec3 {
    if (ball.zone === 'wireform' && ball.wireformState) {
      return ball.wireformState.velocity;
    }
    if (ball.zone === 'saucer') {
      return { x: 0, y: 0, z: 0 };
    }
    const v = ball.body.linvel();
    return { x: v.x, y: v.y, z: v.z };
  }

  /** Caches every dynamic ball's linear velocity right before `world.step()`. */
  public cachePreStepVelocities(): void {
    for (const ball of this.balls.values()) {
      if (ball.zone === 'wireform' || ball.zone === 'saucer') {
        ball.preStepVel.x = 0;
        ball.preStepVel.y = 0;
        ball.preStepVel.z = 0;
        continue;
      }
      const v = ball.body.linvel();
      ball.preStepVel.x = v.x;
      ball.preStepVel.y = v.y;
      ball.preStepVel.z = v.z;
    }
  }

  /**
   * Transitions a playfield ball cleanly onto GROUP_RAMP for climbing the Warp Ramp.
   * When `allowDuringCooldown` is true (e.g. deliberate high-speed upward re-entry
   * inside the entry mouth), clears any lingering rollback cooldown so the ball
   * climbs the ramp instead of clipping beneath the low ramp deck.
   */
  public enterRamp(ball: ManagedBall, allowDuringCooldown = false): PhysicsEvent | null {
    if (ball.zone !== 'playfield') {
      return null;
    }
    if (!allowDuringCooldown && ball.rampCooldown > 0) {
      return null;
    }
    ball.collider.setCollisionGroups(INTERACTION_BALL_RAMP);
    ball.zone = 'ramp';
    ball.rampCooldown = 0.08;
    ball.stuckTimer = 0;

    return {
      type: 'rampEntry',
      id: this.layout.warpRamp.id,
      ballId: ball.id,
      position: this.getBallPosition(ball),
    };
  }

  /** Transitions a stalled ramp ball smoothly back onto GROUP_PLAYFIELD. */
  public rollbackFromRamp(ball: ManagedBall): PhysicsEvent | null {
    if (ball.zone !== 'ramp') {
      return null;
    }
    ball.collider.setCollisionGroups(INTERACTION_BALL_PLAYFIELD);
    ball.zone = 'playfield';
    ball.rampCooldown = 0.25;
    ball.stuckTimer = 0;

    return {
      type: 'rampRollback',
      id: this.layout.warpRamp.id,
      ballId: ball.id,
      position: this.getBallPosition(ball),
    };
  }

  /** Transfers a ball cresting the Warp Ramp apex into spline-driven WireformRail physics. */
  public enterWireform(ball: ManagedBall): PhysicsEvent | null {
    if (ball.zone !== 'ramp') {
      return null;
    }

    const v = ball.body.linvel();
    const speed = Math.hypot(v.x, v.y, v.z);
    const entrySpeed = Math.max(MIN_WIREFORM_SPEED, Math.min(18.0, speed * 0.85));
    const r = ball.body.rotation();
    const initRot: Quat = { x: r.x, y: r.y, z: r.z, w: r.w };

    ball.wireformState = this.wireformRail.createBallState(entrySpeed, initRot);
    ball.zone = 'wireform';
    ball.stuckTimer = 0;
    ball.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    ball.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    ball.body.setEnabled(false);

    return {
      type: 'rampComplete',
      id: this.layout.warpRamp.id,
      ballId: ball.id,
      position: { ...ball.wireformState.position },
    };
  }

  /** Captures a ball inside the center Hypercore Lock Saucer. */
  public captureInSaucer(ball: ManagedBall): PhysicsEvent | null {
    if (ball.zone !== 'playfield' || ball.saucerCooldown > 0 || this.isSaucerOccupied()) {
      return null;
    }

    const saucer = this.layout.saucer;
    const r = ball.body.rotation();
    ball.saucerPosition = {
      x: saucer.position.x,
      y: BALL_RADIUS * 0.72,
      z: saucer.position.z,
    };
    ball.saucerRotation = { x: r.x, y: r.y, z: r.z, w: r.w };
    ball.zone = 'saucer';
    ball.saucerHoldTimer = SAUCER_HOLD_DURATION;
    ball.stuckTimer = 0;

    ball.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    ball.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    ball.body.setTranslation(ball.saucerPosition, false);
    ball.body.setEnabled(false);

    return {
      type: 'saucerCapture',
      id: saucer.id,
      ballId: ball.id,
      position: { ...ball.saucerPosition },
    };
  }

  /** Ejects any ball currently held in the Hypercore Saucer cleanly toward the right flipper. */
  public releaseSaucerBall(): PhysicsEvent | null {
    let heldBall: ManagedBall | null = null;
    for (const ball of this.balls.values()) {
      if (ball.zone === 'saucer') {
        heldBall = ball;
        break;
      }
    }
    if (!heldBall) {
      return null;
    }

    const saucer = this.layout.saucer;
    const ejectPos: Vec3 = {
      x: saucer.position.x + saucer.ejectDirection.x * 0.24,
      y: BALL_RADIUS,
      z: saucer.position.z + saucer.ejectDirection.z * 0.24,
    };

    heldBall.zone = 'playfield';
    heldBall.saucerHoldTimer = 0;
    heldBall.saucerCooldown = 0.48;
    heldBall.stuckTimer = 0;

    heldBall.collider.setCollisionGroups(INTERACTION_BALL_PLAYFIELD);
    heldBall.body.setEnabled(true);
    heldBall.body.setTranslation(ejectPos, true);
    heldBall.body.setLinvel(
      {
        x: saucer.ejectDirection.x * SAUCER_EJECT_SPEED,
        y: 0,
        z: saucer.ejectDirection.z * SAUCER_EJECT_SPEED,
      },
      true,
    );
    heldBall.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    heldBall.body.wakeUp();

    return {
      type: 'saucerEject',
      id: saucer.id,
      ballId: heldBall.id,
      position: ejectPos,
    };
  }

  /**
   * Finds the lowest ball currently sitting in the shooter plunger launch zone
   * (if any) so PlungerPhysics can launch it or stay safely behind it.
   */
  public findBallInPlungerZone(): ManagedBall | null {
    const laneX = this.layout.plunger.laneCenterX;
    let lowest: ManagedBall | null = null;
    let maxZ = -Infinity;

    for (const ball of this.balls.values()) {
      if (ball.zone !== 'shooter' && ball.zone !== 'playfield') {
        continue;
      }
      const p = this.getBallPosition(ball);
      const v = this.getBallVelocity(ball);
      // Never intercept or overwrite velocity of a ball already rocketing upward out of the lane.
      if (v.z < -8.0) {
        continue;
      }
      if (Math.abs(p.x - laneX) <= 0.48 && p.z >= 6.5 && p.z <= 10.55) {
        if (p.z > maxZ) {
          maxZ = p.z;
          lowest = ball;
        }
      }
    }
    return lowest;
  }

  /**
   * Advances wireform spline balls, saucer timers, ramp rollback/apex guards,
   * shooter-to-playfield zone tracking, speed/bounds clamping, and the Anti-Stuck watchdog.
   */
  public stepSubstep(dt: number, flippers: FlipperPhysics): PhysicsEvent[] {
    const events: PhysicsEvent[] = [];
    const gate = this.layout.oneWayGate;
    const rampEntry = this.layout.warpRamp.entrySensor;
    const rampApex = this.layout.warpRamp.apexSensor;

    // Collect drains separately so we don't mutate the map mid-iteration.
    const toDrain: number[] = [];

    for (const ball of this.balls.values()) {
      if (ball.saucerCooldown > 0) {
        ball.saucerCooldown = Math.max(0, ball.saucerCooldown - dt);
      }
      if (ball.rampCooldown > 0) {
        ball.rampCooldown = Math.max(0, ball.rampCooldown - dt);
      }
      if (ball.wallHitCooldown > 0) {
        ball.wallHitCooldown = Math.max(0, ball.wallHitCooldown - dt);
      }

      // 1. Wireform rail spline stepping & handoff back to Rapier3D
      if (ball.zone === 'wireform' && ball.wireformState) {
        this.wireformRail.stepBall(ball.wireformState, dt);
        if (ball.wireformState.finished) {
          const exitPos = { ...ball.wireformState.position };
          const exitVel = { ...ball.wireformState.velocity };
          const exitAngVel = { ...ball.wireformState.angularVelocity };
          const exitRot = { ...ball.wireformState.rotation };

          ball.wireformState = null;
          ball.zone = 'playfield';
          ball.stuckTimer = 0;

          ball.collider.setCollisionGroups(INTERACTION_BALL_PLAYFIELD);
          ball.body.setEnabled(true);
          ball.body.setTranslation(exitPos, true);
          ball.body.setRotation(exitRot, true);
          ball.body.setLinvel(exitVel, true);
          ball.body.setAngvel(exitAngVel, true);
          ball.body.wakeUp();

          events.push({
            type: 'wireformExit',
            ballId: ball.id,
            position: exitPos,
          });
        }
        continue;
      }

      // 2. Hypercore Saucer hold countdown & auto-eject
      if (ball.zone === 'saucer') {
        ball.saucerHoldTimer -= dt;
        if (ball.saucerHoldTimer <= 0) {
          const ejectEvent = this.releaseSaucerBall();
          if (ejectEvent) {
            events.push(ejectEvent);
          }
        }
        continue;
      }

      // 3. Dynamic Rapier ball checks
      const pos = ball.body.translation();
      const vel = ball.body.linvel();
      let speed = Math.hypot(vel.x, vel.y, vel.z);

      // Guard against NaN or runaway velocities
      if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
        ball.body.setTranslation(
          { x: ACTIVE_CENTER_X, y: BALL_RADIUS, z: 0 },
          true,
        );
        ball.body.setLinvel({ x: 0, y: 0, z: 8 }, true);
        continue;
      }

      if (speed > MAX_BALL_SPEED) {
        const scale = MAX_BALL_SPEED / speed;
        ball.body.setLinvel(
          { x: vel.x * scale, y: vel.y * scale, z: vel.z * scale },
          true,
        );
        speed = MAX_BALL_SPEED;
      }

      // Keep vertical position safely inside cabinet envelope
      if (pos.y < BALL_RADIUS - 0.12) {
        ball.body.setTranslation({ x: pos.x, y: BALL_RADIUS, z: pos.z }, true);
        if (vel.y < 0) {
          ball.body.setLinvel({ x: vel.x, y: 0, z: vel.z }, true);
        }
      } else if (pos.y > PLAYFIELD_GLASS_Y - BALL_RADIUS) {
        ball.body.setTranslation(
          { x: pos.x, y: PLAYFIELD_GLASS_Y - BALL_RADIUS, z: pos.z },
          true,
        );
        if (vel.y > 0) {
          ball.body.setLinvel({ x: vel.x, y: -Math.abs(vel.y) * 0.2, z: vel.z }, true);
        }
      }

      // 4. Shooter -> Playfield zone transition ONLY once ball physically clears ONE_WAY_GATE
      if (ball.zone === 'shooter') {
        const signed = signedDistanceAlong(
          { x: pos.x, z: pos.z },
          gate.center,
          gate.allowedDirection,
        );
        const clearedGate = signed > 0.34;
        const inActivePlayfield = pos.x < SHOOTER_LANE_MIN_X - 0.35 && pos.z > -5.4;
        if (clearedGate || inActivePlayfield) {
          ball.zone = 'playfield';
          ball.exitingShooterGate = false;
          events.push({
            type: 'shooterExit',
            ballId: ball.id,
            speed,
          });
        }
      }

      // 5. Continuous Warp Ramp entry (handles balls re-accelerated inside entrySensor
      //    or shot back upward during rollback cooldown), apex proximity & rollback checks
      if (ball.zone === 'playfield' && pos.y < 0.7) {
        const insideEntryMouth =
          Math.abs(pos.x - rampEntry.position.x) <= rampEntry.halfExtents.x &&
          Math.abs(pos.z - rampEntry.position.z) <= rampEntry.halfExtents.z + BALL_RADIUS;
        if (insideEntryMouth) {
          const entryDir = rampEntry.entryDirection;
          const vDotEntry = vel.x * entryDir.x + vel.z * entryDir.z;
          const deliberateClimb = vDotEntry > 3.5;
          const deepSlowCreep = pos.z <= rampEntry.position.z - 0.15 && vDotEntry > 0.25;
          if (deliberateClimb || deepSlowCreep) {
            const entryEvent = this.enterRamp(ball, true);
            if (entryEvent) {
              events.push(entryEvent);
            }
          }
        }
      } else if (ball.zone === 'ramp') {
        const distToApex = Math.hypot(
          pos.x - rampApex.position.x,
          pos.y - rampApex.position.y,
          pos.z - rampApex.position.z,
        );
        if (distToApex <= rampApex.radius) {
          const completeEvent = this.enterWireform(ball);
          if (completeEvent) {
            events.push(completeEvent);
          }
          continue;
        }

        // Weak-shot rollback back onto GROUP_PLAYFIELD only once descending past z = -2.50
        // (well clear of the z <= -2.97 playfield ramp sidewalls; never above z = -2.85)
        const rollingBackPastEntry =
          ball.rampCooldown <= 0 &&
          pos.y < 0.68 &&
          pos.z > -2.85 &&
          ((pos.z > rampEntry.position.z + 0.1 && vel.z > 0.35) || pos.z > -1.85);
        if (rollingBackPastEntry) {
          const rollbackEvent = this.rollbackFromRamp(ball);
          if (rollbackEvent) {
            events.push(rollbackEvent);
          }
        }
      }

      // 6. Safety out-of-bounds / drain fallback
      if (
        pos.z > PLAYFIELD_MAX_Z - 0.12 &&
        pos.x < SHOOTER_LANE_MIN_X - 0.12 &&
        ball.zone !== 'shooter'
      ) {
        toDrain.push(ball.id);
        continue;
      }
      if (
        pos.x < PLAYFIELD_MIN_X - 0.5 ||
        pos.x > PLAYFIELD_MAX_X + 0.5 ||
        pos.z < PLAYFIELD_MIN_Z - 0.5 ||
        pos.z > PLAYFIELD_MAX_Z + 0.5
      ) {
        ball.collider.setCollisionGroups(INTERACTION_BALL_PLAYFIELD);
        ball.zone = 'playfield';
        ball.body.setTranslation({ x: ACTIVE_CENTER_X, y: BALL_RADIUS, z: 0 }, true);
        ball.body.setLinvel({ x: 0, y: 0, z: 10 }, true);
        ball.stuckTimer = 0;
        continue;
      }

      // 7. Anti-Stuck watchdog (>4s stationary outside shooter lane, raised flipper cradle, saucer)
      const inShooterLane =
        ball.zone === 'shooter' || (pos.x >= SHOOTER_LANE_MIN_X - 0.18 && pos.z >= -6.2);
      const cradled = flippers.isAnyBallCradled({ x: pos.x, y: pos.y, z: pos.z });

      if (!inShooterLane && !cradled && speed < ANTI_STUCK_SPEED_THRESHOLD) {
        ball.stuckTimer += dt;
        if (ball.stuckTimer >= ANTI_STUCK_TIMEOUT) {
          if (ball.zone === 'ramp') {
            if (pos.y < 0.7) {
              const rb = this.rollbackFromRamp(ball);
              if (rb) {
                events.push(rb);
              }
            }
            ball.body.setLinvel({ x: 0.4, y: 0, z: 10.0 }, true);
          } else {
            const nudgeX = pos.x < ACTIVE_CENTER_X ? 5.5 : -5.5;
            ball.body.setLinvel({ x: nudgeX, y: 0, z: 8.5 }, true);
          }
          ball.body.wakeUp();
          ball.stuckTimer = 0;
        }
      } else {
        ball.stuckTimer = 0;
      }
    }

    for (const ballId of toDrain) {
      const drainEvent = this.drainBall(ballId);
      if (drainEvent) {
        events.push(drainEvent);
      }
    }

    return events;
  }

  public getBallStates(): BallState[] {
    const out: BallState[] = [];
    for (const ball of this.balls.values()) {
      if (ball.zone === 'wireform' && ball.wireformState) {
        const ws = ball.wireformState;
        out.push({
          id: ball.id,
          position: { ...ws.position },
          rotation: { ...ws.rotation },
          velocity: { ...ws.velocity },
          speed: ws.speed,
          zone: 'wireform',
          active: true,
        });
        continue;
      }

      if (ball.zone === 'saucer') {
        out.push({
          id: ball.id,
          position: { ...ball.saucerPosition },
          rotation: { ...ball.saucerRotation },
          velocity: { x: 0, y: 0, z: 0 },
          speed: 0,
          zone: 'saucer',
          active: true,
        });
        continue;
      }

      const t = ball.body.translation();
      const r = ball.body.rotation();
      const v = ball.body.linvel();
      out.push({
        id: ball.id,
        position: { x: t.x, y: t.y, z: t.z },
        rotation: { x: r.x, y: r.y, z: r.z, w: r.w },
        velocity: { x: v.x, y: v.y, z: v.z },
        speed: Math.hypot(v.x, v.y, v.z),
        zone: ball.zone,
        active: ball.active,
      });
    }
    return out;
  }
}
