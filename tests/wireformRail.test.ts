import { describe, expect, it } from 'vitest';
import { BALL_RADIUS, FIXED_DT, MIN_WIREFORM_SPEED } from '../src/config/constants';
import { WIREFORM_RAIL } from '../src/config/tableLayout';
import { MAX_WIREFORM_SPEED, WireformRail } from '../src/physics/WireformRail';

describe('WireformRail', () => {
  it('starts continuously at the Warp Ramp apex and exits cleanly above the left inlane', () => {
    const rail = new WireformRail(WIREFORM_RAIL);
    const start = rail.getPointAt(0);
    const exit = rail.getPointAt(1);

    expect(rail.totalLength).toBeGreaterThan(13.0);
    expect(rail.totalLength).toBeLessThan(16.0);

    expect(start.x).toBeCloseTo(-3.8, 3);
    expect(start.y).toBeCloseTo(1.45 + BALL_RADIUS, 3);
    expect(start.z).toBeCloseTo(-8.1, 3);

    expect(exit.x).toBeCloseTo(-3.75, 3);
    expect(exit.y).toBeCloseTo(0.35, 3);
    expect(exit.z).toBeCloseTo(5.0, 3);
  });

  it('descends monotonically in Y and has uniform arc-length parameterization', () => {
    const rail = new WireformRail(WIREFORM_RAIL);
    const samples = rail.samplePolyline(40);

    for (let i = 1; i < samples.length; i++) {
      expect(samples[i].y).toBeLessThan(samples[i - 1].y + 1e-4);
    }

    const expectedStep = rail.totalLength / 40;
    for (let i = 1; i < samples.length; i++) {
      const seg = Math.hypot(
        samples[i].x - samples[i - 1].x,
        samples[i].y - samples[i - 1].y,
        samples[i].z - samples[i - 1].z,
      );
      expect(seg).toBeGreaterThan(expectedStep * 0.9);
      expect(seg).toBeLessThan(expectedStep * 1.1);
    }
  });

  it('accelerates smoothly under tangential rolling gravity and reaches left-inlane exit', () => {
    const rail = new WireformRail(WIREFORM_RAIL);
    const state = rail.createBallState(MIN_WIREFORM_SPEED);

    let steps = 0;
    let prevProgress = 0;
    const maxSteps = 2000; // > 4s at 480 Hz

    while (!state.finished && steps < maxSteps) {
      rail.stepBall(state, FIXED_DT);
      steps++;

      expect(state.progress).toBeGreaterThanOrEqual(prevProgress);
      prevProgress = state.progress;

      expect(state.speed).toBeGreaterThanOrEqual(MIN_WIREFORM_SPEED - 1e-6);
      expect(state.speed).toBeLessThanOrEqual(MAX_WIREFORM_SPEED + 1e-6);

      // Quaternion stays normalized
      const qLen = Math.hypot(
        state.rotation.x,
        state.rotation.y,
        state.rotation.z,
        state.rotation.w,
      );
      expect(qLen).toBeCloseTo(1.0, 5);
    }

    expect(state.finished).toBe(true);
    expect(steps).toBeLessThan(1200); // completes cleanly in < 2.5s
    expect(state.speed).toBeGreaterThan(MIN_WIREFORM_SPEED + 5.0);

    // Exact exit position over the left inlane
    expect(state.position.x).toBeCloseTo(-3.75, 2);
    expect(state.position.y).toBeCloseTo(0.35, 2);
    expect(state.position.z).toBeCloseTo(5.0, 2);

    // Exit velocity heads forward-downward down the left inlane
    expect(state.velocity.z).toBeGreaterThan(10.0);
    expect(state.velocity.y).toBeLessThan(-1.0);
    expect(Math.abs(state.velocity.x)).toBeLessThan(8.0);

    // Rolling quaternion rotated meaningfully from identity
    const dotIdentity = Math.abs(state.rotation.w);
    expect(dotIdentity).toBeLessThan(0.999);
    expect(Math.hypot(state.angularVelocity.x, state.angularVelocity.y, state.angularVelocity.z))
      .toBeCloseTo(state.speed / BALL_RADIUS, 1);
  });
});
