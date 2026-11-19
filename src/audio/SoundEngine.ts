/**
 * HYPERNOVA Procedural Web Audio Synthesizer & Electromechanical Foley Engine
 *
 * Pure TypeScript + standard browser Web Audio API (zero external imports).
 * Designed for 1990s cosmic sci-fi arcade pinball:
 * - Tactile electromechanical solenoid foley + wooden cabinet resonance
 * - Velocity-scaled impacts (wood/rubber wall bounce, chrome steel ball clacks)
 * - Smooth continuous rolling audio bed (wooden playfield + metallic wireform rail)
 * - 90s sci-fi arcade synth stingers with subtle stereo delay & automatic music ducking
 * - Lookahead-scheduled procedural cosmic bassline & arpeggio ('off' | 'normal' | 'multiball')
 * - Voice limiting, micro-throttling, safe lazy unlock, and graceful headless/Node no-op
 */

export type MusicMode = 'off' | 'normal' | 'multiball';

export interface SoundEngineState {
  readonly unlocked: boolean;
  readonly available: boolean;
  readonly suspended: boolean;
  readonly muted: boolean;
  readonly masterVolume: number;
  readonly sfxVolume: number;
  readonly musicVolume: number;
  readonly musicMode: MusicMode;
}

export interface SoundEngineOptions {
  muted?: boolean;
  masterVolume?: number;
  sfxVolume?: number;
  musicVolume?: number;
  musicMode?: MusicMode;
  maxVoices?: number;
}

interface VoiceHandle {
  readonly endTime: number;
  readonly priority: number;
  readonly isMusic: boolean;
  stop(fadeSeconds?: number): void;
}

interface VoiceContext {
  readonly output: GainNode;
  trackNode<T extends AudioNode>(node: T): T;
  trackSource<T extends AudioScheduledSourceNode>(source: T, stopTime: number): T;
  finalize(): void;
}

type AudioContextCtor = new () => AudioContext;

// ---------------------------------------------------------------------------
// Utility Helpers
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

function sanitizePositive(value: number, fallback = 0): number {
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

function volumeCurve(v: number): number {
  const c = clamp(v, 0, 1);
  return c <= 0 ? 0 : Math.pow(c, 1.5);
}

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function jitter(center: number, spread = 0.04): number {
  return center * (1 + (Math.random() * 2 - 1) * spread);
}

function getAudioContextConstructor(): AudioContextCtor | null {
  const g = globalThis as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

function createSoftClipCurve(drive = 2.4, samples = 1024): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(samples);
  const norm = Math.tanh(drive);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / (samples - 1) - 1;
    curve[i] = Math.tanh(x * drive) / norm;
  }
  return curve;
}

/**
 * C1-continuous transparent master safety ceiling curve.
 * Expects input pre-scaled by 0.5 so real signal s = 2*x in [-2, +2] maps cleanly:
 * - Strictly linear (y = s) for |s| <= threshold (zero distortion during normal play)
 * - Smoothly asymptotic to `ceiling` (< 1.0) above threshold (guarantees 0 clipped samples > 0 dBFS)
 */
function createMasterCeilingCurve(
  threshold = 0.76,
  ceiling = 0.94,
  samples = 2049
): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(samples);
  const headroom = Math.max(0.02, ceiling - threshold);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / (samples - 1) - 1;
    const s = x * 2;
    const abs = Math.abs(s);
    if (abs <= threshold) {
      curve[i] = s;
    } else {
      const shaped = threshold + headroom * Math.tanh((abs - threshold) / headroom);
      curve[i] = s < 0 ? -shaped : shaped;
    }
  }
  return curve;
}

function safeDisconnect(node: AudioNode | null | undefined): void {
  if (!node) return;
  try {
    node.disconnect();
  } catch {
    // Already disconnected or context closed
  }
}

function safeStop(source: AudioScheduledSourceNode | null | undefined, when?: number): void {
  if (!source) return;
  try {
    if (when !== undefined) {
      source.stop(when);
    } else {
      source.stop();
    }
  } catch {
    // Source never started or already stopped
  }
}

// ---------------------------------------------------------------------------
// Music Pattern Tables (D Minor / D Dorian 1990s Cosmic Sci-Fi)
// ---------------------------------------------------------------------------

// 4-bar (64 x 16th-note) bassline progression: Dm -> Bb -> C -> A7/Am
const NORMAL_BASS_ROOTS: readonly number[] = [38, 46, 48, 45]; // D2, Bb2, C3, A2
const NORMAL_BASS_STEPS: readonly number[] = [
  0, -1, 0, 12, 0, -1, 7, -1, 0, -1, 12, 0, -1, 7, 10, -1,
];

const NORMAL_ARP_CHORDS: readonly (readonly number[])[] = [
  [62, 65, 69, 74], // Dm: D4, F4, A4, D5
  [58, 62, 65, 70], // Bb: Bb3, D4, F4, Bb4
  [60, 64, 67, 72], // C:  C4, E4, G4, C5
  [57, 60, 64, 69], // Am: A3, C4, E4, A4
];
const NORMAL_ARP_GATE: readonly number[] = [
  0, -1, -1, 1, -1, -1, 2, -1, -1, 3, -1, -1, 2, -1, 1, -1,
];

// High-energy Multiball progression: Dm -> F -> G -> A7
const MULTIBALL_BASS_ROOTS: readonly number[] = [38, 41, 43, 45]; // D2, F2, G2, A2
const MULTIBALL_BASS_STEPS: readonly number[] = [
  0, 0, 12, 0, 0, 12, 7, 12, 0, 0, 12, 0, 7, 10, 12, 7,
];

const MULTIBALL_ARP_CHORDS: readonly (readonly number[])[] = [
  [62, 65, 69, 72, 74], // Dm7
  [65, 69, 72, 74, 77], // F6
  [67, 71, 74, 77, 79], // G7 (Dorian lift!)
  [69, 73, 76, 79, 81], // A7 (dominant tension!)
];
const MULTIBALL_ARP_PATTERN: readonly number[] = [
  0, 1, 2, 3, 4, 3, 2, 1, 0, 2, 3, 4, 2, 4, 3, 1,
];

// Musical pitch tables for targets & rollovers
const DROP_TARGET_NOTES: readonly number[] = [74, 78, 81]; // D5, F#5, A5 (R-A-Y)
const STANDUP_TARGET_NOTES: readonly number[] = [81, 85, 88]; // A5, C#6, E6
const ROLLOVER_NOTES: readonly number[] = [76, 80, 83]; // E5, G#5, B5 (I-O-N)
const BONUS_SCALE_OFFSETS: readonly number[] = [0, 2, 3, 5, 7, 9, 10, 12]; // D Dorian

// ---------------------------------------------------------------------------
// SoundEngine
// ---------------------------------------------------------------------------

export class SoundEngine {
  private readonly available: boolean;
  private readonly maxVoices: number;

  private ctx: AudioContext | null = null;
  private disposed = false;
  private suspended = false;
  private resumePending = false;
  private pendingOnResume: (() => void) | null = null;
  private pendingOnResumeSetAt = 0;

  // User-facing state
  private muted: boolean;
  private masterVolume: number;
  private sfxVolume: number;
  private musicVolume: number;
  private musicMode: MusicMode;

  // Core audio graph buses
  private muteGain: GainNode | null = null;
  private masterGain: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private cabinetSend: GainNode | null = null;
  private sfxDelaySend: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private musicDuckGain: GainNode | null = null;
  private musicModeGain: GainNode | null = null;
  private musicDelaySend: GainNode | null = null;
  private staticNodes: AudioNode[] = [];

  // Shared pre-generated buffers & curves
  private whiteNoiseBuffer: AudioBuffer | null = null;
  private pinkNoiseBuffer: AudioBuffer | null = null;
  private metallicNoiseBuffer: AudioBuffer | null = null;
  private softClipCurve: Float32Array<ArrayBuffer> | null = null;

  // Continuous rolling bed nodes
  private playfieldRollSource: AudioBufferSourceNode | null = null;
  private playfieldRollFilter: BiquadFilterNode | null = null;
  private playfieldRollGain: GainNode | null = null;
  private wireformRollSource: AudioBufferSourceNode | null = null;
  private wireformFilterA: BiquadFilterNode | null = null;
  private wireformFilterB: BiquadFilterNode | null = null;
  private wireformRollGain: GainNode | null = null;

  // Voice tracking & rate-limiting state
  private readonly activeVoices = new Set<VoiceHandle>();
  private readonly fadingVoices = new Set<VoiceHandle>();
  private readonly lastTriggerTime = new Map<string, number>();
  private lastPlungerTickTension = -1;
  private duckUntil = 0;

  // Lookahead music scheduler state
  private musicTimerId: ReturnType<typeof setInterval> | null = null;
  private nextMusicStepTime = 0;
  private musicStepIndex = 0;
  private stateChangeListener: (() => void) | null = null;

  constructor(options?: SoundEngineOptions) {
    this.available = getAudioContextConstructor() !== null;
    this.muted = options?.muted ?? false;
    this.masterVolume = clamp(options?.masterVolume ?? 0.85, 0, 1);
    this.sfxVolume = clamp(options?.sfxVolume ?? 0.9, 0, 1);
    this.musicVolume = clamp(options?.musicVolume ?? 0.65, 0, 1);
    this.musicMode = options?.musicMode ?? 'off';
    this.maxVoices = Math.max(8, Math.floor(options?.maxVoices ?? 36));
  }

  // -------------------------------------------------------------------------
  // Lifecycle & Unlock
  // -------------------------------------------------------------------------

  /**
   * Lazily initializes and resumes the Web Audio context on the first user gesture.
   * Safe no-op in headless/Node environments where AudioContext is unavailable.
   */
  public unlock(): void {
    if (this.disposed || !this.available) return;

    if (!this.ctx) {
      const Ctor = getAudioContextConstructor();
      if (!Ctor) return;
      try {
        this.ctx = new Ctor();
        this.initAudioGraph(this.ctx);
      } catch {
        this.ctx = null;
        return;
      }
    }

    const ctx = this.ctx;
    if (!ctx) return;

    if (this.suspended) {
      this.stopMusicScheduler();
      if (ctx.state === 'running' && typeof ctx.suspend === 'function') {
        void ctx.suspend().catch(() => {});
      }
      return;
    }

    this.resumeAudioContext();
  }

  /**
   * Suspends or resumes the underlying AudioContext and procedural music scheduler
   * cleanly (e.g., when gameplay is paused or the browser tab becomes hidden).
   * Prevents throttled background timer stutter and catch-up bursts on resume.
   */
  public setSuspended(suspended: boolean): void {
    if (this.disposed) return;
    const next = Boolean(suspended);
    const prev = this.suspended;
    this.suspended = next;

    if (next) {
      this.resumePending = false;
      this.pendingOnResume = null;
      this.stopMusicScheduler();

      const ctx = this.ctx;
      if (ctx) {
        if (this.playfieldRollGain) {
          this.smoothParam(this.playfieldRollGain.gain, 0, 0.012);
        }
        if (this.wireformRollGain) {
          this.smoothParam(this.wireformRollGain.gain, 0, 0.012);
        }
        if (ctx.state === 'running' && typeof ctx.suspend === 'function') {
          void ctx
            .suspend()
            .then(() => {
              // Reconcile if setSuspended(false) raced while suspend() was in flight
              if (!this.disposed && !this.suspended && this.ctx === ctx && this.isResumableState(ctx)) {
                this.resumeAudioContext();
              }
            })
            .catch(() => {
              // Ignore suspend errors on closing context
            });
        }
      }
      return;
    }

    if (!this.ctx) return;
    if (this.isResumableState(this.ctx)) {
      this.resumeAudioContext();
    } else if (this.ctx.state === 'running' && (prev || this.musicTimerId === null)) {
      this.onContextRunning();
    }
  }

  /**
   * True when the AudioContext is paused or OS-preempted and can be resumed via `resume()`.
   * Covers both standard `'suspended'` and Safari/iOS WebKit's `'interrupted'` state
   * (phone calls, Siri, alarms, Bluetooth/headphone disconnect).
   */
  private isResumableState(ctx: AudioContext): boolean {
    const state = ctx.state as string;
    return state !== 'running' && state !== 'closed';
  }

  private resumeAudioContext(): void {
    const ctx = this.ctx;
    if (!ctx || this.disposed || this.suspended) return;

    if (this.isResumableState(ctx)) {
      this.resumePending = true;
      void ctx
        .resume()
        .then(() => {
          this.resumePending = false;
          if (this.disposed || this.ctx !== ctx) return;
          if (this.suspended) {
            // Reconcile if setSuspended(true) raced while resume() was in flight
            this.stopMusicScheduler();
            if (ctx.state === 'running' && typeof ctx.suspend === 'function') {
              void ctx.suspend().catch(() => {});
            }
            return;
          }
          if (ctx.state === 'running') {
            this.onContextRunning();
          }
        })
        .catch(() => {
          this.resumePending = false;
        });
    } else if (ctx.state === 'running') {
      this.resumePending = false;
      this.onContextRunning();
    }
  }

  /**
   * Stops all active audio, disconnects all nodes and delay feedback loops,
   * clears timers, and closes the underlying AudioContext.
   */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resumePending = false;
    this.pendingOnResume = null;

    this.stopMusicScheduler();

    // Stop and clean up all active & fading one-shot/music voices immediately
    for (const voice of Array.from(this.activeVoices)) {
      voice.stop(0);
    }
    this.activeVoices.clear();
    for (const voice of Array.from(this.fadingVoices)) {
      voice.stop(0);
    }
    this.fadingVoices.clear();
    this.lastTriggerTime.clear();

    // Stop continuous rolling sources
    safeStop(this.playfieldRollSource);
    safeStop(this.wireformRollSource);
    this.playfieldRollSource = null;
    this.wireformRollSource = null;
    this.playfieldRollFilter = null;
    this.playfieldRollGain = null;
    this.wireformFilterA = null;
    this.wireformFilterB = null;
    this.wireformRollGain = null;

    // Disconnect all persistent graph nodes (breaking delay feedback loops)
    for (const node of this.staticNodes) {
      safeDisconnect(node);
    }
    this.staticNodes = [];

    this.muteGain = null;
    this.masterGain = null;
    this.sfxBus = null;
    this.cabinetSend = null;
    this.sfxDelaySend = null;
    this.musicBus = null;
    this.musicDuckGain = null;
    this.musicModeGain = null;
    this.musicDelaySend = null;

    this.whiteNoiseBuffer = null;
    this.pinkNoiseBuffer = null;
    this.metallicNoiseBuffer = null;
    this.softClipCurve = null;

    if (this.ctx) {
      const ctx = this.ctx;
      if (this.stateChangeListener) {
        try {
          ctx.removeEventListener('statechange', this.stateChangeListener);
        } catch {
          // Ignore listener removal failures on partial mocks
        }
        this.stateChangeListener = null;
      }
      this.ctx = null;
      try {
        void ctx.close().catch(() => {
          // Ignore close errors
        });
      } catch {
        // Ignore synchronous close errors
      }
    }
  }

  // -------------------------------------------------------------------------
  // Volume, Mute & State Controls
  // -------------------------------------------------------------------------

  public setMuted(muted: boolean): void {
    this.muted = Boolean(muted);
    if (this.ctx && this.muteGain) {
      this.smoothParam(this.muteGain.gain, this.muted ? 0 : 1, 0.015);
    }
  }

  public setMasterVolume(v: number): void {
    this.masterVolume = clamp(v, 0, 1);
    if (this.ctx && this.masterGain) {
      this.smoothParam(this.masterGain.gain, volumeCurve(this.masterVolume), 0.02);
    }
  }

  public setSfxVolume(v: number): void {
    this.sfxVolume = clamp(v, 0, 1);
    if (this.ctx && this.sfxBus) {
      this.smoothParam(this.sfxBus.gain, volumeCurve(this.sfxVolume), 0.02);
    }
  }

  public setMusicVolume(v: number): void {
    this.musicVolume = clamp(v, 0, 1);
    if (this.ctx && this.musicBus) {
      // Conservative internal trim so background groove sits cleanly under mechanical foley
      this.smoothParam(this.musicBus.gain, volumeCurve(this.musicVolume) * 0.34, 0.025);
    }
  }

  public getState(): SoundEngineState {
    return {
      unlocked: !this.disposed && !this.suspended && this.ctx !== null && this.ctx.state === 'running',
      available: this.available,
      suspended: this.suspended,
      muted: this.muted,
      masterVolume: this.masterVolume,
      sfxVolume: this.sfxVolume,
      musicVolume: this.musicVolume,
      musicMode: this.musicMode,
    };
  }

  /**
   * Controls the procedural 1990s cosmic sci-fi background synth groove.
   * Cleanly starts, transitions, or fades out without clicks or leaked nodes.
   */
  public setMusicMode(mode: MusicMode): void {
    const prevMode = this.musicMode;
    this.musicMode = mode;

    if (this.disposed || !this.ctx || !this.musicModeGain) return;

    if (mode === 'off') {
      this.stopMusicScheduler();
      this.smoothParam(this.musicModeGain.gain, 0, 0.035);
      this.fadeOutMusicVoices(0.045);
      return;
    }

    if (prevMode !== mode) {
      // Fade out already-scheduled prior-tempo lookahead voices (~20ms) before the new groove starts (+50ms)
      this.fadeOutMusicVoices(0.02);
    }

    if (!this.suspended && this.ctx.state === 'running') {
      this.smoothParam(this.musicModeGain.gain, 1, 0.035);
      if (prevMode !== mode || this.musicTimerId === null) {
        this.startMusicScheduler(prevMode !== mode);
      }
    }
  }

  private fadeOutMusicVoices(fadeSeconds: number): void {
    for (const voice of Array.from(this.activeVoices)) {
      if (voice.isMusic) {
        voice.stop(fadeSeconds);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Electromechanical Pinball Foley (pan in [-1, 1])
  // -------------------------------------------------------------------------

  /** Punchy low woody cabinet thump + crisp dual-stage mechanical solenoid clack. */
  public playFlipperUp(pan = 0): void {
    const side = pan < -0.1 ? 'L' : pan > 0.1 ? 'R' : 'C';
    if (!this.canPlay() || !this.throttle(`flipperUp_${side}`, 0.02)) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const v = this.beginVoice(1, 0.14, pan);
    if (!v) return;

    // 1. Solenoid coil kick + woody cabinet thump
    const thumpOsc = v.trackSource(ctx.createOscillator(), now + 0.075);
    const thumpGain = v.trackNode(ctx.createGain());
    const thumpDrive = this.createShaper(ctx, v);
    thumpOsc.type = 'triangle';
    thumpOsc.frequency.setValueAtTime(jitter(182, 0.04), now);
    thumpOsc.frequency.exponentialRampToValueAtTime(jitter(54, 0.05), now + 0.058);
    this.envDecay(thumpGain.gain, now, 0.002, 0.068, 0.68);
    thumpOsc.connect(thumpDrive);
    thumpDrive.connect(thumpGain);
    thumpGain.connect(v.output);
    this.sendToCabinet(thumpGain, 0.72, v);
    thumpOsc.start(now);
    thumpOsc.stop(now + 0.075);

    // 2. Initial solenoid engagement clack (high-mid filtered transient)
    this.addNoiseBurst(v, now, 0.022, 'bandpass', jitter(2250, 0.06), 2.4, 0.44);

    // 3. Mechanical end-stop impact (~15 ms later as bat hits top rubber/coil stop)
    const stopAt = now + 0.015;
    this.addNoiseBurst(v, stopAt, 0.018, 'bandpass', jitter(3450, 0.06), 3.6, 0.34);

    const stopPing = v.trackSource(ctx.createOscillator(), stopAt + 0.028);
    const stopPingGain = v.trackNode(ctx.createGain());
    stopPing.type = 'sine';
    stopPing.frequency.setValueAtTime(jitter(960, 0.05), stopAt);
    stopPing.frequency.exponentialRampToValueAtTime(420, stopAt + 0.024);
    this.envDecay(stopPingGain.gain, stopAt, 0.001, 0.024, 0.24);
    stopPing.connect(stopPingGain);
    stopPingGain.connect(v.output);
    stopPing.start(stopAt);
    stopPing.stop(stopAt + 0.028);

    v.finalize();
  }

  /** Softer return spring release + bat settling against lower rubber stop. */
  public playFlipperDown(pan = 0): void {
    const side = pan < -0.1 ? 'L' : pan > 0.1 ? 'R' : 'C';
    if (!this.canPlay() || !this.throttle(`flipperDown_${side}`, 0.02)) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const v = this.beginVoice(1, 0.09, pan);
    if (!v) return;

    // Soft hollow cabinet thud
    const osc = v.trackSource(ctx.createOscillator(), now + 0.055);
    const gain = v.trackNode(ctx.createGain());
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(jitter(124, 0.05), now);
    osc.frequency.exponentialRampToValueAtTime(48, now + 0.045);
    this.envDecay(gain.gain, now, 0.002, 0.048, 0.34);
    osc.connect(gain);
    gain.connect(v.output);
    this.sendToCabinet(gain, 0.52, v);
    osc.start(now);
    osc.stop(now + 0.055);

    // Muted mechanical return click
    this.addNoiseBurst(v, now, 0.022, 'bandpass', jitter(1380, 0.07), 2.1, 0.22);

    v.finalize();
  }

  /** Strong electromagnetic jet-bumper coil knock + pitch-escalating 90s sci-fi synth zap. */
  public playPopBumper(comboIndex = 0, pan = 0): void {
    const panBucket = pan < -0.15 ? 'L' : pan > 0.15 ? 'R' : 'C';
    if (!this.canPlay() || !this.throttle(`popBumper_${panBucket}`, 0.02)) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const v = this.beginVoice(1, 0.22, pan);
    if (!v) return;

    const step = clamp(Math.floor(comboIndex), 0, 14);

    // 1. Heavy electromagnetic jet coil punch
    const coilOsc = v.trackSource(ctx.createOscillator(), now + 0.095);
    const coilGain = v.trackNode(ctx.createGain());
    const drive = this.createShaper(ctx, v);
    coilOsc.type = 'triangle';
    coilOsc.frequency.setValueAtTime(jitter(225, 0.04), now);
    coilOsc.frequency.exponentialRampToValueAtTime(43, now + 0.078);
    this.envDecay(coilGain.gain, now, 0.0015, 0.085, 0.85);
    coilOsc.connect(drive);
    drive.connect(coilGain);
    coilGain.connect(v.output);
    this.sendToCabinet(coilGain, 0.9, v);
    coilOsc.start(now);
    coilOsc.stop(now + 0.095);

    // Skirt impact transient
    this.addNoiseBurst(v, now, 0.026, 'bandpass', jitter(1950, 0.07), 2.0, 0.48);

    // 2. Pitch-escalating 90s sci-fi dual-oscillator zap
    const baseMidi = 62 + Math.min(step, 12) * 1.5;
    const fStart = this.clampFreq(midiToFreq(baseMidi + 12));
    const fEnd = this.clampFreq(midiToFreq(baseMidi - 4));

    const zapFilter = v.trackNode(ctx.createBiquadFilter());
    zapFilter.type = 'lowpass';
    zapFilter.Q.setValueAtTime(6.2, now);
    zapFilter.frequency.setValueAtTime(this.clampFreq(fStart * 2.8), now);
    zapFilter.frequency.exponentialRampToValueAtTime(this.clampFreq(Math.max(420, fEnd * 1.4)), now + 0.14);

    const zapGain = v.trackNode(ctx.createGain());
    this.envDecay(zapGain.gain, now, 0.003, 0.145, 0.34);

    const oscA = v.trackSource(ctx.createOscillator(), now + 0.16);
    oscA.type = 'sawtooth';
    oscA.frequency.setValueAtTime(fStart, now);
    oscA.frequency.exponentialRampToValueAtTime(fEnd, now + 0.13);

    const oscB = v.trackSource(ctx.createOscillator(), now + 0.16);
    oscB.type = 'square';
    oscB.detune.setValueAtTime(11, now);
    oscB.frequency.setValueAtTime(this.clampFreq(fStart * 1.005), now);
    oscB.frequency.exponentialRampToValueAtTime(this.clampFreq(fEnd * 0.5), now + 0.13);

    oscA.connect(zapFilter);
    oscB.connect(zapFilter);
    zapFilter.connect(zapGain);
    zapGain.connect(v.output);
    this.sendToSfxDelay(zapGain, 0.28, v);

    oscA.start(now);
    oscB.start(now);
    oscA.stop(now + 0.16);
    oscB.stop(now + 0.16);

    v.finalize();
  }

  /** Snappy white silicone rubber rebound + fast kicker solenoid punch. */
  public playSlingshot(pan = 0): void {
    const side = pan < 0 ? 'L' : 'R';
    if (!this.canPlay() || !this.throttle(`slingshot_${side}`, 0.025)) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const v = this.beginVoice(1, 0.15, pan);
    if (!v) return;

    // Fast solenoid kicker thump
    const kick = v.trackSource(ctx.createOscillator(), now + 0.06);
    const kickGain = v.trackNode(ctx.createGain());
    kick.type = 'triangle';
    kick.frequency.setValueAtTime(jitter(175, 0.05), now);
    kick.frequency.exponentialRampToValueAtTime(56, now + 0.05);
    this.envDecay(kickGain.gain, now, 0.0015, 0.054, 0.64);
    kick.connect(kickGain);
    kickGain.connect(v.output);
    this.sendToCabinet(kickGain, 0.68, v);
    kick.start(now);
    kick.stop(now + 0.06);

    // Rubber snap twang (quick pitch bend + resonant noise burst)
    const rubber = v.trackSource(ctx.createOscillator(), now + 0.07);
    const rubberGain = v.trackNode(ctx.createGain());
    rubber.type = 'triangle';
    rubber.frequency.setValueAtTime(jitter(265, 0.06), now);
    rubber.frequency.exponentialRampToValueAtTime(132, now + 0.028);
    rubber.frequency.exponentialRampToValueAtTime(192, now + 0.06);
    this.envDecay(rubberGain.gain, now, 0.002, 0.062, 0.34);
    rubber.connect(rubberGain);
    rubberGain.connect(v.output);
    rubber.start(now);
    rubber.stop(now + 0.07);

    this.addNoiseBurst(v, now, 0.036, 'bandpass', jitter(1450, 0.08), 3.0, 0.42);
    this.addNoiseBurst(v, now, 0.015, 'bandpass', jitter(3100, 0.07), 2.5, 0.3);

    // Quick bright 90s slingshot blip
    const blip = v.trackSource(ctx.createOscillator(), now + 0.065);
    const blipGain = v.trackNode(ctx.createGain());
    blip.type = 'sawtooth';
    blip.frequency.setValueAtTime(jitter(720, 0.04), now);
    blip.frequency.exponentialRampToValueAtTime(1180, now + 0.05);
    const blipFilter = v.trackNode(ctx.createBiquadFilter());
    blipFilter.type = 'lowpass';
    blipFilter.frequency.setValueAtTime(2800, now);
    this.envDecay(blipGain.gain, now, 0.002, 0.055, 0.16);
    blip.connect(blipFilter);
    blipFilter.connect(blipGain);
    blipGain.connect(v.output);
    blip.start(now);
    blip.stop(now + 0.065);

    v.finalize();
  }

  /** Polycarbonate target impact snap + spring drop clunk + R-A-Y musical cue. */
  public playDropTarget(index = 0, pan = -0.5): void {
    if (!this.canPlay()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const v = this.beginVoice(1, 0.28, pan);
    if (!v) return;

    // 1. Crisp polycarbonate plastic impact
    this.addNoiseBurst(v, now, 0.02, 'bandpass', jitter(2950, 0.06), 3.2, 0.46);
    const plastic = v.trackSource(ctx.createOscillator(), now + 0.045);
    const plasticGain = v.trackNode(ctx.createGain());
    plastic.type = 'triangle';
    plastic.frequency.setValueAtTime(jitter(540, 0.05), now);
    plastic.frequency.exponentialRampToValueAtTime(220, now + 0.036);
    this.envDecay(plasticGain.gain, now, 0.001, 0.038, 0.34);
    plastic.connect(plasticGain);
    plasticGain.connect(v.output);
    plastic.start(now);
    plastic.stop(now + 0.045);

    // 2. Target dropping into under-playfield latch (~26 ms later)
    const dropAt = now + 0.026;
    const dropThud = v.trackSource(ctx.createOscillator(), dropAt + 0.045);
    const dropGain = v.trackNode(ctx.createGain());
    dropThud.type = 'sine';
    dropThud.frequency.setValueAtTime(160, dropAt);
    dropThud.frequency.exponentialRampToValueAtTime(64, dropAt + 0.038);
    this.envDecay(dropGain.gain, dropAt, 0.002, 0.04, 0.36);
    dropThud.connect(dropGain);
    dropGain.connect(v.output);
    this.sendToCabinet(dropGain, 0.5, v);
    dropThud.start(dropAt);
    dropThud.stop(dropAt + 0.045);
    this.addNoiseBurst(v, dropAt, 0.014, 'bandpass', 1100, 2.2, 0.25);

    // 3. Musical R-A-Y sci-fi confirm ping
    const idx = ((Math.floor(index) % DROP_TARGET_NOTES.length) + DROP_TARGET_NOTES.length) % DROP_TARGET_NOTES.length;
    const freq = midiToFreq(DROP_TARGET_NOTES[idx] ?? 74);
    this.addSynthTone(v, now + 0.006, 0.22, freq, 'triangle', 0.24, 3800, 0.35);
    this.addSynthTone(v, now + 0.006, 0.14, freq * 2, 'sine', 0.11, 6000, 0.25);

    v.finalize();
  }

  /** Mechanical 3-target bank reset solenoid bar slamming all targets back up. */
  public playDropTargetBankReset(): void {
    if (!this.canPlay()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const v = this.beginVoice(2, 0.42, -0.45);
    if (!v) return;

    // Heavy reset bar solenoid thump
    const bar = v.trackSource(ctx.createOscillator(), now + 0.1);
    const barGain = v.trackNode(ctx.createGain());
    bar.type = 'triangle';
    bar.frequency.setValueAtTime(148, now);
    bar.frequency.exponentialRampToValueAtTime(44, now + 0.088);
    this.envDecay(barGain.gain, now, 0.002, 0.092, 0.72);
    bar.connect(barGain);
    barGain.connect(v.output);
    this.sendToCabinet(barGain, 0.9, v);
    bar.start(now);
    bar.stop(now + 0.1);

    // Triple staggered target snap-ups (R, A, Y resetting in rapid mechanical ripple)
    const clackTimes = [0.004, 0.026, 0.048];
    const clackFreqs = [2250, 2600, 3050];
    for (let i = 0; i < clackTimes.length; i++) {
      const t = now + (clackTimes[i] ?? 0);
      this.addNoiseBurst(v, t, 0.022, 'bandpass', clackFreqs[i] ?? 2500, 3.4, 0.42);
      const snap = v.trackSource(ctx.createOscillator(), t + 0.032);
      const snapGain = v.trackNode(ctx.createGain());
      snap.type = 'sine';
      snap.frequency.setValueAtTime(620 + i * 110, t);
      snap.frequency.exponentialRampToValueAtTime(280, t + 0.026);
      this.envDecay(snapGain.gain, t, 0.001, 0.028, 0.22);
      snap.connect(snapGain);
      snapGain.connect(v.output);
      snap.start(t);
      snap.stop(t + 0.032);
    }

    // Subtle heroic power-up triad confirming lock / kickback readiness
    const chord = [62, 69, 74];
    for (let i = 0; i < chord.length; i++) {
      this.addSynthTone(v, now + 0.04 + i * 0.035, 0.26, midiToFreq(chord[i] ?? 62), 'sawtooth', 0.12, 2600, 0.35);
    }

    v.finalize();
  }

  /** Crisp metallic leaf-switch chime + crystalline sci-fi ping. */
  public playStandupTarget(index = 0, pan = 0.5): void {
    if (!this.canPlay()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const v = this.beginVoice(1, 0.26, pan);
    if (!v) return;

    // Mechanical target impact + metallic spring chime
    this.addNoiseBurst(v, now, 0.016, 'bandpass', jitter(3300, 0.06), 3.0, 0.32);

    const metal = v.trackSource(ctx.createOscillator(), now + 0.042);
    const metalGain = v.trackNode(ctx.createGain());
    metal.type = 'sine';
    metal.frequency.setValueAtTime(jitter(1920, 0.04), now);
    this.envDecay(metalGain.gain, now, 0.001, 0.038, 0.22);
    metal.connect(metalGain);
    metalGain.connect(v.output);
    metal.start(now);
    metal.stop(now + 0.042);

    // Bright crystalline FM-like synth ping
    const idx =
      ((Math.floor(index) % STANDUP_TARGET_NOTES.length) + STANDUP_TARGET_NOTES.length) %
      STANDUP_TARGET_NOTES.length;
    const freq = midiToFreq(STANDUP_TARGET_NOTES[idx] ?? 81);
    this.addBellPing(v, now + 0.004, 0.22, freq, 0.25, 0.36);

    v.finalize();
  }

  /** Delicate rollover wire switch tick + bright ascending I-O-N cosmic chime. */
  public playRollover(index = 0, pan = 0): void {
    const safeIdx = Number.isFinite(index) ? Math.floor(index) : 0;
    const idx = ((safeIdx % ROLLOVER_NOTES.length) + ROLLOVER_NOTES.length) % ROLLOVER_NOTES.length;
    if (!this.canPlay() || !this.throttle(`rollover_${idx}`, 0.04)) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const v = this.beginVoice(1, 0.26, pan);
    if (!v) return;

    // Tiny wire rollover microswitch click
    this.addNoiseBurst(v, now, 0.01, 'highpass', 3800, 1.5, 0.16);

    const freq = midiToFreq(ROLLOVER_NOTES[idx] ?? 76);
    this.addBellPing(v, now, 0.23, freq, 0.24, 0.35);

    v.finalize();
  }

  /** Sparkling ascending sci-fi chord on completing I-O-N rollover lanes (Bonus X up!). */
  public playRolloverComplete(): void {
    if (!this.canPlay()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const v = this.beginVoice(2, 0.65, 0);
    if (!v) return;

    const notes = [76, 80, 83, 88]; // E5, G#5, B5, E6
    for (let i = 0; i < notes.length; i++) {
      const t = now + i * 0.048;
      const freq = midiToFreq(notes[i] ?? 76);
      this.addSynthTone(v, t, 0.34, freq, 'triangle', 0.2, 5200, 0.42);
      this.addSynthTone(v, t, 0.26, freq * 1.004, 'sawtooth', 0.1, 3400, 0.38);
    }

    v.finalize();
  }

  /**
   * Rapid crisp metallic spinner blade whirr click scaled by angular velocity.
   * @param speed Angular speed (typically 4..60 rad/s; smaller normalized values also audible)
   * @param pan Stereo pan in [-1, 1]
   */
  public playSpinnerTick(speed = 18, pan = -0.55): void {
    if (!this.canPlay() || !this.throttle('spinner', 0.022)) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;

    const spd = sanitizePositive(speed, 10);
    const norm = clamp(spd <= 1.2 ? Math.max(0.2, spd) : spd / 45, 0.15, 1);
    const decay = 0.022 - norm * 0.011; // Faster spin = crisper shorter ping

    const v = this.beginVoice(0, decay + 0.025, pan);
    if (!v) return;

    const baseFreq = this.clampFreq(jitter(2400 + norm * 2500, 0.04));
    const overtoneFreq = this.clampFreq(baseFreq * 1.63); // Inharmonic thin steel blade mode

    const osc1 = v.trackSource(ctx.createOscillator(), now + decay + 0.01);
    const osc2 = v.trackSource(ctx.createOscillator(), now + decay + 0.01);
    const gain = v.trackNode(ctx.createGain());
    osc1.type = 'sine';
    osc2.type = 'triangle';
    osc1.frequency.setValueAtTime(baseFreq, now);
    osc2.frequency.setValueAtTime(overtoneFreq, now);
    this.envDecay(gain.gain, now, 0.0008, decay, 0.16 + norm * 0.16);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(v.output);
    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + decay + 0.01);
    osc2.stop(now + decay + 0.01);

    // Micro wire bracket click
    this.addNoiseBurst(v, now, 0.007, 'highpass', 4800, 1.4, 0.14 + norm * 0.16);

    v.finalize();
  }

  /**
   * Subtle metallic spring-coil compression ratchet ticks as plunger tension rises.
   * Safe to call every animation frame (internally quantizes into tactile steps).
   * @param tension Plunger compression in [0, 1]
   */
  public playPlungerPull(tension: number): void {
    if (!this.canPlay()) return;
    const t = clamp(tension, 0, 1);

    // Reset step tracking if starting a new pull from lower tension
    if (this.lastPlungerTickTension < 0 || t < this.lastPlungerTickTension - 0.12) {
      this.lastPlungerTickTension = Math.max(0, t - 0.075);
    }

    // Only click when compression advances past the next coil ratchet step
    if (t < 0.03 || t - this.lastPlungerTickTension < 0.072) return;
    if (!this.throttle('plungerPull', 0.035)) return;

    this.lastPlungerTickTension = t;

    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const v = this.beginVoice(0, 0.045, 0.68);
    if (!v) return;

    const freq = this.clampFreq(jitter(950 + t * 1450, 0.05));
    const osc = v.trackSource(ctx.createOscillator(), now + 0.032);
    const gain = v.trackNode(ctx.createGain());
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.65, now + 0.025);
    this.envDecay(gain.gain, now, 0.001, 0.026, 0.11 + t * 0.08);
    osc.connect(gain);
    gain.connect(v.output);
    osc.start(now);
    osc.stop(now + 0.032);

    this.addNoiseBurst(v, now, 0.011, 'bandpass', 2400 + t * 1800, 4.5, 0.12 + t * 0.1);

    v.finalize();
  }

  /**
   * Metallic helical spring twang + shooter rod impact on steel ball + cabinet thump.
   * @param tension Launch compression in [0, 1]
   */
  public playPlungerRelease(tension: number): void {
    this.lastPlungerTickTension = -1;
    if (!this.canPlay()) return;

    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const t = clamp(tension, 0.1, 1);
    const twangDur = 0.16 + t * 0.16;

    const v = this.beginVoice(1, twangDur + 0.06, 0.68);
    if (!v) return;

    // 1. Shooter lane housing thump
    const thump = v.trackSource(ctx.createOscillator(), now + 0.08);
    const thumpGain = v.trackNode(ctx.createGain());
    thump.type = 'triangle';
    thump.frequency.setValueAtTime(130 + t * 55, now);
    thump.frequency.exponentialRampToValueAtTime(46, now + 0.068);
    this.envDecay(thumpGain.gain, now, 0.0015, 0.072, 0.34 + t * 0.42);
    thump.connect(thumpGain);
    thumpGain.connect(v.output);
    this.sendToCabinet(thumpGain, 0.72, v);
    thump.start(now);
    thump.stop(now + 0.08);

    // 2. Hardened steel plunger tip smacking steel pinball
    const impactFreqA = this.clampFreq(jitter(2750, 0.04));
    const impactFreqB = this.clampFreq(jitter(4480, 0.04));
    for (const f of [impactFreqA, impactFreqB]) {
      const ping = v.trackSource(ctx.createOscillator(), now + 0.035);
      const pingGain = v.trackNode(ctx.createGain());
      ping.type = 'sine';
      ping.frequency.setValueAtTime(f, now);
      this.envDecay(pingGain.gain, now, 0.0008, 0.028, (0.14 + t * 0.2) * (f > 3500 ? 0.7 : 1));
      ping.connect(pingGain);
      pingGain.connect(v.output);
      ping.start(now);
      ping.stop(now + 0.035);
    }

    // 3. Helical compression spring twang (metallic FM wobble + bright ring)
    const springStart = now + 0.004;
    const springBase = 235 + t * 85;
    const carrier = v.trackSource(ctx.createOscillator(), springStart + twangDur + 0.02);
    const mod = v.trackSource(ctx.createOscillator(), springStart + twangDur + 0.02);
    const modGain = v.trackNode(ctx.createGain());
    const springFilter = v.trackNode(ctx.createBiquadFilter());
    const springGain = v.trackNode(ctx.createGain());

    carrier.type = 'sawtooth';
    carrier.frequency.setValueAtTime(springBase * 1.25, springStart);
    carrier.frequency.exponentialRampToValueAtTime(springBase, springStart + twangDur);

    mod.type = 'sine';
    mod.frequency.setValueAtTime(34 + t * 14, springStart);
    modGain.gain.setValueAtTime(48 + t * 42, springStart);
    modGain.gain.exponentialRampToValueAtTime(6, springStart + twangDur);

    springFilter.type = 'bandpass';
    springFilter.frequency.setValueAtTime(1100 + t * 900, springStart);
    springFilter.Q.setValueAtTime(3.2, springStart);

    this.envDecay(springGain.gain, springStart, 0.004, twangDur, 0.16 + t * 0.22);

    mod.connect(modGain);
    modGain.connect(carrier.frequency);
    carrier.connect(springFilter);
    springFilter.connect(springGain);
    springGain.connect(v.output);

    mod.start(springStart);
    carrier.start(springStart);
    mod.stop(springStart + twangDur + 0.02);
    carrier.stop(springStart + twangDur + 0.02);

    this.addNoiseBurst(v, now, 0.032, 'bandpass', 2600 + t * 1200, 3.0, 0.2 + t * 0.22);

    v.finalize();
  }

  /** Hollow Hypercore saucer cup capture clunk + rising plasma reactor charge sweep. */
  public playSaucerCapture(): void {
    if (!this.canPlay()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const v = this.beginVoice(2, 0.98, 0);
    if (!v) return;

    // 1. Hollow metal cup rim click + recessed settle thud
    this.addNoiseBurst(v, now, 0.018, 'bandpass', 1450, 4.0, 0.36);

    const cup = v.trackSource(ctx.createOscillator(), now + 0.11);
    const cupGain = v.trackNode(ctx.createGain());
    cup.type = 'triangle';
    cup.frequency.setValueAtTime(220, now + 0.018);
    cup.frequency.exponentialRampToValueAtTime(92, now + 0.095);
    this.envDecay(cupGain.gain, now + 0.018, 0.003, 0.085, 0.48);
    cup.connect(cupGain);
    cupGain.connect(v.output);
    this.sendToCabinet(cupGain, 0.7, v);
    cup.start(now + 0.018);
    cup.stop(now + 0.11);

    // 2. Rising plasma reactor charge sweep (0.85s build-up)
    const chargeStart = now + 0.04;
    const chargeDur = 0.86;
    const osc1 = v.trackSource(ctx.createOscillator(), chargeStart + chargeDur + 0.03);
    const osc2 = v.trackSource(ctx.createOscillator(), chargeStart + chargeDur + 0.03);
    const lfo = v.trackSource(ctx.createOscillator(), chargeStart + chargeDur + 0.03);
    const lfoDepth = v.trackNode(ctx.createGain());
    const chargeFilter = v.trackNode(ctx.createBiquadFilter());
    const chargeGain = v.trackNode(ctx.createGain());

    osc1.type = 'sawtooth';
    osc2.type = 'triangle';
    osc1.frequency.setValueAtTime(115, chargeStart);
    osc1.frequency.exponentialRampToValueAtTime(540, chargeStart + chargeDur);
    osc2.frequency.setValueAtTime(173, chargeStart); // 5th harmonic shimmer
    osc2.frequency.exponentialRampToValueAtTime(810, chargeStart + chargeDur);

    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(10, chargeStart);
    lfo.frequency.exponentialRampToValueAtTime(28, chargeStart + chargeDur);
    lfoDepth.gain.setValueAtTime(18, chargeStart);
    lfoDepth.gain.linearRampToValueAtTime(52, chargeStart + chargeDur);
    lfo.connect(lfoDepth);
    lfoDepth.connect(osc1.frequency);

    chargeFilter.type = 'bandpass';
    chargeFilter.Q.setValueAtTime(4.5, chargeStart);
    chargeFilter.frequency.setValueAtTime(280, chargeStart);
    chargeFilter.frequency.exponentialRampToValueAtTime(3400, chargeStart + chargeDur);

    chargeGain.gain.setValueAtTime(0, now);
    chargeGain.gain.setValueAtTime(0.0001, chargeStart);
    chargeGain.gain.linearRampToValueAtTime(0.28, chargeStart + chargeDur * 0.78);
    chargeGain.gain.exponentialRampToValueAtTime(0.0001, chargeStart + chargeDur);
    chargeGain.gain.setValueAtTime(0, chargeStart + chargeDur + 0.002);

    osc1.connect(chargeFilter);
    osc2.connect(chargeFilter);
    chargeFilter.connect(chargeGain);
    chargeGain.connect(v.output);
    this.sendToSfxDelay(chargeGain, 0.35, v);

    osc1.start(chargeStart);
    osc2.start(chargeStart);
    lfo.start(chargeStart);
    osc1.stop(chargeStart + chargeDur + 0.03);
    osc2.stop(chargeStart + chargeDur + 0.03);
    lfo.stop(chargeStart + chargeDur + 0.03);

    v.finalize();
  }

  /** Heavy Hypercore kickout solenoid + crisp VUK plunger snap + plasma release burst. */
  public playSaucerEject(): void {
    if (!this.canPlay()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const v = this.beginVoice(2, 0.25, 0);
    if (!v) return;

    // Heavy solenoid punch
    const kick = v.trackSource(ctx.createOscillator(), now + 0.11);
    const kickGain = v.trackNode(ctx.createGain());
    const drive = this.createShaper(ctx, v);
    kick.type = 'triangle';
    kick.frequency.setValueAtTime(215, now);
    kick.frequency.exponentialRampToValueAtTime(42, now + 0.09);
    this.envDecay(kickGain.gain, now, 0.0015, 0.098, 0.88);
    kick.connect(drive);
    drive.connect(kickGain);
    kickGain.connect(v.output);
    this.sendToCabinet(kickGain, 0.95, v);
    kick.start(now);
    kick.stop(now + 0.11);

    // Metallic kickout rod snap
    this.addNoiseBurst(v, now, 0.025, 'bandpass', 2450, 2.6, 0.5);
    this.addNoiseBurst(v, now + 0.008, 0.018, 'bandpass', 4150, 3.8, 0.32);

    // Plasma discharge downward whoosh
    const zap = v.trackSource(ctx.createOscillator(), now + 0.16);
    const zapGain = v.trackNode(ctx.createGain());
    zap.type = 'sawtooth';
    zap.frequency.setValueAtTime(1650, now);
    zap.frequency.exponentialRampToValueAtTime(210, now + 0.14);
    const zapFilter = v.trackNode(ctx.createBiquadFilter());
    zapFilter.type = 'lowpass';
    zapFilter.frequency.setValueAtTime(3200, now);
    zapFilter.frequency.exponentialRampToValueAtTime(420, now + 0.14);
    this.envDecay(zapGain.gain, now, 0.002, 0.145, 0.24);
    zap.connect(zapFilter);
    zapFilter.connect(zapGain);
    zapGain.connect(v.output);
    this.sendToSfxDelay(zapGain, 0.3, v);
    zap.start(now);
    zap.stop(now + 0.16);

    v.finalize();
  }

  /** Left outlane Shield Kickback: energetic laser shield blast + heavy firing solenoid. */
  public playKickback(): void {
    if (!this.canPlay()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const v = this.beginVoice(2, 0.38, -0.68);
    if (!v) return;

    // 1. Heavy firing solenoid
    const sol = v.trackSource(ctx.createOscillator(), now + 0.1);
    const solGain = v.trackNode(ctx.createGain());
    const drive = this.createShaper(ctx, v);
    sol.type = 'triangle';
    sol.frequency.setValueAtTime(195, now);
    sol.frequency.exponentialRampToValueAtTime(44, now + 0.082);
    this.envDecay(solGain.gain, now, 0.0015, 0.088, 0.84);
    sol.connect(drive);
    drive.connect(solGain);
    solGain.connect(v.output);
    this.sendToCabinet(solGain, 0.85, v);
    sol.start(now);
    sol.stop(now + 0.1);

    this.addNoiseBurst(v, now, 0.028, 'bandpass', 2600, 2.2, 0.45);

    // 2. Energetic laser shield discharge blast
    const laser = v.trackSource(ctx.createOscillator(), now + 0.3);
    const lfo = v.trackSource(ctx.createOscillator(), now + 0.3);
    const lfoGain = v.trackNode(ctx.createGain());
    const laserFilter = v.trackNode(ctx.createBiquadFilter());
    const laserGain = v.trackNode(ctx.createGain());

    laser.type = 'sawtooth';
    laser.frequency.setValueAtTime(1750, now);
    laser.frequency.exponentialRampToValueAtTime(240, now + 0.26);

    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(44, now);
    lfoGain.gain.setValueAtTime(160, now);
    lfoGain.gain.exponentialRampToValueAtTime(15, now + 0.26);
    lfo.connect(lfoGain);
    lfoGain.connect(laser.frequency);

    laserFilter.type = 'lowpass';
    laserFilter.Q.setValueAtTime(5.5, now);
    laserFilter.frequency.setValueAtTime(4500, now);
    laserFilter.frequency.exponentialRampToValueAtTime(600, now + 0.27);
    this.envDecay(laserGain.gain, now, 0.002, 0.27, 0.34);

    laser.connect(laserFilter);
    laserFilter.connect(laserGain);
    laserGain.connect(v.output);
    this.sendToSfxDelay(laserGain, 0.4, v);

    laser.start(now);
    lfo.start(now);
    laser.stop(now + 0.3);
    lfo.stop(now + 0.3);

    // Rising shield confirm harmonic
    this.addBellPing(v, now + 0.02, 0.26, midiToFreq(86), 0.2, 0.35);

    v.finalize();
  }

  /**
   * Velocity-scaled wood/rubber playfield wall thud.
   * @param speed Impact speed in world units/s (typically 1..45; sub-0.35 grazing ignored)
   * @param pan Stereo pan in [-1, 1]
   */
  public playWallBounce(speed: number, pan = 0): void {
    const spd = sanitizePositive(speed, 0);
    if (spd < 0.35) return;
    if (!this.canPlay() || !this.throttle('wallBounce', 0.032)) return;

    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const norm = clamp(Math.pow(Math.min(spd / 32, 1), 0.72), 0.06, 1);

    const v = this.beginVoice(0, 0.08, pan);
    if (!v) return;

    // Warm woody/rubber impact body
    const osc = v.trackSource(ctx.createOscillator(), now + 0.055);
    const gain = v.trackNode(ctx.createGain());
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(jitter(128 + norm * 75, 0.06), now);
    osc.frequency.exponentialRampToValueAtTime(52, now + 0.042);
    this.envDecay(gain.gain, now, 0.0015, 0.044, 0.1 + norm * 0.42);
    osc.connect(gain);
    gain.connect(v.output);
    this.sendToCabinet(gain, 0.42 * norm, v);
    osc.start(now);
    osc.stop(now + 0.055);

    // Velocity-brightened rubber/rail snap
    this.addNoiseBurst(v, now, 0.018 + norm * 0.012, 'bandpass', jitter(550 + norm * 1450, 0.08), 2.2, 0.06 + norm * 0.24);

    v.finalize();
  }

  /**
   * Velocity-scaled high-Q chrome steel-on-steel pinball clack (signature multiball foley!).
   * @param speed Relative collision speed in world units/s (typically 1..45)
   * @param pan Stereo pan in [-1, 1]
   */
  public playBallCollision(speed: number, pan = 0): void {
    const spd = sanitizePositive(speed, 0);
    if (spd < 0.25) return;
    if (!this.canPlay() || !this.throttle('ballCollision', 0.024)) return;

    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const norm = clamp(Math.pow(Math.min(spd / 28, 1), 0.7), 0.08, 1);
    const ringDur = 0.016 + norm * 0.02;

    const v = this.beginVoice(0, ringDur + 0.03, pan);
    if (!v) return;

    // Ultra-sharp hardened steel contact transient
    this.addNoiseBurst(v, now, 0.006, 'highpass', 3200, 1.2, 0.14 + norm * 0.34);

    // Inharmonic 27mm chrome steel sphere modal ringing (3.1 kHz, 4.9 kHz, 7.1 kHz)
    const modes: readonly [number, number][] = [
      [jitter(3140, 0.03), 0.34],
      [jitter(4920, 0.035), 0.26],
      [jitter(7180, 0.04), 0.16],
    ];
    for (const [freq, weight] of modes) {
      const clampedFreq = this.clampFreq(freq);
      const osc = v.trackSource(ctx.createOscillator(), now + ringDur + 0.012);
      const gain = v.trackNode(ctx.createGain());
      osc.type = 'sine';
      osc.frequency.setValueAtTime(clampedFreq, now);
      this.envDecay(gain.gain, now, 0.0005, ringDur, weight * (0.18 + norm * 0.82));
      osc.connect(gain);
      gain.connect(v.output);
      osc.start(now);
      osc.stop(now + ringDur + 0.012);
    }

    // Minimal crisp mid-knock for body
    const knock = v.trackSource(ctx.createOscillator(), now + 0.02);
    const knockGain = v.trackNode(ctx.createGain());
    knock.type = 'sine';
    knock.frequency.setValueAtTime(420, now);
    knock.frequency.exponentialRampToValueAtTime(190, now + 0.014);
    this.envDecay(knockGain.gain, now, 0.0006, 0.015, 0.08 + norm * 0.14);
    knock.connect(knockGain);
    knockGain.connect(v.output);
    knock.start(now);
    knock.stop(now + 0.02);

    v.finalize();
  }

  /** Ball lost: metal trough drop clunk + descending sci-fi power-down sweep. */
  public playDrain(): void {
    if (!this.canPlay()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const v = this.beginVoice(3, 0.78, 0);
    if (!v) return;

    // 1. Metallic ball-trough drop clunk
    const clunkAt = now + 0.035;
    const clunk = v.trackSource(ctx.createOscillator(), clunkAt + 0.075);
    const clunkGain = v.trackNode(ctx.createGain());
    clunk.type = 'triangle';
    clunk.frequency.setValueAtTime(240, clunkAt);
    clunk.frequency.exponentialRampToValueAtTime(98, clunkAt + 0.06);
    this.envDecay(clunkGain.gain, clunkAt, 0.002, 0.065, 0.44);
    clunk.connect(clunkGain);
    clunkGain.connect(v.output);
    this.sendToCabinet(clunkGain, 0.65, v);
    clunk.start(clunkAt);
    clunk.stop(clunkAt + 0.075);
    this.addNoiseBurst(v, clunkAt, 0.026, 'bandpass', 1800, 3.0, 0.28);

    // 2. Descending sci-fi power-down synth sweep
    const sweepDur = 0.66;
    const oscA = v.trackSource(ctx.createOscillator(), now + sweepDur + 0.04);
    const oscB = v.trackSource(ctx.createOscillator(), now + sweepDur + 0.04);
    const filter = v.trackNode(ctx.createBiquadFilter());
    const gain = v.trackNode(ctx.createGain());

    oscA.type = 'sawtooth';
    oscB.type = 'triangle';
    oscA.frequency.setValueAtTime(440, now);
    oscA.frequency.exponentialRampToValueAtTime(70, now + sweepDur);
    oscB.frequency.setValueAtTime(444, now);
    oscB.frequency.exponentialRampToValueAtTime(68, now + sweepDur);

    filter.type = 'lowpass';
    filter.Q.setValueAtTime(4.0, now);
    filter.frequency.setValueAtTime(2400, now);
    filter.frequency.exponentialRampToValueAtTime(140, now + sweepDur);

    this.envDecay(gain.gain, now, 0.015, sweepDur, 0.34);

    oscA.connect(filter);
    oscB.connect(filter);
    filter.connect(gain);
    gain.connect(v.output);
    this.sendToSfxDelay(gain, 0.28, v);

    oscA.start(now);
    oscB.start(now);
    oscA.stop(now + sweepDur + 0.04);
    oscB.stop(now + sweepDur + 0.04);

    v.finalize();
  }

  /** HYPER SAVE active: urgent ascending sci-fi rescue siren + warp-back chime. */
  public playBallSave(): void {
    if (!this.canPlay()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const v = this.beginVoice(3, 0.72, 0);
    if (!v) return;

    this.duckMusic(0.65, 0.38);

    // 3 rapid urgent ascending rescue chirps
    const chirps: readonly [number, number][] = [
      [587.33, 880],
      [659.25, 987.77],
      [783.99, 1174.66],
    ];
    for (let i = 0; i < chirps.length; i++) {
      const pair = chirps[i] ?? [587.33, 880];
      const t = now + i * 0.135;
      const dur = 0.125;

      const osc = v.trackSource(ctx.createOscillator(), t + dur + 0.02);
      const osc2 = v.trackSource(ctx.createOscillator(), t + dur + 0.02);
      const filter = v.trackNode(ctx.createBiquadFilter());
      const gain = v.trackNode(ctx.createGain());

      osc.type = 'square';
      osc2.type = 'sawtooth';
      osc.frequency.setValueAtTime(pair[0], t);
      osc.frequency.exponentialRampToValueAtTime(pair[1], t + dur * 0.85);
      osc2.frequency.setValueAtTime(pair[0] * 1.006, t);
      osc2.frequency.exponentialRampToValueAtTime(pair[1] * 1.006, t + dur * 0.85);

      filter.type = 'lowpass';
      filter.Q.setValueAtTime(3.8, t);
      filter.frequency.setValueAtTime(1600, t);
      filter.frequency.exponentialRampToValueAtTime(4200, t + dur * 0.85);

      this.envDecay(gain.gain, t, 0.005, dur, 0.24);
      osc.connect(filter);
      osc2.connect(filter);
      filter.connect(gain);
      gain.connect(v.output);
      this.sendToSfxDelay(gain, 0.35, v);

      osc.start(t);
      osc2.start(t);
      osc.stop(t + dur + 0.02);
      osc2.stop(t + dur + 0.02);
    }

    // Crisp shield-restore sparkle chime at apex
    this.addBellPing(v, now + 0.4, 0.28, midiToFreq(86), 0.26, 0.42);

    v.finalize();
  }

  /**
   * Heavy physical wooden cabinet nudge thump + subtle internal mechanism rattle.
   * @param intensity Nudge strength in [0, 1]
   */
  public playNudge(intensity = 0.7): void {
    if (!this.canPlay() || !this.throttle('nudge', 0.08)) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const k = clamp(intensity, 0.15, 1);

    const v = this.beginVoice(2, 0.18, 0);
    if (!v) return;

    // Deep hollow wooden cabinet body knock
    const body = v.trackSource(ctx.createOscillator(), now + 0.12);
    const bodyGain = v.trackNode(ctx.createGain());
    const drive = this.createShaper(ctx, v);
    body.type = 'sine';
    body.frequency.setValueAtTime(jitter(96 + k * 24, 0.05), now);
    body.frequency.exponentialRampToValueAtTime(34, now + 0.095);
    this.envDecay(bodyGain.gain, now, 0.003, 0.105, 0.48 + k * 0.42);
    body.connect(drive);
    drive.connect(bodyGain);
    bodyGain.connect(v.output);
    this.sendToCabinet(bodyGain, 1.0, v);
    body.start(now);
    body.stop(now + 0.12);

    // Palm-on-cabinet slap noise
    this.addNoiseBurst(v, now, 0.055, 'bandpass', 260, 1.5, 0.32 + k * 0.34);

    // Subtle internal tilt-plumb / spring metallic rattle
    this.addNoiseBurst(v, now + 0.032, 0.022, 'bandpass', 2150, 4.5, 0.08 + k * 0.12);

    v.finalize();
  }

  /** Sharp double-pulse arcade DANGER tilt warning buzzer. */
  public playTiltWarning(): void {
    if (!this.canPlay()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const v = this.beginVoice(2, 0.38, 0);
    if (!v) return;

    const pulseStarts = [0, 0.155];
    for (const offset of pulseStarts) {
      const t = now + offset;
      const dur = 0.115;
      const oscA = v.trackSource(ctx.createOscillator(), t + dur + 0.015);
      const oscB = v.trackSource(ctx.createOscillator(), t + dur + 0.015);
      const filter = v.trackNode(ctx.createBiquadFilter());
      const drive = this.createShaper(ctx, v);
      const gain = v.trackNode(ctx.createGain());

      // Dissonant tritone arcade warning buzzer (Eb3 + A3)
      oscA.type = 'sawtooth';
      oscB.type = 'square';
      oscA.frequency.setValueAtTime(155.56, t);
      oscB.frequency.setValueAtTime(220.0, t);

      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(920, t);
      filter.Q.setValueAtTime(1.8, t);

      gain.gain.setValueAtTime(0, now);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(0.32, t + 0.006);
      gain.gain.setValueAtTime(0.3, t + dur - 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      gain.gain.setValueAtTime(0, t + dur + 0.002);

      oscA.connect(drive);
      oscB.connect(drive);
      drive.connect(filter);
      filter.connect(gain);
      gain.connect(v.output);

      oscA.start(t);
      oscB.start(t);
      oscA.stop(t + dur + 0.015);
      oscB.stop(t + dur + 0.015);
    }

    v.finalize();
  }

  /** Dramatic full TILT power-relay cutoff clunk + reactor shutdown groan. */
  public playTilt(): void {
    if (!this.canPlay()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const v = this.beginVoice(3, 1.32, 0);
    if (!v) return;

    this.duckMusic(1.4, 0.12);

    // 1. Heavy power relay cutout clunk
    this.addNoiseBurst(v, now, 0.032, 'bandpass', 1100, 2.0, 0.55);
    const relay = v.trackSource(ctx.createOscillator(), now + 0.09);
    const relayGain = v.trackNode(ctx.createGain());
    relay.type = 'triangle';
    relay.frequency.setValueAtTime(140, now);
    relay.frequency.exponentialRampToValueAtTime(40, now + 0.08);
    this.envDecay(relayGain.gain, now, 0.002, 0.082, 0.72);
    relay.connect(relayGain);
    relayGain.connect(v.output);
    this.sendToCabinet(relayGain, 0.9, v);
    relay.start(now);
    relay.stop(now + 0.09);

    // 2. Heavy grinding power-down tilt groan
    const groanStart = now + 0.01;
    const groanDur = 1.18;
    const oscA = v.trackSource(ctx.createOscillator(), groanStart + groanDur + 0.04);
    const oscB = v.trackSource(ctx.createOscillator(), groanStart + groanDur + 0.04);
    const sub = v.trackSource(ctx.createOscillator(), groanStart + groanDur + 0.04);
    const lfo = v.trackSource(ctx.createOscillator(), groanStart + groanDur + 0.04);
    const lfoGain = v.trackNode(ctx.createGain());
    const drive = this.createShaper(ctx, v);
    const filter = v.trackNode(ctx.createBiquadFilter());
    const gain = v.trackNode(ctx.createGain());

    oscA.type = 'sawtooth';
    oscB.type = 'sawtooth';
    sub.type = 'triangle';
    oscA.frequency.setValueAtTime(196, groanStart);
    oscA.frequency.exponentialRampToValueAtTime(38, groanStart + groanDur);
    oscB.frequency.setValueAtTime(207, groanStart); // Gritty minor-second rub
    oscB.frequency.exponentialRampToValueAtTime(36, groanStart + groanDur);
    sub.frequency.setValueAtTime(98, groanStart);
    sub.frequency.exponentialRampToValueAtTime(28, groanStart + groanDur);

    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(10, groanStart);
    lfo.frequency.exponentialRampToValueAtTime(2.8, groanStart + groanDur);
    lfoGain.gain.setValueAtTime(16, groanStart);
    lfoGain.gain.exponentialRampToValueAtTime(4, groanStart + groanDur);
    lfo.connect(lfoGain);
    lfoGain.connect(oscA.frequency);

    filter.type = 'lowpass';
    filter.Q.setValueAtTime(3.2, groanStart);
    filter.frequency.setValueAtTime(1500, groanStart);
    filter.frequency.exponentialRampToValueAtTime(85, groanStart + groanDur);

    this.envDecay(gain.gain, groanStart, 0.025, groanDur, 0.44);

    oscA.connect(drive);
    oscB.connect(drive);
    sub.connect(filter);
    drive.connect(filter);
    filter.connect(gain);
    gain.connect(v.output);

    oscA.start(groanStart);
    oscB.start(groanStart);
    sub.start(groanStart);
    lfo.start(groanStart);
    oscA.stop(groanStart + groanDur + 0.04);
    oscB.stop(groanStart + groanDur + 0.04);
    sub.stop(groanStart + groanDur + 0.04);
    lfo.stop(groanStart + groanDur + 0.04);

    v.finalize();
  }

  // -------------------------------------------------------------------------
  // Continuous Rolling Audio Bed
  // -------------------------------------------------------------------------

  /**
   * Continuously modulates the playfield wooden rolling bed and chrome wireform
   * dual-rail resonant metallic ring. Safe to call every render frame.
   *
   * @param playfieldSpeed Fastest active ball speed on the playfield (world units/s, ~0..40)
   * @param wireformSpeed Fastest active ball speed riding the chrome wireform (world units/s, ~0..35)
   */
  public updateRolling(playfieldSpeed: number, wireformSpeed: number): void {
    if (!this.canPlay()) return;

    const pfSpeed = sanitizePositive(playfieldSpeed, 0);
    const wfSpeed = sanitizePositive(wireformSpeed, 0);

    // Playfield wooden rolling rumble
    if (this.playfieldRollGain && this.playfieldRollFilter) {
      const pfNorm = pfSpeed > 0.35 ? clamp((pfSpeed - 0.35) / 28, 0, 1) : 0;
      const targetGain = pfNorm > 0 ? Math.pow(pfNorm, 1.35) * 0.2 : 0;
      const targetCutoff = this.clampFreq(155 + pfNorm * 640);
      this.smoothParam(this.playfieldRollGain.gain, targetGain, 0.045);
      this.smoothParam(this.playfieldRollFilter.frequency, targetCutoff, 0.05);
    }

    // Chrome wireform habitrail bright metallic dual-rail resonant ring
    if (this.wireformRollGain && this.wireformFilterA && this.wireformFilterB) {
      const wfNorm = wfSpeed > 0.25 ? clamp(wfSpeed / 24, 0, 1) : 0;
      const targetGain = wfNorm > 0 ? Math.pow(wfNorm, 0.85) * 0.42 : 0;
      const freqA = this.clampFreq(1380 + wfNorm * 620);
      const freqB = this.clampFreq(2680 + wfNorm * 1050);
      this.smoothParam(this.wireformRollGain.gain, targetGain, 0.04);
      this.smoothParam(this.wireformFilterA.frequency, freqA, 0.05);
      this.smoothParam(this.wireformFilterB.frequency, freqB, 0.05);
    }
  }

  // -------------------------------------------------------------------------
  // 90s Sci-Fi Arcade Synth Stingers
  // -------------------------------------------------------------------------

  /** Coin-up chime + energetic rising cosmic launch sequence fanfare. */
  public playStartGame(): void {
    this.playOrDeferOnUnlock(() => {
      const ctx = this.ctx!;
      const now = ctx.currentTime;
      const v = this.beginVoice(3, 1.05, 0);
      if (!v) return;

      this.duckMusic(0.9, 0.3);

      // Classic bright arcade coin/start double chime
      this.addBellPing(v, now, 0.16, midiToFreq(83), 0.2, 0.3);
      this.addBellPing(v, now + 0.075, 0.24, midiToFreq(88), 0.24, 0.35);

      // Rising cosmic synth fanfare (D4 -> F4 -> A4 -> D5 -> F5 -> A5)
      const notes = [62, 65, 69, 74, 77, 81];
      for (let i = 0; i < notes.length; i++) {
        const t = now + 0.12 + i * 0.062;
        const dur = i === notes.length - 1 ? 0.45 : 0.16;
        const freq = midiToFreq(notes[i] ?? 62);
        this.addSynthTone(v, t, dur, freq, 'sawtooth', 0.16, 3800, 0.42);
        this.addSynthTone(v, t, dur, freq * 1.005, 'triangle', 0.14, 4600, 0.32);
      }

      // Deep warm cosmic sub anchor on final chord
      this.addSynthTone(v, now + 0.42, 0.5, midiToFreq(50), 'triangle', 0.28, 700, 0);

      v.finalize();
    });
  }

  /** Sparkling triumphant sci-fi fanfare on Skill Shot hit. */
  public playSkillShot(): void {
    if (!this.canPlay()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const v = this.beginVoice(2, 1.15, 0);
    if (!v) return;

    this.duckMusic(0.95, 0.3);

    // Bright D-major heroic arpeggio burst
    const notes = [74, 78, 81, 86, 90, 93]; // D5, F#5, A5, D6, F#6, A6
    for (let i = 0; i < notes.length; i++) {
      const t = now + i * 0.068;
      const isLast = i === notes.length - 1;
      const freq = midiToFreq(notes[i] ?? 74);
      this.addBellPing(v, t, isLast ? 0.58 : 0.22, freq, isLast ? 0.28 : 0.2, 0.48);
      this.addSynthTone(v, t, isLast ? 0.55 : 0.18, freq * 0.5, 'sawtooth', 0.14, 4200, 0.4);
    }

    // Upward laser shimmer wash
    const sweep = v.trackSource(ctx.createOscillator(), now + 0.32);
    const sweepGain = v.trackNode(ctx.createGain());
    sweep.type = 'sine';
    sweep.frequency.setValueAtTime(520, now);
    sweep.frequency.exponentialRampToValueAtTime(2600, now + 0.28);
    this.envDecay(sweepGain.gain, now, 0.015, 0.28, 0.14);
    sweep.connect(sweepGain);
    sweepGain.connect(v.output);
    this.sendToSfxDelay(sweepGain, 0.45, v);
    sweep.start(now);
    sweep.stop(now + 0.32);

    v.finalize();
  }

  /**
   * Warp Ramp combo arpeggio escalating in pitch & brightness with comboCount.
   * @param comboCount Current ramp combo chain count (1, 2, 3...)
   */
  public playRampCombo(comboCount = 1): void {
    if (!this.canPlay()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const combo = clamp(Math.floor(comboCount), 1, 8);
    const transpose = (combo - 1) * 2; // +2 semitones per combo step

    const v = this.beginVoice(2, 0.85, -0.2);
    if (!v) return;

    // Warp-tunnel whoosh filter sweep
    const whooshDur = 0.34;
    const src = this.createNoiseSource(ctx, this.pinkNoiseBuffer, v, now + whooshDur + 0.04);
    if (src) {
      const wf = v.trackNode(ctx.createBiquadFilter());
      const wg = v.trackNode(ctx.createGain());
      wf.type = 'bandpass';
      wf.Q.setValueAtTime(3.2, now);
      wf.frequency.setValueAtTime(320, now);
      wf.frequency.exponentialRampToValueAtTime(this.clampFreq(2800 + combo * 350), now + whooshDur);
      this.envDecay(wg.gain, now, 0.03, whooshDur, 0.24);
      src.connect(wf);
      wf.connect(wg);
      wg.connect(v.output);
      src.start(now, Math.random() * 1.2);
      src.stop(now + whooshDur + 0.04);
    }

    // Fast ascending warp arpeggio
    const arpBase = [69, 74, 77, 81, 86]; // A4, D5, F5, A5, D6
    const count = combo >= 3 ? 5 : 4;
    for (let i = 0; i < count; i++) {
      const t = now + 0.03 + i * 0.056;
      const midi = Math.min(98, (arpBase[i] ?? 69) + transpose);
      const freq = midiToFreq(midi);
      const isLast = i === count - 1;
      this.addSynthTone(v, t, isLast ? 0.36 : 0.16, freq, 'sawtooth', 0.16, 4600, 0.45);
      this.addBellPing(v, t, isLast ? 0.34 : 0.14, freq, 0.16, 0.4);
    }

    v.finalize();
  }

  /**
   * Dramatic Hypercore lock confirmation stinger escalating across Lock 1, 2, and 3.
   * @param lockNumber 1, 2, or 3
   */
  public playBallLocked(lockNumber = 1): void {
    if (!this.canPlay()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const lock = clamp(Math.floor(lockNumber), 1, 3);

    const v = this.beginVoice(2, 1.18, 0);
    if (!v) return;

    this.duckMusic(1.05, 0.26);

    // Deep reactor lock sub-boom
    const boom = v.trackSource(ctx.createOscillator(), now + 0.32);
    const boomGain = v.trackNode(ctx.createGain());
    boom.type = 'sine';
    boom.frequency.setValueAtTime(110 + lock * 15, now);
    boom.frequency.exponentialRampToValueAtTime(38, now + 0.26);
    this.envDecay(boomGain.gain, now, 0.004, 0.28, 0.62);
    boom.connect(boomGain);
    boomGain.connect(v.output);
    this.sendToCabinet(boomGain, 0.8, v);
    boom.start(now);
    boom.stop(now + 0.32);

    // Escalating heroic sci-fi lock chord progressions
    const lockChords: readonly (readonly number[])[] = [
      [62, 69, 74, 77], // Lock 1: D minor power lock
      [65, 72, 77, 81], // Lock 2: F major/Dorian tension rise
      [69, 73, 76, 81, 86], // Lock 3: A7 -> D critical reactor lock!
    ];
    const chord = lockChords[lock - 1] ?? lockChords[0]!;
    for (let i = 0; i < chord.length; i++) {
      const t = now + 0.03 + i * 0.065;
      const freq = midiToFreq(chord[i] ?? 62);
      this.addSynthTone(v, t, 0.65, freq, 'sawtooth', 0.14, 3400 + lock * 600, 0.45);
      this.addBellPing(v, t, 0.45, freq * 2, 0.12, 0.4);
    }

    v.finalize();
  }

  /** Epic HYPERNOVA MULTIBALL alert siren + driving heroic 90s sci-fi fanfare. */
  public playMultiballStart(): void {
    if (!this.canPlay()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const v = this.beginVoice(3, 2.05, 0);
    if (!v) return;

    this.duckMusic(2.0, 0.18);

    // Stage 1 (0.00 - 0.62s): Twin-oscillator sci-fi klaxon siren pulses
    for (let pulse = 0; pulse < 2; pulse++) {
      const t = now + pulse * 0.3;
      const dur = 0.27;
      const sA = v.trackSource(ctx.createOscillator(), t + dur + 0.02);
      const sB = v.trackSource(ctx.createOscillator(), t + dur + 0.02);
      const sf = v.trackNode(ctx.createBiquadFilter());
      const sg = v.trackNode(ctx.createGain());

      sA.type = 'sawtooth';
      sB.type = 'square';
      sA.frequency.setValueAtTime(420, t);
      sA.frequency.exponentialRampToValueAtTime(920, t + dur * 0.82);
      sB.frequency.setValueAtTime(424, t);
      sB.frequency.exponentialRampToValueAtTime(930, t + dur * 0.82);

      sf.type = 'bandpass';
      sf.Q.setValueAtTime(3.0, t);
      sf.frequency.setValueAtTime(900, t);
      sf.frequency.exponentialRampToValueAtTime(3600, t + dur);

      this.envDecay(sg.gain, t, 0.012, dur, 0.28);
      sA.connect(sf);
      sB.connect(sf);
      sf.connect(sg);
      sg.connect(v.output);
      this.sendToSfxDelay(sg, 0.38, v);

      sA.start(t);
      sB.start(t);
      sA.stop(t + dur + 0.02);
      sB.stop(t + dur + 0.02);
    }

    // Stage 2 (0.60 - 1.85s): Heroic 90s brassy arcade fanfare (D5 - D5 - F5 - G5 - A5 - D6!)
    const melody: readonly [number, number, number][] = [
      [0.6, 74, 0.14],
      [0.74, 74, 0.14],
      [0.88, 77, 0.16],
      [1.04, 79, 0.16],
      [1.2, 81, 0.2],
      [1.38, 86, 0.56],
    ];
    for (const [offset, midi, dur] of melody) {
      const t = now + offset;
      const freq = midiToFreq(midi);
      this.addSynthTone(v, t, dur, freq, 'sawtooth', 0.2, 4800, 0.45);
      this.addSynthTone(v, t, dur, freq * 1.006, 'sawtooth', 0.15, 4200, 0.35);
      this.addSynthTone(v, t, dur, freq * 0.5, 'triangle', 0.16, 1800, 0.15);
    }

    // Driving electronic impact hits under fanfare climax
    for (const hitOffset of [0.6, 1.04, 1.38]) {
      const t = now + hitOffset;
      const kick = v.trackSource(ctx.createOscillator(), t + 0.15);
      const kg = v.trackNode(ctx.createGain());
      kick.type = 'sine';
      kick.frequency.setValueAtTime(145, t);
      kick.frequency.exponentialRampToValueAtTime(38, t + 0.12);
      this.envDecay(kg.gain, t, 0.002, 0.13, 0.58);
      kick.connect(kg);
      kg.connect(v.output);
      kick.start(t);
      kick.stop(t + 0.15);
    }

    v.finalize();
  }

  /**
   * Massive euphoric arcade JACKPOT or SUPER JACKPOT fanfare.
   * @param isSuper True for Super Jackpot double-octave cosmic cascade
   */
  public playJackpot(isSuper = false): void {
    if (!this.canPlay()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const totalDur = isSuper ? 1.95 : 1.35;

    const v = this.beginVoice(3, totalDur, 0);
    if (!v) return;

    this.duckMusic(isSuper ? 1.85 : 1.25, 0.2);

    // Impact sub-boom
    const boom = v.trackSource(ctx.createOscillator(), now + 0.28);
    const boomGain = v.trackNode(ctx.createGain());
    boom.type = 'sine';
    boom.frequency.setValueAtTime(140, now);
    boom.frequency.exponentialRampToValueAtTime(36, now + 0.22);
    this.envDecay(boomGain.gain, now, 0.003, 0.24, isSuper ? 0.7 : 0.52);
    boom.connect(boomGain);
    boomGain.connect(v.output);
    this.sendToCabinet(boomGain, 0.85, v);
    boom.start(now);
    boom.stop(now + 0.28);

    // Victory synth run
    const run = isSuper
      ? [69, 74, 77, 81, 86, 89, 93, 98] // A4 -> D7 double-octave hypernova explosion!
      : [69, 74, 77, 81, 84, 86]; // A4 -> D6 triumphant jackpot run

    const stepGap = isSuper ? 0.072 : 0.082;
    for (let i = 0; i < run.length; i++) {
      const t = now + 0.02 + i * stepGap;
      const isLast = i === run.length - 1;
      const dur = isLast ? (isSuper ? 0.95 : 0.62) : 0.2;
      const freq = midiToFreq(run[i] ?? 74);

      this.addSynthTone(v, t, dur, freq, 'sawtooth', 0.18, 5600, 0.48);
      this.addSynthTone(v, t, dur, freq * 1.007, 'sawtooth', 0.13, 4800, 0.42);
      this.addBellPing(v, t, isLast ? 0.7 : 0.24, freq, 0.2, 0.5);
    }

    if (isSuper) {
      // Heroic sustained D major/power chord swell + shimmering laser flares
      const chordAt = now + 0.56;
      for (const midi of [62, 69, 74, 78, 86]) {
        this.addSynthTone(v, chordAt, 1.1, midiToFreq(midi), 'sawtooth', 0.1, 4400, 0.45);
      }
      // Sparkling high glitter cascade
      for (let i = 0; i < 6; i++) {
        const gt = now + 0.72 + i * 0.09;
        const gMidi = 86 + ((i * 3) % 12);
        this.addBellPing(v, gt, 0.28, midiToFreq(gMidi), 0.16, 0.55);
      }
    }

    v.finalize();
  }

  /** Classic ecstatic arcade 1-UP / Extra Ball fanfare. */
  public playExtraBall(): void {
    if (!this.canPlay()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const v = this.beginVoice(3, 1.45, 0);
    if (!v) return;

    this.duckMusic(1.35, 0.22);

    // Classic joyous major-pentatonic arcade fanfare (D5 -> F#5 -> A5 -> B5 -> D6 -> F#6 -> A6)
    const notes: readonly [number, number, number][] = [
      [0.0, 74, 0.11],
      [0.095, 78, 0.11],
      [0.19, 81, 0.11],
      [0.285, 83, 0.11],
      [0.38, 86, 0.14],
      [0.5, 90, 0.16],
      [0.64, 93, 0.65],
    ];
    for (const [offset, midi, dur] of notes) {
      const t = now + offset;
      const freq = midiToFreq(midi);
      this.addSynthTone(v, t, dur, freq, 'square', 0.15, 4800, 0.42);
      this.addSynthTone(v, t, dur, freq * 0.5, 'triangle', 0.16, 2600, 0.2);
      this.addBellPing(v, t, dur + 0.1, freq, 0.18, 0.45);
    }

    v.finalize();
  }

  /**
   * Crisp ascending end-of-ball bonus tally tick.
   * @param step 0-based count step (climbs musically and caps gracefully)
   */
  public playBonusTick(step = 0): void {
    if (!this.canPlay() || !this.throttle('bonusTick', 0.03)) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const v = this.beginVoice(2, 0.12, 0);
    if (!v) return;

    const s = clamp(Math.floor(step), 0, 28);
    const octave = Math.floor(s / BONUS_SCALE_OFFSETS.length);
    const scaleDeg = BONUS_SCALE_OFFSETS[s % BONUS_SCALE_OFFSETS.length] ?? 0;
    const midi = Math.min(93, 62 + Math.min(octave, 2) * 12 + scaleDeg);
    const freq = midiToFreq(midi);

    this.addSynthTone(v, now, 0.068, freq, 'square', 0.16, 3600, 0.22);
    this.addSynthTone(v, now, 0.08, freq * 2, 'sine', 0.09, 6400, 0.18);
    this.addNoiseBurst(v, now, 0.008, 'highpass', 3600, 1.5, 0.1);

    v.finalize();
  }

  /** Bittersweet 1990s sci-fi arcade Game Over descending synth cadence. */
  public playGameOver(): void {
    if (!this.canPlay()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const v = this.beginVoice(3, 1.95, 0);
    if (!v) return;

    this.duckMusic(1.85, 0.14);

    // Classic descending cosmic minor cadence: D5 -> C5 -> Bb4 -> A4 -> D4
    const cadence: readonly [number, number, number][] = [
      [0.0, 74, 0.28],
      [0.26, 72, 0.28],
      [0.52, 70, 0.28],
      [0.78, 69, 0.38],
      [1.12, 62, 0.74],
    ];
    for (const [offset, midi, dur] of cadence) {
      const t = now + offset;
      const freq = midiToFreq(midi);
      this.addSynthTone(v, t, dur, freq, 'sawtooth', 0.18, 2200, 0.4);
      this.addSynthTone(v, t, dur, freq * 0.996, 'triangle', 0.16, 1600, 0.25);
    }

    // Deep fading low D2 sub-pad under final resolve
    this.addSynthTone(v, now + 1.12, 0.78, midiToFreq(38), 'triangle', 0.28, 360, 0);

    v.finalize();
  }

  // -------------------------------------------------------------------------
  // Audio Graph Construction & Reusable Buffers
  // -------------------------------------------------------------------------

  private initAudioGraph(ctx: AudioContext): void {
    // Shared pre-generated buffers (zero allocations during gameplay)
    this.whiteNoiseBuffer = this.buildWhiteNoiseBuffer(ctx, 2.0);
    this.pinkNoiseBuffer = this.buildPinkNoiseBuffer(ctx, 3.0);
    this.metallicNoiseBuffer = this.buildMetallicNoiseBuffer(ctx, 2.0);
    this.softClipCurve = createSoftClipCurve(2.2, 1024);

    // Master output chain: preLimiter -> limiter -> ceilingPre -> ceilingShaper -> masterGain -> muteGain -> destination
    const muteGain = ctx.createGain();
    muteGain.gain.setValueAtTime(this.muted ? 0 : 1, ctx.currentTime);

    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(volumeCurve(this.masterVolume), ctx.currentTime);

    const preLimiter = ctx.createGain();
    preLimiter.gain.setValueAtTime(0.68, ctx.currentTime);

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.setValueAtTime(-10, ctx.currentTime);
    limiter.knee.setValueAtTime(14, ctx.currentTime);
    limiter.ratio.setValueAtTime(5, ctx.currentTime);
    limiter.attack.setValueAtTime(0.002, ctx.currentTime);
    limiter.release.setValueAtTime(0.15, ctx.currentTime);

    const ceilingPre = ctx.createGain();
    ceilingPre.gain.setValueAtTime(0.5, ctx.currentTime);

    const ceilingShaper = ctx.createWaveShaper();
    ceilingShaper.curve = createMasterCeilingCurve(0.76, 0.94, 2049);
    ceilingShaper.oversample = 'none';

    preLimiter.connect(limiter);
    limiter.connect(ceilingPre);
    ceilingPre.connect(ceilingShaper);
    ceilingShaper.connect(masterGain);
    masterGain.connect(muteGain);
    muteGain.connect(ctx.destination);

    // SFX Bus
    const sfxBus = ctx.createGain();
    sfxBus.gain.setValueAtTime(volumeCurve(this.sfxVolume), ctx.currentTime);
    sfxBus.connect(preLimiter);

    // Wooden Pinball Cabinet Resonance Send (adds authentic plywood cabinet body to mechanical hits)
    const cabinetSend = ctx.createGain();
    cabinetSend.gain.setValueAtTime(0.42, ctx.currentTime);
    const cabBody = ctx.createBiquadFilter();
    cabBody.type = 'bandpass';
    cabBody.frequency.setValueAtTime(142, ctx.currentTime);
    cabBody.Q.setValueAtTime(2.6, ctx.currentTime);
    const cabWood = ctx.createBiquadFilter();
    cabWood.type = 'bandpass';
    cabWood.frequency.setValueAtTime(305, ctx.currentTime);
    cabWood.Q.setValueAtTime(3.0, ctx.currentTime);
    const cabReturn = ctx.createGain();
    cabReturn.gain.setValueAtTime(0.55, ctx.currentTime);
    cabinetSend.connect(cabBody);
    cabinetSend.connect(cabWood);
    cabBody.connect(cabReturn);
    cabWood.connect(cabReturn);
    cabReturn.connect(sfxBus);

    // Subtle 90s Sci-Fi Stereo Delay Send for SFX Synth Stingers (routed inside sfxBus)
    const sfxDelaySend = this.buildStereoDelay(ctx, sfxBus, 0.135, 0.205, 0.22, 0.22);

    // Music Bus: musicModeGain -> musicDuckGain -> musicBus -> preLimiter
    const musicBus = ctx.createGain();
    musicBus.gain.setValueAtTime(volumeCurve(this.musicVolume) * 0.34, ctx.currentTime);
    const musicDuckGain = ctx.createGain();
    musicDuckGain.gain.setValueAtTime(1, ctx.currentTime);
    const musicModeGain = ctx.createGain();
    musicModeGain.gain.setValueAtTime(this.musicMode === 'off' ? 0 : 1, ctx.currentTime);

    musicModeGain.connect(musicDuckGain);
    musicDuckGain.connect(musicBus);
    musicBus.connect(preLimiter);

    // Separate Music Stereo Delay Send (routed inside musicModeGain so muting/stopping music silences tails)
    const musicDelaySend = this.buildStereoDelay(ctx, musicModeGain, 0.18, 0.27, 0.26, 0.24);

    this.muteGain = muteGain;
    this.masterGain = masterGain;
    this.sfxBus = sfxBus;
    this.cabinetSend = cabinetSend;
    this.sfxDelaySend = sfxDelaySend;
    this.musicBus = musicBus;
    this.musicDuckGain = musicDuckGain;
    this.musicModeGain = musicModeGain;
    this.musicDelaySend = musicDelaySend;

    this.staticNodes.push(
      muteGain,
      masterGain,
      preLimiter,
      limiter,
      ceilingPre,
      ceilingShaper,
      sfxBus,
      cabinetSend,
      cabBody,
      cabWood,
      cabReturn,
      musicBus,
      musicDuckGain,
      musicModeGain
    );

    // Continuous Rolling Audio Bed (starts silent at gain 0, smoothly modulated by updateRolling)
    this.initRollingBed(ctx, sfxBus);

    // React automatically if browser suspends, interrupts (Safari/iOS), or resumes context
    this.stateChangeListener = () => {
      if (this.disposed || !this.ctx) return;
      if (this.ctx.state === 'running') {
        if (this.suspended) {
          this.stopMusicScheduler();
          if (typeof this.ctx.suspend === 'function') {
            void this.ctx.suspend().catch(() => {});
          }
          return;
        }
        this.resumePending = false;
        this.onContextRunning();
      } else {
        // Halts music timer cleanly during OS audio interruptions ('interrupted'/'suspended')
        this.stopMusicScheduler();
      }
    };
    try {
      ctx.addEventListener('statechange', this.stateChangeListener);
    } catch {
      // Partial mock AudioContext may omit EventTarget methods
    }
  }

  private buildStereoDelay(
    ctx: AudioContext,
    destination: AudioNode,
    delayTimeL: number,
    delayTimeR: number,
    feedback: number,
    wetAmount: number
  ): GainNode {
    const send = ctx.createGain();
    send.gain.setValueAtTime(1, ctx.currentTime);

    const toneFilter = ctx.createBiquadFilter();
    toneFilter.type = 'bandpass';
    toneFilter.frequency.setValueAtTime(1950, ctx.currentTime);
    toneFilter.Q.setValueAtTime(0.75, ctx.currentTime);

    const delayL = ctx.createDelay(0.5);
    const delayR = ctx.createDelay(0.5);
    delayL.delayTime.setValueAtTime(delayTimeL, ctx.currentTime);
    delayR.delayTime.setValueAtTime(delayTimeR, ctx.currentTime);

    const fbL = ctx.createGain();
    const fbR = ctx.createGain();
    fbL.gain.setValueAtTime(feedback, ctx.currentTime);
    fbR.gain.setValueAtTime(feedback, ctx.currentTime);

    const wet = ctx.createGain();
    wet.gain.setValueAtTime(wetAmount, ctx.currentTime);

    send.connect(toneFilter);
    toneFilter.connect(delayL);
    toneFilter.connect(delayR);

    // Subtle ping-pong cross-feedback
    delayL.connect(fbL);
    fbL.connect(delayR);
    delayR.connect(fbR);
    fbR.connect(delayL);

    if (typeof ctx.createStereoPanner === 'function') {
      const panL = ctx.createStereoPanner();
      const panR = ctx.createStereoPanner();
      panL.pan.setValueAtTime(-0.65, ctx.currentTime);
      panR.pan.setValueAtTime(0.65, ctx.currentTime);
      delayL.connect(panL);
      delayR.connect(panR);
      panL.connect(wet);
      panR.connect(wet);
      this.staticNodes.push(panL, panR);
    } else {
      delayL.connect(wet);
      delayR.connect(wet);
    }

    wet.connect(destination);
    this.staticNodes.push(send, toneFilter, delayL, delayR, fbL, fbR, wet);
    return send;
  }

  private initRollingBed(ctx: AudioContext, destination: AudioNode): void {
    // 1. Playfield wooden rolling rumble loop
    if (this.pinkNoiseBuffer) {
      const pfSource = ctx.createBufferSource();
      pfSource.buffer = this.pinkNoiseBuffer;
      pfSource.loop = true;

      const pfLowpass = ctx.createBiquadFilter();
      pfLowpass.type = 'lowpass';
      pfLowpass.frequency.setValueAtTime(220, ctx.currentTime);
      pfLowpass.Q.setValueAtTime(0.9, ctx.currentTime);

      const pfWoodPeak = ctx.createBiquadFilter();
      pfWoodPeak.type = 'peaking';
      pfWoodPeak.frequency.setValueAtTime(235, ctx.currentTime);
      pfWoodPeak.Q.setValueAtTime(1.8, ctx.currentTime);
      pfWoodPeak.gain.setValueAtTime(4.5, ctx.currentTime);

      const pfGain = ctx.createGain();
      pfGain.gain.setValueAtTime(0, ctx.currentTime);

      pfSource.connect(pfLowpass);
      pfLowpass.connect(pfWoodPeak);
      pfWoodPeak.connect(pfGain);
      pfGain.connect(destination);
      pfSource.start(ctx.currentTime);

      this.playfieldRollSource = pfSource;
      this.playfieldRollFilter = pfLowpass;
      this.playfieldRollGain = pfGain;
      this.staticNodes.push(pfSource, pfLowpass, pfWoodPeak, pfGain);
    }

    // 2. Chrome wireform habitrail dual-rail resonant metallic ring loop
    if (this.metallicNoiseBuffer) {
      const wfSource = ctx.createBufferSource();
      wfSource.buffer = this.metallicNoiseBuffer;
      wfSource.loop = true;

      const wfFilterA = ctx.createBiquadFilter();
      wfFilterA.type = 'bandpass';
      wfFilterA.frequency.setValueAtTime(1480, ctx.currentTime);
      wfFilterA.Q.setValueAtTime(6.5, ctx.currentTime);

      const wfFilterB = ctx.createBiquadFilter();
      wfFilterB.type = 'bandpass';
      wfFilterB.frequency.setValueAtTime(2860, ctx.currentTime);
      wfFilterB.Q.setValueAtTime(8.0, ctx.currentTime);

      const wfGain = ctx.createGain();
      wfGain.gain.setValueAtTime(0, ctx.currentTime);

      wfSource.connect(wfFilterA);
      wfSource.connect(wfFilterB);
      wfFilterA.connect(wfGain);
      wfFilterB.connect(wfGain);

      if (typeof ctx.createStereoPanner === 'function') {
        const wfPan = ctx.createStereoPanner();
        wfPan.pan.setValueAtTime(-0.35, ctx.currentTime);
        wfGain.connect(wfPan);
        wfPan.connect(destination);
        this.staticNodes.push(wfPan);
      } else {
        wfGain.connect(destination);
      }

      wfSource.start(ctx.currentTime);

      this.wireformRollSource = wfSource;
      this.wireformFilterA = wfFilterA;
      this.wireformFilterB = wfFilterB;
      this.wireformRollGain = wfGain;
      this.staticNodes.push(wfSource, wfFilterA, wfFilterB, wfGain);
    }
  }

  private buildWhiteNoiseBuffer(ctx: AudioContext, durationSec: number): AudioBuffer {
    const length = Math.max(1, Math.floor(ctx.sampleRate * durationSec));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  private buildPinkNoiseBuffer(ctx: AudioContext, durationSec: number): AudioBuffer {
    const length = Math.max(1, Math.floor(ctx.sampleRate * durationSec));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Paul Kellet's refined pink noise approximation
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    }

    // Crossfade loop seam for seamless click-free looping
    const fadeLen = Math.min(2048, Math.floor(length / 8));
    for (let i = 0; i < fadeLen; i++) {
      const t = i / fadeLen;
      data[length - fadeLen + i] =
        (data[length - fadeLen + i] ?? 0) * (1 - t) + (data[i] ?? 0) * t;
    }
    return buffer;
  }

  private buildMetallicNoiseBuffer(ctx: AudioContext, durationSec: number): AudioBuffer {
    const length = Math.max(1, Math.floor(ctx.sampleRate * durationSec));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // High-frequency bright noise with gentle micro-ripple (simulating stainless steel wireform grain)
    let prev = 0;
    const rippleRate = (Math.PI * 2 * 22) / ctx.sampleRate;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      const high = white - prev * 0.82;
      prev = white;
      const mod = 0.78 + 0.22 * Math.sin(i * rippleRate);
      data[i] = high * mod * 0.55;
    }

    const fadeLen = Math.min(1024, Math.floor(length / 8));
    for (let i = 0; i < fadeLen; i++) {
      const t = i / fadeLen;
      data[length - fadeLen + i] =
        (data[length - fadeLen + i] ?? 0) * (1 - t) + (data[i] ?? 0) * t;
    }
    return buffer;
  }

  // -------------------------------------------------------------------------
  // Procedural 90s Sci-Fi Cosmic Music Scheduler
  // -------------------------------------------------------------------------

  private onContextRunning(): void {
    if (this.disposed || this.suspended || !this.ctx) return;

    // Fire at most one deferred critical stinger (e.g. playStartGame called synchronously with unlock)
    if (this.pendingOnResume) {
      const fn = this.pendingOnResume;
      const age = Date.now() - this.pendingOnResumeSetAt;
      this.pendingOnResume = null;
      if (age < 600) {
        fn();
      }
    }

    if (this.musicMode !== 'off' && this.musicModeGain) {
      this.smoothParam(this.musicModeGain.gain, 1, 0.035);
      if (this.musicTimerId === null) {
        this.startMusicScheduler(false);
      }
    }
  }

  private startMusicScheduler(resetPhase: boolean): void {
    if (this.disposed || this.suspended || !this.ctx || this.musicMode === 'off') return;

    this.stopMusicScheduler();

    if (resetPhase) {
      this.musicStepIndex = 0;
    }
    this.nextMusicStepTime = this.ctx.currentTime + 0.05;

    this.musicTimerId = globalThis.setInterval(() => {
      this.pumpMusicScheduler();
    }, 25);

    this.pumpMusicScheduler();
  }

  private stopMusicScheduler(): void {
    if (this.musicTimerId !== null) {
      globalThis.clearInterval(this.musicTimerId);
      this.musicTimerId = null;
    }
  }

  private pumpMusicScheduler(): void {
    if (
      this.disposed ||
      this.suspended ||
      !this.ctx ||
      this.ctx.state !== 'running' ||
      this.musicMode === 'off'
    ) {
      return;
    }

    const ctx = this.ctx;
    const now = ctx.currentTime;

    // Prevent catch-up burst after any timer stall or resume
    if (this.nextMusicStepTime < now - 0.15) {
      this.nextMusicStepTime = now + 0.05;
    }

    const bpm = this.musicMode === 'multiball' ? 146 : 122;
    const stepDuration = 60 / bpm / 4; // 16th-note duration
    const lookahead = 0.13;

    let safetyCounter = 0;
    while (this.nextMusicStepTime < now + lookahead && safetyCounter < 8) {
      this.scheduleMusicStep(this.musicStepIndex, this.nextMusicStepTime, stepDuration);
      this.nextMusicStepTime += stepDuration;
      this.musicStepIndex = (this.musicStepIndex + 1) % 64;
      safetyCounter++;
    }
  }

  private scheduleMusicStep(step: number, when: number, stepDur: number): void {
    if (!this.ctx || !this.musicModeGain) return;
    // Skip node creation while muted or zero volume (step index keeps advancing in sync)
    if (this.muted || this.musicVolume <= 0.001 || this.masterVolume <= 0.001) return;

    const bar = Math.floor(step / 16) % 4;
    const subStep = step % 16;
    const isMultiball = this.musicMode === 'multiball';

    // 1. Pulsing analog 90s sci-fi synth bassline
    const bassRoots = isMultiball ? MULTIBALL_BASS_ROOTS : NORMAL_BASS_ROOTS;
    const bassSteps = isMultiball ? MULTIBALL_BASS_STEPS : NORMAL_BASS_STEPS;
    const bassOffset = bassSteps[subStep] ?? -1;
    if (bassOffset >= 0) {
      const root = bassRoots[bar] ?? 38;
      const bassFreq = midiToFreq(root + bassOffset);
      // Slow resonant filter sweep across the 4-bar cycle in multiball
      const barSweep = isMultiball ? 850 + Math.sin((step / 64) * Math.PI * 2) * 420 : 620;
      this.playMusicBassNote(when, stepDur * (isMultiball ? 0.88 : 1.15), bassFreq, barSweep, isMultiball ? 0.42 : 0.34);
    }

    // 2. Cosmic shimmering synth arpeggio
    if (isMultiball) {
      const chord = MULTIBALL_ARP_CHORDS[bar] ?? MULTIBALL_ARP_CHORDS[0]!;
      const idx = MULTIBALL_ARP_PATTERN[subStep] ?? 0;
      const arpMidi = chord[idx % chord.length] ?? 62;
      const pan = ((subStep % 4) - 1.5) * 0.35;
      this.playMusicArpNote(when, stepDur * 1.1, midiToFreq(arpMidi), pan, 0.16, 3600);
    } else {
      const gate = NORMAL_ARP_GATE[subStep] ?? -1;
      if (gate >= 0) {
        const chord = NORMAL_ARP_CHORDS[bar] ?? NORMAL_ARP_CHORDS[0]!;
        const arpMidi = chord[gate % chord.length] ?? 62;
        const pan = (gate - 1.5) * 0.3;
        this.playMusicArpNote(when, stepDur * 2.1, midiToFreq(arpMidi), pan, 0.13, 2400);
      }
    }

    // 3. Minimal crisp electronic arcade percussion pulse
    const kickTrigger = isMultiball ? subStep % 4 === 0 : subStep === 0 || subStep === 8;
    if (kickTrigger) {
      this.playMusicKick(when, isMultiball ? 0.34 : 0.22);
    }

    const hatTrigger = isMultiball ? subStep % 2 === 1 : subStep === 4 || subStep === 12;
    if (hatTrigger) {
      this.playMusicHat(when, isMultiball ? 0.085 : 0.05);
    }
  }

  private playMusicBassNote(
    when: number,
    dur: number,
    freq: number,
    cutoff: number,
    level: number
  ): void {
    const ctx = this.ctx!;
    const v = this.beginVoice(1, dur + 0.06, 0, true, when);
    if (!v) return;

    const saw = v.trackSource(ctx.createOscillator(), when + dur + 0.03);
    const sub = v.trackSource(ctx.createOscillator(), when + dur + 0.03);
    const filter = v.trackNode(ctx.createBiquadFilter());
    const gain = v.trackNode(ctx.createGain());

    saw.type = 'sawtooth';
    sub.type = 'sine';
    saw.frequency.setValueAtTime(freq, when);
    sub.frequency.setValueAtTime(freq, when);

    filter.type = 'lowpass';
    filter.Q.setValueAtTime(4.2, when);
    filter.frequency.setValueAtTime(this.clampFreq(cutoff * 1.9), when);
    filter.frequency.exponentialRampToValueAtTime(this.clampFreq(Math.max(180, cutoff * 0.45)), when + dur);

    this.envDecay(gain.gain, when, 0.004, dur, level);

    saw.connect(filter);
    sub.connect(gain);
    filter.connect(gain);
    gain.connect(v.output);

    saw.start(when);
    sub.start(when);
    saw.stop(when + dur + 0.03);
    sub.stop(when + dur + 0.03);

    v.finalize();
  }

  private playMusicArpNote(
    when: number,
    dur: number,
    freq: number,
    pan: number,
    level: number,
    cutoff: number
  ): void {
    const ctx = this.ctx!;
    const v = this.beginVoice(0, dur + 0.05, pan, true, when);
    if (!v) return;

    const osc = v.trackSource(ctx.createOscillator(), when + dur + 0.02);
    const filter = v.trackNode(ctx.createBiquadFilter());
    const gain = v.trackNode(ctx.createGain());

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, when);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(this.clampFreq(cutoff), when);
    filter.frequency.exponentialRampToValueAtTime(this.clampFreq(Math.max(400, cutoff * 0.35)), when + dur);

    this.envDecay(gain.gain, when, 0.004, dur, level);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(v.output);
    if (this.musicDelaySend) {
      const send = v.trackNode(ctx.createGain());
      send.gain.setValueAtTime(0.45, when);
      v.output.connect(send);
      send.connect(this.musicDelaySend);
    }

    osc.start(when);
    osc.stop(when + dur + 0.02);

    v.finalize();
  }

  private playMusicKick(when: number, level: number): void {
    const ctx = this.ctx!;
    const v = this.beginVoice(0, 0.12, 0, true, when);
    if (!v) return;

    const osc = v.trackSource(ctx.createOscillator(), when + 0.1);
    const gain = v.trackNode(ctx.createGain());
    osc.type = 'sine';
    osc.frequency.setValueAtTime(118, when);
    osc.frequency.exponentialRampToValueAtTime(42, when + 0.075);
    this.envDecay(gain.gain, when, 0.002, 0.088, level);

    osc.connect(gain);
    gain.connect(v.output);
    osc.start(when);
    osc.stop(when + 0.1);

    v.finalize();
  }

  private playMusicHat(when: number, level: number): void {
    const v = this.beginVoice(0, 0.045, 0.15, true, when);
    if (!v) return;
    this.addNoiseBurst(v, when, 0.028, 'highpass', 7600, 1.2, level);
    v.finalize();
  }

  // -------------------------------------------------------------------------
  // Voice Management, Synthesis Primitives & Helpers
  // -------------------------------------------------------------------------

  private canPlay(): boolean {
    return !this.disposed && !this.suspended && this.ctx !== null && this.ctx.state === 'running';
  }

  private playOrDeferOnUnlock(fn: () => void): void {
    if (this.disposed || this.suspended || !this.ctx) return;
    if (this.ctx.state === 'running') {
      fn();
    } else if (this.resumePending) {
      this.pendingOnResume = fn;
      this.pendingOnResumeSetAt = Date.now();
    }
  }

  private throttle(key: string, minIntervalSec: number): boolean {
    if (!this.ctx) return false;
    const now = this.ctx.currentTime;
    const prev = this.lastTriggerTime.get(key);
    if (prev !== undefined && now - prev < minIntervalSec) {
      return false;
    }
    this.lastTriggerTime.set(key, now);
    return true;
  }

  private clampFreq(freq: number): number {
    const maxFreq = this.ctx ? Math.min(20000, this.ctx.sampleRate * 0.45) : 18000;
    return clamp(freq, 20, maxFreq);
  }

  private smoothParam(param: AudioParam, value: number, timeConstant: number): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    param.setTargetAtTime(clamp(value, 0, 20000), now, Math.max(0.004, timeConstant));
  }

  private duckMusic(durationSec: number, depth = 0.28): void {
    if (!this.ctx || !this.musicDuckGain) return;
    const now = this.ctx.currentTime;
    const gain = this.musicDuckGain.gain;
    const current = clamp(gain.value, 0.05, 1);
    const targetLevel = Math.min(current, clamp(depth, 0.08, 1));
    const targetEnd = Math.max(this.duckUntil, now + durationSec);
    this.duckUntil = targetEnd;

    gain.cancelScheduledValues(now);
    gain.setValueAtTime(current, now);
    gain.linearRampToValueAtTime(targetLevel, now + 0.035);
    gain.setValueAtTime(targetLevel, targetEnd);
    gain.linearRampToValueAtTime(1, targetEnd + 0.45);
  }

  private pruneAndEnforceVoiceLimit(now: number, incomingPriority: number): boolean {
    // First remove expired voices whose onended may have been delayed
    for (const voice of Array.from(this.activeVoices)) {
      if (now >= voice.endTime + 0.08) {
        voice.stop(0);
      }
    }

    if (this.activeVoices.size < this.maxVoices) {
      return true;
    }

    // Steal lowest-priority (tie-break: soonest-ending) voice
    let victim: VoiceHandle | null = null;
    for (const voice of this.activeVoices) {
      if (!victim) {
        victim = voice;
      } else if (
        voice.priority < victim.priority ||
        (voice.priority === victim.priority && voice.endTime < victim.endTime)
      ) {
        victim = voice;
      }
    }

    if (!victim || victim.priority > incomingPriority) {
      return false;
    }

    victim.stop(0.008);
    return true;
  }

  private beginVoice(
    priority: number,
    durationSec: number,
    pan = 0,
    isMusic = false,
    startTime?: number
  ): VoiceContext | null {
    const ctx = this.ctx;
    const bus = isMusic ? this.musicModeGain : this.sfxBus;
    if (!ctx || !bus) return null;

    const now = ctx.currentTime;
    const start = Math.max(now, startTime ?? now);
    if (!this.pruneAndEnforceVoiceLimit(now, priority)) {
      return null;
    }

    const nodes: AudioNode[] = [];
    const sources: AudioScheduledSourceNode[] = [];
    let latestStopTime = start + durationSec;
    let latestSource: AudioScheduledSourceNode | null = null;
    let cleaned = false;

    const output = ctx.createGain();
    output.gain.setValueAtTime(1, start);
    nodes.push(output);

    const clampedPan = clamp(pan, -1, 1) * 0.85;
    if (Math.abs(clampedPan) > 0.005 && typeof ctx.createStereoPanner === 'function') {
      const panner = ctx.createStereoPanner();
      panner.pan.setValueAtTime(clampedPan, start);
      output.connect(panner);
      panner.connect(bus);
      nodes.push(panner);
    } else {
      output.connect(bus);
    }

    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      this.activeVoices.delete(handle);
      this.fadingVoices.delete(handle);
      for (const n of nodes) {
        safeDisconnect(n);
      }
    };

    const handle: VoiceHandle = {
      get endTime(): number {
        return latestStopTime;
      },
      priority,
      isMusic,
      stop: (fadeSeconds = 0.008): void => {
        if (cleaned) return;
        const stopNow = this.ctx ? this.ctx.currentTime : 0;
        if (fadeSeconds > 0 && this.ctx && this.ctx.state === 'running') {
          try {
            const cur = clamp(output.gain.value, 0.0001, 1);
            output.gain.cancelScheduledValues(stopNow);
            output.gain.setValueAtTime(cur, stopNow);
            output.gain.linearRampToValueAtTime(0.0001, stopNow + fadeSeconds);
            output.gain.setValueAtTime(0, stopNow + fadeSeconds + 0.001);
          } catch {
            // Ignore automation errors on closing context
          }
          const stopAt = stopNow + fadeSeconds + 0.003;
          for (const src of sources) {
            safeStop(src, stopAt);
          }
          this.activeVoices.delete(handle);
          if (sources.length === 0) {
            cleanup();
          } else {
            this.fadingVoices.add(handle);
          }
        } else {
          for (const src of sources) {
            safeStop(src);
          }
          cleanup();
        }
      },
    };

    this.activeVoices.add(handle);

    return {
      output,
      trackNode<T extends AudioNode>(node: T): T {
        nodes.push(node);
        return node;
      },
      trackSource<T extends AudioScheduledSourceNode>(source: T, stopTime: number): T {
        nodes.push(source);
        sources.push(source);
        if (stopTime >= latestStopTime || latestSource === null) {
          latestStopTime = stopTime;
          latestSource = source;
        }
        return source;
      },
      finalize(): void {
        if (latestSource) {
          latestSource.onended = cleanup;
        } else {
          cleanup();
        }
      },
    };
  }

  private envDecay(
    param: AudioParam,
    start: number,
    attackSec: number,
    decaySec: number,
    peak: number
  ): void {
    const safePeak = Math.max(0.0002, peak);
    const atk = Math.max(0.0005, attackSec);
    const dec = Math.max(0.004, decaySec);
    const now = this.ctx ? this.ctx.currentTime : start;
    if (start > now) {
      param.setValueAtTime(0, now);
    }
    param.setValueAtTime(0.0001, start);
    param.linearRampToValueAtTime(safePeak, start + atk);
    param.exponentialRampToValueAtTime(0.0001, start + atk + dec);
    param.setValueAtTime(0, start + atk + dec + 0.002);
  }

  private createShaper(ctx: AudioContext, v: VoiceContext): WaveShaperNode {
    const shaper = v.trackNode(ctx.createWaveShaper());
    if (this.softClipCurve) {
      shaper.curve = this.softClipCurve;
    }
    shaper.oversample = 'none';
    return shaper;
  }

  private createNoiseSource(
    ctx: AudioContext,
    buffer: AudioBuffer | null,
    v: VoiceContext,
    stopTime: number
  ): AudioBufferSourceNode | null {
    if (!buffer) return null;
    const src = v.trackSource(ctx.createBufferSource(), stopTime);
    src.buffer = buffer;
    src.loop = true;
    return src;
  }

  private addNoiseBurst(
    v: VoiceContext,
    start: number,
    duration: number,
    filterType: BiquadFilterType,
    frequency: number,
    q: number,
    peak: number
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.whiteNoiseBuffer) return;

    const src = this.createNoiseSource(ctx, this.whiteNoiseBuffer, v, start + duration + 0.015);
    if (!src) return;

    const filter = v.trackNode(ctx.createBiquadFilter());
    filter.type = filterType;
    filter.frequency.setValueAtTime(this.clampFreq(frequency), start);
    filter.Q.setValueAtTime(q, start);

    const gain = v.trackNode(ctx.createGain());
    this.envDecay(gain.gain, start, 0.001, duration, peak);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(v.output);

    const maxOffset = Math.max(0, this.whiteNoiseBuffer.duration - duration - 0.05);
    src.start(start, Math.random() * maxOffset);
    src.stop(start + duration + 0.015);
  }

  private addSynthTone(
    v: VoiceContext,
    start: number,
    duration: number,
    freq: number,
    type: OscillatorType,
    peak: number,
    cutoff: number,
    delaySendLevel: number
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;

    const osc = v.trackSource(ctx.createOscillator(), start + duration + 0.025);
    const filter = v.trackNode(ctx.createBiquadFilter());
    const gain = v.trackNode(ctx.createGain());

    osc.type = type;
    osc.frequency.setValueAtTime(this.clampFreq(freq), start);

    filter.type = 'lowpass';
    filter.Q.setValueAtTime(1.8, start);
    filter.frequency.setValueAtTime(this.clampFreq(cutoff), start);
    filter.frequency.exponentialRampToValueAtTime(
      this.clampFreq(Math.max(260, cutoff * 0.32)),
      start + duration
    );

    this.envDecay(gain.gain, start, 0.005, duration, peak);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(v.output);

    if (delaySendLevel > 0) {
      this.sendToSfxDelay(gain, delaySendLevel, v);
    }

    osc.start(start);
    osc.stop(start + duration + 0.025);
  }

  private addBellPing(
    v: VoiceContext,
    start: number,
    duration: number,
    freq: number,
    peak: number,
    delaySendLevel: number
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;

    const clamped = this.clampFreq(freq);
    const carrier = v.trackSource(ctx.createOscillator(), start + duration + 0.02);
    const mod = v.trackSource(ctx.createOscillator(), start + duration + 0.02);
    const modGain = v.trackNode(ctx.createGain());
    const gain = v.trackNode(ctx.createGain());

    carrier.type = 'sine';
    carrier.frequency.setValueAtTime(clamped, start);

    // Classic 90s digital FM chime ratio (2.756 produces bright glassy arcade sparkle)
    mod.type = 'sine';
    mod.frequency.setValueAtTime(this.clampFreq(clamped * 2.756), start);
    modGain.gain.setValueAtTime(clamped * 1.4, start);
    modGain.gain.exponentialRampToValueAtTime(1, start + Math.min(duration * 0.55, 0.14));

    this.envDecay(gain.gain, start, 0.002, duration, peak);

    mod.connect(modGain);
    modGain.connect(carrier.frequency);
    carrier.connect(gain);
    gain.connect(v.output);

    if (delaySendLevel > 0) {
      this.sendToSfxDelay(gain, delaySendLevel, v);
    }

    mod.start(start);
    carrier.start(start);
    mod.stop(start + duration + 0.02);
    carrier.stop(start + duration + 0.02);
  }

  private sendToCabinet(source: AudioNode, amount: number, v: VoiceContext): void {
    if (!this.ctx || !this.cabinetSend || amount <= 0) return;
    const send = v.trackNode(this.ctx.createGain());
    send.gain.setValueAtTime(clamp(amount, 0, 1.2), this.ctx.currentTime);
    source.connect(send);
    send.connect(this.cabinetSend);
  }

  private sendToSfxDelay(source: AudioNode, amount: number, v: VoiceContext): void {
    if (!this.ctx || !this.sfxDelaySend || amount <= 0) return;
    const send = v.trackNode(this.ctx.createGain());
    send.gain.setValueAtTime(clamp(amount, 0, 1), this.ctx.currentTime);
    source.connect(send);
    send.connect(this.sfxDelaySend);
  }
}
