"use client";

import { memo, useEffect, useRef } from "react";

/* Decorative, data-driven backdrop: a landscape of wind turbines (plus a solar farm as scenery;
 * the data is wind-only) whose rotors turn at the selected day's actual wind, and a canvas of
 * wind streaks that the pointer pushes around. aria-hidden and pointer-events: none throughout,
 * so it never carries information or blocks the UI.
 *
 * Motion follows the motion guide: rotors and clouds animate transform only (compositor), via
 * the Web Animations API so speed changes use playbackRate without resetting the rotation. The
 * canvas follows MDN "Optimizing canvas": one layer over a CSS-painted static sky, one batched
 * path per frame, integer coordinates, no shadowBlur, requestAnimationFrame, DPR capped at 2. */

type Props = { windiness: number; motion: boolean };

// [x, ground y, scale, depth 0 = far .. 1 = near] in the 1440x900 viewBox. The near, large
// turbines stand in the side gutters (content is a centred 70rem column) so they stay visible.
const TURBINES: [number, number, number, number][] = [
  [250, 630, 0.6, 0.2], [520, 612, 0.5, 0.15], [930, 605, 0.55, 0.2], [1190, 625, 0.7, 0.35],
  [70, 780, 1.55, 0.9], [1372, 790, 1.7, 1], [740, 730, 0.9, 0.6],
];

function Turbine({ x, y, s, depth }: { x: number; y: number; s: number; depth: number }) {
  const blade = "M0 0 C 3 -8, 4 -40, 1.5 -78 L -1.5 -78 C -2.5 -40, -2 -8, 0 0 Z";
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`} opacity={0.55 + depth * 0.45}>
      <path d="M-4 0 L-1.8 -118 L1.8 -118 L4 0 Z" fill="url(#tower)" stroke="#aebbd1" strokeWidth="0.6" />
      <rect x="-5" y="-123" width="13" height="8" rx="4" fill="#eef2f8" />
      <g transform="translate(0 -119)">
        {/* The transparent circle makes the rotor's bounding box centred on the hub, so
            transform-box: fill-box + transform-origin: center spins it about the hub. */}
        <g className="rotor">
          <circle r="78" fill="transparent" />
          {[0, 120, 240].map((a) => <path key={a} d={blade} transform={`rotate(${a})`} fill="url(#blade)" stroke="#aebbd1" strokeWidth="0.6" />)}
          <circle r="4.5" fill="#f7f9fc" stroke="#c9d3e3" strokeWidth="1" />
        </g>
      </g>
    </g>
  );
}

function SolarFarm() {
  // Two rows of tilted panels, lower right: pale so text that scrolls over them stays legible.
  const panels = [];
  for (let row = 0; row < 2; row++)
    for (let i = 0; i < 6; i++) {
      const x = 1010 + i * 40 + row * 16, y = 815 + row * 26;
      panels.push(
        <g key={`${row}-${i}`} transform={`translate(${x} ${y})`}>
          <rect x="16" y="10" width="3" height="12" fill="#9aa8bd" />
          <path d="M0 10 L10 -6 L46 -6 L36 10 Z" fill="url(#panel)" stroke="#e8eefb" strokeWidth="1" />
          <path className="glint" d="M12 -4 L18 -4 L10 8 L4 8 Z" fill="#ffffff" />
        </g>,
      );
    }
  return <g>{panels}</g>;
}

const Cloud = ({ x, y, s }: { x: number; y: number; s: number }) => (
  <g className="cloud" transform={`translate(${x} ${y}) scale(${s})`}>
    <path d="M0 40 a30 30 0 0 1 28-38 a40 40 0 0 1 72 6 a28 28 0 0 1 40 32 Z" fill="url(#cloud)" />
  </g>
);

/** Scene: the landscape markup never changes (only animation speed does, via the Web Animations
 *  API), so it is memoised and a calendar click doesn't re-render hundreds of SVG nodes. */
export const Scene = memo(function Scene({ windiness, motion }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const animsRef = useRef<Animation[]>([]);

  // Build the rotor and cloud animations once; stagger phases so turbines don't move in lockstep.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const rotors = [...svg.querySelectorAll<SVGGElement>(".rotor")].map((el, i) => {
      const a = el.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], { duration: 4000, iterations: Infinity });
      a.currentTime = (i * 1373) % 4000;
      return a;
    });
    const clouds = [...svg.querySelectorAll<SVGGElement>(".cloud")].map((el) =>
      el.animate([{ translate: "-260px 0" }, { translate: "1700px 0" }], { duration: 160000, iterations: Infinity, delay: -Math.random() * 160000 }),
    );
    animsRef.current = [...rotors, ...clouds];
    return () => animsRef.current.forEach((a) => a.cancel());
  }, []);

  // Speed follows the day's wind; pause/play follows the motion setting.
  useEffect(() => {
    for (const a of animsRef.current) {
      a.updatePlaybackRate(0.2 + windiness * 1.8);
      if (motion) a.play(); else a.pause();
    }
  }, [windiness, motion]);

  return (
    <div className="scene" aria-hidden="true" data-motion={motion ? "on" : "off"}>
      <Landscape svgRef={svgRef} />
      <WindCanvas windiness={windiness} motion={motion} />
    </div>
  );
});

const Landscape = memo(function Landscape({ svgRef }: { svgRef: React.RefObject<SVGSVGElement | null> }) {
  return (
      <svg ref={svgRef} viewBox="0 0 1440 900" preserveAspectRatio="xMidYMax slice" focusable="false">
        <defs>
          <linearGradient id="tower" x1="0" x2="1"><stop offset="0" stopColor="#ffffff" /><stop offset="1" stopColor="#bfcbdd" /></linearGradient>
          <linearGradient id="blade" x1="0" x2="1"><stop offset="0" stopColor="#ffffff" /><stop offset="1" stopColor="#c9d4e6" /></linearGradient>
          <linearGradient id="panel" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#c3cdf2" /><stop offset="1" stopColor="#97a6de" /></linearGradient>
          <radialGradient id="cloud" cx="0.4" cy="0.3"><stop offset="0" stopColor="#ffffff" /><stop offset="1" stopColor="#e6edf8" /></radialGradient>
          <radialGradient id="sun"><stop offset="0" stopColor="#fff4d6" /><stop offset="0.5" stopColor="#ffe7ad" stopOpacity="0.6" /><stop offset="1" stopColor="#ffe7ad" stopOpacity="0" /></radialGradient>
          <linearGradient id="hillFar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#dfeee4" /><stop offset="1" stopColor="#d3e7da" /></linearGradient>
          <linearGradient id="hillNear" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#e5f3e2" /><stop offset="1" stopColor="#d6ebd3" /></linearGradient>
        </defs>
        <circle cx="1220" cy="150" r="170" fill="url(#sun)" />
        <Cloud x={200} y={140} s={1.1} />
        <Cloud x={760} y={90} s={0.8} />
        <Cloud x={1100} y={230} s={0.65} />
        <path d="M0 640 C 220 580, 420 600, 640 640 S 1100 570, 1440 620 L1440 900 L0 900 Z" fill="url(#hillFar)" />
        {TURBINES.filter((t) => t[3] < 0.5).map(([x, y, s, d], i) => <Turbine key={i} x={x} y={y} s={s} depth={d} />)}
        <path d="M0 760 C 260 700, 520 720, 760 760 S 1200 700, 1440 750 L1440 900 L0 900 Z" fill="url(#hillNear)" />
        {TURBINES.filter((t) => t[3] >= 0.5).map(([x, y, s, d], i) => <Turbine key={i} x={x} y={y} s={s} depth={d} />)}
        <SolarFarm />
      </svg>
  );
});

function WindCanvas({ windiness, motion }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const windRef = useRef(windiness);
  useEffect(() => { windRef.current = windiness; }, [windiness]); // read per frame: no restart on a new day

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !motion) return;

    let w = 0, h = 0, raf = 0;
    type P = { x: number; y: number; vx: number; vy: number; len: number };
    let ps: P[] = [];
    const spawn = (x = Math.random() * w): P => ({ x, y: Math.random() * h, vx: 0, vy: 0, len: 8 + Math.random() * 22 });
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth; h = window.innerHeight;
      canvas.width = Math.floor(w * dpr); canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Resizing a canvas resets its context state, so styles are (re)applied here.
      ctx.lineWidth = 1.4;
      ctx.lineCap = "round";
      ctx.strokeStyle = "rgba(88, 118, 168, 0.28)";
      ps = Array.from({ length: Math.min(180, Math.round((w * h) / 9000)) }, () => spawn());
    };

    // Pointer gusts: smoothed pointer velocity pushes nearby streaks, then decays.
    const ptr = { x: -1e4, y: -1e4, vx: 0, vy: 0 };
    const onMove = (e: PointerEvent) => {
      ptr.vx = ptr.vx * 0.6 + (e.clientX - ptr.x) * 0.4;
      ptr.vy = ptr.vy * 0.6 + (e.clientY - ptr.y) * 0.4;
      if (ptr.x < -1e3) ptr.vx = ptr.vy = 0; // first event: no jump from off-screen
      ptr.x = e.clientX; ptr.y = e.clientY;
    };

    const R = 170, t0 = performance.now();
    const frame = (now: number) => {
      const base = 0.6 + windRef.current * 3.4; // px per frame of steady wind
      const t = (now - t0) / 1000;
      ctx.clearRect(0, 0, w, h);
      ctx.beginPath();
      for (const p of ps) {
        const dx = p.x - ptr.x, dy = p.y - ptr.y, d2 = dx * dx + dy * dy;
        if (d2 < R * R) {
          const f = (1 - Math.sqrt(d2) / R) * 0.12;
          p.vx += ptr.vx * f; p.vy += ptr.vy * f;
        }
        p.vx *= 0.94; p.vy *= 0.94; // gusts fade back into the steady flow
        p.x += base + p.vx;
        p.y += Math.sin(p.y * 0.006 + t * 0.6) * 0.35 * base + p.vy;
        if (p.x > w + 40 || p.x < -60 || p.y < -40 || p.y > h + 40) Object.assign(p, spawn(-30));
        const sp = Math.hypot(base + p.vx, p.vy) || 1, k = p.len / sp;
        ctx.moveTo(Math.round(p.x), Math.round(p.y));
        ctx.lineTo(Math.round(p.x - (base + p.vx) * k), Math.round(p.y - p.vy * k));
      }
      ctx.stroke();
      ptr.vx *= 0.9; ptr.vy *= 0.9;
      raf = requestAnimationFrame(frame); // rAF also pauses itself in background tabs
    };

    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onMove, { passive: true });
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onMove);
      ctx.clearRect(0, 0, w, h);
    };
  }, [motion]);

  return <canvas ref={ref} className="wind" />;
}
