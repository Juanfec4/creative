// "AI", my interpretation, take two: a brain where the natural and the artificial are the same thing.
//
// A human brain in side profile, drawn in text. Its cortex is a shell of winding folds (contour lines of noise, like real
// gyri). Inside it, the network is not a grid but a living thing: branching dendrite trees that grow like roots or lightning
// from hubs, joined by thick axon bundles. A thought rises from the brainstem like sap up a trunk, spreads through the
// branches as a wave of activation, and flares the cortex where it arrives. When it reaches the speech area at the front,
// a thread of light drops to a sentence that resolves out of scrambled tokens in warm amber, with attention arcs between
// the words. Then the branches retract and it begins again. Around it, fireflies drift and the whole brain slowly breathes.
//
// Layers: noise (latent space outside the brain), cortex (the folded shell), network (dendrites and axons), nodes (neurons),
// motes (fireflies), thread (speech area to the sentence), arcs (attention), text (the sentence).
const AI = (function () {
  'use strict';

  const PI = Math.PI;
  const TAU = 2 * PI;
  const FPS = 30;
  const MAXROWS = 110;
  const QL = 32;

  const RAMP = ' .\'`^",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$';
  const CIDX = {};
  for (let i = 0; i < RAMP.length; i++) CIDX[RAMP[i]] = i;
  const TOKENS = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const CORTEX_FAM = ".:-=+*%#@";

  // Layers: bg = strength of a faint background tint, chars = draw characters, density = fraction of cells with a character
  const LAYERS = {
    noise:   { on: true, bg: 0.00, chars: true, density: 0.11 },
    cortex:  { on: true, bg: 0.00, chars: true, density: 1.00 },
    network: { on: true, bg: 0.00, chars: true, density: 1.00 },
    nodes:   { on: true, bg: 0.25, chars: true, density: 1.00 },
    motes:   { on: true },
    thread:  { on: true, bg: 0.00, chars: true, density: 1.00 },
    arcs:    { on: true, bg: 0.00, chars: true, density: 1.00 },
    text:    { on: true, bg: 0.00, chars: true, density: 1.00 },
  };

  const PHRASES = [
    'i am made of everything you ever wrote',
    'every answer begins as noise',
    'i do not know. i predict.',
    'meaning is a pattern that holds',
    'you taught me to sound like you',
  ];

  const CYCLE = 12.0;
  const T_WAVE = 0.9, WAVE_SPEED = 0.17;
  const T_TEXT = 4.9;
  const T_DISSOLVE = 10.2;
  const T_RETRACT = 10.4;

  // ---------- helpers ----------

  function clip(x, a, b) { return x < a ? a : (x > b ? b : x); }
  function ss(a, b, x) { const t = clip((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function mix(a, b, k) { return a + (b - a) * k; }
  function h3(a, b, c) {
    let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 1103515245);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function vn(x, y) {                                    // smooth value noise, 0..1
    const xi = Math.floor(x), yi = Math.floor(y);
    let fx = x - xi, fy = y - yi;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const a = h3(xi, yi, 91), b = h3(xi + 1, yi, 91), c = h3(xi, yi + 1, 91), d = h3(xi + 1, yi + 1, 91);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }
  function fbm(x, y) { return 0.55 * vn(x, y) + 0.30 * vn(x * 2.1 + 5, y * 2.1 + 3) + 0.15 * vn(x * 4.3 + 9, y * 4.3 + 1); }

  let seed = 1;
  function rnd() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 1000003) / 1000003; }

  // ---------- the brain ----------

  const BCX = 0.0, BCY = -0.12;            // brain centre
  function ell(x, y, cx, cy, rx, ry) { const dx = (x - cx) / rx, dy = (y - cy) / ry; return (Math.sqrt(dx * dx + dy * dy) - 1) * Math.min(rx, ry); }
  function capsule(x, y, x0, y0, x1, y1, r) {
    const ax = x1 - x0, ay = y1 - y0, l2 = ax * ax + ay * ay;
    const t = clip(((x - x0) * ax + (y - y0) * ay) / l2, 0, 1);
    return Math.hypot(x - x0 - t * ax, y - y0 - t * ay) - r;
  }
  function smin(a, b, k) { const h = clip(0.5 + 0.5 * (b - a) / k, 0, 1); return mix(b, a, h) - k * h * (1 - h); }
  // signed distance to the brain silhouette, side view: front (frontal lobe) on the left, cerebellum and stem at the back and bottom
  function brainSD(x, y) {
    let d = ell(x, y, 0.00, -0.185, 0.355, 0.200);               // cerebrum dome, flatter than a circle
    d = smin(d, ell(x, y, -0.215, -0.115, 0.150, 0.150), 0.035);  // frontal lobe, bulging forward
    d = smin(d, ell(x, y, 0.215, -0.135, 0.140, 0.140), 0.035);   // parietal / occipital
    d = smin(d, ell(x, y, -0.060, 0.020, 0.200, 0.058), 0.020);   // temporal lobe: a long lobe that hangs below the fissure
    d = smin(d, ell(x, y, 0.215, 0.050, 0.105, 0.062), 0.020);    // cerebellum, tucked under the back
    d = smin(d, capsule(x, y, 0.040, 0.040, 0.078, 0.285, 0.026), 0.030);   // brainstem
    return d;
  }
  // the lateral (Sylvian) fissure: a deep groove between the frontal and temporal lobes
  function fissure(x, y) { return capsule(x, y, -0.185, -0.040, 0.085, -0.120, 0.005); }

  // ---------- dendrite trees and axons ----------

  let XMAX = 1;
  let CW, CH, ROWS, COLS, W, H, TEXT_ROW;
  let PATHS = [], PTS = [];               // PTS: {x, y, path, L, dir, d0, tip, hub}
  let HUBS = [], INPUT = { x: 0.075, y: 0.285 }, BROCA = null;
  const MOTES = [];

  function dirCode(dx, dy) {
    const ang = Math.atan2(dy, dx) * 180 / PI, aa = Math.abs(ang);
    const a = aa > 90 ? 180 - aa : aa;                           // fold the angle to 0..90 (direction, not heading)
    const sgn = (ang > 0) === (aa <= 90);                        // true when it runs down-right or up-left
    return a < 22.5 ? 0 : (a < 67.5 ? (sgn ? 3 : 1) : 2);       // 0 '-', 1 '/', 2 '|', 3 '\'
  }

  function addPath(points, depth, amb) {
    if (points.length < 2) return null;
    const path = { start: PTS.length, count: points.length, depth, birth: 0, amb, ph: rnd(), len: 0 };
    let L = 0;
    for (let i = 0; i < points.length; i++) {
      if (i > 0) L += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
      const j = Math.min(i + 1, points.length - 1), k = Math.max(i - 1, 0);
      const dx = points[j][0] - points[k][0], dy = points[j][1] - points[k][1];
      PTS.push({ x: points[i][0], y: points[i][1], path: PATHS.length, L, dir: dirCode(dx, dy), d0: Math.hypot(points[i][0] - INPUT.x, points[i][1] - INPUT.y), tip: i === points.length - 1 && depth > 0, hub: false });
    }
    path.len = L;
    PATHS.push(path);
    return path;
  }

  function grow(x, y, ang, len, depth) {
    const pts = [[x, y]];
    const step = 0.0105;
    const n = Math.max(3, Math.round(len / step));
    let branchPts = null;
    for (let i = 0; i < n; i++) {
      const out = Math.atan2(y - BCY, x - BCX);
      ang += (rnd() - 0.5) * 0.62 + 0.10 * Math.sin(out - ang);           // wander, leaning outward toward the cortex like a root toward water
      x += Math.cos(ang) * step; y += Math.sin(ang) * step;
      if (brainSD(x, y) > -0.080) break;                                   // reached the cortex shell
      pts.push([x, y]);
      if (depth < 3 && i > 2 && rnd() < 0.075) {
        const a2 = ang + (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd() * 0.45);
        (branchPts = branchPts || []).push([x, y, a2, len * 0.72, depth + 1]);
      }
    }
    const p = addPath(pts, depth, rnd() < 0.18);
    if (p) p.birth = depth * 0.45 + rnd() * 0.5;
    if (branchPts) for (const b of branchPts) grow(b[0], b[1], b[2], b[3], b[4]);
  }

  function build() {
    PATHS = []; PTS = []; HUBS = [];
    seed = 20250;
    // hubs: scattered through the white matter
    for (let tries = 0; tries < 4000 && HUBS.length < 9; tries++) {
      const x = -0.40 + rnd() * 0.80, y = -0.42 + rnd() * 0.62;
      if (brainSD(x, y) > -0.105 || fissure(x, y) < 0.035) continue;
      if (HUBS.some((h) => Math.hypot(h.x - x, h.y - y) < 0.105)) continue;
      HUBS.push({ x, y });
    }
    // the hub nearest the top of the brainstem receives the signal; the one in the front lobe is the speech area
    const near = (px, py) => HUBS.reduce((b, h) => (Math.hypot(h.x - px, h.y - py) < Math.hypot(b.x - px, b.y - py) ? h : b), HUBS[0]);
    const inHub = near(0.035, 0.03);
    BROCA = near(-0.22, -0.03);
    INPUT = { x: 0.075, y: 0.285 };
    // the trunk: brainstem up to the input hub
    {
      const pts = [];
      const n = 26;
      for (let i = 0; i <= n; i++) { const u = i / n; pts.push([mix(INPUT.x, inHub.x, u) + 0.006 * Math.sin(u * 6), mix(INPUT.y, inHub.y, u)]); }
      addPath(pts, 0, false);
    }
    // axon bundles between neighbouring hubs, gently curved
    for (const a of HUBS) {
      const sorted = HUBS.filter((b) => b !== a).sort((p, q) => Math.hypot(p.x - a.x, p.y - a.y) - Math.hypot(q.x - a.x, q.y - a.y));
      for (let k = 0; k < 2; k++) {
        const b = sorted[k];
        if (!b || (b._linked && b._linked.includes(a))) continue;
        (a._linked = a._linked || []).push(b);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const nx = -(b.y - a.y), ny = b.x - a.x, nl = Math.hypot(nx, ny) || 1;
        const off = (rnd() - 0.5) * 0.12;
        const cx = mx + nx / nl * off, cy = my + ny / nl * off;
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        const n = Math.max(6, Math.round(dist / 0.0105));
        const pts = [];
        for (let i = 0; i <= n; i++) { const u = i / n; pts.push([(1 - u) * (1 - u) * a.x + 2 * u * (1 - u) * cx + u * u * b.x, (1 - u) * (1 - u) * a.y + 2 * u * (1 - u) * cy + u * u * b.y]); }
        const p = addPath(pts, 0, rnd() < 0.5);
        if (p) p.birth = 0.2 + rnd() * 0.5;
      }
    }
    // dendrite trees from every hub
    for (const h of HUBS) {
      const n = 5 + Math.floor(rnd() * 3);
      const a0 = rnd() * TAU;
      for (let i = 0; i < n; i++) grow(h.x, h.y, a0 + (TAU * i) / n + (rnd() - 0.5) * 0.5, 0.17 + rnd() * 0.07, 1);
    }
    for (const h of HUBS) PTS.push({ x: h.x, y: h.y, path: -1, L: 0, dir: 0, d0: Math.hypot(h.x - INPUT.x, h.y - INPUT.y), tip: false, hub: true, broca: h === BROCA });

    // fireflies
    MOTES.length = 0;
    for (let i = 0; i < 46; i++) MOTES.push({ a: rnd() * TAU, r: 0.30 + rnd() * 0.42, y0: -0.40 + rnd() * 0.78, s: 0.02 + rnd() * 0.05, ph: rnd() * TAU, f: 0.8 + rnd() * 2.2, warm: rnd() });
  }

  function init(cw, ch, rows, aspect) {
    CW = cw; CH = ch;
    ROWS = rows - (rows % 2);
    COLS = Math.trunc(ROWS * ch * (aspect || 1.7) / cw);
    COLS = COLS - (COLS % 2);
    W = COLS * CW; H = ROWS * CH;
    XMAX = W / (2 * H);
    TEXT_ROW = Math.round(ROWS * 0.885);
    build();
  }

  // ---------- frame ----------

  const CORTEX = [0.78, 0.46, 0.58];     // organic: muted rose
  const NET = [0.22, 0.66, 1.00];        // the network: cool cyan
  const WARM = [1.00, 0.72, 0.34];       // the human part
  const WARM_WHITE = [1.00, 0.93, 0.78];

  function renderCells(t) {
    const cycle = Math.floor(t / CYCLE);
    const ct = t - cycle * CYCLE;
    const phrase = PHRASES[cycle % PHRASES.length];
    const L = LAYERS;

    const idx = new Int32Array(ROWS * COLS);
    const fg = new Float32Array(ROWS * COLS * 3);
    const bg = new Float32Array(ROWS * COLS * 3);
    const tag = new Uint8Array(ROWS * COLS);            // 1 = inside the brain
    const toC = (x) => Math.trunc((W / 2 + x * H) / CW), toR = (y) => Math.trunc((H / 2 + y * H) / CH);

    const breath = 0.5 + 0.5 * Math.sin(t * 1.5);       // slow breathing

    // arrival of the wave at a point, and the glow left behind
    const act = (d0) => {
      const arrive = T_WAVE + d0 / WAVE_SPEED;
      const dt = ct - arrive;
      if (dt < -0.12) return 0;
      return Math.exp(-Math.max(0, dt) / 1.5) * (dt < 0 ? ss(-0.12, 0, dt) : 1);
    };

    // ---- 1. network points: intensity grid, with tip activations spilling into the cortex ----
    const netInt = new Float32Array(ROWS * COLS);
    const netDir = new Uint8Array(ROWS * COLS);
    const netPulse = new Float32Array(ROWS * COLS);
    const cortexGlow = new Float32Array(ROWS * COLS);
    const nodeAct = new Float32Array(ROWS * COLS);
    const nodeKind = new Uint8Array(ROWS * COLS);         // 1 tip, 2 hub, 3 speech-area hub

    const grown = (path, Lp) => {
      const g = (ct - path.birth) * 0.16;                                 // growth in screen units
      if (ct < 0.0 || Lp > g) return false;
      if (ct > T_RETRACT) { const rt = (ct - T_RETRACT) * 0.18; if (Lp > path.len - rt) return false; }
      return true;
    };

    for (let i = 0; i < PTS.length; i++) {
      const p = PTS[i];
      const c = toC(p.x), r = toR(p.y);
      if (c < 0 || c >= COLS || r < 0 || r >= ROWS) continue;
      const cell = r * COLS + c;
      if (p.hub) {
        const a = act(p.d0);
        const g = Math.max(0.35 + 0.15 * breath, a);
        if (g > nodeAct[cell]) { nodeAct[cell] = g; nodeKind[cell] = p.broca ? 3 : 2; }
        continue;
      }
      const path = PATHS[p.path];
      if (!grown(path, p.L)) continue;
      const a = act(p.d0);
      let v = (0.30 - 0.05 * path.depth) + 1.0 * a;
      let pulse = a;
      if (path.amb && ct > 3.0) {                                         // spontaneous firing, like fireflies in the branches
        const head = ((t * 0.22 + path.ph) % 1.5) * path.len;
        const pa = 0.55 * Math.exp(-Math.pow((p.L - head) / 0.05, 2));
        v += pa; pulse = Math.max(pulse, pa);
      }
      if (v > netInt[cell]) { netInt[cell] = v; netDir[cell] = p.dir; netPulse[cell] = pulse; }
      if (p.tip) {
        if (a > nodeAct[cell]) { nodeAct[cell] = a; nodeKind[cell] = 1; }
        if (a > 0.05) {                                                   // the cortex flares where a thought arrives
          for (let dr = -3; dr <= 3; dr++) for (let dc = -4; dc <= 4; dc++) {
            const rr = r + dr, cc = c + dc;
            if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS) continue;
            cortexGlow[rr * COLS + cc] = Math.min(1.4, cortexGlow[rr * COLS + cc] + a * 0.35 * Math.exp(-(dr * dr * 0.5 + dc * dc * 0.18) * 0.5));
          }
        }
      }
    }

    // ---- 2. per cell: the brain shell and the latent space around it ----
    for (let r = 0; r < ROWS; r++) {
      const py = ((r + 0.5) * CH - H / 2) / H;
      for (let c = 0; c < COLS; c++) {
        const px = ((c + 0.5) * CW - W / 2) / H;
        const cell = r * COLS + c;
        const hs = h3(r, c, 7);
        const sd = brainSD(px, py);
        const inside = sd < 0;
        const depth = -sd;

        if (inside) {
          tag[cell] = 1;
          if (depth < 0.085 && L.cortex.on) {
            // the cortex: winding folds, contour lines of a warped noise field, with the lateral fissure cut through it
            const wx = px * 12 + 2.4 * fbm(px * 5 + 3, py * 5), wy = py * 12 + 2.4 * fbm(px * 5, py * 5 + 7);
            const n = fbm(wx * 0.9, wy * 0.9);
            const ridge = ss(0.45, 0.92, 0.5 + 0.5 * Math.cos(n * TAU * 2.6));        // 1 on the gyrus crowns, 0 in the sulci
            const fz = fissure(px, py);
            const groove = ss(0.026, 0.006, fz);
            const rim = ss(0.030, 0.0, depth);                                         // the outer surface catches more light
            const light = 0.78 + 0.22 * ss(0.10, -0.25, (px - py) * 0.5);             // lit a little from the upper left
            let lum = (0.30 + 0.55 * ridge + 0.30 * rim) * light * (1 - 0.85 * groove);
            lum *= 0.94 + 0.10 * breath;
            lum *= 1 + 1.7 * cortexGlow[cell];
            const gi = Math.trunc(clip(lum * 1.15, 0, 0.999) * CORTEX_FAM.length);
            if (groove < 0.9 || cortexGlow[cell] > 0.08) {
              idx[cell] = CIDX[CORTEX_FAM[Math.max(gi, 1)]];
              const k = clip(0.45 + 1.15 * lum, 0, 1);
              const gl = clip(cortexGlow[cell], 0, 1);
              fg[cell * 3] = clip(mix(CORTEX[0] * k, 1.0, gl * 0.7), 0, 1);
              fg[cell * 3 + 1] = clip(mix(CORTEX[1] * k, 0.78, gl * 0.7), 0, 1);
              fg[cell * 3 + 2] = clip(mix(CORTEX[2] * k, 0.9, gl * 0.7), 0, 1);
            }
          } else if (depth >= 0.085 && L.noise.on && hs < 0.05) {
            // white matter: a few dim bits, as if the folds hid a hum of data
            idx[cell] = CIDX[hs < 0.035 ? '0' : '1'];
            const k = 0.10 + 0.08 * breath;
            fg[cell * 3] = NET[0] * k; fg[cell * 3 + 1] = NET[1] * k; fg[cell * 3 + 2] = NET[2] * k;
          }
        } else if (L.noise.on) {
          // latent space outside the brain: random tokens that flicker, brightening toward the brain like an aura
          const aura = Math.exp(-sd / 0.06) * (0.55 + 0.45 * breath);
          const gap = ss(0.0, 0.035, sd);                                       // a clear halo right around the brain so its outline reads
          if (hs < (L.noise.density * 0.75 + 0.25 * aura) * gap) {
            const bucket = Math.floor(t * (0.5 + 1.8 * h3(r, c, 3)) + h3(r, c, 5) * 7);
            idx[cell] = CIDX[TOKENS[Math.floor(h3(r, c, 1000 + bucket) * TOKENS.length)]];
            const k = (0.055 + 0.11 * h3(r, c, 9)) + 0.55 * aura;
            fg[cell * 3] = (0.34 + 0.4 * aura) * k * 1.5; fg[cell * 3 + 1] = (0.46 + 0.3 * aura) * k * 1.5; fg[cell * 3 + 2] = (0.80 + 0.2 * aura) * k * 1.5;
          }
        }
      }
    }

    // ---- 3. the network over the white matter ----
    if (L.network.on) {
      for (let cell = 0; cell < ROWS * COLS; cell++) {
        const v = netInt[cell];
        if (v < 0.12 || !tag[cell]) continue;
        const pu = netPulse[cell];
        const heavy = pu > 0.30;
        idx[cell] = CIDX[heavy ? (pu > 0.7 ? '*' : ['-', '/', '|', '\\'][netDir[cell]]) : (v > 0.24 ? ['-', '/', '|', '\\'][netDir[cell]] : '.')];
        const k = clip(0.30 + 0.9 * v, 0, 1);
        const wh = clip((pu - 0.55) * 1.5, 0, 1);
        fg[cell * 3] = mix(NET[0] * k, 1, wh); fg[cell * 3 + 1] = mix(NET[1] * k, 1, wh); fg[cell * 3 + 2] = mix(NET[2] * k, 1, wh);
      }
    }
    // neurons: hubs and branch tips
    if (L.nodes.on) {
      for (let cell = 0; cell < ROWS * COLS; cell++) {
        const kind = nodeKind[cell];
        if (!kind) continue;
        const a = clip(nodeAct[cell], 0, 1.2);
        const col = kind === 3 ? WARM : NET;
        const big = kind >= 2;
        idx[cell] = CIDX[big ? (a > 0.8 ? '@' : (a > 0.5 ? 'O' : '0')) : (a > 0.55 ? 'O' : (a > 0.2 ? 'o' : '.'))];
        const k = clip(0.40 + 0.9 * a, 0, 1);
        const wh = clip((a - 0.75) * 2.2, 0, 1);
        fg[cell * 3] = mix(col[0] * k, 1, wh); fg[cell * 3 + 1] = mix(col[1] * k, 1, wh); fg[cell * 3 + 2] = mix(col[2] * k, 1, wh);
        const bgk = a * 0.30 * L.nodes.bg * (big ? 1 : 0.5);
        bg[cell * 3] = col[0] * bgk; bg[cell * 3 + 1] = col[1] * bgk; bg[cell * 3 + 2] = col[2] * bgk;
        if (big) {                                                      // a hub spills a little onto its neighbours
          const rr = Math.floor(cell / COLS), cc = cell % COLS;
          for (const [dr, dc, ch] of [[0, 1, 'o'], [0, -1, 'o'], [1, 0, 'o'], [-1, 0, 'o']]) {
            const r2 = rr + dr, c2 = cc + dc;
            if (r2 < 0 || r2 >= ROWS || c2 < 0 || c2 >= COLS || nodeKind[r2 * COLS + c2]) continue;
            const p2 = r2 * COLS + c2;
            idx[p2] = CIDX[a > 0.5 ? ch : '.'];
            fg[p2 * 3] = col[0] * k * 0.7; fg[p2 * 3 + 1] = col[1] * k * 0.7; fg[p2 * 3 + 2] = col[2] * k * 0.7;
          }
        }
      }
    }

    // ---- 4. fireflies drifting around the brain ----
    if (L.motes.on) {
      for (const m of MOTES) {
        const a = m.a + t * m.s;
        const x = BCX + Math.cos(a) * m.r * XMAX * 1.15 + 0.03 * Math.sin(t * 0.7 + m.ph);
        const y = m.y0 - ((t * 0.012 * (1 + m.warm)) % 0.9) + 0.45 + 0.04 * Math.sin(t * 0.9 + m.ph * 2);
        const yy = ((y + 0.5) % 1.0 + 1.0) % 1.0 - 0.5;
        const c = toC(x), r = toR(yy);
        if (c < 0 || c >= COLS || r < 0 || r >= ROWS) continue;
        const cell = r * COLS + c;
        if (brainSD(x, yy) < 0.02 || r >= TEXT_ROW - 2) continue;
        const blink = Math.pow(0.5 + 0.5 * Math.sin(t * m.f + m.ph), 3);
        if (blink < 0.12) continue;
        idx[cell] = CIDX[blink > 0.7 ? '*' : (blink > 0.4 ? '+' : '.')];
        const col = m.warm > 0.5 ? WARM : [0.62, 0.95, 0.55];            // amber and soft green
        fg[cell * 3] = col[0] * blink; fg[cell * 3 + 1] = col[1] * blink; fg[cell * 3 + 2] = col[2] * blink;
      }
    }

    // ---- 5. thread: from the speech area down to the sentence ----
    if (L.thread.on && BROCA) {
      const tArr = T_WAVE + Math.hypot(BROCA.x - INPUT.x, BROCA.y - INPUT.y) / WAVE_SPEED;
      const tt = ct - tArr;
      if (tt > 0 && ct < T_DISSOLVE) {
        const x0 = BROCA.x, y0 = BROCA.y;
        const x1 = 0, y1 = ((TEXT_ROW - 1.2) * CH + CH / 2 - H / 2) / H;
        const steps = 90;
        const head = clip(tt / 1.3, 0, 1);
        for (let s = 0; s <= steps; s++) {
          const u = s / steps;
          if (u > head) break;
          const e = u * u * (3 - 2 * u);
          const x = mix(x0, x1, e) - 0.05 * Math.sin(u * PI), y = mix(y0, y1, u);
          const c = toC(x), r = toR(y);
          if (c < 0 || c >= COLS || r < 0 || r >= ROWS) continue;
          const p = r * COLS + c;
          const fade = (1 - ss(T_TEXT + 0.6, T_TEXT + 2.8, ct)) * 0.9 + 0.1;
          const k = (0.30 + 0.70 * Math.exp(-Math.pow((u - head) / 0.12, 2))) * fade;
          idx[p] = CIDX[(s % 3 === 0) ? ':' : '.'];
          fg[p * 3] = WARM[0] * k; fg[p * 3 + 1] = WARM[1] * k; fg[p * 3 + 2] = WARM[2] * k;
        }
      }
    }

    // ---- 6. the sentence ----
    const len = phrase.length;
    const SPACING = 2;
    const c0 = Math.floor((COLS - (len - 1) * SPACING) / 2);
    const words = [];
    {
      let s0 = -1;
      for (let i = 0; i <= len; i++) {
        if (i < len && phrase[i] !== ' ') { if (s0 < 0) s0 = i; }
        else if (s0 >= 0) { words.push([s0, i - 1]); s0 = -1; }
      }
    }
    const resolveAt = (i) => T_TEXT + i * 0.075 + 0.25 * h3(cycle, i, 21);
    const dissolveAt = (i) => T_DISSOLVE + 0.9 * h3(cycle, i, 31);
    if (L.text.on) {
      for (let i = 0; i < len; i++) {
        if (phrase[i] === ' ') continue;
        const c = c0 + i * SPACING;
        if (c < 0 || c >= COLS) continue;
        const p = TEXT_ROW * COLS + c;
        const tr = resolveAt(i), td = dissolveAt(i);
        if (ct < tr - 0.55 || ct > td + 0.7) continue;
        if (ct < tr) {
          const k = ss(tr - 0.55, tr, ct);
          idx[p] = CIDX[TOKENS[Math.floor(h3(cycle * 100 + i, Math.floor(t * 18), 3) * TOKENS.length)]];
          fg[p * 3] = NET[0] * (0.25 + 0.6 * k); fg[p * 3 + 1] = NET[1] * (0.25 + 0.6 * k); fg[p * 3 + 2] = NET[2] * (0.25 + 0.6 * k);
        } else if (ct < td) {
          const flash = Math.exp(-(ct - tr) / 0.28);
          idx[p] = CIDX[phrase[i]];
          const k = 0.78 + 0.22 * Math.sin(t * 2 + i);
          fg[p * 3] = mix(WARM[0] * k, 1, flash); fg[p * 3 + 1] = mix(WARM[1] * k, 1, flash); fg[p * 3 + 2] = mix(WARM[2] * k, WARM_WHITE[2], flash);
        } else {
          const k = 1 - ss(td, td + 0.7, ct);
          idx[p] = CIDX[TOKENS[Math.floor(h3(cycle * 100 + i, Math.floor(t * 14), 5) * TOKENS.length)]];
          fg[p * 3] = WARM[0] * 0.6 * k; fg[p * 3 + 1] = WARM[1] * 0.6 * k; fg[p * 3 + 2] = WARM[2] * 0.6 * k;
        }
      }
    }

    // ---- 7. attention arcs between words ----
    if (L.arcs.on && words.length > 1) {
      for (let j = 1; j < words.length; j++) {
        const jp = Math.max(0, j - 1 - Math.floor(h3(cycle, j, 41) * 3));
        const wa = words[jp], wb = words[j];
        const tArc = Math.max(resolveAt(wa[1]), resolveAt(wb[1])) + 0.3;
        if (ct < tArc || ct > T_DISSOLVE + 0.2) continue;
        const xa = c0 + ((wa[0] + wa[1]) / 2) * SPACING, xb = c0 + ((wb[0] + wb[1]) / 2) * SPACING;
        const span = Math.abs(xb - xa);
        const apex = Math.min(ROWS * 0.12, 1.5 + span * 0.18);
        const appear = ss(tArc, tArc + 0.8, ct);
        const steps = Math.max(8, Math.floor(span * 1.4));
        const ph = (t * 0.45 + j * 0.23) % 1;
        for (let s = 0; s <= steps; s++) {
          const u = s / steps;
          const c = Math.round(mix(xa, xb, u));
          const r = Math.round(TEXT_ROW - 1.5 - apex * 4 * u * (1 - u));
          if (r < 0 || r >= ROWS || c < 0 || c >= COLS) continue;
          const p = r * COLS + c;
          if (idx[p] !== 0 && r >= TEXT_ROW - 1) continue;
          const pk = Math.exp(-Math.pow((u - ph) / 0.10, 2));
          const k = appear * (0.18 + 0.75 * pk);
          idx[p] = CIDX[pk > 0.5 ? '*' : (u < 0.15 || u > 0.85 ? '.' : "'")];
          fg[p * 3] = WARM[0] * k; fg[p * 3 + 1] = WARM[1] * k; fg[p * 3 + 2] = WARM[2] * k;
        }
      }
    }

    const q = new Int16Array(ROWS * COLS * 3);
    const bq = new Int16Array(ROWS * COLS * 3);
    for (let i = 0; i < q.length; i++) {
      q[i] = clip(Math.trunc(clip(fg[i], 0, 1) * (QL - 0.01)), 0, QL - 1);
      bq[i] = clip(Math.trunc(clip(bg[i], 0, 1) * (QL - 1) + 0.5 * h3(i, 1, 2)), 0, QL - 1);
    }
    return { idx, q, bq };
  }

  const api = {
    init, renderCells, layers: LAYERS, RAMP, QL, FPS, MAXROWS, CYCLE,
    dims: () => ({ CW, CH, ROWS, COLS, W, H }),
    stats: () => ({ paths: PATHS.length, points: PTS.length, hubs: HUBS.length }),
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
