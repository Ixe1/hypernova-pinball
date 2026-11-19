import { afterEach, describe, expect, it } from 'vitest';
import {
  BALL_RADIUS,
  BALL_SAVE_DURATION_SEC,
  FIXED_DT,
  MAX_FRAME_DT,
  PLAYFIELD_GLASS_Y,
} from '../src/config/constants';
import {
  DROP_TARGETS,
  FLIPPERS,
  HYPERCORE_SAUCER,
  KICKBACK,
  ONE_WAY_GATE,
  POP_BUMPERS,
  ROLLOVER_LANES,
  SLINGSHOTS,
  SPINNER,
  STANDUP_TARGETS,
} from '../src/config/tableLayout';
import type { PhysicsEvent } from '../src/config/types';
import { GameState, SCORE_SKILL_SHOT } from '../src/game/GameState';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import {
  PLUNGER_SKILL_SHOT_TENSION,
  PLUNGER_SKILL_SHOT_TENSIONS,
} from '../src/physics/PlungerPhysics';

const deterministicRng = () => 0.5;

describe('PhysicsWorld Integration (Headless Rapier3D @ 480 Hz)', () => {
  const worldsToDispose: PhysicsWorld[] = [];

  async function createWorld(spawnInitialBall = false): Promise<PhysicsWorld> {
    const world = await PhysicsWorld.create({
      rng: deterministicRng,
      spawnInitialBall,
    });
    worldsToDispose.push(world);
    return world;
  }

  afterEach(() => {
    while (worldsToDispose.length > 0) {
      worldsToDispose.pop()?.dispose();
    }
  });

  it('never tunnels a fast ball through a rapidly swinging flipper across base, mid, and tip', async () => {
    const leftFlipper = FLIPPERS.find((f) => f.side === 'left')!;
    const fractions = [0.22, 0.52, 0.84];

    for (const frac of fractions) {
      const world = await createWorld(false);

      const angle = leftFlipper.restAngle;
      const armX = leftFlipper.direction * Math.cos(angle);
      const armZ = -leftFlipper.direction * Math.sin(angle);
      const upX = -Math.sin(angle);
      const upZ = -Math.cos(angle);

      const spawnX =
        leftFlipper.pivot.x + armX * (leftFlipper.length * frac) + upX * (BALL_RADIUS + 0.35);
      const spawnZ =
        leftFlipper.pivot.z + armZ * (leftFlipper.length * frac) + upZ * (BALL_RADIUS + 0.35);

      world.spawnBallAt(
        { x: spawnX, y: BALL_RADIUS, z: spawnZ },
        { x: 0, y: 0, z: 22.0 },
        'playfield',
      );

      let drained = false;
      let reversedUpward = false;
      let maxZ = spawnZ;

      for (let step = 0; step < 180; step++) {
        // Trigger upward swing right as the fast ball arrives at the bat
        const press = step >= 4 && step < 90;
        const events = world.stepSubsteps(1, { leftFlipper: press });
        if (events.some((e) => e.type === 'drain')) {
          drained = true;
        }
        const ball = world.getSnapshot().balls[0];
        if (ball) {
          if (ball.position.z > maxZ) {
            maxZ = ball.position.z;
          }
          if (ball.velocity.z < -8.0) {
            reversedUpward = true;
          }
        }
      }

      expect(drained, `ball tunneled and drained at fraction ${frac}`).toBe(false);
      expect(reversedUpward, `ball did not rebound upward at fraction ${frac}`).toBe(true);
      expect(maxZ, `ball penetrated past flipper line at fraction ${frac}`).toBeLessThan(9.35);
    }
  });

  it('launches tip hits faster than base hits and achieves vz < -35 near the tip', async () => {
    const leftFlipper = FLIPPERS.find((f) => f.side === 'left')!;

    async function measurePeakUpwardVz(frac: number): Promise<number> {
      const world = await createWorld(false);
      const angle = leftFlipper.restAngle;
      const armX = leftFlipper.direction * Math.cos(angle);
      const armZ = -leftFlipper.direction * Math.sin(angle);
      const upX = -Math.sin(angle);
      const upZ = -Math.cos(angle);

      const localRadius =
        leftFlipper.baseRadius + (leftFlipper.tipRadius - leftFlipper.baseRadius) * frac;
      const spawnX =
        leftFlipper.pivot.x +
        armX * (leftFlipper.length * frac) +
        upX * (localRadius + BALL_RADIUS + 0.03);
      const spawnZ =
        leftFlipper.pivot.z +
        armZ * (leftFlipper.length * frac) +
        upZ * (localRadius + BALL_RADIUS + 0.03);

      world.spawnBallAt(
        { x: spawnX, y: BALL_RADIUS, z: spawnZ },
        { x: 0, y: 0, z: 3.0 },
        'playfield',
      );

      // Let ball settle into contact with resting bat for ~12ms
      world.stepSubsteps(6, { leftFlipper: false });

      let minVz = 0;
      for (let i = 0; i < 60; i++) {
        world.stepSubsteps(1, { leftFlipper: true });
        const ball = world.getSnapshot().balls[0];
        if (ball && ball.velocity.z < minVz) {
          minVz = ball.velocity.z;
        }
      }
      return minVz;
    }

    const baseMinVz = await measurePeakUpwardVz(0.22);
    const midMinVz = await measurePeakUpwardVz(0.55);
    const tipMinVz = await measurePeakUpwardVz(0.88);

    expect(tipMinVz).toBeLessThan(-35.0);
    expect(tipMinVz).toBeLessThan(midMinVz);
    expect(midMinVz).toBeLessThan(baseMinVz);
  });

  it('smoothly cradles a rolling ball on a raised flipper without popping it out', async () => {
    const world = await createWorld(false);

    // Raise left flipper fully first
    world.stepSubsteps(60, { leftFlipper: true });

    // Place a slowly rolling ball in the left inlane feeding onto the raised flipper cradle
    world.spawnBallAt(
      { x: -3.55, y: BALL_RADIUS, z: 6.4 },
      { x: 1.8, y: 0, z: 3.2 },
      'playfield',
    );

    let drained = false;
    // Simulate 2.2 seconds (1056 substeps at 480 Hz) holding the left flipper raised
    for (let i = 0; i < 1056; i++) {
      const events = world.stepSubsteps(1, { leftFlipper: true });
      if (events.some((e) => e.type === 'drain')) {
        drained = true;
      }
    }

    expect(drained).toBe(false);
    const snap = world.getSnapshot();
    expect(snap.balls).toHaveLength(1);
    const ball = snap.balls[0];

    // Ball settles completely still inside the left flipper cradle V-pocket
    expect(ball.position.x).toBeGreaterThan(-4.1);
    expect(ball.position.x).toBeLessThan(-1.5);
    expect(ball.position.z).toBeGreaterThan(6.5);
    expect(ball.position.z).toBeLessThan(8.2);
    expect(ball.speed).toBeLessThan(0.25);
  });

  it('full plunger launch clears the shooter lane around the top arch past the one-way gate', async () => {
    const world = await createWorld(true);
    const allEvents: PhysicsEvent[] = [];

    // Hold plunger for ~1.0s to reach full tension = 1.0
    for (let i = 0; i < 480; i++) {
      allEvents.push(...world.stepSubsteps(1, { plungerHeld: true }));
    }
    expect(world.getSnapshot().plungerTension).toBeCloseTo(1.0, 2);

    // Release plunger and simulate 2.5 seconds
    let enteredPlayfield = false;
    let reachedTopArch = false;
    for (let i = 0; i < 1200; i++) {
      allEvents.push(...world.stepSubsteps(1, { plungerHeld: false }));
      const ball = world.getSnapshot().balls[0];
      if (!ball) {
        break;
      }
      if (ball.position.z < -8.6 && ball.position.x < 3.4) {
        reachedTopArch = true;
      }
      if (ball.zone === 'playfield' && ball.position.x < 3.2) {
        enteredPlayfield = true;
      }
    }

    expect(allEvents.some((e) => e.type === 'plungerLaunch')).toBe(true);
    expect(allEvents.some((e) => e.type === 'shooterExit')).toBe(true);
    expect(reachedTopArch).toBe(true);
    expect(enteredPlayfield).toBe(true);
    expect(world.getSnapshot().hasBallInShooter).toBe(false);
  });

  it('keeps weak plunger pulls (<45%) in shooter lane without burning timers and awards Skill Shot (+25,000) for exact I/O/N targets across 100% of jitter bounds', async () => {
    // 1. Weak pulls (<45%) stay in shooter lane without clearing ONE_WAY_GATE,
    //    emitting shooterExit, or exiting LAUNCH_READY / burning Ball Save timers.
    for (const weakTension of [0.25, 0.35, 0.42, 0.44]) {
      const world = await createWorld(true);
      const game = new GameState();
      game.startNewGame();
      game.consumeCommands();

      world.stepSubsteps(288, { plungerDragTension: weakTension });
      const events: PhysicsEvent[] = [];
      const releaseEvts = world.stepSubsteps(1, { plungerDragTension: null });
      events.push(...releaseEvts);
      for (const e of releaseEvts) {
        game.handlePhysicsEvent(e);
      }

      for (let i = 0; i < 480 * 3.0; i++) {
        const stepEvts = world.stepSubsteps(1);
        events.push(...stepEvts);
        for (const e of stepEvts) {
          game.handlePhysicsEvent(e);
        }
        game.update(FIXED_DT);
      }

      expect(events.some((e) => e.type === 'plungerLaunch')).toBe(true);
      expect(
        events.some((e) => e.type === 'shooterExit'),
        `weak tension ${weakTension} unexpectedly emitted shooterExit`,
      ).toBe(false);
      const physSnap = world.getSnapshot();
      expect(physSnap.hasBallInShooter).toBe(true);
      expect(physSnap.balls[0]?.zone).toBe('shooter');
      const gameSnap = game.getSnapshot();
      expect(gameSnap.phase).toBe('LAUNCH_READY');
      expect(gameSnap.ballSaveTimer).toBe(BALL_SAVE_DURATION_SEC);
    }

    // 2. End-to-end PhysicsWorld + GameState: across 100% of jitter extremes (rng = 0, 0.5, 1),
    //    pulling dead-on [tI=62%, tO=58%, tN=53%] for Ball 1 (I), Ball 2 (O), and Ball 3 (N)
    //    clears the 28-segment arch past ONE_WAY_GATE, emits shooterExit, hits the EXACT
    //    target lane within 5.0s, and awards SKILL SHOT (+25,000).
    const expectedLanes = ['I', 'O', 'N'] as const;

    for (const rngVal of [0, 0.5, 1]) {
      const world = await PhysicsWorld.create({
        rng: () => rngVal,
        spawnInitialBall: false,
      });
      worldsToDispose.push(world);

      const game = new GameState();
      game.startNewGame();
      game.consumeCommands();

      for (let ballIdx = 0; ballIdx < 3; ballIdx++) {
        world.resetTable(true);
        const startSnap = game.getSnapshot();
        expect(startSnap.phase).toBe('LAUNCH_READY');
        expect(startSnap.ballNumber).toBe(ballIdx + 1);
        expect(startSnap.skillShotLaneIndex).toBe(ballIdx);

        const targetTension = PLUNGER_SKILL_SHOT_TENSIONS[ballIdx];
        const scoreBefore = startSnap.score;

        world.stepSubsteps(288, { plungerDragTension: targetTension });
        const relEvts = world.stepSubsteps(1, { plungerDragTension: null });
        for (const e of relEvts) {
          game.handlePhysicsEvent(e);
        }

        let shooterExitTime = -1;
        let hitRolloverLabel = '';
        let rolloverTime = -1;
        let sawSkillShotBanner = false;

        for (let i = 0; i < 480 * 5.0; i++) {
          const stepEvts = world.stepSubsteps(1);
          for (const e of stepEvts) {
            if (e.type === 'shooterExit' && shooterExitTime < 0) {
              shooterExitTime = i * FIXED_DT;
            }
            if (e.type === 'rollover' && !hitRolloverLabel) {
              hitRolloverLabel = e.label;
              rolloverTime = i * FIXED_DT;
            }
            game.handlePhysicsEvent(e);
          }
          game.update(FIXED_DT);

          const cmds = game.consumeCommands();
          if (cmds.some((c) => c.type === 'dmdBanner' && c.banner.title === 'SKILL SHOT!')) {
            sawSkillShotBanner = true;
          }
          if (hitRolloverLabel && sawSkillShotBanner) {
            break;
          }
        }

        const expectedLabel = expectedLanes[ballIdx];
        expect(
          shooterExitTime,
          `Ball ${ballIdx + 1} (rng=${rngVal}) failed to emit shooterExit`,
        ).toBeGreaterThan(0);
        expect(
          hitRolloverLabel,
          `Ball ${ballIdx + 1} (${Math.round(targetTension * 100)}%, rng=${rngVal}) missed ${expectedLabel}`,
        ).toBe(expectedLabel);
        expect(rolloverTime - shooterExitTime).toBeGreaterThan(0);
        expect(rolloverTime - shooterExitTime).toBeLessThan(5.0);
        expect(sawSkillShotBanner).toBe(true);
        expect(game.getSnapshot().score - scoreBefore).toBeGreaterThanOrEqual(SCORE_SKILL_SHOT);
        expect(world.getSnapshot().hasBallInShooter).toBe(false);

        // Advance cleanly to next ball via drain after ball-save expires
        if (ballIdx < 2) {
          game.update(13.0);
          game.handlePhysicsEvent({
            type: 'drain',
            ballId: 1,
            position: { x: 0, y: BALL_RADIUS, z: 10.4 },
          });
          for (let t = 0; t < 40 && game.getSnapshot().phase === 'BALL_BONUS'; t++) {
            game.update(0.25);
          }
          game.consumeCommands();
        }
      }
    }
  });

  it('blocks playfield balls from re-entering the shooter lane through the one-way gate', async () => {
    const world = await createWorld(false);
    // Spawn ball on the playfield side of the one-way gate heading clockwise back into the gate
    const gate = ONE_WAY_GATE;
    const startX = gate.center.x + gate.allowedDirection.x * 1.1;
    const startZ = gate.center.z + gate.allowedDirection.z * 1.1;

    world.spawnBallAt(
      { x: startX, y: BALL_RADIUS, z: startZ },
      {
        x: -gate.allowedDirection.x * 26,
        y: 0,
        z: -gate.allowedDirection.z * 26,
      },
      'playfield',
    );

    let enteredShooterLane = false;
    for (let i = 0; i < 240; i++) {
      world.stepSubsteps(1);
      const ball = world.getSnapshot().balls[0];
      if (ball && ball.position.x > 4.35 && ball.position.z > -6.0) {
        enteredShooterLane = true;
      }
    }

    expect(enteredShooterLane).toBe(false);
  });

  it('triggers pop bumper radial kick, slingshot kick, drop target knockdown/reset, spinner ticks, and shield kickback', async () => {
    // 1. Pop bumper test
    {
      const world = await createWorld(false);
      const b0 = POP_BUMPERS[0];
      world.spawnBallAt(
        { x: b0.position.x, y: BALL_RADIUS, z: b0.position.z + b0.radius + BALL_RADIUS + 0.3 },
        { x: 0, y: 0, z: -18 },
        'playfield',
      );
      let bumperEvt: PhysicsEvent | undefined;
      let kickedVz = 0;
      for (let i = 0; i < 80; i++) {
        const stepEvents = world.stepSubsteps(1);
        const found = stepEvents.find((e) => e.type === 'bumper');
        if (found) {
          bumperEvt = found;
          kickedVz = world.getSnapshot().balls[0]?.velocity.z ?? 0;
          break;
        }
      }
      expect(bumperEvt).toBeDefined();
      expect(world.getSnapshot().bumperFlashTimers[0]).toBeGreaterThan(0);
      // Kicked radially back toward +Z away from bumper_0 at solenoid speed
      expect(kickedVz).toBeGreaterThan(20.0);
    }

    // 2. Slingshot active hypotenuse test
    {
      const world = await createWorld(false);
      const sling = SLINGSHOTS[0];
      const midX = (sling.activeEdge[0].x + sling.activeEdge[1].x) * 0.5;
      const midZ = (sling.activeEdge[0].z + sling.activeEdge[1].z) * 0.5;
      world.spawnBallAt(
        {
          x: midX + sling.kickNormal.x * 0.85,
          y: BALL_RADIUS,
          z: midZ + sling.kickNormal.z * 0.85,
        },
        {
          x: -sling.kickNormal.x * 16,
          y: 0,
          z: -sling.kickNormal.z * 16,
        },
        'playfield',
      );
      const events = world.stepSubsteps(80);
      expect(events.some((e) => e.type === 'slingshot' && e.side === 'left')).toBe(true);
      const ball = world.getSnapshot().balls[0];
      expect(ball!.velocity.x).toBeGreaterThan(15.0);
    }

    // 3. Drop target knockdown & reset test
    {
      const world = await createWorld(false);
      const dropR = DROP_TARGETS[0];
      world.spawnBallAt(
        {
          x: dropR.position.x + dropR.normal.x * 0.9,
          y: BALL_RADIUS,
          z: dropR.position.z + dropR.normal.z * 0.9,
        },
        {
          x: -dropR.normal.x * 20,
          y: 0,
          z: -dropR.normal.z * 20,
        },
        'playfield',
      );
      const events = world.stepSubsteps(90);
      expect(events.some((e) => e.type === 'dropTarget' && e.label === 'R')).toBe(true);
      expect(world.getSnapshot().dropTargetsDropped[0]).toBe(true);

      // Reset drop targets (without resetTable) and fire a second ball directly at target R
      // to prove resetDropTargets() itself re-enabled the Rapier collider
      world.resetDropTargets();
      expect(world.getSnapshot().dropTargetsDropped[0]).toBe(false);

      const secondBallId = world.spawnBallAt(
        {
          x: dropR.position.x + dropR.normal.x * 0.9,
          y: BALL_RADIUS,
          z: dropR.position.z + dropR.normal.z * 0.9,
        },
        {
          x: -dropR.normal.x * 20,
          y: 0,
          z: -dropR.normal.z * 20,
        },
        'playfield',
      );
      expect(secondBallId).not.toBeNull();
      const secondHitEvents = world.stepSubsteps(90);
      expect(
        secondHitEvents.some(
          (e) => e.type === 'dropTarget' && e.label === 'R' && e.ballId === secondBallId,
        ),
      ).toBe(true);
      expect(world.getSnapshot().dropTargetsDropped[0]).toBe(true);
    }

    // 4. Spinner half-revolution ticks test
    {
      const world = await createWorld(false);
      world.spawnBallAt(
        { x: SPINNER.position.x, y: BALL_RADIUS, z: SPINNER.position.z + 0.8 },
        { x: 0, y: 0, z: -38 },
        'playfield',
      );
      const events = world.stepSubsteps(240);
      const spinnerEvents = events.filter((e) => e.type === 'spinner');
      expect(spinnerEvents.length).toBeGreaterThanOrEqual(3);
      expect(Math.abs(world.getSnapshot().spinnerAngle)).toBeGreaterThan(Math.PI);
    }

    // 5. Left outlane Shield Kickback test
    {
      const world = await createWorld(false);
      world.setKickbackArmed(true);
      world.spawnBallAt(
        { x: KICKBACK.position.x, y: BALL_RADIUS, z: KICKBACK.position.z - 1.0 },
        { x: 0, y: 0, z: 14 },
        'playfield',
      );
      let kickbackFired = false;
      let kickedVz = 0;
      for (let i = 0; i < 120; i++) {
        const stepEvents = world.stepSubsteps(1);
        if (stepEvents.some((e) => e.type === 'kickback')) {
          kickbackFired = true;
          kickedVz = world.getSnapshot().balls[0]?.velocity.z ?? 0;
          break;
        }
      }
      expect(kickbackFired).toBe(true);
      expect(world.getSnapshot().kickbackArmed).toBe(false);
      expect(kickedVz).toBeLessThan(-35.0);
    }
  });

  it('high-speed Warp Ramp shot crests into Chrome Wireform and exits above left inlane, while weak shot stalls and rolls back onto PLAYFIELD', async () => {
    // High-speed ramp climb -> wireform -> left inlane exit
    {
      const world = await createWorld(false);
      world.spawnBallAt(
        { x: -3.02, y: BALL_RADIUS, z: -1.6 },
        { x: -3.0, y: 0, z: -45.0 },
        'playfield',
      );

      const events: PhysicsEvent[] = [];
      let maxY = 0;
      let sawWireform = false;

      for (let i = 0; i < 2000; i++) {
        events.push(...world.stepSubsteps(1));
        const ball = world.getSnapshot().balls[0];
        if (ball) {
          if (ball.position.y > maxY) {
            maxY = ball.position.y;
          }
          if (ball.zone === 'wireform') {
            sawWireform = true;
          }
        }
        if (events.some((e) => e.type === 'wireformExit')) {
          break;
        }
      }

      expect(events.some((e) => e.type === 'rampEntry')).toBe(true);
      expect(maxY).toBeGreaterThan(1.55);
      expect(events.some((e) => e.type === 'rampComplete')).toBe(true);
      expect(sawWireform).toBe(true);

      const exitEvt = events.find((e) => e.type === 'wireformExit');
      expect(exitEvt).toBeDefined();
      if (exitEvt && exitEvt.type === 'wireformExit') {
        expect(exitEvt.position.x).toBeCloseTo(-3.75, 1);
        expect(exitEvt.position.z).toBeCloseTo(5.0, 1);
      }

      // After wireform exit, ball is cleanly back on playfield heading down left inlane
      const postExitBall = world.getSnapshot().balls[0];
      expect(postExitBall).toBeDefined();
      expect(postExitBall!.zone).toBe('playfield');
    }

    // Weak ramp shot stalls partway up and rolls smoothly back onto GROUP_PLAYFIELD
    {
      const world = await createWorld(false);
      world.spawnBallAt(
        { x: -3.02, y: BALL_RADIUS, z: -1.6 },
        { x: -1.8, y: 0, z: -16.0 },
        'playfield',
      );

      const events: PhysicsEvent[] = [];
      let sawRampZone = false;
      let peakHeight = 0;

      for (let i = 0; i < 1200; i++) {
        events.push(...world.stepSubsteps(1));
        const ball = world.getSnapshot().balls[0];
        if (ball) {
          if (ball.zone === 'ramp') {
            sawRampZone = true;
          }
          if (ball.position.y > peakHeight) {
            peakHeight = ball.position.y;
          }
        }
        if (events.some((e) => e.type === 'rampRollback')) {
          break;
        }
      }

      expect(events.some((e) => e.type === 'rampEntry')).toBe(true);
      expect(sawRampZone).toBe(true);
      expect(peakHeight).toBeGreaterThan(BALL_RADIUS + 0.05);
      expect(events.some((e) => e.type === 'rampComplete')).toBe(false);
      expect(events.some((e) => e.type === 'rampRollback')).toBe(true);

      const ball = world.getSnapshot().balls[0];
      expect(ball).toBeDefined();
      expect(ball!.zone).toBe('playfield');
    }
  });

  it('captures & ejects in Hypercore Saucer, supports 3-ball multiball, respects TILT flipper lock, and enforces glass ceiling', async () => {
    const world = await createWorld(false);

    // Saucer capture & controlled release
    world.spawnBallAt(
      { x: HYPERCORE_SAUCER.position.x, y: BALL_RADIUS, z: HYPERCORE_SAUCER.position.z + 1.0 },
      { x: 0, y: 0, z: -14 },
      'playfield',
    );
    const captureEvents = world.stepSubsteps(120);
    expect(captureEvents.some((e) => e.type === 'saucerCapture')).toBe(true);
    expect(world.getSnapshot().saucerOccupied).toBe(true);

    const ejectEvt = world.releaseSaucerBall();
    expect(ejectEvt?.type).toBe('saucerEject');
    expect(world.getSnapshot().saucerOccupied).toBe(false);

    // Spawn 3-ball multiball
    world.spawnMultiball(3);
    expect(world.getSnapshot().balls).toHaveLength(3);

    // Verify frame accumulator `step(dt)` clamps huge lag spikes to MAX_FRAME_DT (1/30s)
    world.resetTable(false);
    const startZ = -2.0;
    const launchVz = 20.0;
    world.spawnBallAt({ x: 0, y: BALL_RADIUS, z: startZ }, { x: 0, y: 0, z: launchVz }, 'playfield');
    world.step(0.25, { leftFlipper: false, rightFlipper: false });
    const clampedBall = world.getSnapshot().balls[0];
    expect(clampedBall).toBeDefined();
    const traveledZ = clampedBall!.position.z - startZ;
    // Expected displacement for MAX_FRAME_DT (1/30s): ~20 * (1/30) = 0.67 units (nowhere near 20 * 0.25 = 5.0)
    expect(traveledZ).toBeGreaterThan(launchVz * MAX_FRAME_DT * 0.65);
    expect(traveledZ).toBeLessThan(launchVz * MAX_FRAME_DT * 1.4);

    // TILT disables flippers
    world.setFlippersEnabled(false);
    world.stepSubsteps(60, { leftFlipper: true, rightFlipper: true });
    const leftDef = FLIPPERS.find((f) => f.side === 'left')!;
    expect(world.getSnapshot().flipperAngles.left).toBeCloseTo(leftDef.restAngle, 4);
    expect(world.getSnapshot().flippersEnabled).toBe(false);

    // Glass ceiling prevents upward ball escape
    world.resetTable(false);
    world.spawnBallAt({ x: 0, y: BALL_RADIUS, z: 0 }, { x: 0, y: 55, z: 0 }, 'playfield');
    let maxGlassY = 0;
    for (let i = 0; i < 120; i++) {
      world.stepSubsteps(1);
      const b = world.getSnapshot().balls[0];
      expect(b).toBeDefined();
      if (b!.position.y > maxGlassY) {
        maxGlassY = b!.position.y;
      }
      expect(b!.position.y).toBeLessThanOrEqual(PLAYFIELD_GLASS_Y - BALL_RADIUS + 0.08);
    }
    expect(maxGlassY).toBeGreaterThan(1.5);
  });

  it('triggers standup targets, I-O-N rollovers, nudge impulses, partial skill-shot plunges, and respects raised cradles in anti-stuck watchdog', async () => {
    // Standup target & rollover sensor
    {
      const world = await createWorld(false);
      const st = STANDUP_TARGETS[0];
      world.spawnBallAt(
        {
          x: st.position.x + st.normal.x * 0.85,
          y: BALL_RADIUS,
          z: st.position.z + st.normal.z * 0.85,
        },
        {
          x: -st.normal.x * 18,
          y: 0,
          z: -st.normal.z * 18,
        },
        'playfield',
      );
      const stEvents = world.stepSubsteps(90);
      expect(stEvents.some((e) => e.type === 'standup' && e.index === 0)).toBe(true);

      world.resetTable(false);
      const laneO = ROLLOVER_LANES[1];
      world.spawnBallAt(
        { x: laneO.position.x, y: BALL_RADIUS, z: laneO.position.z - 0.8 },
        { x: 0, y: 0, z: 12 },
        'playfield',
      );
      const rollEvents = world.stepSubsteps(90);
      expect(rollEvents.some((e) => e.type === 'rollover' && e.label === 'O')).toBe(true);
    }

    // Nudge impulse changes active ball velocity
    {
      const world = await createWorld(false);
      world.spawnBallAt({ x: 0, y: BALL_RADIUS, z: 0 }, { x: 0, y: 0, z: 0 }, 'playfield');
      world.applyNudgeImpulse(6.0, -4.0);
      world.stepSubsteps(1);
      const b = world.getSnapshot().balls[0]!;
      expect(b.velocity.x).toBeGreaterThan(4.5);
      expect(b.velocity.z).toBeLessThan(-2.5);
    }

    // Keyboard-hold Skill Shot (58%) launches softer than full pull, clears gate, and hits O lane
    {
      const world = await createWorld(true);
      const holdSteps = Math.round(PLUNGER_SKILL_SHOT_TENSION / (1.15 * FIXED_DT));
      world.stepSubsteps(holdSteps, { plungerHeld: true });
      const softEvents = world.stepSubsteps(1, { plungerHeld: false });
      const launch = softEvents.find((e) => e.type === 'plungerLaunch');
      expect(launch).toBeDefined();
      if (launch && launch.type === 'plungerLaunch') {
        expect(launch.speed).toBeGreaterThan(35);
        expect(launch.speed).toBeLessThan(40);
      }

      let clearedGate = false;
      let hitRollover = '';
      for (let i = 0; i < 480 * 3.0; i++) {
        const stepEvts = world.stepSubsteps(1);
        if (stepEvts.some((e) => e.type === 'shooterExit')) {
          clearedGate = true;
        }
        const ro = stepEvts.find((e) => e.type === 'rollover');
        if (ro && ro.type === 'rollover') {
          hitRollover = ro.label;
          break;
        }
      }
      expect(clearedGate).toBe(true);
      expect(hitRollover).toBe('O');
    }

    // Auto-launched ball moving swiftly up shooter lane does not show hasBallInShooter
    // and cannot have its velocity overwritten by a concurrent manual plunger release (MINOR #2)
    {
      const world = await createWorld(false);
      world.stepSubsteps(10, { plungerDragTension: 0.2 });
      world.spawnMultiball(1); // launches ball at (4.75, R, 8.8) with vz = -60
      expect(world.getSnapshot().hasBallInShooter).toBe(false);
      const releaseEvts = world.stepSubsteps(1, { plungerDragTension: null });
      expect(releaseEvts.some((e) => e.type === 'plungerLaunch')).toBe(false);
      expect(world.getSnapshot().balls[0]!.velocity.z).toBeLessThan(-50.0);
    }

    // Playfield ball fired horizontally at low Warp Ramp sidewall bounces off without clipping (MINOR #4)
    {
      const world = await createWorld(false);
      world.spawnBallAt({ x: -1.6, y: BALL_RADIUS, z: -4.15 }, { x: -18.0, y: 0, z: 0 }, 'playfield');
      let minX = 0;
      let bouncedRight = false;
      for (let i = 0; i < 80; i++) {
        world.stepSubsteps(1);
        const b = world.getSnapshot().balls[0]!;
        if (b.position.x < minX) {
          minX = b.position.x;
        }
        if (b.velocity.x > 4.0) {
          bouncedRight = true;
        }
      }
      expect(bouncedRight).toBe(true);
      expect(minX).toBeGreaterThan(-2.65);
    }

    // Playfield ball re-accelerated upward while already inside entrySensor (and immediately
    // after rampRollback within 0.25s cooldown) enters GROUP_RAMP cleanly without clipping (R5 MINOR #3)
    {
      const world = await createWorld(false);
      // Case A: Spawn stationary inside entrySensor, settle, then nudge/accelerate upward
      world.spawnBallAt({ x: -3.1, y: BALL_RADIUS, z: -2.55 }, { x: 0, y: 0, z: 0 }, 'playfield');
      world.stepSubsteps(5);
      world.applyNudgeImpulse(-1.2, -10.5);
      const reAccelEvts = world.stepSubsteps(20);
      expect(reAccelEvts.some((e) => e.type === 'rampEntry')).toBe(true);
      expect(world.getSnapshot().balls[0]!.zone).toBe('ramp');

      // Case B: Weak shot rolls back (triggers rampRollback + 0.25s cooldown), then an immediate
      // upward impulse inside entry mouth re-enters ramp instead of passing beneath the low deck
      world.resetTable(false);
      world.spawnBallAt({ x: -3.02, y: BALL_RADIUS, z: -1.6 }, { x: -1.8, y: 0, z: -15.5 }, 'playfield');
      let rolledBack = false;
      for (let i = 0; i < 1200; i++) {
        const evts = world.stepSubsteps(1);
        if (evts.some((e) => e.type === 'rampRollback')) {
          rolledBack = true;
          // Verify rollback never happens above z = -2.85
          const b = world.getSnapshot().balls[0]!;
          expect(b.position.z).toBeGreaterThan(-2.85);
          break;
        }
      }
      expect(rolledBack).toBe(true);

      // Immediately push the rolled-back ball back up into the ramp mouth during the 0.25s cooldown
      world.applyNudgeImpulse(-1.5, -12.0);
      world.applyNudgeImpulse(-1.5, -12.0);
      let reEntered = false;
      for (let i = 0; i < 60; i++) {
        const evts = world.stepSubsteps(1);
        if (evts.some((e) => e.type === 'rampEntry')) {
          reEntered = true;
          break;
        }
      }
      expect(reEntered).toBe(true);
      expect(world.getSnapshot().balls[0]!.zone).toBe('ramp');
    }

    // Cradled ball held > 4.5s on a raised flipper is NOT kicked out by anti-stuck watchdog
    {
      const world = await createWorld(false);
      world.stepSubsteps(60, { leftFlipper: true });
      world.spawnBallAt(
        { x: -3.55, y: BALL_RADIUS, z: 6.4 },
        { x: 1.8, y: 0, z: 3.2 },
        'playfield',
      );
      // 4.8s = 2304 substeps (> ANTI_STUCK_TIMEOUT of 4.0s)
      world.stepSubsteps(2304, { leftFlipper: true });
      const b = world.getSnapshot().balls[0];
      expect(b).toBeDefined();
      expect(b!.speed).toBeLessThan(0.5);
      expect(b!.position.z).toBeGreaterThan(6.5);
      expect(b!.position.z).toBeLessThan(8.2);
    }
  });
});
