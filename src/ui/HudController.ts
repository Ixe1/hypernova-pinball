/**
 * HYPERNOVA — Arcade HUD & Overlay Controller
 *
 * Renders the translucent 1990s sci-fi arcade HUD inside `#hud-root` without
 * obstructing the 3D pinball playfield. Completely decoupled from physics,
 * audio, and rendering via typed `HudCallbacks`.
 */

import type {
  CameraMode,
  GamePhase,
  GameSnapshot,
  GlassMode,
  HighScoreEntry,
  QualityLevel,
  SettingsState,
} from '../config/types';

export interface HudCallbacks {
  onStartGame(): void;
  onCycleCamera(): void;
  onToggleMute(): void;
  onTogglePause(): void;
  onSettingsChange(patch: Partial<SettingsState>): void;
  onFlipperInput(side: 'left' | 'right', pressed: boolean): void;
  onPlungerChange(pressed: boolean, manualTension?: number): void;
  onNudge(dir: 'left' | 'right' | 'up'): void;
  onSubmitHighScore(initials: string): void;
  onResetHighScores?(): void;
}

const INITIAL_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const INITIAL_CHAR_COUNT = INITIAL_CHARSET.length;
const SVG_NS = 'http://www.w3.org/2000/svg';

const CAMERA_LABELS: Record<CameraMode, string> = {
  classic: 'Classic',
  dynamic: 'Dynamic',
  lowAction: 'Low Action',
  overhead: 'Overhead',
};

const CAMERA_MODES: readonly { value: CameraMode; label: string }[] = [
  { value: 'classic', label: 'Classic' },
  { value: 'dynamic', label: 'Dynamic' },
  { value: 'lowAction', label: 'Low Action' },
  { value: 'overhead', label: 'Overhead' },
];

const GLASS_MODES: readonly { value: GlassMode; label: string }[] = [
  { value: 'subtle', label: 'Subtle' },
  { value: 'realistic', label: 'Realistic' },
  { value: 'off', label: 'Off' },
];

const QUALITY_LEVELS: readonly { value: QualityLevel; label: string }[] = [
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
];

/** Empirically verified Skill Shot plunger sweet-spot tensions per I-O-N rollover lane (0=I, 1=O, 2=N). */
const SKILL_SHOT_TARGETS: readonly { readonly lane: string; readonly pct: number }[] = [
  { lane: 'I', pct: 62 },
  { lane: 'O', pct: 58 },
  { lane: 'N', pct: 53 },
];

const CONTROLS_LEGEND: readonly { label: string; keys: readonly string[] }[] = [
  { label: 'Left Flipper / Lane', keys: ['L-Shift', 'Z', 'A', '←'] },
  { label: 'Right + Mini Flipper', keys: ['R-Shift', '/', 'D', '→'] },
  { label: 'Plunger Launch', keys: ['Space', 'Enter', '↓'] },
  { label: 'Nudge Left / Right', keys: ['Q / X', 'E / .'] },
  { label: 'Nudge Forward', keys: ['W', '↑'] },
  { label: 'Cycle Camera', keys: ['C'] },
  { label: 'Audio Mute', keys: ['M'] },
  { label: 'Pause / Settings', keys: ['Esc', 'P'] },
];

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function formatScore(score: number): string {
  return Math.max(0, Math.floor(score)).toLocaleString('en-US');
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function kbd(label: string): HTMLElement {
  return el('kbd', 'hud-kbd', label);
}

function createSvgIcon(paths: readonly string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

function blurOnPointerClick(event: MouseEvent): void {
  if (event.detail > 0 && event.currentTarget instanceof HTMLElement) {
    event.currentTarget.blur();
  }
}

interface InitialSlotRefs {
  container: HTMLDivElement;
  charBtn: HTMLButtonElement;
  upBtn: HTMLButtonElement;
  downBtn: HTMLButtonElement;
}

interface SliderRefs {
  input: HTMLInputElement;
  valueLabel: HTMLSpanElement;
}

export class HudController {
  private readonly root: HTMLElement;
  private readonly callbacks: HudCallbacks;
  private readonly shell: HTMLDivElement;

  // Top-left DMD mirror & status pills
  private readonly dmdBezel: HTMLDivElement;
  private readonly dmdCanvas: HTMLCanvasElement;
  private readonly dmdCtx: CanvasRenderingContext2D | null;
  private readonly scoreFallbackPill: HTMLSpanElement;
  private readonly ballPill: HTMLSpanElement;
  private readonly multPill: HTMLSpanElement;
  private readonly locksPill: HTMLSpanElement;
  private readonly locksLabel: HTMLSpanElement;
  private readonly lockDotEls: HTMLSpanElement[] = [];
  private readonly ballSavePill: HTMLSpanElement;
  private readonly kickbackPill: HTMLSpanElement;
  private readonly comboPill: HTMLSpanElement;
  private readonly dangerPill: HTMLSpanElement;

  // Top-right minimal control bar
  private readonly topRightBar: HTMLDivElement;
  private readonly cameraBtn: HTMLButtonElement;
  private readonly cameraValueSpan: HTMLSpanElement;
  private readonly muteBtn: HTMLButtonElement;
  private readonly muteIconOn: SVGSVGElement;
  private readonly muteIconOff: SVGSVGElement;
  private readonly muteLabelSpan: HTMLSpanElement;
  private readonly pauseBtn: HTMLButtonElement;

  // Bottom-right vertical plunger gauge
  private readonly plungerWidget: HTMLDivElement;
  private readonly plungerSkillLabel: HTMLSpanElement;
  private readonly plungerPctEl: HTMLSpanElement;
  private readonly plungerTrack: HTMLDivElement;
  private readonly plungerFill: HTMLDivElement;
  private readonly plungerSkillMark: HTMLDivElement;
  private readonly plungerKnob: HTMLDivElement;

  // Bottom-center attract / game over overlay
  private readonly attractOverlay: HTMLDivElement;
  private readonly brandSubEl: HTMLSpanElement;
  private readonly gameOverScoreEl: HTMLDivElement;
  private readonly gameOverScoreValEl: HTMLSpanElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly playBtnLabel: HTMLSpanElement;
  private readonly scoresListEl: HTMLOListElement;

  // Pause & settings drawer
  private readonly drawerBackdrop: HTMLDivElement;
  private readonly drawer: HTMLElement;
  private readonly drawerTitleEl: HTMLHeadingElement;
  private readonly resumeBtn: HTMLButtonElement;
  private readonly restartBtn: HTMLButtonElement;
  private readonly cameraButtons = new Map<CameraMode, HTMLButtonElement>();
  private readonly glassButtons = new Map<GlassMode, HTMLButtonElement>();
  private readonly qualityButtons = new Map<QualityLevel, HTMLButtonElement>();
  private readonly dmdOnBtn: HTMLButtonElement;
  private readonly dmdOffBtn: HTMLButtonElement;
  private readonly musicOnBtn: HTMLButtonElement;
  private readonly musicOffBtn: HTMLButtonElement;
  private readonly mutedBanner: HTMLDivElement;
  private readonly masterSlider: SliderRefs;
  private readonly sfxSlider: SliderRefs;
  private readonly musicSlider: SliderRefs;
  private readonly resetScoresBtn: HTMLButtonElement | null = null;

  // High score initials modal
  private readonly modalBackdrop: HTMLDivElement;
  private readonly modalDialog: HTMLDivElement;
  private readonly modalRankEl: HTMLSpanElement;
  private readonly modalScoreEl: HTMLDivElement;
  private readonly initialSlots: InitialSlotRefs[] = [];
  private readonly modalConfirmBtn: HTMLButtonElement;

  // Touch / coarse-pointer controls
  private readonly touchLayer: HTMLDivElement;
  private readonly touchLeftFlipper: HTMLButtonElement;
  private readonly touchRightFlipper: HTMLButtonElement;
  private readonly touchNudgeGroup: HTMLDivElement;

  // Interactive runtime state
  private disposed = false;
  private hasTouchInput = false;
  private contextLostBlocked = false;
  private dmdMirrorVisible = true;
  private currentPhase: GamePhase = 'ATTRACT';
  private currentPaused = false;
  private drawerOpenerEl: HTMLElement | null = null;
  private modalOpenerEl: HTMLElement | null = null;
  private initialsIndices: [number, number, number] = [0, 0, 0];
  private selectedInitialSlot = 0;
  private highScoreSubmitted = false;
  private confirmResetScores = false;
  private resetConfirmTimer: number | null = null;

  // Pointer tracking for plunger & multi-touch flippers
  private plungerPointerId: number | null = null;
  private plungerStartY = 0;
  private plungerDragMode: 'none' | 'track' | 'relative' = 'none';
  private plungerDragActive = false;
  private plungerDragBaseTension = 0;
  private plungerDragAnchorY = 0;
  private currentPlungerTension = 0;
  private readonly activeLeftPointers = new Set<number>();
  private readonly activeRightPointers = new Set<number>();

  // Diff cache to keep 60fps update() completely allocation/DOM-churn free
  private lastPhase: GamePhase | null = null;
  private lastPaused: boolean | null = null;
  private lastScore = -1;
  private lastBallSig = '';
  private lastMultSig = '';
  private lastLocksSig = '';
  private lastBallSaveSig = '';
  private lastKickback: boolean | null = null;
  private lastComboCount = -1;
  private lastDangerSig = '';
  private lastCameraMode: CameraMode | null = null;
  private lastGlassMode: GlassMode | null = null;
  private lastQuality: QualityLevel | null = null;
  private lastMuted: boolean | null = null;
  private lastShowDmd: boolean | null = null;
  private lastMusicEnabled: boolean | null = null;
  private lastMasterPct = -1;
  private lastSfxPct = -1;
  private lastMusicPct = -1;
  private lastPlungerVisible: boolean | null = null;
  private lastPlungerDisplayTension = -1;
  private lastSkillLaneIndex = -1;
  private lastSkillShotVisible: boolean | null = null;
  private lastHighScoresRef: readonly HighScoreEntry[] | null = null;
  private lastHighScoresSig = '';
  private lastModalScore = -1;

  constructor(root: HTMLElement, callbacks: HudCallbacks) {
    this.root = root;
    this.callbacks = callbacks;

    this.shell = el('div', 'hud-shell');
    this.shell.setAttribute('data-hud', 'hypernova');

    // 1. Top-Left: DMD Mirror & Status Pills
    const topLeft = el('div', 'hud-top-left');

    this.dmdBezel = el('div', 'hud-dmd-bezel');
    const dmdScreen = el('div', 'hud-dmd-screen');
    this.dmdCanvas = el('canvas', 'hud-dmd-canvas');
    this.dmdCanvas.width = 256;
    this.dmdCanvas.height = 64;
    this.dmdCanvas.setAttribute('aria-label', 'Dot Matrix Display');
    this.dmdCtx = this.dmdCanvas.getContext('2d');
    if (this.dmdCtx) {
      this.dmdCtx.imageSmoothingEnabled = false;
    }
    dmdScreen.appendChild(this.dmdCanvas);
    this.dmdBezel.appendChild(dmdScreen);

    const statusStrip = el('div', 'hud-status-strip');

    this.scoreFallbackPill = el('span', 'hud-pill hud-pill--score is-hidden', '0');
    this.ballPill = el('span', 'hud-pill hud-pill--ball', 'FREE PLAY');
    this.multPill = el('span', 'hud-pill hud-pill--mult is-hidden', 'PLAYFIELD 2X');

    this.locksPill = el('span', 'hud-pill hud-pill--locks is-hidden');
    this.locksLabel = el('span', undefined, 'LOCKS');
    const lockDotsWrap = el('span', 'hud-lock-dots');
    lockDotsWrap.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 3; i++) {
      const dot = el('span', 'hud-lock-dot');
      this.lockDotEls.push(dot);
      lockDotsWrap.appendChild(dot);
    }
    this.locksPill.append(this.locksLabel, lockDotsWrap);

    this.ballSavePill = el('span', 'hud-pill hud-pill--ball-save is-hidden', 'BALL SAVE');
    this.kickbackPill = el('span', 'hud-pill hud-pill--kickback is-hidden', 'SHIELD');
    this.comboPill = el('span', 'hud-pill hud-pill--combo is-hidden', 'COMBO ×2');
    this.dangerPill = el('span', 'hud-pill hud-pill--danger is-hidden', 'DANGER');

    statusStrip.append(
      this.scoreFallbackPill,
      this.ballPill,
      this.multPill,
      this.locksPill,
      this.ballSavePill,
      this.kickbackPill,
      this.comboPill,
      this.dangerPill,
    );
    topLeft.append(this.dmdBezel, statusStrip);

    // 2. Top-Right: Minimal Control Bar
    const topRight = el('div', 'hud-top-right');
    this.topRightBar = topRight;

    this.cameraBtn = el('button', 'hud-ctrl-btn');
    this.cameraBtn.type = 'button';
    this.cameraBtn.title = 'Cycle Camera Angle (C)';
    this.cameraBtn.setAttribute('aria-label', 'Cycle Camera Angle');
    const camIcon = createSvgIcon([
      'M3 7h3l2-2h8l2 2h3v12H3z',
      'M12 10a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7z',
    ]);
    const camPrefix = el('span', 'hud-ctrl-label-full', 'CAM:');
    this.cameraValueSpan = el('span', 'hud-cam-value', 'CLASSIC');
    this.cameraBtn.append(camIcon, camPrefix, this.cameraValueSpan, kbd('C'));
    this.cameraBtn.addEventListener('click', (e) => {
      blurOnPointerClick(e);
      this.callbacks.onCycleCamera();
    });

    this.muteBtn = el('button', 'hud-ctrl-btn');
    this.muteBtn.type = 'button';
    this.muteBtn.title = 'Toggle Audio Mute (M)';
    this.muteBtn.setAttribute('aria-label', 'Toggle Audio Mute');
    this.muteBtn.setAttribute('aria-pressed', 'false');
    this.muteIconOn = createSvgIcon([
      'M11 5L6 9H3v6h3l5 4V5z',
      'M15.5 8.5a5 5 0 0 1 0 7',
      'M18.5 5.5a9 9 0 0 1 0 13',
    ]);
    this.muteIconOff = createSvgIcon([
      'M11 5L6 9H3v6h3l5 4V5z',
      'M16 9l5 6',
      'M21 9l-5 6',
    ]);
    this.muteIconOff.style.display = 'none';
    this.muteLabelSpan = el('span', 'hud-ctrl-label-full', 'AUDIO');
    this.muteBtn.append(this.muteIconOn, this.muteIconOff, this.muteLabelSpan, kbd('M'));
    this.muteBtn.addEventListener('click', (e) => {
      blurOnPointerClick(e);
      this.callbacks.onToggleMute();
    });

    this.pauseBtn = el('button', 'hud-ctrl-btn');
    this.pauseBtn.type = 'button';
    this.pauseBtn.title = 'Pause & Settings (Esc)';
    this.pauseBtn.setAttribute('aria-label', 'Pause and Settings');
    this.pauseBtn.setAttribute('aria-expanded', 'false');
    const settingsIcon = createSvgIcon([
      'M4 7h16',
      'M4 12h16',
      'M4 17h16',
      'M8 5v4',
      'M15 10v4',
      'M10 15v4',
    ]);
    const pauseLabel = el('span', 'hud-ctrl-label-full', 'MENU');
    this.pauseBtn.append(settingsIcon, pauseLabel, kbd('ESC'));
    this.pauseBtn.addEventListener('click', (e) => {
      blurOnPointerClick(e);
      this.callbacks.onTogglePause();
    });

    topRight.append(this.cameraBtn, this.muteBtn, this.pauseBtn);

    // 3. Bottom-Right: Interactive Vertical Plunger Tension Gauge
    this.plungerWidget = el('div', 'hud-plunger-widget');
    this.plungerWidget.setAttribute('role', 'slider');
    this.plungerWidget.setAttribute('aria-label', 'Plunger Tension');
    this.plungerWidget.setAttribute('aria-valuemin', '0');
    this.plungerWidget.setAttribute('aria-valuemax', '100');
    this.plungerWidget.setAttribute('aria-valuenow', '0');
    this.plungerWidget.title = 'Hold or drag down to pull plunger, release to launch';

    const plungerTitle = el('span', 'hud-plunger-title', 'LAUNCH');
    this.plungerSkillLabel = el('span', 'hud-plunger-skill-label', 'I · 62%');
    this.plungerPctEl = el('span', 'hud-plunger-pct', '0%');
    this.plungerTrack = el('div', 'hud-plunger-track');
    this.plungerFill = el('div', 'hud-plunger-fill');
    const plungerTicks = el('div', 'hud-plunger-ticks');
    this.plungerSkillMark = el('div', 'hud-plunger-skill-mark');
    this.plungerTrack.append(this.plungerFill, plungerTicks, this.plungerSkillMark);

    this.plungerKnob = el('div', 'hud-plunger-knob');
    const plungerHint = el('span', 'hud-plunger-hint', 'PULL\nSPACE');

    this.plungerWidget.append(
      plungerTitle,
      this.plungerSkillLabel,
      this.plungerPctEl,
      this.plungerTrack,
      this.plungerKnob,
      plungerHint,
    );
    this.updateSkillShotMarker(0, true);
    this.bindPlungerEvents();

    // 4. Bottom-Center: Attract Mode / Game Over Floating Overlay
    this.attractOverlay = el('div', 'hud-attract is-visible');
    const attractRow = el('div', 'hud-attract-row');

    const attractHero = el('div', 'hud-attract-hero');
    const brandBadge = el('div', 'hud-brand-badge');
    const brandTitle = el('h1', 'hud-brand-title', 'HYPERNOVA');
    this.brandSubEl = el('span', 'hud-brand-sub', 'COSMIC PINBALL // 1994');
    brandBadge.append(brandTitle, this.brandSubEl);

    this.gameOverScoreEl = el('div', 'hud-gameover-score');
    const goLabel = el('span', undefined, 'FINAL SCORE');
    this.gameOverScoreValEl = el('span', undefined, '0');
    this.gameOverScoreEl.append(goLabel, this.gameOverScoreValEl);

    this.playBtn = el('button', 'hud-play-btn');
    this.playBtn.type = 'button';
    this.playBtnLabel = el('span', undefined, 'PLAY / INSERT COIN');
    this.playBtn.appendChild(this.playBtnLabel);
    this.playBtn.addEventListener('click', (e) => {
      blurOnPointerClick(e);
      this.callbacks.onStartGame();
    });

    const playHint = el('div', 'hud-play-hint');
    playHint.append(el('span', undefined, 'PRESS'), kbd('SPACE'), el('span', undefined, 'OR'), kbd('ENTER'));

    attractHero.append(brandBadge, this.gameOverScoreEl, this.playBtn, playHint);

    const scoresCard = el('div', 'hud-scores-card');
    const scoresHeader = el('div', 'hud-scores-title');
    scoresHeader.append(el('span', undefined, 'HIGH SCORES'), el('span', undefined, 'TOP 5'));
    this.scoresListEl = el('ol', 'hud-scores-list');
    scoresCard.append(scoresHeader, this.scoresListEl);

    attractRow.append(attractHero, scoresCard);

    const attractControls = el('div', 'hud-attract-controls');
    const flipHint = el('span');
    flipHint.append(el('span', undefined, 'FLIPPERS'), kbd('SHIFT'), kbd('Z'), kbd('/'));
    const launchHint = el('span');
    launchHint.append(el('span', undefined, 'PLUNGE'), kbd('SPACE'));
    const nudgeHint = el('span');
    nudgeHint.append(el('span', undefined, 'NUDGE'), kbd('Q'), kbd('E'), kbd('W'));
    const camHint = el('span');
    camHint.append(el('span', undefined, 'CAM'), kbd('C'));
    attractControls.append(flipHint, launchHint, nudgeHint, camHint);

    this.attractOverlay.append(attractRow, attractControls);

    // 5. Pause & Settings Drawer
    this.drawerBackdrop = el('div', 'hud-drawer-backdrop');
    this.drawerBackdrop.addEventListener('click', () => {
      this.callbacks.onTogglePause();
    });

    this.drawer = el('aside', 'hud-drawer');
    this.drawer.setAttribute('role', 'dialog');
    this.drawer.setAttribute('aria-modal', 'true');
    this.drawer.setAttribute('aria-label', 'Pause and Settings');

    const drawerHeader = el('div', 'hud-drawer-header');
    this.drawerTitleEl = el('h2', 'hud-drawer-title', 'SYSTEM PAUSED');
    const closeDrawerBtn = el('button', 'hud-drawer-close', '×');
    closeDrawerBtn.type = 'button';
    closeDrawerBtn.setAttribute('aria-label', 'Close Pause and Settings');
    closeDrawerBtn.addEventListener('click', () => {
      this.callbacks.onTogglePause();
    });
    drawerHeader.append(this.drawerTitleEl, closeDrawerBtn);

    const drawerBody = el('div', 'hud-drawer-body');

    const actionsRow = el('div', 'hud-drawer-actions');
    this.resumeBtn = el('button', 'hud-action-btn hud-action-btn--primary', 'RESUME');
    this.resumeBtn.type = 'button';
    this.resumeBtn.addEventListener('click', (e) => {
      blurOnPointerClick(e);
      this.callbacks.onTogglePause();
    });
    this.restartBtn = el('button', 'hud-action-btn hud-action-btn--secondary', 'RESTART GAME');
    this.restartBtn.type = 'button';
    this.restartBtn.addEventListener('click', (e) => {
      blurOnPointerClick(e);
      this.callbacks.onStartGame();
    });
    actionsRow.append(this.resumeBtn, this.restartBtn);
    drawerBody.appendChild(actionsRow);

    // Camera mode selector
    const camSection = this.createSection('Camera Angle', 'C');
    const camGroup = el('div', 'hud-seg-group hud-seg-group--4');
    for (const option of CAMERA_MODES) {
      const btn = el('button', 'hud-seg-btn', option.label);
      btn.type = 'button';
      btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', () => {
        this.callbacks.onSettingsChange({ cameraMode: option.value });
      });
      this.cameraButtons.set(option.value, btn);
      camGroup.appendChild(btn);
    }
    camSection.appendChild(camGroup);
    drawerBody.appendChild(camSection);

    // Glass reflection selector
    const glassSection = this.createSection('Cabinet Glass Reflection');
    const glassGroup = el('div', 'hud-seg-group hud-seg-group--3');
    for (const option of GLASS_MODES) {
      const btn = el('button', 'hud-seg-btn', option.label);
      btn.type = 'button';
      btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', () => {
        this.callbacks.onSettingsChange({ glassMode: option.value });
      });
      this.glassButtons.set(option.value, btn);
      glassGroup.appendChild(btn);
    }
    glassSection.appendChild(glassGroup);
    drawerBody.appendChild(glassSection);

    // Graphics quality selector
    const qualitySection = this.createSection('Graphics Quality');
    const qualityGroup = el('div', 'hud-seg-group hud-seg-group--2');
    for (const option of QUALITY_LEVELS) {
      const btn = el('button', 'hud-seg-btn', option.label);
      btn.type = 'button';
      btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', () => {
        this.callbacks.onSettingsChange({ quality: option.value });
      });
      this.qualityButtons.set(option.value, btn);
      qualityGroup.appendChild(btn);
    }
    qualitySection.appendChild(qualityGroup);
    drawerBody.appendChild(qualitySection);

    // DMD HUD Mirror toggle
    const dmdSection = this.createSection('DMD HUD Mirror');
    const dmdGroup = el('div', 'hud-seg-group hud-seg-group--2');
    this.dmdOnBtn = el('button', 'hud-seg-btn', 'On');
    this.dmdOnBtn.type = 'button';
    this.dmdOnBtn.addEventListener('click', () => {
      this.callbacks.onSettingsChange({ showDmdMirror: true });
    });
    this.dmdOffBtn = el('button', 'hud-seg-btn', 'Off');
    this.dmdOffBtn.type = 'button';
    this.dmdOffBtn.addEventListener('click', () => {
      this.callbacks.onSettingsChange({ showDmdMirror: false });
    });
    dmdGroup.append(this.dmdOnBtn, this.dmdOffBtn);
    dmdSection.appendChild(dmdGroup);
    drawerBody.appendChild(dmdSection);

    // Audio volumes + music toggle
    const audioSection = this.createSection('Audio Mix', 'M');

    this.mutedBanner = el('div', 'hud-muted-banner');
    const mutedText = el('span', undefined, 'Master audio is muted');
    const unmuteBtn = el('button', 'hud-muted-unmute', 'Unmute');
    unmuteBtn.type = 'button';
    unmuteBtn.addEventListener('click', () => {
      this.callbacks.onToggleMute();
    });
    this.mutedBanner.append(mutedText, unmuteBtn);
    audioSection.appendChild(this.mutedBanner);

    const musicToggleRow = el('div', 'hud-seg-group hud-seg-group--2');
    this.musicOnBtn = el('button', 'hud-seg-btn', 'Music On');
    this.musicOnBtn.type = 'button';
    this.musicOnBtn.addEventListener('click', () => {
      this.callbacks.onSettingsChange({ musicEnabled: true });
    });
    this.musicOffBtn = el('button', 'hud-seg-btn', 'Music Off');
    this.musicOffBtn.type = 'button';
    this.musicOffBtn.addEventListener('click', () => {
      this.callbacks.onSettingsChange({ musicEnabled: false });
    });
    musicToggleRow.append(this.musicOnBtn, this.musicOffBtn);
    audioSection.appendChild(musicToggleRow);

    this.masterSlider = this.createVolumeSlider('Master Volume', (v) => {
      this.callbacks.onSettingsChange({ masterVolume: v });
    });
    this.sfxSlider = this.createVolumeSlider('SFX Volume', (v) => {
      this.callbacks.onSettingsChange({ sfxVolume: v });
    });
    this.musicSlider = this.createVolumeSlider('Music Volume', (v) => {
      this.callbacks.onSettingsChange({ musicVolume: v });
    });
    audioSection.append(
      this.masterSlider.input.parentElement!,
      this.sfxSlider.input.parentElement!,
      this.musicSlider.input.parentElement!,
    );
    drawerBody.appendChild(audioSection);

    // Controls legend
    const legendSection = this.createSection('Controls');
    const legendBox = el('div', 'hud-legend');
    for (const item of CONTROLS_LEGEND) {
      const row = el('div', 'hud-legend-row');
      const label = el('span', undefined, item.label);
      const keysWrap = el('span', 'hud-legend-keys');
      for (const k of item.keys) {
        keysWrap.appendChild(kbd(k));
      }
      row.append(label, keysWrap);
      legendBox.appendChild(row);
    }
    const mouseRow = el('div', 'hud-legend-row');
    mouseRow.append(
      el('span', undefined, 'Mouse'),
      el('span', 'hud-legend-keys', 'Drag Plunger'),
    );
    const touchRow = el('div', 'hud-legend-row');
    touchRow.append(
      el('span', undefined, 'Touch'),
      el('span', 'hud-legend-keys', 'Drag Plunger · Corner Flippers'),
    );
    legendBox.append(mouseRow, touchRow);
    legendSection.appendChild(legendBox);
    drawerBody.appendChild(legendSection);

    // Optional reset high scores button
    if (this.callbacks.onResetHighScores) {
      const dataSection = this.createSection('Leaderboard');
      const resetBtn = el('button', 'hud-reset-btn', 'Reset High Scores');
      resetBtn.type = 'button';
      resetBtn.addEventListener('click', () => {
        if (!this.confirmResetScores) {
          this.confirmResetScores = true;
          resetBtn.textContent = 'Confirm Reset High Scores?';
          resetBtn.classList.add('is-confirming');
          this.clearResetConfirmTimer();
          this.resetConfirmTimer = window.setTimeout(() => {
            this.resetHighScoreConfirmation();
          }, 4000);
        } else {
          this.resetHighScoreConfirmation();
          this.callbacks.onResetHighScores?.();
        }
      });
      this.resetScoresBtn = resetBtn;
      dataSection.appendChild(resetBtn);
      drawerBody.appendChild(dataSection);
    }

    this.drawer.append(drawerHeader, drawerBody);

    // 6. 3-Letter High Score Initials Modal
    this.modalBackdrop = el('div', 'hud-modal-backdrop');
    const modal = el('div', 'hud-modal');
    this.modalDialog = modal;
    modal.tabIndex = -1;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Enter High Score Initials');

    this.modalRankEl = el('span', 'hud-modal-eyebrow', 'HALL OF FAME QUALIFIER');
    const modalTitle = el('h2', 'hud-modal-title', 'NEW HIGH SCORE!');
    this.modalScoreEl = el('div', 'hud-modal-score', '0');

    const initialsRow = el('div', 'hud-initials-row');
    for (let slotIndex = 0; slotIndex < 3; slotIndex++) {
      const slot = this.createInitialSlot(slotIndex);
      this.initialSlots.push(slot);
      initialsRow.appendChild(slot.container);
    }

    const modalHint = el(
      'div',
      'hud-modal-hint',
      'Type A–Z / 0–9 or use arrows & buttons · Enter to confirm',
    );

    this.modalConfirmBtn = el('button', 'hud-modal-confirm', 'SAVE INITIALS');
    this.modalConfirmBtn.type = 'button';
    this.modalConfirmBtn.addEventListener('click', () => {
      this.submitHighScore();
    });

    modal.append(
      this.modalRankEl,
      modalTitle,
      this.modalScoreEl,
      initialsRow,
      modalHint,
      this.modalConfirmBtn,
    );
    this.modalBackdrop.appendChild(modal);

    // 7. Touch Flipper Pads & Micro Nudge Buttons
    this.touchLayer = el('div', 'hud-touch-layer');

    this.touchLeftFlipper = el('button', 'hud-touch-flipper hud-touch-flipper--left', 'L FLIPPER');
    this.touchLeftFlipper.type = 'button';
    this.touchLeftFlipper.setAttribute('aria-label', 'Left Flipper');

    this.touchRightFlipper = el('button', 'hud-touch-flipper hud-touch-flipper--right', 'R FLIPPER');
    this.touchRightFlipper.type = 'button';
    this.touchRightFlipper.setAttribute('aria-label', 'Right Flipper');

    this.bindTouchFlipper(this.touchLeftFlipper, 'left', this.activeLeftPointers);
    this.bindTouchFlipper(this.touchRightFlipper, 'right', this.activeRightPointers);

    this.touchNudgeGroup = el('div', 'hud-touch-nudge-group is-hidden');
    const nudgeLeftBtn = el('button', 'hud-touch-nudge', '◄ NUDGE');
    nudgeLeftBtn.type = 'button';
    nudgeLeftBtn.setAttribute('aria-label', 'Nudge Left');
    nudgeLeftBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.callbacks.onNudge('left');
    });

    const nudgeUpBtn = el('button', 'hud-touch-nudge', '▲');
    nudgeUpBtn.type = 'button';
    nudgeUpBtn.setAttribute('aria-label', 'Nudge Forward');
    nudgeUpBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.callbacks.onNudge('up');
    });

    const nudgeRightBtn = el('button', 'hud-touch-nudge', 'NUDGE ►');
    nudgeRightBtn.type = 'button';
    nudgeRightBtn.setAttribute('aria-label', 'Nudge Right');
    nudgeRightBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.callbacks.onNudge('right');
    });

    this.touchNudgeGroup.append(nudgeLeftBtn, nudgeUpBtn, nudgeRightBtn);
    this.touchLayer.append(this.touchNudgeGroup, this.touchLeftFlipper, this.touchRightFlipper);

    // Assemble shell
    this.shell.append(
      topLeft,
      topRight,
      this.plungerWidget,
      this.attractOverlay,
      this.touchLayer,
      this.modalBackdrop,
      this.drawerBackdrop,
      this.drawer,
    );
    this.root.appendChild(this.shell);

    this.setSubtreeHidden(this.plungerWidget, true);
    this.setSubtreeHidden(this.drawer, true);
    this.setSubtreeHidden(this.modalBackdrop, true);
    this.setSubtreeHidden(this.touchLayer, true);

    this.renderInitialsSlots();

    // Global capture-phase listener for High Score modal entry + hybrid touch detection + blur cleanup
    window.addEventListener('keydown', this.handleWindowKeyDown, { capture: true });
    window.addEventListener('pointerdown', this.handleWindowPointerDown, { passive: true });
    window.addEventListener('blur', this.handleWindowBlur);
  }

  /**
   * Returns true while the 3-letter High Score Initials Modal is actively capturing input.
   */
  public isHighScoreModalOpen(): boolean {
    return !this.contextLostBlocked && this.currentPhase === 'HIGH_SCORE_ENTRY' && !this.currentPaused;
  }

  /**
   * Makes the entire HUD subtree inert and blurs any active descendant while an
   * external overlay (such as the WebGL context-lost banner) blocks interaction.
   */
  public setContextLostBlocked(blocked: boolean): void {
    if (this.disposed) return;
    this.contextLostBlocked = blocked;
    this.setSubtreeHidden(this.shell, blocked);
    if (blocked) {
      this.releaseAllPointerInputs();
    }
  }

  /**
   * Returns the live 3-character initials buffer and active cursor slot (0..2)
   * so the 3D backbox DMD can mirror initials entry in real time.
   */
  public getHighScoreInitialsState(): { chars: string[]; cursor: number } {
    return {
      chars: [
        INITIAL_CHARSET[this.initialsIndices[0]],
        INITIAL_CHARSET[this.initialsIndices[1]],
        INITIAL_CHARSET[this.initialsIndices[2]],
      ],
      cursor: this.selectedInitialSlot,
    };
  }

  /**
   * Synchronizes the full HUD state with the current frame snapshot, settings,
   * plunger tension, high score leaderboard, and pause flag.
   * Diffed internally to avoid DOM churn at 60 FPS.
   */
  public update(
    snapshot: GameSnapshot,
    settings: SettingsState,
    plungerTension: number,
    highScores: readonly HighScoreEntry[],
    isPaused: boolean,
    ballInShooter = false,
  ): void {
    if (this.disposed) return;

    const phase = snapshot.phase;
    const enteringHighScore = phase === 'HIGH_SCORE_ENTRY' && this.lastPhase !== 'HIGH_SCORE_ENTRY';
    if (enteringHighScore) {
      this.initialsIndices = [0, 0, 0];
      this.selectedInitialSlot = 0;
      this.highScoreSubmitted = false;
      this.renderInitialsSlots();
    } else if (phase !== 'HIGH_SCORE_ENTRY' && this.lastPhase === 'HIGH_SCORE_ENTRY') {
      this.highScoreSubmitted = false;
    }

    if (isPaused && !this.lastPaused) {
      this.releaseAllPointerInputs();
      this.resetHighScoreConfirmation();
    }

    this.currentPhase = phase;
    this.currentPaused = isPaused;
    this.dmdMirrorVisible = settings.showDmdMirror;

    // 1. DMD mirror & score fallback pill
    const isActivePlayPhase =
      phase === 'LAUNCH_READY' || phase === 'PLAYING' || phase === 'BALL_BONUS';

    if (this.lastShowDmd !== settings.showDmdMirror || this.lastPhase !== phase) {
      this.dmdBezel.classList.toggle('is-hidden', !settings.showDmdMirror);
      this.dmdOnBtn.classList.toggle('is-selected', settings.showDmdMirror);
      this.dmdOffBtn.classList.toggle('is-selected', !settings.showDmdMirror);
      this.dmdOnBtn.setAttribute('aria-pressed', String(settings.showDmdMirror));
      this.dmdOffBtn.setAttribute('aria-pressed', String(!settings.showDmdMirror));

      const showFallbackScore = !settings.showDmdMirror && isActivePlayPhase;
      this.scoreFallbackPill.classList.toggle('is-hidden', !showFallbackScore);
      this.lastShowDmd = settings.showDmdMirror;
    }

    if (snapshot.score !== this.lastScore) {
      const formatted = formatScore(snapshot.score);
      this.scoreFallbackPill.textContent = formatted;
      this.gameOverScoreValEl.textContent = formatted;
      this.lastScore = snapshot.score;
    }

    // 2. Top-left compact status pills
    this.updateStatusPills(snapshot, isActivePlayPhase);

    // 3. Top-right bar & Settings drawer controls
    this.updateSettingsUi(settings);

    // 4. Bottom-right vertical plunger tension gauge
    const clampedTension = clamp01(plungerTension);
    const isPullingPlunger = clampedTension > 0.01 || this.plungerPointerId !== null;
    const plungerVisible =
      !isPaused &&
      isActivePlayPhase &&
      (phase === 'LAUNCH_READY' || ballInShooter || isPullingPlunger);

    if (plungerVisible !== this.lastPlungerVisible) {
      this.plungerWidget.classList.toggle('is-visible', plungerVisible);
      this.setSubtreeHidden(this.plungerWidget, !plungerVisible);
      this.lastPlungerVisible = plungerVisible;
      if (!plungerVisible && this.plungerPointerId !== null) {
        this.releasePlungerPointer();
      }
    }

    if (!this.plungerDragActive) {
      this.currentPlungerTension = clampedTension;
      this.renderPlungerMeter(clampedTension);
      this.plungerWidget.classList.toggle('is-pulling', clampedTension > 0.01 || this.plungerPointerId !== null);
    }

    const skillShotAvailable = phase === 'LAUNCH_READY' || snapshot.skillShotActive;
    this.updateSkillShotMarker(snapshot.skillShotLaneIndex, skillShotAvailable);

    // 5. Attract / Game Over floating bottom overlay
    const showAttract = (phase === 'ATTRACT' || phase === 'GAME_OVER') && !isPaused;
    const showModal = phase === 'HIGH_SCORE_ENTRY' && !isPaused;

    if (this.lastPhase !== phase || this.lastPaused !== isPaused) {
      const wasPaused = this.lastPaused === true;
      const wasModalOpen = this.lastPhase === 'HIGH_SCORE_ENTRY' && !wasPaused;

      // Capture opener elements before hiding background subtrees
      const activeBeforeTransition =
        document.activeElement instanceof HTMLElement &&
        document.activeElement !== document.body
          ? document.activeElement
          : null;
      if (isPaused && !wasPaused && activeBeforeTransition && !this.drawer.contains(activeBeforeTransition)) {
        this.drawerOpenerEl = activeBeforeTransition;
      }
      if (showModal && !wasModalOpen && activeBeforeTransition && !this.modalBackdrop.contains(activeBeforeTransition)) {
        this.modalOpenerEl = activeBeforeTransition;
      }

      this.attractOverlay.classList.toggle('is-visible', showAttract);
      this.setSubtreeHidden(this.attractOverlay, !showAttract);

      const isGameOver = phase === 'GAME_OVER';
      this.brandSubEl.textContent = isGameOver ? 'GAME OVER // INSERT COIN' : 'COSMIC PINBALL // 1994';
      this.gameOverScoreEl.classList.toggle('is-visible', isGameOver);
      this.playBtnLabel.textContent = isGameOver ? 'PLAY AGAIN / INSERT COIN' : 'PLAY / INSERT COIN';

      // Drawer open/closed state
      this.drawerBackdrop.classList.toggle('is-open', isPaused);
      this.drawer.classList.toggle('is-open', isPaused);
      this.setSubtreeHidden(this.drawer, !isPaused);
      const obscureTopRight = isPaused || showModal;
      this.topRightBar.classList.toggle('is-obscured', obscureTopRight);
      this.setSubtreeHidden(this.topRightBar, obscureTopRight);
      this.pauseBtn.classList.toggle('is-active', isPaused);
      this.pauseBtn.setAttribute('aria-expanded', String(isPaused));

      const drawerTitle = isActivePlayPhase ? 'SYSTEM PAUSED' : 'ARCADE SETTINGS';
      this.drawerTitleEl.textContent = drawerTitle;
      this.resumeBtn.textContent = isActivePlayPhase ? 'RESUME' : 'CLOSE';
      this.restartBtn.textContent = isActivePlayPhase ? 'RESTART GAME' : 'START GAME';

      // High score modal state
      this.modalBackdrop.classList.toggle('is-open', showModal);
      this.setSubtreeHidden(this.modalBackdrop, !showModal);
      if (showModal) {
        this.updateModalScoreAndRank(snapshot.score, highScores);
      }

      // Dialog focus management (skip while WebGL context-loss overlay holds focus)
      if (!this.contextLostBlocked) {
        if (isPaused && !wasPaused) {
          this.resumeBtn.focus({ preventScroll: true });
        } else if (showModal && !wasModalOpen) {
          if (!isPaused && wasPaused) this.drawerOpenerEl = null;
          this.modalDialog.focus({ preventScroll: true });
        } else if (!isPaused && wasPaused) {
          this.restoreFocusToOpener(this.drawerOpenerEl);
          this.drawerOpenerEl = null;
        } else if (!showModal && wasModalOpen) {
          this.restoreFocusToOpener(this.modalOpenerEl);
          this.modalOpenerEl = null;
        }
      }

      // Touch flipper pads visible only during active play on touch screens
      const touchPlayActive = isActivePlayPhase && !isPaused;
      this.touchLayer.classList.toggle('is-active', touchPlayActive);
      this.setSubtreeHidden(this.touchLayer, !touchPlayActive);
      this.touchNudgeGroup.classList.toggle('is-hidden', phase !== 'PLAYING' || isPaused);
      if (!touchPlayActive) {
        this.releaseTouchFlippers();
      }

      this.lastPhase = phase;
      this.lastPaused = isPaused;
    } else if (showModal && snapshot.score !== this.lastModalScore) {
      this.updateModalScoreAndRank(snapshot.score, highScores);
    }

    // 6. Top-5 High Scores mini-card (re-rendered only when data changes)
    const scoresChanged = this.updateHighScoresList(highScores);
    if (scoresChanged && showModal) {
      this.updateModalScoreAndRank(snapshot.score, highScores);
    }
  }

  /**
   * Blits the live 128x32 (or higher-DPI LED-masked) DMD canvas into the
   * top-left HUD mirror bezel. No-op while the DMD mirror is hidden.
   */
  public syncDmd(sourceCanvas: HTMLCanvasElement): void {
    if (this.disposed || !this.dmdMirrorVisible || !this.dmdCtx) return;
    const sw = sourceCanvas.width;
    const sh = sourceCanvas.height;
    if (sw <= 0 || sh <= 0) return;

    const targetW = sw > 256 ? Math.min(sw, 512) : 256;
    const targetH = sh > 64 ? Math.min(sh, 128) : 64;

    if (this.dmdCanvas.width !== targetW || this.dmdCanvas.height !== targetH) {
      this.dmdCanvas.width = targetW;
      this.dmdCanvas.height = targetH;
    }

    const usePixelCrisp = sw <= 256 && sh <= 64;
    this.dmdCtx.imageSmoothingEnabled = !usePixelCrisp;
    if (!usePixelCrisp) {
      this.dmdCtx.imageSmoothingQuality = 'high';
    }

    this.dmdCtx.clearRect(0, 0, targetW, targetH);
    this.dmdCtx.drawImage(sourceCanvas, 0, 0, sw, sh, 0, 0, targetW, targetH);
  }

  /**
   * Releases all event listeners, timers, held pointer inputs, and removes HUD DOM.
   */
  public dispose(): void {
    if (this.disposed) return;
    this.releaseAllPointerInputs();
    this.clearResetConfirmTimer();
    this.drawerOpenerEl = null;
    this.modalOpenerEl = null;
    this.disposed = true;

    window.removeEventListener('keydown', this.handleWindowKeyDown, { capture: true });
    window.removeEventListener('pointerdown', this.handleWindowPointerDown);
    window.removeEventListener('blur', this.handleWindowBlur);

    if (this.shell.parentElement === this.root) {
      this.root.removeChild(this.shell);
    } else {
      this.shell.remove();
    }
  }

  // ---------------------------------------------------------------------------
  // Private UI Builders
  // ---------------------------------------------------------------------------

  private createSection(title: string, shortcut?: string): HTMLDivElement {
    const section = el('div', 'hud-section');
    const head = el('div', 'hud-section-label');
    head.appendChild(el('span', undefined, title));
    if (shortcut) {
      head.appendChild(kbd(shortcut));
    }
    section.appendChild(head);
    return section;
  }

  private createVolumeSlider(label: string, onChange: (value: number) => void): SliderRefs {
    const row = el('div', 'hud-slider-row');
    const head = el('div', 'hud-slider-head');
    const labelEl = el('span', undefined, label);
    const valueLabel = el('span', 'hud-slider-val', '100%');
    head.append(labelEl, valueLabel);

    const input = el('input', 'hud-slider');
    input.type = 'range';
    input.min = '0';
    input.max = '100';
    input.step = '1';
    input.value = '100';
    input.setAttribute('aria-label', label);
    input.addEventListener('input', () => {
      const pct = Math.max(0, Math.min(100, Math.round(Number(input.value))));
      valueLabel.textContent = `${pct}%`;
      onChange(pct / 100);
    });

    row.append(head, input);
    return { input, valueLabel };
  }

  private createInitialSlot(slotIndex: number): InitialSlotRefs {
    const container = el('div', 'hud-initial-slot');

    const upBtn = el('button', 'hud-initial-step', '▲');
    upBtn.type = 'button';
    upBtn.setAttribute('aria-label', `Next character for slot ${slotIndex + 1}`);
    upBtn.addEventListener('click', (e) => {
      blurOnPointerClick(e);
      this.selectedInitialSlot = slotIndex;
      this.stepInitialChar(slotIndex, 1);
    });

    const charBtn = el('button', 'hud-initial-char', 'A');
    charBtn.type = 'button';
    charBtn.setAttribute('aria-label', `Initial slot ${slotIndex + 1}`);
    charBtn.addEventListener('click', (e) => {
      blurOnPointerClick(e);
      this.selectedInitialSlot = slotIndex;
      this.renderInitialsSlots();
    });

    const downBtn = el('button', 'hud-initial-step', '▼');
    downBtn.type = 'button';
    downBtn.setAttribute('aria-label', `Previous character for slot ${slotIndex + 1}`);
    downBtn.addEventListener('click', (e) => {
      blurOnPointerClick(e);
      this.selectedInitialSlot = slotIndex;
      this.stepInitialChar(slotIndex, -1);
    });

    container.append(upBtn, charBtn, downBtn);
    return { container, charBtn, upBtn, downBtn };
  }

  // ---------------------------------------------------------------------------
  // Private Update Helpers
  // ---------------------------------------------------------------------------

  private updateStatusPills(snapshot: GameSnapshot, isActivePlayPhase: boolean): void {
    // Ball pill
    let ballText: string;
    if (isActivePlayPhase) {
      const ebSuffix = snapshot.extraBalls > 0 ? ` +${snapshot.extraBalls} EB` : '';
      ballText = `BALL ${snapshot.ballNumber}/${snapshot.totalBalls}${ebSuffix}`;
    } else if (snapshot.phase === 'GAME_OVER' || snapshot.phase === 'HIGH_SCORE_ENTRY') {
      ballText = 'GAME OVER';
    } else {
      ballText = 'FREE PLAY';
    }

    if (ballText !== this.lastBallSig) {
      this.ballPill.textContent = ballText;
      this.lastBallSig = ballText;
    }

    const activeObjectives = isActivePlayPhase && !snapshot.isTilted;

    // Playfield multiplier pill
    const showMult = activeObjectives && snapshot.playfieldMultiplier > 1;
    const multSec = showMult ? Math.max(0, Math.ceil(snapshot.playfieldMultiplierTimer)) : 0;
    const multSig = showMult ? `${snapshot.playfieldMultiplier}:${multSec}` : 'off';
    if (multSig !== this.lastMultSig) {
      this.multPill.classList.toggle('is-hidden', !showMult);
      if (showMult) {
        const timerStr = multSec > 0 ? ` · ${multSec}s` : '';
        this.multPill.textContent = `PLAYFIELD ${snapshot.playfieldMultiplier}X${timerStr}`;
        this.multPill.classList.toggle('is-max', snapshot.playfieldMultiplier >= 5);
      }
      this.lastMultSig = multSig;
    }

    // Locks / Multiball pill (suppressed while TILTed)
    const lockedCount = Math.max(0, Math.min(3, snapshot.lockedBalls));
    const locksSig = activeObjectives
      ? `${lockedCount}:${snapshot.lockLit ? 1 : 0}:${snapshot.multiballActive ? 1 : 0}:${snapshot.superJackpotLit ? 1 : 0}:${snapshot.jackpotLit ? 1 : 0}:${snapshot.activeBallCount}`
      : 'hidden';

    if (locksSig !== this.lastLocksSig) {
      this.locksPill.classList.toggle('is-hidden', !activeObjectives);
      if (activeObjectives) {
        this.locksPill.classList.toggle('is-multiball', snapshot.multiballActive);
        this.locksPill.classList.toggle('is-lit', !snapshot.multiballActive && snapshot.lockLit);

        if (snapshot.multiballActive) {
          this.locksLabel.textContent = snapshot.superJackpotLit
            ? 'SUPER JACKPOT'
            : snapshot.jackpotLit
              ? 'MULTIBALL · JP'
              : `MULTIBALL ×${Math.max(2, snapshot.activeBallCount)}`;
        } else {
          this.locksLabel.textContent = snapshot.lockLit ? 'LOCK LIT' : 'LOCKS';
        }

        const filledCount = snapshot.multiballActive ? 3 : lockedCount;
        for (let i = 0; i < 3; i++) {
          this.lockDotEls[i].classList.toggle('is-filled', i < filledCount);
        }
      }
      this.lastLocksSig = locksSig;
    }

    // Ball Save pulsing pill (suppressed while TILTed)
    const showBallSave = activeObjectives && snapshot.ballSaveActive;
    const saveUrgent = showBallSave && snapshot.ballSaveTimer <= 3.5;
    const saveSec = showBallSave ? Math.max(1, Math.ceil(snapshot.ballSaveTimer)) : 0;
    const ballSaveSig = showBallSave ? `${saveUrgent ? 1 : 0}:${saveSec}` : 'off';
    if (ballSaveSig !== this.lastBallSaveSig) {
      this.ballSavePill.classList.toggle('is-hidden', !showBallSave);
      if (showBallSave) {
        this.ballSavePill.classList.toggle('is-urgent', saveUrgent);
        this.ballSavePill.textContent = `BALL SAVE ${saveSec}s`;
      }
      this.lastBallSaveSig = ballSaveSig;
    }

    // Shield Kickback pill (suppressed while TILTed)
    const showKickback = activeObjectives && snapshot.kickbackLit;
    if (showKickback !== this.lastKickback) {
      this.kickbackPill.classList.toggle('is-hidden', !showKickback);
      this.lastKickback = showKickback;
    }

    // Warp Ramp combo pill (suppressed while TILTed)
    const activeCombo = activeObjectives && snapshot.rampComboTimer > 0 ? snapshot.rampComboCount : 0;
    if (activeCombo !== this.lastComboCount) {
      const showCombo = activeCombo >= 2;
      this.comboPill.classList.toggle('is-hidden', !showCombo);
      if (showCombo) {
        this.comboPill.textContent = `WARP COMBO ×${activeCombo}`;
      }
      this.lastComboCount = activeCombo;
    }

    // Tilt / Danger pill
    const dangerSig = !isActivePlayPhase
      ? 'off'
      : snapshot.isTilted
        ? 'tilt'
        : snapshot.tiltWarnings > 0
          ? `warn:${snapshot.tiltWarnings}`
          : 'off';

    if (dangerSig !== this.lastDangerSig) {
      this.dangerPill.classList.toggle('is-hidden', dangerSig === 'off');
      if (dangerSig === 'tilt') {
        this.dangerPill.textContent = 'TILT!';
      } else if (dangerSig !== 'off') {
        this.dangerPill.textContent = `DANGER ×${snapshot.tiltWarnings}`;
      }
      this.lastDangerSig = dangerSig;
    }
  }

  private updateSettingsUi(settings: SettingsState): void {
    if (settings.cameraMode !== this.lastCameraMode) {
      this.cameraValueSpan.textContent = CAMERA_LABELS[settings.cameraMode].toUpperCase();
      for (const [mode, btn] of this.cameraButtons) {
        const selected = mode === settings.cameraMode;
        btn.classList.toggle('is-selected', selected);
        btn.setAttribute('aria-pressed', String(selected));
      }
      this.lastCameraMode = settings.cameraMode;
    }

    if (settings.glassMode !== this.lastGlassMode) {
      for (const [mode, btn] of this.glassButtons) {
        const selected = mode === settings.glassMode;
        btn.classList.toggle('is-selected', selected);
        btn.setAttribute('aria-pressed', String(selected));
      }
      this.lastGlassMode = settings.glassMode;
    }

    if (settings.quality !== this.lastQuality) {
      for (const [level, btn] of this.qualityButtons) {
        const selected = level === settings.quality;
        btn.classList.toggle('is-selected', selected);
        btn.setAttribute('aria-pressed', String(selected));
      }
      this.lastQuality = settings.quality;
    }

    if (settings.muted !== this.lastMuted) {
      this.muteBtn.classList.toggle('is-muted', settings.muted);
      this.muteBtn.setAttribute('aria-pressed', String(settings.muted));
      this.muteIconOn.style.display = settings.muted ? 'none' : '';
      this.muteIconOff.style.display = settings.muted ? '' : 'none';
      this.muteLabelSpan.textContent = settings.muted ? 'MUTED' : 'AUDIO';
      this.mutedBanner.classList.toggle('is-visible', settings.muted);
      this.lastMuted = settings.muted;
    }

    if (settings.musicEnabled !== this.lastMusicEnabled) {
      this.musicOnBtn.classList.toggle('is-selected', settings.musicEnabled);
      this.musicOffBtn.classList.toggle('is-selected', !settings.musicEnabled);
      this.musicOnBtn.setAttribute('aria-pressed', String(settings.musicEnabled));
      this.musicOffBtn.setAttribute('aria-pressed', String(!settings.musicEnabled));
      this.lastMusicEnabled = settings.musicEnabled;
    }

    const masterPct = Math.round(clamp01(settings.masterVolume) * 100);
    if (masterPct !== this.lastMasterPct) {
      if (document.activeElement !== this.masterSlider.input) {
        this.masterSlider.input.value = String(masterPct);
      }
      this.masterSlider.valueLabel.textContent = `${masterPct}%`;
      this.lastMasterPct = masterPct;
    }

    const sfxPct = Math.round(clamp01(settings.sfxVolume) * 100);
    if (sfxPct !== this.lastSfxPct) {
      if (document.activeElement !== this.sfxSlider.input) {
        this.sfxSlider.input.value = String(sfxPct);
      }
      this.sfxSlider.valueLabel.textContent = `${sfxPct}%`;
      this.lastSfxPct = sfxPct;
    }

    const musicPct = Math.round(clamp01(settings.musicVolume) * 100);
    if (musicPct !== this.lastMusicPct) {
      if (document.activeElement !== this.musicSlider.input) {
        this.musicSlider.input.value = String(musicPct);
      }
      this.musicSlider.valueLabel.textContent = `${musicPct}%`;
      this.lastMusicPct = musicPct;
    }
  }

  private setSubtreeHidden(container: HTMLElement, hidden: boolean): void {
    if (hidden) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && container.contains(active)) {
        active.blur();
      }
    }
    container.inert = hidden;
    container.setAttribute('aria-hidden', String(hidden));
  }

  private restoreFocusToOpener(opener: HTMLElement | null): void {
    if (!opener || !opener.isConnected) return;
    if (opener.closest('[inert]') || opener.closest('[aria-hidden="true"]')) return;
    opener.focus({ preventScroll: true });
  }

  private updateHighScoresList(highScores: readonly HighScoreEntry[]): boolean {
    if (highScores === this.lastHighScoresRef) return false;

    const count = Math.min(5, highScores.length);
    let sig = '';
    for (let i = 0; i < count; i++) {
      sig += `${highScores[i].initials}:${highScores[i].score}|`;
    }
    this.lastHighScoresRef = highScores;
    if (sig === this.lastHighScoresSig) return false;
    this.lastHighScoresSig = sig;

    this.scoresListEl.replaceChildren();
    if (count === 0) {
      const emptyRow = el('li', 'hud-score-row');
      emptyRow.append(
        el('span', 'hud-score-rank', '—'),
        el('span', 'hud-score-initials', '---'),
        el('span', 'hud-score-val', '0'),
      );
      this.scoresListEl.appendChild(emptyRow);
      return true;
    }

    for (let i = 0; i < count; i++) {
      const entry = highScores[i];
      const row = el('li', 'hud-score-row');
      row.append(
        el('span', 'hud-score-rank', `${i + 1}.`),
        el('span', 'hud-score-initials', entry.initials.slice(0, 3).toUpperCase()),
        el('span', 'hud-score-val', formatScore(entry.score)),
      );
      this.scoresListEl.appendChild(row);
    }
    return true;
  }

  private updateModalScoreAndRank(score: number, highScores: readonly HighScoreEntry[]): void {
    this.lastModalScore = score;
    this.modalScoreEl.textContent = formatScore(score);

    let rank = 1;
    for (const entry of highScores) {
      if (score <= entry.score) {
        rank += 1;
      }
    }
    this.modalRankEl.textContent =
      rank === 1 ? 'GRAND CHAMPION · #1' : `HALL OF FAME · RANK #${Math.min(rank, 5)}`;
  }

  private updateSkillShotMarker(laneIndex: number, visible: boolean): void {
    if (visible !== this.lastSkillShotVisible) {
      this.plungerSkillLabel.classList.toggle('is-hidden', !visible);
      this.plungerSkillMark.classList.toggle('is-hidden', !visible);
      this.lastSkillShotVisible = visible;
    }

    const clampedIdx = Math.max(0, Math.min(SKILL_SHOT_TARGETS.length - 1, Math.floor(laneIndex)));
    if (clampedIdx === this.lastSkillLaneIndex) return;
    this.lastSkillLaneIndex = clampedIdx;

    const target = SKILL_SHOT_TARGETS[clampedIdx];
    const tooltip = `Skill Shot Target: ${target.lane} (${target.pct}%)`;
    this.plungerSkillMark.style.top = `${target.pct}%`;
    this.plungerSkillMark.title = tooltip;
    this.plungerSkillMark.setAttribute('data-skill-lane', target.lane);
    this.plungerSkillMark.setAttribute('data-skill-pct', String(target.pct));
    this.plungerSkillLabel.textContent = `${target.lane} · ${target.pct}%`;
    this.plungerSkillLabel.title = tooltip;
  }

  private renderPlungerMeter(tension: number): void {
    const clamped = clamp01(tension);
    this.currentPlungerTension = clamped;
    if (
      clamped !== 0 &&
      clamped !== 1 &&
      Math.abs(clamped - this.lastPlungerDisplayTension) < 0.002
    ) {
      return;
    }
    this.lastPlungerDisplayTension = clamped;

    const pct = Math.round(clamped * 100);
    this.plungerFill.style.transform = `scaleY(${clamped.toFixed(4)})`;
    this.plungerKnob.style.transform = `translateY(${(clamped * 8).toFixed(2)}px)`;
    this.plungerPctEl.textContent = `${pct}%`;
    this.plungerWidget.setAttribute('aria-valuenow', String(pct));
  }

  // ---------------------------------------------------------------------------
  // Plunger Pointer Drag / Hold Handling
  // ---------------------------------------------------------------------------

  private bindPlungerEvents(): void {
    const computeTrackTension = (clientY: number): number => {
      const rect = this.plungerTrack.getBoundingClientRect();
      if (rect.height > 0) {
        return clamp01((clientY - rect.top) / rect.height);
      }
      return clamp01((clientY - this.plungerStartY) / 140);
    };

    const computeRelativeTension = (clientY: number): number => {
      const rect = this.plungerTrack.getBoundingClientRect();
      const trackHeight = rect.height > 0 ? rect.height : 140;
      return clamp01(this.plungerDragBaseTension + (clientY - this.plungerDragAnchorY) / trackHeight);
    };

    this.plungerWidget.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (this.plungerPointerId !== null) return;
      e.preventDefault();

      this.plungerPointerId = e.pointerId;
      this.plungerStartY = e.clientY;
      this.plungerDragBaseTension = this.currentPlungerTension;
      this.plungerDragAnchorY = e.clientY;
      const startedOnTrack =
        e.target instanceof Node && this.plungerTrack.contains(e.target);
      this.plungerDragMode = startedOnTrack ? 'track' : 'relative';
      this.plungerDragActive = startedOnTrack;

      try {
        this.plungerWidget.setPointerCapture(e.pointerId);
      } catch {
        // Ignore capture failure on synthetic pointer events
      }

      this.plungerWidget.classList.add('is-pulling');
      if (startedOnTrack) {
        const tension = computeTrackTension(e.clientY);
        this.renderPlungerMeter(tension);
        this.callbacks.onPlungerChange(true, tension);
      } else {
        this.callbacks.onPlungerChange(true);
      }
    });

    this.plungerWidget.addEventListener('pointermove', (e: PointerEvent) => {
      if (e.pointerId !== this.plungerPointerId) return;
      const dy = e.clientY - this.plungerStartY;

      if (!this.plungerDragActive && Math.abs(dy) >= 5) {
        this.plungerDragActive = true;
        // Anchor drag to live ramped tension so transitioning from hold -> drag never snaps back
        this.plungerDragBaseTension = this.currentPlungerTension;
        this.plungerDragAnchorY = e.clientY;
      }

      if (this.plungerDragActive) {
        const tension =
          this.plungerDragMode === 'track'
            ? computeTrackTension(e.clientY)
            : computeRelativeTension(e.clientY);
        this.renderPlungerMeter(tension);
        this.callbacks.onPlungerChange(true, tension);
      }
    });

    const handleRelease = (e: PointerEvent): void => {
      if (e.pointerId !== this.plungerPointerId) return;
      this.releasePlungerPointer();
    };

    this.plungerWidget.addEventListener('pointerup', handleRelease);
    this.plungerWidget.addEventListener('pointercancel', handleRelease);
    this.plungerWidget.addEventListener('lostpointercapture', handleRelease);
  }

  private releasePlungerPointer(): void {
    if (this.plungerPointerId === null) return;
    const pointerId = this.plungerPointerId;
    this.plungerPointerId = null;
    this.plungerDragMode = 'none';
    this.plungerDragActive = false;
    this.plungerDragBaseTension = 0;
    this.plungerDragAnchorY = 0;
    this.plungerWidget.classList.remove('is-pulling');

    try {
      if (this.plungerWidget.hasPointerCapture(pointerId)) {
        this.plungerWidget.releasePointerCapture(pointerId);
      }
    } catch {
      // Ignore release errors
    }

    this.callbacks.onPlungerChange(false);
  }

  // ---------------------------------------------------------------------------
  // Multi-Touch Flipper Pad Handling
  // ---------------------------------------------------------------------------

  private bindTouchFlipper(
    button: HTMLButtonElement,
    side: 'left' | 'right',
    activePointers: Set<number>,
  ): void {
    button.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      try {
        button.setPointerCapture(e.pointerId);
      } catch {
        // Ignore capture failure on synthetic events
      }

      const wasEmpty = activePointers.size === 0;
      activePointers.add(e.pointerId);
      if (wasEmpty) {
        button.classList.add('is-pressed');
        this.callbacks.onFlipperInput(side, true);
      }
    });

    const releasePointer = (e: PointerEvent): void => {
      if (!activePointers.delete(e.pointerId)) return;
      try {
        if (button.hasPointerCapture(e.pointerId)) {
          button.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Ignore release errors
      }
      if (activePointers.size === 0) {
        button.classList.remove('is-pressed');
        this.callbacks.onFlipperInput(side, false);
      }
    };

    button.addEventListener('pointerup', releasePointer);
    button.addEventListener('pointercancel', releasePointer);
    button.addEventListener('lostpointercapture', releasePointer);
  }

  private releaseTouchFlippers(): void {
    if (this.activeLeftPointers.size > 0) {
      this.activeLeftPointers.clear();
      this.touchLeftFlipper.classList.remove('is-pressed');
      this.callbacks.onFlipperInput('left', false);
    }
    if (this.activeRightPointers.size > 0) {
      this.activeRightPointers.clear();
      this.touchRightFlipper.classList.remove('is-pressed');
      this.callbacks.onFlipperInput('right', false);
    }
  }

  private releaseAllPointerInputs(): void {
    this.releasePlungerPointer();
    this.releaseTouchFlippers();
  }

  // ---------------------------------------------------------------------------
  // High Score 3-Letter Initials Entry Logic
  // ---------------------------------------------------------------------------

  private stepInitialChar(slotIndex: number, delta: number): void {
    const current = this.initialsIndices[slotIndex];
    const next = (current + delta + INITIAL_CHAR_COUNT) % INITIAL_CHAR_COUNT;
    this.initialsIndices[slotIndex] = next;
    this.renderInitialsSlots();
  }

  private setInitialChar(slotIndex: number, char: string): void {
    const idx = INITIAL_CHARSET.indexOf(char.toUpperCase());
    if (idx < 0) return;
    this.initialsIndices[slotIndex] = idx;
    this.renderInitialsSlots();
  }

  private renderInitialsSlots(): void {
    for (let i = 0; i < 3; i++) {
      const slot = this.initialSlots[i];
      const char = INITIAL_CHARSET[this.initialsIndices[i]];
      slot.charBtn.textContent = char;
      slot.charBtn.setAttribute('aria-label', `Initial slot ${i + 1}, ${char}`);
      slot.container.classList.toggle('is-selected', i === this.selectedInitialSlot);
    }
  }

  private getInitialsString(): string {
    return (
      INITIAL_CHARSET[this.initialsIndices[0]] +
      INITIAL_CHARSET[this.initialsIndices[1]] +
      INITIAL_CHARSET[this.initialsIndices[2]]
    );
  }

  private submitHighScore(): void {
    if (this.highScoreSubmitted || this.currentPhase !== 'HIGH_SCORE_ENTRY') return;
    this.highScoreSubmitted = true;
    this.callbacks.onSubmitHighScore(this.getInitialsString());
  }

  private readonly handleWindowKeyDown = (e: KeyboardEvent): void => {
    if (this.disposed || !this.isHighScoreModalOpen()) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const key = e.key;

    if (key.length === 1 && /^[a-zA-Z0-9]$/.test(key)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.setInitialChar(this.selectedInitialSlot, key);
      if (this.selectedInitialSlot < 2) {
        this.selectedInitialSlot += 1;
        this.renderInitialsSlots();
      }
      return;
    }

    switch (key) {
      case 'ArrowUp':
        e.preventDefault();
        e.stopImmediatePropagation();
        this.stepInitialChar(this.selectedInitialSlot, 1);
        break;
      case 'ArrowDown':
        e.preventDefault();
        e.stopImmediatePropagation();
        this.stepInitialChar(this.selectedInitialSlot, -1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        e.stopImmediatePropagation();
        this.selectedInitialSlot = (this.selectedInitialSlot + 2) % 3;
        this.renderInitialsSlots();
        break;
      case 'ArrowRight':
        e.preventDefault();
        e.stopImmediatePropagation();
        this.selectedInitialSlot = (this.selectedInitialSlot + 1) % 3;
        this.renderInitialsSlots();
        break;
      case 'Backspace':
        e.preventDefault();
        e.stopImmediatePropagation();
        if (this.selectedInitialSlot > 0) {
          this.selectedInitialSlot -= 1;
          this.renderInitialsSlots();
        }
        break;
      case 'Enter': {
        const activeEl = document.activeElement;
        const targetEl = e.target;
        const isSlotControl = (node: EventTarget | Element | null): boolean =>
          node instanceof HTMLButtonElement &&
          (node.classList.contains('hud-initial-step') ||
            node.classList.contains('hud-initial-char'));
        if (isSlotControl(activeEl) || isSlotControl(targetEl)) {
          // Let keyboard-focused slot/step buttons handle Enter natively instead of submitting
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        this.submitHighScore();
        break;
      }
      case ' ':
        // Prevent spacebar from leaking to plunger/start while entering initials
        if (!(e.target instanceof HTMLButtonElement)) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
        break;
      default:
        break;
    }
  };

  private readonly handleWindowPointerDown = (e: PointerEvent): void => {
    if (this.disposed || this.hasTouchInput) return;
    if (e.pointerType === 'touch') {
      this.hasTouchInput = true;
      this.shell.classList.add('has-touch-input');
    }
  };

  private readonly handleWindowBlur = (): void => {
    if (this.disposed) return;
    this.releaseAllPointerInputs();
  };

  private clearResetConfirmTimer(): void {
    if (this.resetConfirmTimer !== null) {
      window.clearTimeout(this.resetConfirmTimer);
      this.resetConfirmTimer = null;
    }
  }

  private resetHighScoreConfirmation(): void {
    this.clearResetConfirmTimer();
    this.confirmResetScores = false;
    if (this.resetScoresBtn) {
      this.resetScoresBtn.textContent = 'Reset High Scores';
      this.resetScoresBtn.classList.remove('is-confirming');
    }
  }
}
