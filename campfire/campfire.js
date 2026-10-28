// An ASCII campfire at night, built from overlaid layers (same approach as ../candle/candle.js).
//
// A per-pixel shader fills an image and records which layer owns each pixel; bloom + tone mapping; then a cell compositor
// gives every character cell a background colour and a character chosen by the layer that owns it.
//
// Layers, back to front: glow (character-only halo in the air), ground (dirt lit by the fire), smoke, stones (the ring),
// coals (the glowing bed), logs (with glowing cracks), flame (several tongues, emissive), sparks (stamped particles).
const Campfire = (function () {
  'use strict';

  const { MT } = (typeof module !== 'undefined' && module.exports) ? require('./rng.js') : window.RNG;
  const f32 = Math.fround;
  const PI = Math.PI;

  const FPS = 30;
  const MAXROWS = 130;
  const QL = 48;

  // geometry, in screen-height units (x right, y down, 0 = screen centre)
  const GY = 0.31;            // y where the logs meet the ground
  const FIRE_Y = 0.262;       // y where the flames start
  const HF = 0.46;            // tallest flame tongue
  const BASE_W = 0.12;        // half-width of the fire's base

  const RAMP = ' .\'`^",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$';
  const CIDX = {};
  for (let i = 0; i < RAMP.length; i++) CIDX[RAMP[i]] = i;

  const rng = new MT().initGenrand(23);
  const prnd = new MT().initByArray([88]);

  // Layers: bg = strength of the background colour field, chars = draw characters, density = fraction of cells with a character
  const LAYERS = {
    glow:   { on: true, bg: 0.00, chars: true, density: 0.95 },   // character-led halo: muted amber characters that thin out to black
    ground: { on: true, bg: 0.16, chars: true, density: 0.80 },
    smoke:  { on: true, bg: 0.00, chars: true, density: 0.60 },
    stones: { on: true, bg: 0.55, chars: true, density: 0.55 },
    coals:  { on: true, bg: 0.65, chars: true, density: 0.90 },
    logs:   { on: true, bg: 0.55, chars: true, density: 0.90 },
    flame:  { on: true, bg: 0.70, chars: true, density: 0.95 },
    sparks: { on: true },
    stars:  { on: true },
  };
  const GLOW_FAM = "`.',:;+*";
  const GROUND_FAM = "\"'|/\\,;!l";    // grass blades
  const STONE_FAM = "oO0Q#";
  const BARK_FAM = "=|%#/\\";
  const COAL_FAM = "*+%@#";
  const SMOKE_FAM = ".:'`;";
  const FLAME_FAM = ".:'^~*+(){}%&8#@";

  // ---------- helpers ----------

  function clip(x, a, b) { return x < a ? a : (x > b ? b : x); }
  function ss(a, b, x) { const t = clip((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function ease(t) { t = Math.min(Math.max(t, 0), 1); return t * t * (3 - 2 * t); }
  function mix(a, b, k) { return a + (b - a) * k; }
  function mod(x, n) { return ((x % n) + n) % n; }

  function randArr(n) {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = rng.random();
    return a;
  }

  function up2(b, g, n) {
    const i0 = new Int32Array(n), i1 = new Int32Array(n);
    const f = new Float32Array(n), omf = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const idx = (k * g) / n;
      i0[k] = Math.trunc(idx) % g;
      i1[k] = (i0[k] + 1) % g;
      const fr = idx - Math.floor(idx);
      f[k] = fr * fr * (3 - 2 * fr);
      omf[k] = f32(1 - f[k]);
    }
    const t = new Float32Array(g * n);
    for (let row = 0; row < g; row++) {
      for (let col = 0; col < n; col++) {
        t[row * n + col] = f32(b[row * g + i0[col]] * omf[col]) + f32(b[row * g + i1[col]] * f[col]);
      }
    }
    const out = new Float32Array(n * n);
    for (let y = 0; y < n; y++) {
      const r0 = i0[y] * n, r1 = i1[y] * n, a = omf[y], c = f[y];
      for (let x = 0; x < n; x++) out[y * n + x] = f32(t[r0 + x] * a) + f32(t[r1 + x] * c);
    }
    return out;
  }

  function norm(a, k) {
    const n = a.length;
    let s = 0;
    for (let i = 0; i < n; i++) s += a[i];
    const mean = s / n;
    let v = 0;
    for (let i = 0; i < n; i++) { const d = a[i] - mean; v += d * d; }
    const den = Math.sqrt(v / n) * k + 1e-9;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = clip(0.5 + (a[i] - mean) / den, 0, 1);
    return out;
  }

  function tex2d(n, grids) {
    const out = new Float32Array(n * n);
    let amp = 1.0;
    for (const g of grids) {
      const up = up2(randArr(g * g), g, n);
      const a = f32(amp);
      for (let i = 0; i < out.length; i++) out[i] = out[i] + f32(a * up[i]);
      amp *= 0.55;
    }
    return norm(out, 4.0);
  }

  function bil(tex, n, u, v) {
    const u0 = Math.floor(u), v0 = Math.floor(v);
    const fu = u - u0, fv = v - v0;
    const i0 = mod(u0, n), j0 = mod(v0, n);
    const i1 = (i0 + 1) % n, j1 = (j0 + 1) % n;
    return ((tex[j0 * n + i0] * (1 - fu) + tex[j0 * n + i1] * fu) * (1 - fv)
      + (tex[j1 * n + i0] * (1 - fu) + tex[j1 * n + i1] * fu) * fv);
  }

  const TN = tex2d(256, [4, 12, 40, 100]);
  function n1(t, off) { return (bil(TN, 256, t + off * 13.7, 40.5) - 0.5) * 3.2; }

  // ---------- geometry ----------

  let CW, CH, ROWS, COLS, W, H, GW, GH, SS = 1;
  let X, Y, HSC;

  const LOGS = [   // back to front: x0, y0, x1, y1, radius. A teepee of logs, plus logs lying around the base and kindling.
    { x0: -0.135, y0: 0.268, x1: 0.135, y1: 0.264, r: 0.027 },
    { x0: -0.165, y0: 0.305, x1: 0.060, y1: 0.214, r: 0.030 },
    { x0: 0.165, y0: 0.305, x1: -0.060, y1: 0.214, r: 0.030 },
    { x0: -0.230, y0: 0.324, x1: 0.145, y1: 0.236, r: 0.036 },
    { x0: 0.230, y0: 0.324, x1: -0.145, y1: 0.236, r: 0.036 },
    { x0: -0.085, y0: 0.302, x1: 0.020, y1: 0.228, r: 0.013 },
    { x0: 0.090, y0: 0.302, x1: 0.000, y1: 0.232, r: 0.013 },
    { x0: -0.285, y0: 0.346, x1: -0.095, y1: 0.318, r: 0.025 },
    { x0: 0.285, y0: 0.347, x1: 0.100, y1: 0.320, r: 0.025 },
    { x0: -0.195, y0: 0.336, x1: 0.195, y1: 0.338, r: 0.034 },
    { x0: -0.125, y0: 0.356, x1: 0.170, y1: 0.353, r: 0.026 },
  ];
  const STONES = [];

  function init(cw, ch, rows, aspect) {
    CW = cw; CH = ch;
    ROWS = rows - (rows % 8);
    SS = ROWS > 64 ? 1 : 2;
    COLS = Math.trunc(ROWS * ch * (aspect || 1.0) / cw);
    COLS = COLS - (COLS % 8);
    W = COLS * CW; H = ROWS * CH;
    GW = COLS * SS; GH = ROWS * SS;
    X = new Float32Array(GW * GH);
    Y = new Float32Array(GW * GH);
    for (let j = 0; j < GH; j++) {
      const yv = f32(((j + 0.5) * (CH / SS) - H / 2) / H);
      for (let i = 0; i < GW; i++) {
        X[j * GW + i] = f32(((i + 0.5) * (CW / SS) - W / 2) / H);
        Y[j * GW + i] = yv;
      }
    }
    buildStars();
    HSC = new Float32Array(ROWS * COLS);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const hh = (BigInt(r) * 73856093n) ^ (BigInt(c) * 19349663n) ^ 0x5bd1e995n;
        HSC[r * COLS + c] = Number(hh % 1009n) / 1009.0;
      }
    }
    // a ring of stones around the fire, seen at a shallow angle (an ellipse on the ground)
    STONES.length = 0;
    const sr = new MT().initByArray([9]);
    const N = 13;
    for (let i = 0; i < N; i++) {
      const a = TAU_ * (i + 0.5) / N + sr.uniform(-0.12, 0.12);
      const front = Math.sin(a) > 0;
      STONES.push({ x: 0.35 * Math.cos(a), y: 0.340 + 0.066 * Math.sin(a), rx: sr.uniform(0.032, 0.046), ry: sr.uniform(0.022, 0.032), tone: sr.uniform(0.8, 1.15), front, a });
    }
    STONES.sort((p, q) => p.y - q.y);
  }
  const TAU_ = 2 * PI;

  // twinkling stars that drift slowly sideways, as in the Toronto scene
  const ST = { n: 0, x: null, y: null, b: null, ph: null, f: null, col: null, xmax: 1 };
  function buildStars() {
    ST.n = 90;
    ST.xmax = W / (2 * H);
    ST.x = new Float32Array(ST.n); ST.y = new Float32Array(ST.n);
    ST.b = new Float32Array(ST.n); ST.ph = new Float32Array(ST.n);
    ST.f = new Float32Array(ST.n); ST.col = new Float32Array(ST.n * 3);
    const sr = new MT().initByArray([61]);
    for (let i = 0; i < ST.n; i++) {
      ST.x[i] = sr.uniform(-ST.xmax, ST.xmax);
      ST.y[i] = sr.uniform(-0.5, GY - 0.10);
      ST.b[i] = 0.10 + 0.90 * Math.pow(sr.random(), 3.2);
      ST.ph[i] = sr.uniform(0, 6.28);
      ST.f[i] = sr.uniform(1.0, 3.5);
      const tm = Math.pow(sr.random(), 1.5);
      ST.col[i * 3] = mix(0.70, 1.0, tm); ST.col[i * 3 + 1] = mix(0.82, 0.80, tm); ST.col[i * 3 + 2] = mix(1.0, 0.55, tm);
    }
  }

  function stampStars(idx, fg, own, lumCell, t) {
    for (let i = 0; i < ST.n; i++) {
      const sx = mod(ST.x[i] + 0.004 * t + ST.xmax, 2 * ST.xmax) - ST.xmax;
      const sy = ST.y[i];
      const c = Math.trunc((W * 0.5 + sx * H) / CW), r = Math.trunc((H * 0.5 + sy * H) / CH);
      if (c < 0 || c >= COLS || r < 0 || r >= ROWS) continue;
      const cell = r * COLS + c;
      const o = own[cell];
      if (o !== OWN.none && o !== OWN.glow) continue;                         // only open sky: not on smoke, flames, logs or ground
      const b = ST.b[i] * (0.80 + 0.20 * Math.sin(t * ST.f[i] + ST.ph[i])) * 0.9;
      if (!(b > lumCell[cell] * 1.5 + 0.03)) continue;                         // the fire's halo drowns out the stars near it
      idx[cell] = CIDX[b < 0.18 ? '.' : (b < 0.40 ? '+' : '*')];
      const k = clip(0.35 + 0.9 * b, 0, 1);
      fg[cell * 3] = ST.col[i * 3] * k; fg[cell * 3 + 1] = ST.col[i * 3 + 1] * k; fg[cell * 3 + 2] = ST.col[i * 3 + 2] * k;
      if (b > 0.55) {                                                          // the brightest ones get short rays
        idx[cell] = CIDX[b > 0.85 ? '@' : '*'];
        for (const [dr, dc, ch] of [[0, 1, '-'], [0, -1, '-'], [1, 0, '|'], [-1, 0, '|']]) {
          const r2 = r + dr, c2 = c + dc;
          if (r2 < 0 || r2 >= ROWS || c2 < 0 || c2 >= COLS) continue;
          const p2 = r2 * COLS + c2;
          if ((own[p2] !== OWN.none && own[p2] !== OWN.glow) || lumCell[p2] > 0.15) continue;
          idx[p2] = CIDX[b > 0.7 ? ch : '.'];
          fg[p2 * 3] = ST.col[i * 3] * 0.55; fg[p2 * 3 + 1] = ST.col[i * 3 + 1] * 0.55; fg[p2 * 3 + 2] = ST.col[i * 3 + 2] * 0.55;
        }
      }
    }
  }

  // ---------- wind: gusts of random direction, length and strength ----------

  const wrnd = new MT().initByArray([404]);
  const GUSTS = [];
  let gustEnd = 0;
  function extendGusts(upto) {
    while (gustEnd < upto) {
      const t0 = gustEnd + wrnd.uniform(2.5, 7.0);
      const dur = wrnd.uniform(1.2, 3.0);
      GUSTS.push([t0, dur, (wrnd.random() < 0.5 ? -1 : 1) * wrnd.uniform(0.4, 1.0)]);
      gustEnd = t0 + dur;
    }
  }
  function windAt(t) {
    extendGusts(t + 12);
    let w = 0;
    for (const g of GUSTS) {
      const x = (t - g[0]) / g[1];
      if (x > 0 && x < 1) w += g[2] * Math.pow(Math.sin(PI * x), 2);
    }
    return clip(w + 0.10 * n1(t * 0.7, 11), -1.2, 1.2);
  }

  // ---------- state ----------

  const S = { last: 0, wx: 0, wv: 0 };
  const sparks = [];

  // ---------- flame colour ramp (dark red -> orange -> yellow -> pale yellow) ----------

  const STOPS = [
    [0.00, 0.14, 0.012, 0.000],
    [0.18, 0.62, 0.090, 0.010],
    [0.40, 1.00, 0.340, 0.030],
    [0.62, 1.00, 0.620, 0.100],
    [0.82, 1.00, 0.860, 0.320],
    [1.00, 1.00, 0.960, 0.700],
  ];
  let cr = 0, cg = 0, cb = 0;
  function flameRGB(T) {
    T = clip(T, 0, 1);
    let i = 0;
    while (i < STOPS.length - 2 && T > STOPS[i + 1][0]) i++;
    const a = STOPS[i], b = STOPS[i + 1];
    const k = (T - a[0]) / (b[0] - a[0]);
    cr = mix(a[1], b[1], k); cg = mix(a[2], b[2], k); cb = mix(a[3], b[3], k);
  }

  // ---------- per-frame parameters ----------

  const TONGUES = [   // base x, height scale, width scale, flicker speed, phase. Five medium-wide tongues.
    { bx: -0.135, h: 0.56, w: 0.85, sp: 1.8, ph: 1 },
    { bx: -0.068, h: 0.84, w: 0.95, sp: 1.4, ph: 2 },
    { bx: 0.000, h: 1.00, w: 1.00, sp: 1.2, ph: 3 },
    { bx: 0.070, h: 0.80, w: 0.92, sp: 1.6, ph: 4 },
    { bx: 0.138, h: 0.54, w: 0.82, sp: 2.0, ph: 5 },
  ];
  const P = { wind: 0, windA: 0, light: 1, gx: 0, gy: 0, tipX: 0, tipY: 0, hs: [], lean: [], crack: 0, t: 0, smokeK: 0.20 };

  function frameParams(t) {
    P.t = t;
    P.wind = S.wx; P.windA = Math.min(1, Math.abs(S.wx));
    const crack = Math.max(0, n1(t * 6.0, 17) - 0.95) * 1.6;                 // an occasional crackle: a brief flash
    P.crack = crack;
    P.light = 0.80 * (0.96 + 0.14 * n1(t * 3.2, 5) + 0.05 * n1(t * 9, 6) + 0.30 * crack) * (1 - 0.06 * P.windA);
    for (let i = 0; i < TONGUES.length; i++) {
      const q = TONGUES[i];
      P.hs[i] = HF * q.h * (1 + 0.20 * n1(t * q.sp, q.ph) + 0.06 * n1(t * q.sp * 3.1, q.ph + 9)) * (1 - 0.12 * P.windA);
      P.lean[i] = 0.030 * n1(t * q.sp * 0.6, q.ph + 20) + 0.085 * P.wind;
    }
    P.gx = 0.02 * P.wind;
    P.gy = FIRE_Y - 0.17;
    P.tipX = P.lean[2] * 1.2;
    P.tipY = FIRE_Y - P.hs[2];
  }

  // ---------- the per-pixel shader ----------

  const OWN = { none: 0, glow: 1, ground: 2, smoke: 3, stones: 4, coals: 5, logs: 6, flame: 7 };
  let sR = 0, sG = 0, sB = 0, sO = 0, sT = 0;

  function shade(x, y, t) {
    let r = 0, g = 0, b = 0, own = 0, heat = 0;
    const L = P.light;

    // glow: light in the air around the fire
    {
      const dx = x - P.gx, dy = y - P.gy;
      const g0 = 0.060 * L / (1 + (dx * dx + dy * dy) / 0.040);
      r += g0 * 1.00; g += g0 * 0.50; b += g0 * 0.15;
      if (g0 > 0.003) own = OWN.glow;
    }

    // ground: grass, tufted in vertical blades, lit orange by the fire and dark green further away
    if (y > GY - 0.075) {
      const gdx = x / 0.46, gdy = (y - 0.34) / 0.17;
      const lit = L * 0.55 / (1 + (gdx * gdx + gdy * gdy) * 2.0);
      const blade = bil(TN, 256, x * 85 + 5, y * 7 + 3);                      // narrow vertical streaks = blades
      const tuft = bil(TN, 256, x * 9 + 40, y * 14);                          // clumps
      const gr = (0.35 + 0.95 * blade) * (0.55 + 0.9 * tuft);
      const gk = 0.026 * gr;                                                  // dark green in the shade
      r = gk * 0.55 + lit * gr * 0.80; g = gk * 0.90 + lit * gr * 0.52; b = gk * 0.40 + lit * gr * 0.14;   // muted olive in the shade   // warm light on green grass
      own = OWN.ground;
      if (y < GY - 0.005) { const fade = ss(GY - 0.075, GY - 0.005, y); r *= fade; g *= fade; b *= fade; if (fade < 0.3) own = OWN.glow; }
    }

    // smoke: soft grey plume above the flames, drifting with the wind
    {
      const h = P.tipY - y;
      if (h > -0.05 && y > -0.52) {
        const hh = Math.max(h, 0);
        const sx = P.tipX + 0.11 * P.wind * Math.min(1, hh * 2.2) + 0.05 * Math.sin(hh * 8 - t * 1.0 + 0.7) * Math.min(1, hh * 3)
          + 0.04 * (bil(TN, 256, hh * 3 + 20, t * 0.4) - 0.5) * hh * 5;
        const sw = 0.055 + 0.20 * hh;
        const dens = bil(TN, 256, x * 8 + 3, y * 5 + t * 0.7);
        const warm = Math.exp(-hh / 0.22);                                   // the base of the plume is lit orange by the fire
        const sm = P.smokeK * Math.exp(-hh / 0.50) * Math.exp(-Math.pow((x - sx) / sw, 2)) * (0.25 + 1.2 * dens) * ss(-0.04, 0.05, h);
        if (sm > 0.003) {
          r += sm * (0.38 + 0.9 * warm); g += sm * (0.36 + 0.42 * warm); b += sm * (0.38 + 0.12 * warm);
          if (sm > 0.03 && (own === OWN.none || own === OWN.glow)) own = OWN.smoke;
        }
      }
    }

    // stones: a ring around the fire, dark grey, warm on the sides that face the flames
    for (let i = 0; i < STONES.length; i++) {
      const st = STONES[i];
      const dx = (x - st.x) / st.rx, dy = (y - st.y) / st.ry;
      const e = dx * dx + dy * dy;
      if (e < 1) {
        const nz = Math.sqrt(1 - e);
        const toFx = -st.x, toFy = 0.30 - st.y;                              // direction toward the fire
        const tl = Math.hypot(toFx, toFy) || 1;
        const face = clip(((x - st.x) * toFx + (y - st.y) * toFy) / (tl * Math.hypot(x - st.x, y - st.y) + 1e-6), -1, 1);
        const fire = L * (0.20 + 0.80 * ss(-0.2, 0.9, face)) * (0.4 + 0.6 * nz);
        const tx = 0.85 + 0.30 * bil(TN, 256, x * 40 + i * 7, y * 40);
        const base = 0.050 * st.tone * tx;
        r = base + 0.80 * fire * 0.55 * st.tone; g = base * 0.98 + 0.46 * fire * 0.55 * st.tone; b = base * 0.95 + 0.18 * fire * 0.55 * st.tone;
        own = OWN.stones;
      }
    }

    // coal bed: glowing embers under the logs
    {
      const cx = x / 0.215, cy = (y - 0.322) / 0.036;
      const ce = cx * cx + cy * cy;
      if (ce < 1) {
        const nz = bil(TN, 256, x * 30 + 5, y * 60 - t * 0.35);
        const nz2 = bil(TN, 256, x * 70 + 40, y * 120 + t * 0.2);
        const heat0 = clip(0.30 + 1.05 * nz + 0.35 * nz2 - ce * 0.55, 0, 1.3) * L;
        flameRGB(clip(heat0 * 0.78, 0, 1));
        const k = 0.50 + 0.9 * heat0;
        r = cr * k; g = cg * k; b = cb * k;
        own = OWN.coals; heat = Math.max(heat, clip(heat0 * 0.6, 0, 1));
      }
    }

    // logs
    for (let i = 0; i < LOGS.length; i++) {
      const lg = LOGS[i];
      const ax = lg.x1 - lg.x0, ay = lg.y1 - lg.y0;
      const len2 = ax * ax + ay * ay;
      const px = x - lg.x0, py = y - lg.y0;
      const tt = clip((px * ax + py * ay) / len2, 0, 1);
      const qx = px - tt * ax, qy = py - tt * ay;
      const dist = Math.sqrt(qx * qx + qy * qy);
      if (dist < lg.r) {
        const len = Math.sqrt(len2);
        const across = (qx * (-ay) + qy * ax) / (len * lg.r);               // -1..1 across the log
        const nz = Math.sqrt(Math.max(0, 1 - across * across));
        const along = tt * len;
        const bark = bil(TN, 256, along * 45 + i * 11, across * 7 + 4);
        const grain = bil(TN, 256, along * 12 + i * 5, across * 3 + 17);
        // light from the fire: strongest toward the middle of the fire and on the top of each log
        const mx = (lg.x0 + lg.x1) * 0.5, my = (lg.y0 + lg.y1) * 0.5;
        const att = 1 / (1 + ((x * x) / 0.060 + ((y - 0.25) * (y - 0.25)) / 0.020));
        const topK = 0.55 + 0.45 * clip(-across * (ax >= 0 ? 1 : -1) * 0.0 + (0.5 - (qy / lg.r) * 0.5), 0, 1);
        const lit = (0.16 + 1.45 * att * L * topK) * (0.55 + 0.45 * nz) * (0.7 + 0.6 * bark);
        let rr = 0.46 * lit * (0.8 + 0.4 * grain), gg = 0.27 * lit * (0.8 + 0.4 * grain), bb = 0.13 * lit;
        // glowing cracks and charring: embers show through where the bark has burned away, strongest in the middle of the log
        const hot = ss(0.30, 0.95, 1 - Math.abs(tt - 0.5) * 2) * (0.5 + 0.5 * att);
        const crack = ss(0.58, 0.82, bark) * hot * (0.55 + 0.7 * L);
        flameRGB(clip(0.30 + 0.55 * crack, 0, 0.9));
        rr = mix(rr, cr * (0.9 + 0.6 * crack), clip(crack * 1.2, 0, 1)); gg = mix(gg, cg * (0.9 + 0.6 * crack), clip(crack * 1.2, 0, 1)); bb = mix(bb, cb * (0.9 + 0.6 * crack), clip(crack * 1.2, 0, 1));
        const endChar = ss(0.0, 0.12, tt) * ss(1.0, 0.88, tt);              // ends are charred black
        rr *= 0.35 + 0.65 * endChar; gg *= 0.35 + 0.65 * endChar; bb *= 0.35 + 0.65 * endChar;
        // rim light along the lit edge
        const rim = Math.pow(1 - nz, 2) * 0.25 * att * L;
        r = rr + rim * 0.9; g = gg + rim * 0.5; b = bb + rim * 0.2;
        own = OWN.logs; heat = Math.max(heat, crack * 0.7);
        void mx; void my;
      }
    }

    // flame: several tongues, each a teardrop with a wavering centre line and turbulent edges
    {
      let T = 0, A = 0;
      for (let i = 0; i < TONGUES.length; i++) {
        const q = TONGUES[i];
        const hgt = P.hs[i];
        const yn = (FIRE_Y - y) / hgt;
        if (yn < -0.08 || yn > 1.08) continue;
        const yp = clip(yn, 0, 1);
        const cx = q.bx + P.lean[i] * yp * yp * 3.2
          + 0.012 * Math.sin(yp * 5.5 + t * (6 + i) + q.ph) * yp
          + 0.050 * (bil(TN, 256, yp * 1.7 + q.ph * 3, t * 1.8 * (0.8 + 0.1 * i)) - 0.5) * yp;
        let w = 0.072 * q.w * Math.pow(Math.sin(PI * Math.pow(yp, 0.55)), 0.9) * (1 - 0.25 * yp);
        if (yp < 0.30) w = Math.max(w, 0.024 * q.w * (1 - yp / 0.30));
        if (Math.abs(x - cx) > w * 1.8 + 0.02) continue;
        const en = bil(TN, 256, x * 24 + q.ph * 5, y * 24 - t * 4.2) - 0.5;
        const dn = Math.abs(x - cx) / (w + 1e-4) + en * (0.26 + 0.80 * yp) * (1 + 0.6 * P.windA);
        let d = ss(1.05, 0.22, dn) * ss(1.08, 0.84, yn) * ss(-0.08, 0.0, yn);
        if (d <= 0.01) continue;
        const core = Math.exp(-Math.pow((x - cx) / (w * 0.40 + 1e-4), 2)) * Math.pow(1 - yp, 0.6);
        let Ti = Math.pow(d, 1.15) * (1 - 0.60 * Math.pow(yp, 1.05));
        Ti = clip(Ti * 0.78 + 0.22 * core * d, 0, 1);
        if (Ti > T) T = Ti;
        if (d > A) A = d;
      }
      if (A > 0.01) {
        // the base of the fire is hottest where the tongues overlap
        const base = ss(0.10, 0.0, Math.abs(y - FIRE_Y + 0.03)) * ss(BASE_W * 1.5, 0.0, Math.abs(x));
        T = clip(T + 0.12 * base, 0, 1);
        flameRGB(T);
        const alpha = A * (0.35 + 0.65 * ss(0.0, 0.35, T));
        const gain = 0.50 + 0.58 * T;
        // the front of the logs and stones hide the bottom of the flame
        const solid = (own === OWN.logs || own === OWN.coals || own === OWN.stones);
        const vis = solid ? ss(FIRE_Y - 0.01, FIRE_Y + 0.025, y) : 0;
        const al = alpha * (1 - vis);
        r = r * (1 - 0.6 * al) + cr * gain * al;
        g = g * (1 - 0.6 * al) + cg * gain * al;
        b = b * (1 - 0.6 * al) + cb * gain * al;
        if (al > 0.22) { own = OWN.flame; heat = T; }
      }
    }


    sR = r; sG = g; sB = b; sO = own; sT = heat;
  }

  // ---------- sparks ----------

  function spawnSpark(fast) {
    const x = prnd.uniform(-0.10, 0.10) + P.tipX * 0.3;
    const y = FIRE_Y - prnd.uniform(0.02, 0.28);
    sparks.push({
      x, y,
      vx: prnd.uniform(-0.05, 0.05) + x * 0.35,
      vy: -prnd.uniform(0.07, 0.26) * (fast ? 1.8 : 1),
      life: prnd.uniform(1.0, 3.6) * (fast ? 0.7 : 1),
      age: 0, ph: prnd.uniform(0, 6.28),
    });
  }

  function updateSparks(t, dt) {
    if (sparks.length < 260) {
      let want = 11 * (1 + 1.2 * P.windA) * (1 + 1.5 * P.crack) * dt;
      while (want > 0) { if (prnd.random() < Math.min(want, 1)) spawnSpark(false); want -= 1; }
      if (prnd.random() < 0.7 * dt || P.crack > 0.3) { const n = 4 + Math.floor(prnd.random() * 7); for (let i = 0; i < n; i++) spawnSpark(true); }
    }
    for (const s of sparks) {
      s.age += dt;
      s.vx += (bil(TN, 256, s.y * 8 + s.ph, t * 0.7 + s.life * 5) - 0.5) * 0.55 * dt;
      s.vx += P.wind * 0.45 * dt;
      s.vy *= 1 - 0.10 * dt;
      s.x += s.vx * dt; s.y += s.vy * dt;
    }
    for (let i = sparks.length - 1; i >= 0; i--) if (sparks[i].age >= sparks[i].life) sparks.splice(i, 1);
  }

  function stampSparks(idx, fg, own) {
    for (const s of sparks) {
      const k = s.age / s.life;
      const c = Math.trunc((W / 2 + s.x * H) / CW), r = Math.trunc((H / 2 + s.y * H) / CH);
      if (c < 0 || c >= COLS || r < 0 || r >= ROWS) continue;
      const p = r * COLS + c;
      if (own[p] === OWN.flame || own[p] === OWN.logs || own[p] === OWN.coals || own[p] === OWN.stones) continue;
      const a = (1 - k) * Math.min(1, s.age * 6) * (0.75 + 0.25 * Math.sin(s.age * 22 + s.ph));
      idx[p] = CIDX[k < 0.22 ? '*' : (k < 0.5 ? '+' : (k < 0.8 ? '.' : '`'))];
      fg[p * 3] = clip(1.0 * a + 0.08, 0, 1);
      fg[p * 3 + 1] = clip((0.88 - 0.62 * k) * a, 0, 1);
      fg[p * 3 + 2] = clip((0.40 - 0.38 * k) * a, 0, 1);
    }
  }

  // ---------- post ----------

  function bloom(img) {
    const out = Float32Array.from(img);
    const b = new Float32Array(img.length);
    for (let i = 0; i < img.length; i++) b[i] = Math.max(img[i] - 0.45, 0);
    for (const [f, w_] of [[2, 0.26], [4, 0.20], [8, 0.15]]) {
      const gh = GH / f, gw = GW / f;
      let s_ = new Float32Array(gh * gw * 3);
      const inv = 1 / (f * f);
      for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
          for (let ch = 0; ch < 3; ch++) {
            let acc = 0;
            for (let dy = 0; dy < f; dy++) {
              for (let dx = 0; dx < f; dx++) acc += b[((y * f + dy) * GW + (x * f + dx)) * 3 + ch];
            }
            s_[(y * gw + x) * 3 + ch] = acc * inv;
          }
        }
      }
      for (let pass = 0; pass < 2; pass++) {
        const n2 = new Float32Array(s_.length);
        for (let y = 0; y < gh; y++) {
          const yu = (y + gh - 1) % gh, yd = (y + 1) % gh;
          for (let x = 0; x < gw; x++) {
            const xl = (x + gw - 1) % gw, xr = (x + 1) % gw;
            for (let ch = 0; ch < 3; ch++) {
              n2[(y * gw + x) * 3 + ch] = (s_[(y * gw + x) * 3 + ch] * 2
                + s_[(yu * gw + x) * 3 + ch] + s_[(yd * gw + x) * 3 + ch]
                + s_[(y * gw + xl) * 3 + ch] + s_[(y * gw + xr) * 3 + ch]) / 6;
            }
          }
        }
        s_ = n2;
      }
      for (let y = 0; y < GH; y++) {
        for (let x = 0; x < GW; x++) {
          const sp_ = (((y / f) | 0) * gw + ((x / f) | 0)) * 3;
          const p = (y * GW + x) * 3;
          out[p] += w_ * s_[sp_]; out[p + 1] += w_ * s_[sp_ + 1]; out[p + 2] += w_ * s_[sp_ + 2];
        }
      }
    }
    return out;
  }

  // ---------- frame ----------

  const PRIO = [0, 1, 2, 3, 4, 5, 6, 7];
  const KEY = ['none', 'glow', 'ground', 'smoke', 'stones', 'coals', 'logs', 'flame'];

  function renderCells(t) {
    const dt = clip(t - S.last, 0, 0.1);
    S.last = t;
    {
      const w = windAt(t);
      const n = 3, h = dt / n;
      for (let i = 0; i < n; i++) { S.wv += (34 * (w - S.wx) - 8 * S.wv) * h; S.wx += S.wv * h; }
    }
    frameParams(t);
    updateSparks(t, dt);

    const img = new Float32Array(GW * GH * 3);
    const owner = new Uint8Array(GW * GH);
    const heat = new Float32Array(GW * GH);
    for (let j = 0; j < GH; j++) {
      for (let i = 0; i < GW; i++) {
        const p = j * GW + i;
        shade(X[p], Y[p], t);
        img[p * 3] = sR; img[p * 3 + 1] = sG; img[p * 3 + 2] = sB;
        owner[p] = sO; heat[p] = sT;
      }
    }

    const bl = bloom(img);
    for (let i = 0; i < bl.length; i++) bl[i] = 1 - Math.exp(-1.45 * Math.max(bl[i], 0));

    const idx = new Int32Array(ROWS * COLS);
    const fg = new Float32Array(ROWS * COLS * 3);
    const bg = new Float32Array(ROWS * COLS * 3);
    const ownCell = new Uint8Array(ROWS * COLS);
    const lumCell = new Float32Array(ROWS * COLS);
    const inv = 1 / (SS * SS);
    const pick = (fam, v) => fam[Math.trunc(clip(v, 0, 0.999) * fam.length)];

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        let R_ = 0, G_ = 0, B_ = 0, best = 0, bestP = -1, Tm = 0;
        for (let a = 0; a < SS; a++) {
          for (let b = 0; b < SS; b++) {
            const pp = (r * SS + a) * GW + (c * SS + b);
            R_ += bl[pp * 3]; G_ += bl[pp * 3 + 1]; B_ += bl[pp * 3 + 2];
            const o = owner[pp];
            if (o && PRIO[o] > bestP) { bestP = PRIO[o]; best = o; }
            if (heat[pp] > Tm) Tm = heat[pp];
          }
        }
        R_ *= inv; G_ *= inv; B_ *= inv;
        const cell = r * COLS + c;
        ownCell[cell] = best;
        lumCell[cell] = 0.30 * R_ + 0.60 * G_ + 0.10 * B_;
        if (!best) continue;
        const key = KEY[best];
        const Ly = LAYERS[key];
        if (!Ly.on) continue;
        const lum = 0.30 * R_ + 0.60 * G_ + 0.10 * B_;
        lumCell[cell] = lum;
        const l = Math.pow(clip(lum, 0, 1), 0.72);
        const hs = HSC[cell];
        const hs2 = (hs * 13.7) % 1;

        bg[cell * 3] = clip(R_ * Ly.bg, 0, 1); bg[cell * 3 + 1] = clip(G_ * Ly.bg, 0, 1); bg[cell * 3 + 2] = clip(B_ * Ly.bg, 0, 1);

        let ch = '', gain = 1.4, add = 0.06, custom = null;
        if (Ly.chars) {
          if (key === 'flame') {
            const Tn = clip(Tm * 1.05, 0, 1);
            if (hs < Ly.density * (0.55 + 0.45 * Tn)) ch = pick(FLAME_FAM, Tn + (hs - 0.5) * 0.12);
            gain = 1.25; add = 0.10;
          } else if (key === 'coals') {
            if (hs < Ly.density) ch = pick(COAL_FAM, l * 1.1 + (hs2 - 0.5) * 0.3);
            gain = 1.3; add = 0.08;
          } else if (key === 'logs') {
            if (hs < Ly.density) ch = l > 0.62 ? pick(COAL_FAM, hs2) : pick(BARK_FAM, hs2);
            gain = 1.7; add = 0.07;
          } else if (key === 'stones') {
            if (hs < Ly.density) ch = pick(STONE_FAM, l * 1.4 + (hs2 - 0.5) * 0.3);
            gain = 2.1; add = 0.05;
          } else if (key === 'smoke') {
            if (hs < Ly.density * clip(l * 4, 0, 1)) ch = pick(SMOKE_FAM, hs2);
            gain = 1.8; add = 0.0;
          } else if (key === 'ground') {
            if (hs < Ly.density * clip((l - 0.015) / 0.22, 0, 1)) { ch = pick(GROUND_FAM, hs2); custom = [clip(R_ * 1.5 + 0.012, 0, 1), clip(G_ * 1.8 + 0.030 * (0.5 + 0.5 * hs2), 0, 1), clip(B_ * 1.4 + 0.008, 0, 1)]; }
          } else {
            // halo made of characters: density, weight and brightness fall off with distance from the fire, ending in black
            const dx = ((c + 0.5) * CW - W / 2) / H - P.gx, dy = ((r + 0.5) * CH - H / 2) / H - P.gy;
            const gl = Math.min(1, P.light) / (1 + (dx * dx + dy * dy) / 0.040);
            if (hs < Ly.density * Math.min(1, 3.0 * Math.pow(gl, 1.25))) {
              ch = pick(GLOW_FAM, Math.pow(gl, 0.7) + (hs2 - 0.5) * 0.18);
              const op = Math.pow(gl, 0.85) * (0.45 + 0.55 * hs2);
              custom = [clip(1.05 * op, 0, 1), clip(0.56 * op, 0, 1), clip(0.22 * op, 0, 1)];
            }
          }
        }
        if (ch) {
          idx[cell] = CIDX[ch];
          if (custom) { fg[cell * 3] = custom[0]; fg[cell * 3 + 1] = custom[1]; fg[cell * 3 + 2] = custom[2]; }
          else { fg[cell * 3] = clip(R_ * gain + add, 0, 1); fg[cell * 3 + 1] = clip(G_ * gain + add, 0, 1); fg[cell * 3 + 2] = clip(B_ * gain + add, 0, 1); }
        }
      }
    }

    if (LAYERS.stars.on) stampStars(idx, fg, ownCell, lumCell, t);
    if (LAYERS.sparks.on) stampSparks(idx, fg, ownCell);

    const q = new Int16Array(ROWS * COLS * 3);
    const bq = new Int16Array(ROWS * COLS * 3);
    for (let i = 0; i < q.length; i++) {
      q[i] = clip(Math.trunc(clip(fg[i], 0, 1) * (QL - 0.01)), 0, QL - 1);
      bq[i] = clip(Math.trunc(clip(bg[i], 0, 1) * (QL - 1) + 0.5 * HSC[(i / 3) | 0]), 0, QL - 1);
    }
    return { idx, q, bq };
  }

  const api = {
    init, renderCells, layers: LAYERS, RAMP, QL, FPS, MAXROWS,
    sparkCount: () => sparks.length, windNow: () => S.wx,
    dims: () => ({ CW, CH, ROWS, COLS, W, H }),
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
