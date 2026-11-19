import { describe, expect, it } from 'vitest';
import { TiltSystem } from '../src/game/TiltSystem';

describe('TiltSystem (Damped Plumb-Bob Pendulum)', () => {
  it('starts at rest with zero warnings and not tilted', () => {
    const tilt = new TiltSystem();
    const state = tilt.getState();

    expect(state.bobX).toBe(0);
    expect(state.bobZ).toBe(0);
    expect(state.displacement).toBe(0);
    expect(state.warnings).toBe(0);
    expect(state.tilted).toBe(false);
    expect(state.cooldownRemaining).toBe(0);
    expect(tilt.isTilted()).toBe(false);
    expect(tilt.getWarnings()).toBe(0);
  });

  it('emits calibrated directional impulses for left, right, and up nudges', () => {
    const tilt = new TiltSystem();

    const left = tilt.nudge('left');
    expect(left.accepted).toBe(true);
    expect(left.impulseX).toBeLessThan(0);
    expect(left.impulseZ).toBeLessThan(0);
    expect(left.dangerTriggered).toBe(false);
    expect(left.tilted).toBe(false);
    expect(left.warnings).toBe(0);

    tilt.resetForNewBall();
    const right = tilt.nudge('right');
    expect(right.accepted).toBe(true);
    expect(right.impulseX).toBeGreaterThan(0);
    expect(right.impulseZ).toBeLessThan(0);

    tilt.resetForNewBall();
    const up = tilt.nudge('up');
    expect(up.accepted).toBe(true);
    expect(up.impulseX).toBe(0);
    expect(up.impulseZ).toBeLessThan(0);
  });

  it('enforces the ~0.28s nudge cooldown to prevent spam impulse exploits', () => {
    const tilt = new TiltSystem();

    const first = tilt.nudge('left');
    expect(first.accepted).toBe(true);

    // Immediately retrying before cooldown expires is rejected
    const spam1 = tilt.nudge('right');
    expect(spam1.accepted).toBe(false);
    expect(spam1.impulseX).toBe(0);
    expect(spam1.impulseZ).toBe(0);

    // Still inside cooldown at 0.20s
    tilt.update(0.2);
    const spam2 = tilt.nudge('up');
    expect(spam2.accepted).toBe(false);
    expect(spam2.impulseZ).toBe(0);

    // Cooldown clears by 0.28s total
    tilt.update(0.09);
    const afterCooldown = tilt.nudge('up');
    expect(afterCooldown.accepted).toBe(true);
    expect(afterCooldown.impulseZ).toBeLessThan(0);
  });

  it('oscillates and decays cleanly on light occasional nudges without triggering warnings', () => {
    const tilt = new TiltSystem();

    const r1 = tilt.nudge('left', 1.0);
    expect(r1.accepted).toBe(true);
    expect(r1.dangerTriggered).toBe(false);

    // Sample the pendulum arc over 2.5s; verify it swings out and then decays cleanly
    let maxDisplacement = 0;
    for (let i = 0; i < 250; i++) {
      const upd = tilt.update(0.01);
      expect(upd.dangerTriggered).toBe(false);
      expect(upd.tilted).toBe(false);
      maxDisplacement = Math.max(maxDisplacement, tilt.getBobDisplacement());
    }

    expect(maxDisplacement).toBeGreaterThan(0.4);
    expect(maxDisplacement).toBeLessThan(1.0);
    expect(tilt.getBobDisplacement()).toBeLessThan(0.05);
    expect(tilt.getWarnings()).toBe(0);

    // Five occasional nudges spaced 2.0s apart should never trigger DANGER or TILT
    for (let k = 0; k < 5; k++) {
      const dir = k % 3 === 0 ? 'left' : k % 3 === 1 ? 'right' : 'up';
      const res = tilt.nudge(dir, 1.0);
      expect(res.accepted).toBe(true);
      expect(res.dangerTriggered).toBe(false);
      expect(res.tilted).toBe(false);
      for (let s = 0; s < 40; s++) {
        const u = tilt.update(0.05);
        expect(u.dangerTriggered).toBe(false);
      }
    }

    expect(tilt.getWarnings()).toBe(0);
    expect(tilt.isTilted()).toBe(false);
  });

  it('triggers DANGER warnings 1 & 2 and full TILT on strike 3 under rapid same-direction nudging', () => {
    const tilt = new TiltSystem();

    const r1 = tilt.nudge('left');
    expect(r1.accepted).toBe(true);
    expect(r1.warnings).toBe(0);
    expect(r1.dangerTriggered).toBe(false);

    tilt.update(0.3);
    const r2 = tilt.nudge('left');
    expect(r2.accepted).toBe(true);
    expect(r2.dangerTriggered).toBe(true);
    expect(r2.warnings).toBe(1);
    expect(r2.tilted).toBe(false);

    tilt.update(0.3);
    const r3 = tilt.nudge('left');
    expect(r3.accepted).toBe(true);
    expect(r3.dangerTriggered).toBe(true);
    expect(r3.warnings).toBe(2);
    expect(r3.tilted).toBe(false);

    tilt.update(0.3);
    const r4 = tilt.nudge('left');
    expect(r4.accepted).toBe(true);
    expect(r4.dangerTriggered).toBe(true);
    expect(r4.warnings).toBe(3);
    expect(r4.tilted).toBe(true);
    expect(tilt.isTilted()).toBe(true);
  });

  it('triggers DANGER and TILT under rapid alternating slap nudging and upward nudging', () => {
    // Alternating left/right
    const slapTilt = new TiltSystem();
    const dirs: Array<'left' | 'right'> = ['left', 'right', 'left', 'right'];
    for (const d of dirs) {
      slapTilt.nudge(d);
      slapTilt.update(0.3);
    }
    expect(slapTilt.getWarnings()).toBe(3);
    expect(slapTilt.isTilted()).toBe(true);

    // Repeated upward nudges
    const upTilt = new TiltSystem();
    for (let i = 0; i < 4; i++) {
      upTilt.nudge('up');
      upTilt.update(0.3);
    }
    expect(upTilt.getWarnings()).toBe(3);
    expect(upTilt.isTilted()).toBe(true);
  });

  it('does not double-count a single warning-producing swing during subsequent update ticks', () => {
    const tilt = new TiltSystem();

    tilt.nudge('left');
    tilt.update(0.3);
    const strike1 = tilt.nudge('right');
    expect(strike1.dangerTriggered).toBe(true);
    expect(strike1.warnings).toBe(1);

    // Let the bob finish swinging into the brass ring and decay to rest
    for (let i = 0; i < 200; i++) {
      const upd = tilt.update(0.01);
      expect(upd.dangerTriggered).toBe(false);
    }

    expect(tilt.getWarnings()).toBe(1);
    expect(tilt.isTilted()).toBe(false);
    expect(tilt.getBobDisplacement()).toBeLessThan(0.05);
  });

  it('keeps TILT active until resetForNewBall() and rejects further nudges while tilted', () => {
    const tilt = new TiltSystem();
    for (let i = 0; i < 4; i++) {
      tilt.nudge('left');
      tilt.update(0.3);
    }
    expect(tilt.isTilted()).toBe(true);

    // Even after waiting 5 seconds, tilt persists and nudges are rejected
    tilt.update(5.0);
    expect(tilt.isTilted()).toBe(true);
    const blocked = tilt.nudge('right');
    expect(blocked.accepted).toBe(false);
    expect(blocked.impulseX).toBe(0);
    expect(blocked.impulseZ).toBe(0);
    expect(blocked.tilted).toBe(true);
    expect(blocked.warnings).toBe(3);

    // Resetting for a new ball restores fresh zero-warning state
    tilt.resetForNewBall();
    expect(tilt.isTilted()).toBe(false);
    expect(tilt.getWarnings()).toBe(0);
    expect(tilt.getBobDisplacement()).toBe(0);

    const fresh = tilt.nudge('up');
    expect(fresh.accepted).toBe(true);
    expect(fresh.tilted).toBe(false);
    expect(fresh.warnings).toBe(0);
  });

  it('handles non-positive or NaN dt and extreme strength values safely', () => {
    const tilt = new TiltSystem();
    const res = tilt.nudge('left', Number.NaN);
    expect(res.accepted).toBe(true);
    expect(Number.isFinite(res.impulseX)).toBe(true);

    expect(tilt.update(0).warnings).toBe(0);
    expect(tilt.update(-1).warnings).toBe(0);
    expect(tilt.update(Number.NaN).warnings).toBe(0);
  });

  it('produces consistent warning progression under 60 Hz frame steps as well as coarse steps', () => {
    const tilt = new TiltSystem();
    const stepFrameGap = (seconds: number) => {
      const frames = Math.round(seconds * 60);
      for (let i = 0; i < frames; i++) {
        tilt.update(1 / 60);
      }
    };

    expect(tilt.nudge('left').warnings).toBe(0);
    stepFrameGap(0.3);
    expect(tilt.nudge('right').warnings).toBe(1);
    stepFrameGap(0.3);
    expect(tilt.nudge('left').warnings).toBe(2);
    stepFrameGap(0.3);
    const tiltHit = tilt.nudge('right');
    expect(tiltHit.warnings).toBe(3);
    expect(tiltHit.tilted).toBe(true);
  });
});
