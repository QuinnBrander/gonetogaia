/**
 * Story screen ambient particle drift.
 *
 * Mounts an absolutely-positioned `<canvas>` inside the story `host`
 * element and animates a population of soft purple (and a few white)
 * particles slowly drifting left → right across the host, with a small
 * sinusoidal vertical wobble so the motion reads as "windblown" rather
 * than a flat scroll.
 *
 * The canvas is `pointer-events: none` so it never intercepts clicks
 * (the storybook card and Next button still receive their events). It
 * sits at `z-index: 0` while the story content is positioned at
 * `z-index: 1` (see `.screen--story .story-stage` in styles.css), so
 * particles render *over* the porthole background image and *under*
 * the storybook card.
 *
 * Lifecycle: call `startStoryParticles(host)` after the host is in the
 * DOM. The returned `StoryParticles` exposes `.stop()` which cancels
 * the rAF loop and disconnects the resize observer. Story.ts calls
 * `.stop()` at the top of every render (and on `resetStoryProgress`)
 * so the loop never leaks across screen transitions.
 */

const PURPLES = [
  "139, 92, 246",   // violet-500
  "167, 139, 250",  // violet-400
  "196, 181, 253",  // violet-300
  "124, 58, 237",   // violet-600
  "168, 85, 247",   // purple-500
  "216, 180, 254",  // purple-300
  "147, 51, 234",   // purple-600
];
const WHITE = "255, 255, 255";

const WHITE_PROBABILITY = 0.18;

interface Particle {
  x: number;        // px from left of host
  y: number;        // px from top of host (anchor — actual y wobbles around this)
  vx: number;       // px / sec
  size: number;     // radius in px
  alpha: number;    // 0..1 base alpha (multiplied by glow falloff)
  color: string;    // "r, g, b" triplet for rgba()
  wobblePhase: number;
  wobbleFreq: number;   // radians / sec
  wobbleAmp: number;    // px
}

export interface StoryParticles {
  stop(): void;
}

export function startStoryParticles(host: HTMLElement): StoryParticles {
  const canvas = document.createElement("canvas");
  canvas.className = "story-particles";
  host.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    canvas.remove();
    return { stop() {} };
  }

  let viewW = 0;
  let viewH = 0;
  let particles: Particle[] = [];
  let rafId: number | null = null;
  let lastTs = 0;
  let stopped = false;

  const resize = () => {
    // IMPORTANT: use `clientWidth`/`clientHeight` (layout-box pixels)
    // rather than `getBoundingClientRect()` (post-transform pixels).
    //
    // The host lives inside `#app-stage`, which has a uniform
    // `transform: scale(var(--stage-scale))` applied to fit the
    // 3538\u00d72211 design stage inside the current viewport (see
    // `layout/stageScale.ts`). `getBoundingClientRect()` reports the
    // VISIBLE size on screen \u2014 already shrunk by that scale \u2014 so
    // setting `canvas.style.width` from it makes the canvas
    // double-scale (the style px are themselves inside the scaled
    // parent, so they shrink again). The visible particle area
    // collapses to the top-left fraction of the screen.
    //
    // `clientWidth`/`clientHeight` ignore CSS transforms on the
    // element AND its ancestors, returning the untransformed layout
    // box \u2014 i.e. design-stage pixels. That matches the units the
    // canvas's CSS rule (`.story-particles { width: 100%; height:
    // 100% }`) uses, so the canvas now fills the host correctly and
    // the stage's scale transform handles fitting it to the
    // viewport like everything else on the stage.
    const dpr = window.devicePixelRatio || 1;
    viewW = Math.max(1, host.clientWidth);
    viewH = Math.max(1, host.clientHeight);
    canvas.width = viewW * dpr;
    canvas.height = viewH * dpr;
    canvas.style.width = `${viewW}px`;
    canvas.style.height = `${viewH}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rebuildPopulation();
  };

  const rebuildPopulation = () => {
    // ~1 particle per 14000 px² of host area, clamped to a sensible
    // range so tiny windows don't feel empty and giant displays don't
    // turn into a snowstorm.
    const target = Math.min(220, Math.max(40, Math.round((viewW * viewH) / 14000)));
    if (particles.length === target) return;
    if (particles.length < target) {
      while (particles.length < target) particles.push(spawnAtRandom());
    } else {
      particles.length = target;
    }
  };

  const spawnAtRandom = (): Particle => {
    // Initial spawn distributed across the full width so we don't
    // have an empty screen for the first few seconds while particles
    // walk in from the left edge.
    const p = freshParticle();
    p.x = Math.random() * viewW;
    return p;
  };

  const freshParticle = (): Particle => {
    const isWhite = Math.random() < WHITE_PROBABILITY;
    const color = isWhite ? WHITE : PURPLES[Math.floor(Math.random() * PURPLES.length)]!;
    // Long-tail size distribution: bias toward small motes with
    // occasional larger ones for visual interest.
    const sizeRoll = Math.random();
    const size = sizeRoll < 0.7
      ? 0.6 + Math.random() * 1.6   // 0.6 - 2.2 px (most particles)
      : sizeRoll < 0.95
        ? 2.2 + Math.random() * 2.0 // 2.2 - 4.2 px (medium)
        : 4.2 + Math.random() * 3.0; // 4.2 - 7.2 px (rare large)
    return {
      x: -size * 4,
      y: Math.random() * viewH,
      vx: 6 + Math.random() * 26,            // 6 - 32 px/sec — slow drift
      size,
      alpha: 0.35 + Math.random() * 0.55,    // 0.35 - 0.9
      color,
      wobblePhase: Math.random() * Math.PI * 2,
      wobbleFreq: 0.25 + Math.random() * 0.7, // 0.25 - 0.95 Hz-ish
      wobbleAmp: 3 + Math.random() * 10,      // 3 - 13 px
    };
  };

  const recycle = (p: Particle) => {
    const fresh = freshParticle();
    Object.assign(p, fresh);
    p.x = -p.size * 4;
  };

  const tick = (ts: number) => {
    if (stopped) return;
    if (!host.isConnected) {
      stop();
      return;
    }
    if (lastTs === 0) lastTs = ts;
    const dt = Math.min(0.1, (ts - lastTs) / 1000); // clamp big gaps (tab refocus)
    lastTs = ts;

    ctx.clearRect(0, 0, viewW, viewH);
    // Additive-ish blending so overlapping particles brighten softly
    // (gives the wisps a glowing-dust feel without a real bloom pass).
    ctx.globalCompositeOperation = "lighter";

    const tSec = ts / 1000;
    for (const p of particles) {
      p.x += p.vx * dt;
      const y = p.y + Math.sin(tSec * p.wobbleFreq * Math.PI * 2 + p.wobblePhase) * p.wobbleAmp;

      // Soft circular glow: a wider, low-alpha halo + a brighter core.
      const halo = p.size * 2.4;
      const grad = ctx.createRadialGradient(p.x, y, 0, p.x, y, halo);
      grad.addColorStop(0, `rgba(${p.color}, ${p.alpha})`);
      grad.addColorStop(0.45, `rgba(${p.color}, ${p.alpha * 0.45})`);
      grad.addColorStop(1, `rgba(${p.color}, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p.x, y, halo, 0, Math.PI * 2);
      ctx.fill();

      if (p.x - p.size * 4 > viewW) recycle(p);
    }

    ctx.globalCompositeOperation = "source-over";
    rafId = window.requestAnimationFrame(tick);
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
    ro.disconnect();
    canvas.remove();
  };

  const ro = new ResizeObserver(() => resize());
  ro.observe(host);

  resize();
  rafId = window.requestAnimationFrame(tick);

  return { stop };
}
