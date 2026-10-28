// An ASCII candle on a black background, built from overlaid layers.
//
// Pipeline (same idea as ../test/toronto.js): a per-pixel shader fills an image and records which layer owns each
// pixel, bloom + tone mapping, then a cell compositor gives every character cell a background colour AND a character
// chosen by the layer that owns it.
//
// Layers, back to front: glow (light in the air), wax (candle body and drips), pool (melted top), wick, smoke,
// flame (emissive, blended over everything), and sparks (particles stamped as characters).
const Candle = (function () {
  'use strict';

  const { MT } = (typeof module !== 'undefined' && module.exports) ? require('./rng.js') : window.RNG;
  const f32 = Math.fround;
  const PI = Math.PI;

  const FPS = 30;
  const MAXROWS = 130;

  // geometry, in screen-height units (x right, y down, 0 = screen centre)
  const YTOP = 0.17;        // y of the candle's top face
  const R = 0.088;          // candle radius
  const RY = 0.025;         // half-height of the top face ellipse (perspective)
  const WICK_H = 0.042;     // wick height above the top face
  const HF = 0.40;          // flame height
  const WF = 0.092;         // flame max half-width

  const RAMP = ' .\'`^",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$';
  const CIDX = {};
  for (let i = 0; i < RAMP.length; i++) CIDX[RAMP[i]] = i;
  const QL = 48;   // finer colour levels than the other scenes: a dark scene needs smooth low-end gradients

  const rng = new MT().initGenrand(11);
  const prnd = new MT().initByArray([77]);

  // Layers: bg = strength of the background colour field, chars = draw characters, density = fraction of cells with a character
  const LAYERS = {
    glow:   { on: true, bg: 0.00, chars: true, density: 0.95 },   // character-led: no background, muted characters that thin out to black
    wax:    { on: true, bg: 0.55, chars: true, density: 1.00 },
    pool:   { on: true, bg: 0.65, chars: true, density: 1.00 },
    wick:   { on: true, bg: 0.30, chars: true, density: 1.00 },
    smoke:  { on: true, bg: 0.00, chars: true, density: 0.55 },
    flame:  { on: true, bg: 0.70, chars: true, density: 0.95 },
    sparks: { on: true },
  };
  const WAX_FAM = ".:-=+*#%";
  const POOL_FAM = "~-=+";
  const SMOKE_FAM = ".:'`;";
  const GLOW_FAM = "`.',:;+*";   // faint at the edge of the halo, heavier near the flame
  // flame characters from cool/thin edges to the hot core
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
  // smooth noise in [-1, 1] (about +-0.5 in practice) for animation
  function n1(t, off) { return (bil(TN, 256, t + off * 13.7, 40.5) - 0.5) * 3.2; }

  // ---------- geometry ----------

  let CW, CH, ROWS, COLS, W, H, GW, GH, SS = 1;
  let X, Y;
  let HSC;
  const DRIPS = [];

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
    HSC = new Float32Array(ROWS * COLS);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const hh = (BigInt(r) * 73856093n) ^ (BigInt(c) * 19349663n) ^ 0x5bd1e995n;
        HSC[r * COLS + c] = Number(hh % 1009n) / 1009.0;
      }
    }
    // wax drips down the side of the candle
    DRIPS.length = 0;
    const dr = new MT().initByArray([5]);
    const slots = [-0.62, -0.18, 0.30, 0.66];
    for (const sx of slots) {
      DRIPS.push({ x: sx * R + dr.uniform(-0.05, 0.05) * R, len: dr.uniform(0.07, 0.22), w: dr.uniform(0.0050, 0.0075), ph: dr.uniform(0, 6) });
    }
  }

  // ---------- wind: occasional gusts of random direction, length and strength ----------

  const wrnd = new MT().initByArray([303]);
  const GUSTS = [];          // [start, duration, signed strength]
  let gustEnd = 0;
  function extendGusts(upto) {
    while (gustEnd < upto) {
      const t0 = gustEnd + wrnd.uniform(2.2, 6.5);               // calm spells between gusts
      const dur = wrnd.uniform(1.0, 2.6);
      const sgn = wrnd.random() < 0.5 ? -1 : 1;
      GUSTS.push([t0, dur, sgn * wrnd.uniform(0.45, 1.0)]);
      gustEnd = t0 + dur;
    }
  }
  function windAt(t) {
    extendGusts(t + 12);
    let w = 0;
    for (const g of GUSTS) {
      const x = (t - g[0]) / g[1];
      if (x > 0 && x < 1) w += g[2] * Math.pow(Math.sin(PI * x), 2);      // smooth rise and fall
    }
    return clip(w + 0.12 * n1(t * 0.7, 11), -1.2, 1.2);                   // a faint breeze between gusts
  }

  // ---------- state: lit / blown out, sparks ----------

  const S = { level: 1, target: 1, smoke: 0, last: 0, wx: 0, wv: 0 };
  const sparks = [];
  function setLit(on) {
    if (on === S.target) return;
    S.target = on ? 1 : 0;
    if (!on) S.smoke = 1;
  }
  function toggleLit() { setLit(!(S.target > 0.5)); }

  // ---------- flame colour ramp (roughly black-body: dark red -> orange -> yellow -> white-yellow) ----------

  const STOPS = [
    [0.00, 0.12, 0.010, 0.000],
    [0.18, 0.60, 0.080, 0.010],
    [0.40, 1.00, 0.320, 0.030],
    [0.62, 1.00, 0.600, 0.100],
    [0.82, 1.00, 0.850, 0.350],
    [1.00, 1.00, 0.970, 0.800],
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

  const P = { wind: 0, windA: 0, lvl: 1, hs: 1, lean: 0, wid: 1, light: 1, glow: 0, gx: 0, gy: 0, y0: 0, smokeK: 0, tipX: 0, tipY: 0, t: 0 };

  function frameParams(t) {
    const lvl = ease(S.level);
    P.t = t;
    P.lvl = lvl;
    P.y0 = YTOP - WICK_H;                                          // y of the wick tip, where the flame starts
    // slow wobble of height and lean, a faster shimmer on top, and the odd gust
    const gust = Math.max(0, n1(t * 0.25, 9)) * 2.2;
    P.hs = lvl * (1 + 0.078 * n1(t * 1.2, 1) + 0.028 * n1(t * 4.2, 2) - 0.04 * gust);
    P.lean = 0.012 * n1(t * 0.8, 3) + 0.005 * Math.sin(t * 1.6) + 0.011 * gust * Math.sin(t * 0.7);
    P.wid = 1 + 0.05 * n1(t * 2.6, 4);
    P.light = lvl * (0.94 + 0.12 * n1(t * 3.2, 5) + 0.03 * n1(t * 9, 6));
    P.wind = S.wx; P.windA = Math.min(1, Math.abs(S.wx));
    P.hs *= 1 - 0.12 * P.windA;                                    // wind squashes and thins the flame
    P.wid *= 1 - 0.14 * P.windA;
    P.light *= 1 - 0.10 * P.windA;
    P.lean += 0.050 * P.wind;
    P.gx = P.lean * 0.5;
    P.gy = P.y0 - 0.42 * HF * Math.max(P.hs, 0.15);
    P.glow = 0.045 * P.light;
    P.tipX = P.lean;
    P.tipY = P.y0 - HF * P.hs;
    P.smokeK = 0.11 * lvl + 0.55 * S.smoke;
  }

  // ---------- the per-pixel shader ----------

  const OWN = { none: 0, glow: 1, wax: 2, pool: 4, wick: 5, smoke: 6, flame: 7 };
  let sR = 0, sG = 0, sB = 0, sO = 0, sT = 0;

  function shade(x, y, t) {
    let r = 0, g = 0, b = 0, own = 0, heat = 0;

    // glow: light spilling into the air around the flame
    {
      const dx = x - P.gx, dy = y - P.gy;
      const g0 = P.glow / (1 + (dx * dx + dy * dy) / 0.034);
      r += g0 * 1.00; g += g0 * 0.50; b += g0 * 0.15;
      if (g0 > 0.0030) own = OWN.glow;
    }

    // candle: top face (rim + molten pool) and the body below it
    const ex = x / (R * 0.94), ey = (y - YTOP) / RY, el = ex * ex + ey * ey;
    if (el < 1) {
      const e = Math.sqrt(el);
      if (e > 0.80) {                                                     // solid rim of the wax around the pool
        const k = 0.10 + 0.62 * P.light * (0.75 + 0.25 * (1 - e) / 0.2);
        r = 0.98 * k; g = 0.82 * k; b = 0.55 * k;
        own = OWN.wax;
      } else {                                                            // molten pool: translucent amber, brighter near the wick
        const k = 0.22 + 0.78 * P.light;
        const centre = 1 - e / 0.80;
        r = 1.00 * k * (0.78 + 0.22 * centre); g = 0.74 * k * (0.78 + 0.22 * centre); b = 0.36 * k * (0.70 + 0.2 * centre);
        const spec = Math.exp(-Math.pow((x + 0.018) / 0.014, 2) - Math.pow((y - YTOP + 0.004) / 0.005, 2)) * 0.8 * P.light;   // reflection of the flame
        r += spec; g += spec * 0.9; b += spec * 0.7;
        own = OWN.pool;
      }
    } else if (Math.abs(x) < R && y > YTOP) {
      const nx = x / R, nz = Math.sqrt(Math.max(0, 1 - nx * nx));
      const dy = y - YTOP;
      const att = 1 / (1 + (dy / 0.20) * (dy / 0.20));                   // brighter near the flame, fading down the candle
      const dif = 0.30 + 0.70 * nz;
      const tex = 0.94 + 0.12 * (bil(TN, 256, nx * 3 + 10, y * 18) - 0.5) * 2;
      let lw = (0.012 + 0.62 * att * dif * P.light) * tex;
      let inDrip = false, dripSpec = 0;
      for (let i = 0; i < DRIPS.length; i++) {                           // wax drips: slightly brighter, translucent
        const d = DRIPS[i];
        const xd = d.x + 0.0016 * Math.sin(dy * 55 + d.ph);
        const w = d.w * (1 + 0.14 * Math.sin(dy * 38 + d.ph));
        let inside = dy < d.len && Math.abs(x - xd) < w;
        if (!inside && dy >= d.len) {
          const cx = (x - xd) / (w * 1.3), cy = (dy - d.len) / (w * 1.7);
          inside = cx * cx + cy * cy < 1;
        }
        if (inside) {
          inDrip = true;
          dripSpec = Math.max(dripSpec, Math.exp(-Math.pow((x - xd + w * 0.35) / (w * 0.30), 2)) * 0.5 * att);
        }
      }
      if (inDrip) lw = lw * 1.14 + dripSpec * P.light;
      const edge = 0.55 + 0.45 * nz;
      r = 0.98 * lw * edge; g = 0.80 * lw * edge; b = 0.52 * lw * edge;      // warm light on cream wax
      const sss = Math.exp(-dy / 0.06) * 0.40 * P.lvl;                   // light shining through the wax just below the rim
      r += 1.00 * sss * (0.35 + 0.65 * nz); g += 0.52 * sss * (0.35 + 0.65 * nz); b += 0.16 * sss * (0.35 + 0.65 * nz);
      r += glowLeak(x, y, 0.15); g += glowLeak(x, y, 0.07); b += glowLeak(x, y, 0.02);
      own = OWN.wax;
    }

    // wick
    {
      const wy = YTOP - y;
      if (wy > -0.004 && wy < WICK_H) {
        const f = clip(wy / WICK_H, 0, 1);
        const wx = P.lean * 0.35 * f * f;
        if (Math.abs(x - wx) < 0.0028) {
          const ember = f > 0.62 ? (f - 0.62) / 0.38 * 0.9 * P.lvl : 0;
          r = 0.07 + 1.00 * ember; g = 0.045 + 0.35 * ember; b = 0.03 + 0.07 * ember;
          own = OWN.wick;
        }
      }
    }

    // smoke: thin grey wisps rising from the flame tip, stronger right after a blow-out
    if (P.smokeK > 0.01) {
      const h = (P.tipY - y);
      if (h > -0.02 && y > -0.55) {
        const hh = Math.max(h, 0);
        const sx = P.tipX + 0.07 * P.wind * Math.min(1, hh * 3) + 0.035 * Math.sin(hh * 13 - t * 1.7 + 1.3) * Math.min(1, hh * 4) + 0.03 * (bil(TN, 256, hh * 4 + 20, t * 0.5) - 0.5) * hh * 6;
        const sw = 0.006 + 0.045 * hh;
        const dens = bil(TN, 256, x * 12 + 3, y * 7 + t * 0.9);
        const sm = P.smokeK * Math.exp(-hh / 0.30) * Math.exp(-Math.pow((x - sx) / sw, 2)) * (0.35 + 1.2 * dens) * ss(-0.02, 0.03, h);
        if (sm > 0.003) {
          r += 0.55 * sm; g += 0.55 * sm; b += 0.60 * sm;
          if (sm > 0.03 && own === OWN.none) own = OWN.smoke;
          else if (sm > 0.03 && own === OWN.glow) own = OWN.smoke;
        }
      }
    }

    // flame: teardrop, wavering centre line, turbulent edges, black-body colours, dark core above the wick, blue base
    if (P.lvl > 0.02 && P.hs > 0.02) {
      const yn = (P.y0 - y) / (HF * P.hs);
      if (yn > -0.10 && yn < 1.10) {
        const yp = clip(yn, 0, 1);
        const cx = P.lean * yp * yp
          + (0.007 * Math.sin(yp * 5.0 + t * 6.0) * yp + 0.034 * (bil(TN, 256, yp * 1.8 + 11, t * 1.7) - 0.5) * yp) * (1 + 0.9 * P.windA)
          + 0.075 * P.wind * Math.pow(yp, 1.7);
        let w = WF * P.wid * Math.pow(Math.sin(PI * Math.pow(yp, 0.55)), 0.9) * (1 - 0.18 * yp);
        if (yp < 0.35) w = Math.max(w, 0.016 * (1 - yp / 0.35));
        const en = bil(TN, 256, x * 26 + 5, y * 26 - t * 3.8) - 0.5;      // tongues licking the edge, stronger toward the tip
        const dn = Math.abs(x - cx) / (w + 1e-4) + en * (0.22 + 0.70 * yp) * (1 + 0.6 * P.windA);
        let d = ss(1.05, 0.25, dn);
        d *= ss(1.10, 0.86, yn) * ss(-0.10, 0.0, yn);
        if (d > 0.01) {
          const core = Math.exp(-Math.pow((x - cx) / (w * 0.38 + 1e-4), 2)) * Math.pow(1 - yp, 0.7);
          let T = Math.pow(d, 1.2) * (1 - 0.62 * Math.pow(yp, 1.1));
          T = clip(T * 0.85 + 0.35 * core * d, 0, 1);
          T *= 1 - 0.70 * Math.exp(-Math.pow((x - cx) / 0.008, 2)) * ss(0.45, 0.02, yp) * (yn > 0 ? 1 : 0);   // dark zone around the wick
          flameRGB(T);
          let fr = cr, fg = cg, fb = cb;
          const bw = Math.exp(-yp / 0.14) * (0.30 + 0.70 * ss(0.15, 0.85, dn)) * d;   // blue at the base of the flame
          fr = mix(fr, 0.22, bw * 0.9); fg = mix(fg, 0.42, bw * 0.9); fb = mix(fb, 1.00, bw * 0.9);
          const alpha = d * (0.35 + 0.65 * ss(0.0, 0.35, T)) * P.lvl;
          const gain = 0.7 + 1.1 * T;                                      // hotter = brighter, so the core blooms
          r = r * (1 - 0.6 * alpha) + fr * gain * alpha;
          g = g * (1 - 0.6 * alpha) + fg * gain * alpha;
          b = b * (1 - 0.6 * alpha) + fb * gain * alpha;
          if (alpha > 0.22) { own = OWN.flame; heat = T; }
        }
      }
    }

    sR = r; sG = g; sB = b; sO = own; sT = heat;
  }

  // light from the flame leaking onto the candle's top edge
  function glowLeak(x, y, k) {
    const dx = x - P.gx, dy = y - P.gy;
    return P.light * k / (1 + (dx * dx + dy * dy) / 0.02);
  }

  // ---------- sparks ----------

  function spawnSpark(fast) {
    // embers lift off the upper half of the flame and drift outward a little as they rise
    const x = P.tipX * 0.7 + prnd.uniform(-0.035, 0.035);
    const y = P.tipY + prnd.uniform(0.0, 0.16);
    sparks.push({
      x, y,
      vx: prnd.uniform(-0.03, 0.03) + (x - P.tipX) * 0.9,
      vy: -prnd.uniform(0.05, 0.20) * (fast ? 1.7 : 1),
      life: prnd.uniform(1.0, 3.2) * (fast ? 0.7 : 1),
      age: 0, ph: prnd.uniform(0, 6.28),
    });
  }

  function updateSparks(t, dt) {
    if (P.lvl > 0.5 && sparks.length < 140) {
      // steady stream of embers, plus the occasional burst of a few fast ones
      let want = 5.5 * P.lvl * (1 + 1.4 * P.windA) * dt;
      while (want > 0) { if (prnd.random() < Math.min(want, 1)) spawnSpark(false); want -= 1; }
      if (prnd.random() < 0.45 * dt) { const n = 3 + Math.floor(prnd.random() * 4); for (let i = 0; i < n; i++) spawnSpark(true); }
    }
    for (const s of sparks) {
      s.age += dt;
      s.vx += (bil(TN, 256, s.y * 8 + s.ph, t * 0.7 + s.life * 5) - 0.5) * 0.45 * dt;   // sway on the air currents
      s.vx += P.wind * 0.35 * dt;                                                          // blown along by gusts
      s.vy *= 1 - 0.10 * dt;                                                              // slow down as they cool
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
      if (own[p] === OWN.wax || own[p] === OWN.pool || own[p] === OWN.flame) continue;
      const a = (1 - k) * Math.min(1, s.age * 6) * (0.75 + 0.25 * Math.sin(s.age * 22 + s.ph));   // fade out, twinkle
      idx[p] = CIDX[k < 0.22 ? '*' : (k < 0.5 ? '+' : (k < 0.8 ? '.' : '`'))];
      // yellow-white while young, orange, then a dull red ember
      fg[p * 3] = clip(1.0 * a + 0.08, 0, 1);
      fg[p * 3 + 1] = clip((0.88 - 0.62 * k) * a, 0, 1);
      fg[p * 3 + 2] = clip((0.40 - 0.38 * k) * a, 0, 1);
    }
  }

  // ---------- post ----------

  function bloom(img) {
    const out = Float32Array.from(img);
    const b = new Float32Array(img.length);
    for (let i = 0; i < img.length; i++) b[i] = Math.max(img[i] - 0.40, 0);
    for (const [f, w_] of [[2, 0.42], [4, 0.34], [8, 0.30]]) {
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

  const PRIO = [0, 1, 3, 0, 4, 5, 2, 6];   // owner code -> draw priority (flame highest)
  const KEY = ['none', 'glow', 'wax', '', 'pool', 'wick', 'smoke', 'flame'];

  function renderCells(t) {
    const dt = clip(t - S.last, 0, 0.1);
    S.last = t;
    S.level += (S.target - S.level) * Math.min(1, dt / (S.target > S.level ? 0.55 : 0.18));
    if (Math.abs(S.target - S.level) < 0.002) S.level = S.target;
    S.smoke = Math.max(0, S.smoke - dt / 3.0);
    {
      const w = windAt(t);
      const n = 3, h = dt / n;
      for (let i = 0; i < n; i++) { S.wv += (38 * (w - S.wx) - 9 * S.wv) * h; S.wx += S.wv * h; }
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
    for (let i = 0; i < bl.length; i++) bl[i] = 1 - Math.exp(-2.0 * Math.max(bl[i], 0));

    const idx = new Int32Array(ROWS * COLS);
    const fg = new Float32Array(ROWS * COLS * 3);
    const bg = new Float32Array(ROWS * COLS * 3);
    const ownCell = new Uint8Array(ROWS * COLS);
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
        if (!best) continue;                                            // nothing here: pure black
        const key = KEY[best];
        const L = LAYERS[key];
        if (!L.on) continue;
        const lum = 0.30 * R_ + 0.60 * G_ + 0.10 * B_;
        const l = Math.pow(clip(lum, 0, 1), 0.72);
        const hs = HSC[cell];

        bg[cell * 3] = clip(R_ * L.bg, 0, 1); bg[cell * 3 + 1] = clip(G_ * L.bg, 0, 1); bg[cell * 3 + 2] = clip(B_ * L.bg, 0, 1);

        let ch = '', gain = 1.4, add = 0.06, custom = null;
        if (L.chars) {
          if (key === 'flame') {
            const Tn = clip(Tm * 1.05, 0, 1);
            if (hs < L.density * (0.55 + 0.45 * Tn)) ch = pick(FLAME_FAM, Tn + (hs - 0.5) * 0.12);
            gain = 1.25; add = 0.10;
          } else if (key === 'wax') {
            if (hs < L.density) ch = pick(WAX_FAM, l * 1.15 + (hs - 0.5) * 0.10);
          } else if (key === 'pool') {
            if (hs < L.density) ch = pick(POOL_FAM, l + (hs - 0.5) * 0.2);
          } else if (key === 'wick') {
            ch = l > 0.35 ? '*' : '|';
            gain = 1.6;
          } else if (key === 'smoke') {
            if (hs < L.density * clip(l * 4, 0, 1)) ch = pick(SMOKE_FAM, hs * 3.1 % 1);
            gain = 1.8; add = 0.0;
          } else {
            // halo made of characters: density, weight and brightness all fall off with distance from the flame, ending in black
            const dx = ((c + 0.5) * CW - W / 2) / H - P.gx, dy = ((r + 0.5) * CH - H / 2) / H - P.gy;
            const gl = Math.min(1, P.light) / (1 + (dx * dx + dy * dy) / 0.034);
            const hs2 = (hs * 13.7) % 1;
            if (hs < L.density * Math.min(1, 3.0 * Math.pow(gl, 1.25))) {
              ch = pick(GLOW_FAM, Math.pow(gl, 0.7) + (hs2 - 0.5) * 0.18);
              const op = Math.pow(gl, 0.85) * (0.45 + 0.55 * hs2);        // each character has its own opacity
              custom = [clip(1.05 * op, 0, 1), clip(0.56 * op, 0, 1), clip(0.22 * op, 0, 1)];                // muted amber-brown
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
    init, renderCells, setLit, toggleLit, sparkCount: () => sparks.length, windNow: () => S.wx, gusts: () => { extendGusts(40); return GUSTS.slice(0, 8); }, layers: LAYERS, RAMP, QL, FPS, MAXROWS,
    dims: () => ({ CW, CH, ROWS, COLS, W, H }),
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
