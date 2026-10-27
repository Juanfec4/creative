// A comet passing over the Toronto skyline, rendered as colored ASCII.
// Same pipeline as ../eye.js: per-pixel shading on a supersampled grid, bloom, tone map,
// 2x2 average per cell, brightness -> character ramp, then stamped stars on top.
// Everything is procedural: no image files.
const Toronto = (function () {
  'use strict';

  const { MT } = (typeof module !== 'undefined' && module.exports) ? require('./rng.js') : window.RNG;
  const f32 = Math.fround;
  const PI = Math.PI;

  const FPS = 30;
  let SS = 2;
  const ASPECT = 1.9;
  const MAXROWS = 150;
  const LOOP = 42.0;          // seconds before the whole show repeats
  const HOR = 0.20;           // waterline, in screen-height units (y grows downward, 0 = center)
  const CN_X = -0.10;         // CN Tower x position
  const CN_H = 0.68;          // CN Tower total height above the waterline
  const T_C0 = 3.0, T_CD = 35.0;   // comet start time / pass duration

  const RAMP = ' .\'`^",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$';
  const NR = RAMP.length - 1;
  const CIDX = {};
  for (let i = 0; i < RAMP.length; i++) CIDX[RAMP[i]] = i;
  const QL = 24;
  // each depth layer gets its own glyph family so layers read as separate planes
  const FAMS = [
    [0.50, " .'`:;"],
    [0.65, ",;i!l+~<>"],
    [0.82, "[]{}()1/\\|tfjr"],
    [9.00, "xnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$"],
  ];
  const FLIFT = [0.03, 0.07, 0.13, 0.22];
  // Layers composited back to front. Every cell has a background colour AND a character.
  //   bg      0..1  strength of the background colour field (0 = black cell background)
  //   chars   draw characters for this layer
  //   density 0..1  fraction of cells that get a character (the rest show only the background)
  // A cell belongs to one "body" layer (sky, far/back/mid/front towers, tower, dome, water) that supplies the
  // background; water cells also get two character-only layers: reflect (glints of lit windows) and ripple (crests).
  const LAYERS = {
    sky:     { on: true, bg: 0.10, chars: true, density: 0.95 },   // character-led: the gradient is carried by muted characters, not by the background
    far:     { on: true, bg: 0.50, chars: true, density: 0.10 },
    back:    { on: true, bg: 0.68, chars: true, density: 0.22 },
    mid:     { on: true, bg: 0.85, chars: true, density: 0.32 },
    front:   { on: true, bg: 1.00, chars: true, density: 0.42 },
    tower:   { on: true, bg: 0.30, chars: true, density: 1.00 },
    dome:    { on: true, bg: 0.85, chars: true, density: 0.40 },
    water:   { on: true, bg: 0.16, chars: false, density: 0 },
    reflect: { on: true, bg: 0, chars: true, density: 0.26 },
    ripple:  { on: true, bg: 0, chars: true, density: 0.45 },
    stars:   { on: true },
    comet:   { on: true },
  };
  const SKY_FAM = "`.',:;+*";   // faint and thin in the dark sky, heavier toward the horizon glow and the comet
  const TOWER_FAM = "|:!Il1[]{}(tfjxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$";
  const DOME_FAM = "'`^~=+*()/\\#%";
  const REFLECT_FAM = "||||!!:;'";
  const RIPPLE_FAM = ".,'-~=+";
  const WAVE = ' .,-~=+*#%@';   // water uses its own glyph family so it never reads as buildings

  const rng = new MT().initGenrand(7);

  // ---------- helpers ----------

  function clip(x, a, b) { return x < a ? a : (x > b ? b : x); }
  function ss(a, b, x) { const t = clip((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function ease(t) { t = Math.min(Math.max(t, 0), 1); return t * t * (3 - 2 * t); }
  function mix(a, b, k) { return a + (b - a) * k; }
  function mod(x, n) { return ((x % n) + n) % n; }

  function h3(a, b, c) {
    let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 1103515245);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

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

  const TN = tex2d(256, [4, 12, 40, 100]);    // tail streaks + sky haze
  const TWAVE = tex2d(256, [6, 18, 50]);      // water ripple jitter

  // ---------- Gerstner waves ----------
  // Each wave: travel direction in the water plane, wavelength (world units), amplitude, steepness Q.
  // Surface point: P = (x + Q*A*Dx*cos(th), A*sin(th), z + Q*A*Dz*cos(th)),  th = k*(D . (x,z)) - w*t
  const WAVES = [
    { a: PI + 0.25, lam: 3.00, A: 0.030, Q: 0.55 },     // long swell
    { a: PI - 0.45, lam: 1.10, A: 0.018, Q: 0.70 },
    { a: PI + 1.10, lam: 0.60, A: 0.009, Q: 0.70 },
  ].map((w) => {
    const k = 2 * PI / w.lam;
    return { dx: Math.sin(w.a), dz: Math.cos(w.a), k, w: 0.11 * Math.sqrt(9.8 * k), A: w.A, Q: w.Q, lam: w.lam };
  });
  const ELEV_PERIOD = 26;   // seconds for the CN Tower elevator to go up and back down
  const ELEV = { y: 0 };   // current elevator car height above the waterline
  const DOME_PERIOD = 16;   // seconds for the Rogers Centre roof to open and close once
  // Wave field used only to place the water characters. It is built so that waves stay readable all the way to the horizon:
  // wavelengths run from short (near) to long (far), and each wave fades out only where it would be smaller than a character cell.
  const CWAVES = [
    { a: PI + 0.30, lam: 0.22, A: 0.35 },
    { a: PI - 0.50, lam: 0.60, A: 0.45 },
    { a: PI + 0.90, lam: 1.60, A: 0.50 },
    { a: PI - 0.20, lam: 4.50, A: 0.55 },
    { a: PI + 0.40, lam: 12.0, A: 0.60 },
  ].map((q) => ({ k: 2 * PI / q.lam, w: 0.40, dx: Math.sin(q.a), dz: Math.cos(q.a), A: q.A }));
  let cwW = 0, cwS = 0;
  function charWave(x, yy, t) {
    const rowN = CH / H, colN = CW / H;
    const zc = 1 / Math.sqrt(yy);                      // compressed distance: gentler perspective than the true z, so far waves still show
    const dz = Math.abs(zc - 1 / Math.sqrt(yy + rowN));
    const xc = x * zc, dxc = colN * zc;
    let w = 0, sl = 0;
    for (let i = 0; i < CWAVES.length; i++) {
      const q = CWAVES[i];
      const freq = q.k * Math.max(Math.abs(q.dz) * dz, Math.abs(q.dx) * dxc);   // radians per character cell
      const fd = clip((1.6 - freq) / 0.8, 0, 1);
      if (fd <= 0) continue;
      const th = q.k * (q.dx * xc + q.dz * zc) - q.w * t;
      w += fd * q.A * Math.sin(th);
      sl += fd * q.A * q.dx * Math.cos(th);
    }
    cwW = w; cwS = sl * 3;
  }
  let waterPrev = null, wpReady = false;
  const WSMOOTH = 0.20;   // how fast the water cells follow the new frame (lower = calmer)
  const CAM_H = 0.5;       // camera height above the water, in screen-height units
  const SLOPE = 0.42;       // global wave slope multiplier

  // ---------- geometry ----------

  let CW, CH, ROWS, COLS, W, H, GW, GH, PX;
  let X, Y, RS, RSC, HSC;
  let BLD = [];
  const ST = { x: null, y: null, b: null, ph: null, f: null, col: null, n: 0, xmax: 1 };

  function addBox(cx, w, h, depth, col, lit, seed, extra) {
    col = col.map((c) => c * 1.30);          // lighter bodies so the towers separate from the sky
    const o = {
      kind: 'box', cx, hw: w / 2, x0: cx - w / 2, x1: cx + w / 2, h, top: HOR - h,
      depth, col, lit, seed, ws: 1.3 * CW / H, hs: CH / H,
    };
    if (extra) Object.assign(o, extra);
    BLD.push(o);
    return o;
  }

  function buildSkyline(xmax) {
    BLD = [];
    const lr = new MT().initByArray([416]);

    // far, dim low blocks across the whole width (also fills the screen edges)
    let x = -xmax - 0.05;
    while (x < xmax + 0.05) {
      const w = lr.uniform(0.05, 0.09);
      addBox(x + w / 2, w, lr.uniform(0.05, 0.13), 0.42, [0.14, 0.10, 0.20], 0.50, Math.floor(lr.random() * 1e6));
      x += w * lr.uniform(0.8, 1.1);
    }

    // downtown cluster around the tower: distinct blocks of varied height and tone
    //   [cx, width, height, depth, color, crown]
    const C = [
      [-0.52, 0.075, 0.23, 0.55, [0.30, 0.20, 0.15], 1],
      [-0.43, 0.085, 0.13, 0.55, [0.34, 0.24, 0.14], 0],
      [-0.36, 0.060, 0.18, 0.55, [0.18, 0.19, 0.30], 1],
      [-0.02, 0.055, 0.17, 0.55, [0.32, 0.21, 0.15], 1],
      [0.04, 0.070, 0.12, 0.55, [0.36, 0.26, 0.14], 0],
      [0.13, 0.085, 0.15, 0.55, [0.20, 0.20, 0.30], 1],
      [0.23, 0.080, 0.11, 0.55, [0.34, 0.22, 0.12], 0],
      [0.32, 0.070, 0.17, 0.55, [0.30, 0.19, 0.14], 1],
      [0.44, 0.060, 0.22, 0.55, [0.40, 0.26, 0.10], 2],     // amber-topped tower
      [0.54, 0.080, 0.12, 0.55, [0.32, 0.22, 0.15], 0],
    ];
    C.forEach(([cx, w, h, depth, col, crown], i) => {
      addBox(cx, w, h, depth, col, 0.58, 60 + i * 9);
      if (crown) addBox(cx, w * 0.62, h + 0.035, depth, crown === 2 ? [0.55, 0.36, 0.10] : col, 0.40, 61 + i * 9);
      if (crown === 2) addBox(cx, 0.005, h + 0.075, depth, [1.0, 0.82, 0.35], 0, 62 + i * 9);
    });

    // warm, wide waterfront blocks in front, low
    const F = [[-0.46, 0.10, 0.075], [-0.33, 0.09, 0.060], [-0.02, 0.10, 0.085], [0.09, 0.11, 0.070],
               [0.21, 0.10, 0.090], [0.33, 0.09, 0.065], [0.45, 0.11, 0.075], [0.58, 0.10, 0.060]];
    F.forEach(([cx, w, h], i) => addBox(cx, w, h, 0.9, [0.40, 0.27, 0.14], 0.74, 200 + i * 5));

    // CN Tower podium: low glass pavilion at the base
    addBox(CN_X + 0.03, 0.10, 0.030, 0.95, [0.40, 0.28, 0.16], 0.78, 330);
    addBox(CN_X + 0.02, 0.05, 0.048, 0.95, [0.34, 0.24, 0.15], 0.70, 331);

    // Rogers Centre: pale dome on the left of the tower base
    BLD.push({ kind: 'dome', cx: -0.285, hw: 0.150, x0: -0.435, x1: -0.135, top: HOR - 0.104, h: 0.104, depth: 1.0, col: [0.26, 0.42, 0.80], lit: 0, seed: 5 });

    // CN Tower, always in front
    BLD.push({ kind: 'cn', cx: CN_X, hw: 0.04, x0: CN_X - 0.04, x1: CN_X + 0.04, top: HOR - CN_H, h: CN_H, depth: 1.0, col: [0.38, 0.39, 0.42], lit: 0, seed: 9 });

    // waterfront strip of lights
    BLD.push({ kind: 'box', cx: 0, hw: xmax + 0.1, x0: -xmax - 0.1, x1: xmax + 0.1, h: 0.011, top: HOR - 0.011,
      depth: 0.6, col: [0.10, 0.09, 0.10], lit: 0.60, seed: 77, ws: 0.7 * CW / H, hs: 0.5 * CH / H });
  }

  function buildStars() {
    ST.n = 130;
    ST.xmax = W / (2 * H);
    ST.x = new Float32Array(ST.n); ST.y = new Float32Array(ST.n);
    ST.b = new Float32Array(ST.n); ST.ph = new Float32Array(ST.n);
    ST.f = new Float32Array(ST.n); ST.col = new Float32Array(ST.n * 3);
    for (let i = 0; i < ST.n; i++) {
      ST.x[i] = rng.uniform(-ST.xmax, ST.xmax);
      ST.y[i] = rng.uniform(-0.5, HOR - 0.02);
      ST.b[i] = 0.10 + 0.90 * Math.pow(rng.random(), 3.5);
      ST.ph[i] = rng.uniform(0, 6.28);
      ST.f[i] = rng.uniform(1.0, 3.5);
      const tm = Math.pow(rng.random(), 1.5);
      ST.col[i * 3] = mix(0.70, 1.0, tm); ST.col[i * 3 + 1] = mix(0.82, 0.80, tm); ST.col[i * 3 + 2] = mix(1.0, 0.55, tm);
    }
  }

  function init(cw, ch, rows, aspect) {
    CW = cw; CH = ch;
    ROWS = rows - (rows % 8);
    SS = ROWS > 64 ? 1 : 2;
    COLS = Math.trunc(ROWS * ch * (aspect || ASPECT) / cw);
    COLS = COLS - (COLS % 8);
    W = COLS * CW; H = ROWS * CH;
    GW = COLS * SS; GH = ROWS * SS;
    PX = 1 / GH;

    X = new Float32Array(GW * GH);
    Y = new Float32Array(GW * GH);
    RS = new Float32Array(GW * GH);
    for (let j = 0; j < GH; j++) {
      const yv = f32(((j + 0.5) * (CH / SS) - H / 2) / H);
      for (let i = 0; i < GW; i++) {
        const xv = f32(((i + 0.5) * (CW / SS) - W / 2) / H);
        const p = j * GW + i;
        X[p] = xv; Y[p] = yv; RS[p] = Math.sqrt(xv * xv + yv * yv);
      }
    }
    RSC = new Float32Array(ROWS * COLS);
    HSC = new Float32Array(ROWS * COLS);
    for (let r = 0; r < ROWS; r++) {
      const yc = f32(((r + 0.5) * CH - H / 2) / H);
      for (let c = 0; c < COLS; c++) {
        const xc = f32(((c + 0.5) * CW - W / 2) / H);
        RSC[r * COLS + c] = Math.sqrt(xc * xc + yc * yc);
        const hh = (BigInt(r) * 73856093n) ^ (BigInt(c) * 19349663n) ^ 0x5bd1e995n;
        HSC[r * COLS + c] = Number(hh % 1009n) / 1009.0;
      }
    }
    buildSkyline(W / (2 * H));
    buildStars();
  }

  // ---------- the comet ----------

  const C = { on: false, hx: 0, hy: 0, dx: 1, dy: 0, nx: 0, ny: 1, fade: 0 };
  let cR = 0, cG = 0, cB = 0;

  function cometPlace(tl) {
    const u = (tl - T_C0) / T_CD;
    if (u < 0 || u > 1 || !LAYERS.comet.on) { C.on = false; return; }
    C.on = true;
    C.hx = CN_X + 1.6 * (2 * u - 1);
    C.hy = -0.43 + 0.30 * u - 0.06 * Math.sin(PI * u);
    const vx = 3.2, vy = 0.30 - 0.06 * PI * Math.cos(PI * u);
    const vl = Math.hypot(vx, vy);
    C.dx = vx / vl; C.dy = vy / vl;
    C.nx = -C.dy; C.ny = C.dx;
    C.fade = ss(0, 0.03, u) * ss(1, 0.97, u);
  }

  // comet radiance at (x, y) -> cR, cG, cB
  function cometRad(x, y, t) {
    cR = cG = cB = 0;
    if (!C.on) return;
    const dx = x - C.hx, dy = y - C.hy;
    const r2 = dx * dx + dy * dy;
    const a = -(dx * C.dx + dy * C.dy);
    const b = dx * C.nx + dy * C.ny;

    const core = 1.6 * Math.exp(-r2 / 0.00016);
    const coma = 0.38 * Math.exp(-Math.sqrt(r2) / 0.022);
    let r = core * 0.95 + coma * 0.55, g = core * 0.92 + coma * 0.80, bl = core * 0.90 + coma * 0.85;

    if (a > -0.02) {
      const aa = Math.max(a, 0);
      const onset = ss(-0.02, 0.02, a);

      const wi = 0.004 + 0.030 * aa;
      const ion = Math.exp(-aa / 0.36) * Math.exp(-(b / wi) * (b / wi)) * onset;
      const stri = 0.45 + 1.0 * bil(TN, 256, aa * 70, (b / wi) * 1.5 + t * 0.3 + 40);
      const ik = ion * stri * 0.62;
      r += 0.38 * ik; g += 0.55 * ik; bl += 0.85 * ik;

      const bc = b - 0.30 * aa * aa;
      const wd = 0.012 + 0.15 * aa;
      const dust = Math.exp(-aa / 0.22) * Math.exp(-(bc / wd) * (bc / wd)) * onset;
      const dk = dust * (0.40 + 0.9 * bil(TN, 256, aa * 45 + 100, (bc / wd) * 2 + 7)) * 0.55;
      r += 1.0 * dk; g += 0.78 * dk; bl += 0.55 * dk;
    }
    const f = C.fade;
    cR = r * f; cG = g * f; cB = bl * f;
  }

  // ---------- the scene above the waterline ----------

  let sR = 0, sG = 0, sB = 0, sM = 0, sD = 0, sK = 0;

  function cnHalfWidth(yp) {
    const k = CN_H / 0.58, yup = yp / k;
    let hw = 0;
    if (yup >= 0 && yup < 0.30) hw = 0.0058 + 0.0092 * Math.pow(1 - yup / 0.30, 1.8);
    else if (yup >= 0.30 && yup < 0.318) hw = mix(0.0060, 0.034, (yup - 0.30) / 0.018);
    else if (yup >= 0.318 && yup < 0.345) {
      const e = (yup - 0.3315) / 0.0135;
      hw = 0.034 * Math.sqrt(Math.max(0, 1 - e * e));
      if (hw < 0.0045) hw = 0.0045;
    } else if (yup >= 0.345 && yup < 0.52) hw = 0.0050 - 0.0030 * ((yup - 0.345) / 0.175);
    else if (yup >= 0.52 && yup <= 0.58) hw = 0.0018 - 0.0010 * ((yup - 0.52) / 0.06);
    if (yup >= 0.352 && yup < 0.362) hw = Math.max(hw, 0.014);
    if (yup >= 0.372 && yup < 0.384) hw = Math.max(hw, 0.0095);
    if (yup >= 0 && yup < 0.04) hw += 0.008 * (1 - yup / 0.04);
    if (yup >= 0.395 && yup < 0.415) {
      const e = (yup - 0.405) / 0.010;
      hw = Math.max(hw, 0.0105 * Math.sqrt(Math.max(0, 1 - e * e)));
    }
    return hw * k;
  }

  function sceneAbove(x, y, t) {
    const h01 = clip((y + 0.5) / (HOR + 0.5), 0, 1);

    // sky: deep blue at the top, pink-orange city glow at the horizon
    const k0 = ss(0, 0.7, h01);
    const gl2 = Math.pow(h01, 4), gl3 = Math.pow(h01, 9);
    let r = mix(0.010, 0.028, k0) + 0.60 * gl2 + 0.30 * gl3;     // orange band, yellow at the very horizon
    let g = mix(0.015, 0.040, k0) + 0.28 * gl2 + 0.26 * gl3;
    let b = mix(0.07, 0.14, k0) * (1 - 0.75 * gl2) + 0.05 * gl3;
    const haze = (bil(TN, 256, x * 6 + t * 0.15, y * 14) - 0.5) * 0.10 * h01;
    r += haze * 0.9; g += haze * 0.6; b += haze * 0.7;

    cometRad(x, y, t);
    r += cR; g += cG; b += cB;

    const cdist = C.on ? Math.hypot(x - C.hx, y - C.hy) : 9;
    const cglow = C.on ? C.fade * Math.exp(-cdist / 0.45) : 0;

    let maxM = 0, dTop = 0, kTop = 0;
    for (let bi = 0; bi < BLD.length; bi++) {
      const B = BLD[bi];
      if (x < B.x0 - 0.01 || x > B.x1 + 0.01 || y < B.top - 0.01) continue;
      let m = 0, br = 0, bg = 0, bb = 0;

      if (B.kind === 'box') {
        const mx = clip((B.hw - Math.abs(x - B.cx)) / PX + 0.5, 0, 1);
        const my = clip((y - B.top) / PX + 0.5, 0, 1);
        m = mx * my;
        if (m <= 0) continue;
        const vg = 0.75 + 0.9 * clip((y - B.top) / B.h, 0, 1);
        br = B.col[0] * vg; bg = B.col[1] * vg; bb = B.col[2] * vg;
        const wx = (x - B.x0) / B.ws;
        const wy = (y - B.top) / B.hs - 0.9;
        const fxm = wx - Math.floor(wx);
        const mull = 0.74 + 0.26 * ss(0.0, 0.18, fxm) * ss(1.0, 0.82, fxm);   // vertical facade lines
        br *= mull; bg *= mull; bb *= mull;
        const ixa = Math.floor(wx), iya = Math.floor(wy);
        const fin = (mod(ixa, 7) === 0) ? 0.70 : 1;                                   // structural fins
        const flr = (wy > 0 && mod(iya, 5) === 0 && (wy - iya) < 0.2) ? 0.60 : 1;    // floor bands
        const side = B.hw > 0.03 ? 0.70 + 0.40 * (1 - (x - B.x0) / (2 * B.hw)) : 1;  // lit from the left
        const fk = fin * flr * side;
        br *= fk; bg *= fk; bb *= fk;
        if (wy > 0 && B.lit > 0) {
          const ix = Math.floor(wx), iy = Math.floor(wy);
          const fx = wx - ix, fy = wy - iy;
          const wm = ss(0.10, 0.28, fx) * ss(0.90, 0.72, fx) * ss(0.12, 0.30, fy) * ss(0.88, 0.70, fy);
          if (wm > 0) {
            const hv = h3(B.seed, ix, iy);
            let lit = hv < B.lit * (0.55 + 0.9 * h3(B.seed + 9, 0, iy));
            if (h3(B.seed ^ 0x9e37, ix, iy) > 0.86) lit = h3(B.seed, ix * 31 + iy, Math.floor(t * 0.15 + hv * 20)) < B.lit * 1.3;
            if (lit) {
              const ck = h3(B.seed + 3, ix, iy);
              const inten = (0.55 + 0.6 * h3(B.seed + 5, ix, iy)) * (0.35 + 0.65 * B.depth);
              let wr, wg, wb;
              if (ck < 0.28) { wr = 1.0; wg = 0.88; wb = 0.36; }         // yellow
              else if (ck < 0.52) { wr = 1.0; wg = 0.62; wb = 0.20; }    // orange
              else if (ck < 0.72) { wr = 1.0; wg = 0.76; wb = 0.44; }    // amber
              else if (ck < 0.88) { wr = 1.0; wg = 0.93; wb = 0.74; }    // warm white
              else { wr = 1.0; wg = 0.44; wb = 0.26; }                   // red-orange
              br = mix(br, wr * inten, wm); bg = mix(bg, wg * inten, wm); bb = mix(bb, wb * inten, wm);
            } else {
              const dk = mix(1, 0.45, wm);
              br *= dk; bg *= dk; bb *= dk;
            }
          }
        }
        // crisp rim: lit left/right edges and roof line separate towers from each other
        const ex = Math.exp(-(B.hw - Math.abs(x - B.cx)) / 0.0035);
        const ey = Math.exp(-(y - B.top) / 0.0035);
        const er = (0.10 * ex + 0.22 * ey) * (0.4 + 0.6 * B.depth) * 0.40;
        br += er * 1.0; bg += er * 0.72; bb += er * 0.42;
        // roof edge catches the comet light
        const edge = Math.exp(-(y - B.top) / 0.006);
        const rim = cglow * edge * 0.55 * B.depth;
        br += rim * 0.55; bg += rim * 0.8; bb += rim * 1.0;
      } else if (B.kind === 'dome') {
        const ex = (x - B.cx) / B.hw, ey = (y - HOR) / B.h;
        const e = Math.sqrt(ex * ex + ey * ey);
        m = clip((1 - e) * B.h / PX + 0.5, 0, 1) * (y < HOR + 0.002 ? 1 : 0);
        if (m <= 0) continue;
        const open = 0.5 - 0.5 * Math.cos(2 * PI * t / DOME_PERIOD);          // 0 closed .. 1 open
        const g = 0.10 + 0.72 * open;                                         // half-width of the opening, as a fraction of the dome radius
        const roofy = -ey;                                                    // 0 at the base .. 1 at the crown
        const yup = HOR - y;
        if (Math.abs(ex) < g && roofy > 0.18) {
          // roof panels have slid apart: warm floodlit interior, brighter toward the crown
          const lights = h3(B.seed, Math.floor((x - B.x0) / (1.1 * CW / H)), 11) < 0.35 ? 0.35 : 0;
          const k = 0.55 + 0.45 * roofy + lights;
          br = 1.0 * k; bg = 0.86 * k; bb = 0.58 * k;
        } else {
          const rib = (0.72 + 0.28 * Math.sin(Math.atan2(ey, ex) * 40)) * (0.86 + 0.14 * Math.cos(e * 30));
          const vg = 0.8 + 0.7 * clip((y - B.top) / B.h, 0, 1);
          br = B.col[0] * vg * rib; bg = B.col[1] * vg * rib; bb = B.col[2] * vg * rib;
          // panel seams: the edge of the sliding panels, and the fixed seam further out
          const seam = Math.exp(-Math.pow((Math.abs(ex) - g) / 0.03, 2)) + 0.6 * Math.exp(-Math.pow((Math.abs(ex) - 0.64) / 0.02, 2));
          br = mix(br, 0.75, 0.55 * seam); bg = mix(bg, 0.85, 0.55 * seam); bb = mix(bb, 1.0, 0.55 * seam);
        }
        if ((yup > 0.004 && yup < 0.011) || (yup > 0.019 && yup < 0.026)) {
          const ix = Math.floor((x - B.x0) / (0.7 * CW / H));
          if (h3(B.seed, ix, yup > 0.015 ? 4 : 3) < 0.72) { br = 0.95; bg = 0.84; bb = 0.60; }
        }
        const rim = cglow * Math.exp(-(1 - e) / 0.05) * 0.5;
        br += rim * 0.55; bg += rim * 0.8; bb += rim * 1.0;
      } else {
        // CN Tower
        const yup = HOR - y;
        if (yup < 0 || yup > CN_H) continue;
        const hw = cnHalfWidth(yup) * 1.9;
        const ad = Math.abs(x - B.cx);
        m = clip((hw - ad) / PX + 0.5, 0, 1) * clip(yup / PX + 0.5, 0, 1) * clip((CN_H - yup) / PX + 0.5, 0, 1);
        const halo = clip(1 - (ad - hw) / 0.008, 0, 1) * (1 - m);
        if (halo > 0) { const dk = 1 - 0.45 * halo; r *= dk; g *= dk; b *= dk; }
        if (m <= 0) continue;
        const yn = yup * 0.58 / CN_H;
        const u = (x - B.cx) / Math.max(hw, 1e-4);                                   // -1..1 across the shaft
        const shade = 0.50 + 0.50 * (1 - u) / 2;                                     // lit from the left
        const ridge = 0.70 + 0.30 * ss(0.0, 0.10, Math.abs(Math.abs(u) - 0.34));     // three-legged ridges
        const ring = 0.84 + 0.16 * ss(0.0, 0.5, Math.abs(mod(yup / 0.026, 1) - 0.5) * 2);
        const grain = 0.94 + 0.12 * bil(TN, 256, u * 3 + 40, yup * 260);             // concrete grain
        const lk = shade * ridge * ring * grain;
        const spot = Math.exp(-yup / 0.13);                                          // warm spotlights at the base
        const tone = clip(yn / 0.30, 0, 1);                                          // warm at the foot, pale violet near the pod
        br = B.col[0] * (0.40 + 0.95 * lk) + (0.26 * spot + 0.07 * tone) * lk;
        bg = B.col[1] * (0.40 + 0.95 * lk) + (0.19 * spot + 0.07 * tone) * lk;
        bb = B.col[2] * (0.40 + 0.95 * lk) + (0.10 * spot + 0.07 * tone) * lk;
        if (yn < 0.29) {
          // lit seams along the ridges with lights running up them
          const sb = 0.5 + 0.5 * Math.sin(yup * 80 - t * 3.0);
          const seam = Math.exp(-Math.pow((Math.abs(u) - 0.34) / 0.06, 2)) * 0.35 * (0.4 + 0.6 * sb);
          br += seam * 1.0; bg += seam * 0.75; bb += seam * 0.40;
          const ax = Math.abs(x - B.cx), lw = Math.min(0.0032, hw * 0.45);
          if (ax < lw) {                                                    // elevator track: a thin lit line down the middle of the shaft
            br += 0.30; bg += 0.22; bb += 0.10;
            if (mod(yup, 0.05) < 0.005) { br += 0.5; bg += 0.35; bb += 0.12; }
          }
          const dyc = Math.abs(yup - ELEV.y);
          if (dyc < 0.012 && ax < Math.min(0.0065, hw * 0.6)) { br = 0.78; bg = 0.80; bb = 0.84; }   // the glass elevator car, light grey
        }

        const wpx = 0.6 * CW / H;
        const cell = Math.floor((x - B.cx) / wpx);
        if (yn >= 0.29 && yn < 0.318) {                                              // pod underside: ribbed cone that warms toward the pod
          const t1 = (yn - 0.29) / 0.028;
          const rb = 0.75 + 0.25 * Math.sin(u * 14);
          br = 0.17 * rb + 0.34 * t1; bg = 0.16 * rb + 0.28 * t1; bb = 0.17 * rb + 0.20 * t1;
        } else if (yn >= 0.318 && yn < 0.345) {                                      // main pod
          if (yn < 0.3205) { br = 0.62; bg = 0.58; bb = 0.50; }                       // lower rim
          else if (yn >= 0.3375) { br = 0.64; bg = 0.58; bb = 0.46; }                 // top rim
          else if ((yn > 0.3205 && yn < 0.3275) || (yn > 0.3295 && yn < 0.3375)) {   // two window rows
            const row = yn < 0.3285 ? 0 : 1;
            const hh = h3(B.seed, cell, row);
            if (hh < 0.9) { br = 0.78; bg = 0.60 + 0.10 * hh; bb = 0.38 + 0.10 * hh; } else { br = 0.27; bg = 0.25; bb = 0.26; }
          } else { br = 0.22; bg = 0.21; bb = 0.22; }
        } else if (yn >= 0.352 && yn < 0.362) {                                      // upper deck ring
          br = 0.70; bg = 0.55; bb = 0.36;
        } else if (yn >= 0.372 && yn < 0.384) {                                      // second, smaller ring
          const hh = h3(B.seed, cell, 5);
          if (hh < 0.8) { br = 0.66; bg = 0.52; bb = 0.34; } else { br = 0.32; bg = 0.27; bb = 0.20; }
        } else if (yn >= 0.396 && yn < 0.414) {                                      // sky pod
          const hh = h3(B.seed, cell, 7);
          if (hh < 0.85) { br = 0.72; bg = 0.60; bb = 0.42; } else { br = 0.38; bg = 0.30; bb = 0.22; }
        } else if (yn >= 0.414 && yn < 0.435) {                                      // lit lower mast
          br = 0.66; bg = 0.56; bb = 0.42;
        } else if (yn >= 0.435 && yn < 0.46) {                                       // red/white banded mast
          if (Math.floor(yn * 150) % 2 === 0) { br = 0.78; bg = 0.75; bb = 0.72; } else { br = 0.66; bg = 0.26; bb = 0.22; }
        } else if (yn >= 0.46) { br = 0.80; bg = 0.76; bb = 0.70; }                   // spire
        const rim = cglow * cglow * 0.30;
        br += rim * 0.5; bg += rim * 0.75; bb += rim * 1.0;
      }

      r = mix(r, br, m); g = mix(g, bg, m); b = mix(b, bb, m);
      { const mm = m * (0.55 + 0.45 * B.depth); if (mm > maxM) maxM = mm; }
      if (m > 0.5) { dTop = B.depth; kTop = B.kind === 'cn' ? 3 : (B.kind === 'dome' ? 2 : 1); }
    }

    // light spilling out of the open Rogers Centre roof
    {
      const dm = BLD.find((q) => q.kind === 'dome');
      if (dm) {
        const o = 0.5 - 0.5 * Math.cos(2 * PI * t / DOME_PERIOD);
        const gdome = 0.10 + 0.72 * o;
        const above = dm.top - y;
        if (above > 0 && o > 0.03) {
          const dxn = Math.abs((x - dm.cx) / dm.hw);
          const gk = o * 0.30 * Math.exp(-above / 0.045) * ss(gdome + 0.30, gdome - 0.10, dxn);
          r += gk * 1.0; g += gk * 0.78; b += gk * 0.40;
        }
      }
    }

    // red beacon on the antenna
    const beacon = (Math.sin(t * 3.4) > 0.2) ? 1.0 : 0.15;
    const bx = x - CN_X, by = y - (HOR - CN_H);
    const br2 = bx * bx + by * by;
    const bk = beacon * (1.4 * Math.exp(-br2 / 0.000012) + 0.25 * Math.exp(-br2 / 0.0003));
    r += bk * 1.0; g += bk * 0.08; b += bk * 0.06;
    const beacon2 = (Math.sin(t * 3.4 + PI) > 0.2) ? 1.0 : 0.15;
    const b2y = y - (HOR - CN_H * 0.76);
    const bk2 = beacon2 * 0.8 * Math.exp(-(bx * bx + b2y * b2y) / 0.000010);
    r += bk2; g += bk2 * 0.08; b += bk2 * 0.06;
    const pyc = y - (HOR - CN_H * 0.331 / 0.58);
    const halo = 0.14 * Math.exp(-(bx * bx / 0.0016 + pyc * pyc / 0.0009));
    r += halo * 1.0; g += halo * 0.65; b += halo * 0.30;

    sR = r; sG = g; sB = b; sM = maxM; sD = dTop; sK = kTop;
  }

  // ---------- post ----------

  function bloom(img, jwRow) {
    const out = Float32Array.from(img);
    const b = new Float32Array(img.length);
    for (let i = 0; i < img.length; i++) b[i] = Math.max(img[i] - 0.45, 0);
    for (const [f, w_] of [[2, 0.40], [4, 0.30], [8, 0.26]]) {
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
          const wk = w_ * (y >= jwRow ? 0.22 : 1);                       // far less bloom on the water
          out[p] += wk * s_[sp_]; out[p + 1] += wk * s_[sp_ + 1]; out[p + 2] += wk * s_[sp_ + 2];
        }
      }
    }
    return out;
  }

  // ---------- stamping ----------

  function stampStars(idx, fg, L, sky, t, amt, tl) {
    if (amt <= 0.003) return;
    const sel = [];
    for (let i = 0; i < ST.n; i++) {
      const sx = mod(ST.x[i] + 0.004 * t + ST.xmax, 2 * ST.xmax) - ST.xmax;
      const sy = ST.y[i];
      const c = Math.trunc((W * 0.5 + sx * H) / CW);
      const r = Math.trunc((H * 0.5 + sy * H) / CH);
      const h01 = clip((sy + 0.5) / (HOR + 0.5), 0, 1);
      const alpha = (0.80 + 0.20 * Math.sin(t * ST.f[i] + ST.ph[i])) * amt * (1 - 0.92 * ss(0.25, 0.95, h01));
      if (!(c >= 0 && c < COLS && r >= 0 && r < ROWS && alpha > 0.04)) continue;
      const cell = r * COLS + c;
      if (sky[cell] > 0.05) continue;
      const b = ST.b[i] * alpha * 0.8;
      if (!(b > L[cell] * 0.7)) continue;
      sel.push([i, r, c, b]);
    }
    for (const [i, r, c, b] of sel) {
      const cell = r * COLS + c;
      idx[cell] = b < 0.14 ? CIDX['.'] : (b < 0.32 ? CIDX['+'] : CIDX['*']);
      const kk = clip(0.35 + 0.9 * b, 0, 1);
      fg[cell * 3] = ST.col[i * 3] * kk; fg[cell * 3 + 1] = ST.col[i * 3 + 1] * kk; fg[cell * 3 + 2] = ST.col[i * 3 + 2] * kk;
    }
    let nbig = 0;
    for (const [i, rr_, cc_, bb] of sel) {
      if (!(bb > 0.5)) continue;
      if (nbig++ >= 25) break;
      const cell = rr_ * COLS + cc_;
      idx[cell] = bb > 0.8 ? CIDX['@'] : CIDX['*'];
      const ln = Math.trunc(1 + 5 * (bb - 0.45));
      for (let k = 1; k <= ln; k++) {
        const a = (1 - k / (ln + 1)) * bb;
        const v = Math.floor(k / 2) + (k > 2 ? 1 : 0);
        for (const [dr, dc, chh] of [[0, k, '-'], [0, -k, '-'], [v, 0, '|'], [-v, 0, '|']]) {
          if (dr === 0 && dc === 0) continue;
          const r2 = rr_ + dr, c2 = cc_ + dc;
          if (r2 < 0 || r2 >= ROWS || c2 < 0 || c2 >= COLS) continue;
          const p2 = r2 * COLS + c2;
          if (sky[p2] > 0.05 || L[p2] >= a * 0.8) continue;
          idx[p2] = CIDX[a > 0.16 ? chh : '.'];
          const m_ = Math.min(1.0, 0.25 + a);
          fg[p2 * 3] = ST.col[i * 3] * m_; fg[p2 * 3 + 1] = ST.col[i * 3 + 1] * m_; fg[p2 * 3 + 2] = ST.col[i * 3 + 2] * m_;
        }
      }
    }
  }

  // elevator track and car as characters, so they read at any resolution (the shaded image alone is under one cell wide)
  function stampElevator(idx, fg) {
    if (!LAYERS.tower.on) return;
    const c0 = Math.trunc((W / 2 + CN_X * H) / CW);
    const yTop = CN_H * 0.285 / 0.58;
    const rowOf = (yup) => Math.trunc((H / 2 + (HOR - yup) * H) / CH);
    const inb = (r, c) => r >= 0 && r < ROWS && c >= 0 && c < COLS;
    const put = (r, c, ch, cr, cg, cb) => {
      if (!inb(r, c)) return;
      const p = r * COLS + c;
      idx[p] = CIDX[ch];
      fg[p * 3] = cr; fg[p * 3 + 1] = cg; fg[p * 3 + 2] = cb;
    };
    for (let r = rowOf(yTop); r <= rowOf(0.02); r++) {           // track: a thin dim amber '|'
      put(r, c0, '|', 0.70, 0.50, 0.24);
    }
    const rc = rowOf(ELEV.y);
    for (let dr = 0; dr <= 1; dr++) {                            // the car: two rows of [@]
      put(rc - dr, c0 - 1, '[', 0.62, 0.64, 0.68); put(rc - dr, c0, '@', 0.88, 0.90, 0.94); put(rc - dr, c0 + 1, ']', 0.62, 0.64, 0.68);
    }
  }

  function stampCometHead(idx, fg, sky) {
    if (!C.on || C.fade < 0.2) return;
    const c = Math.trunc((W / 2 + C.hx * H) / CW), r = Math.trunc((H / 2 + C.hy * H) / CH);
    const put = (rr, cc, ch, a) => {
      if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS || sky[rr * COLS + cc] > 0.3) return;
      const p = rr * COLS + cc;
      idx[p] = CIDX[ch];
      fg[p * 3] = 0.80 * a; fg[p * 3 + 1] = 0.86 * a; fg[p * 3 + 2] = 0.90 * a;
    };
    put(r, c, '@', 1);
    put(r, c - 1, '*', 0.85); put(r, c + 1, '*', 0.85);
    put(r - 1, c, '*', 0.7); put(r + 1, c, '*', 0.7);
  }

  // ---------- frame ----------

  function renderCells(t) {
    const tl = t % LOOP;
    const master = ease(tl / 1.5) * ease((LOOP - tl) / 1.5);
    cometPlace(tl);

    // elevator: eases up to just under the pod, pauses, and comes back down
    const ep = (t / ELEV_PERIOD) % 1;
    const es = ep < 0.5 ? ease(ep * 2) : 1 - ease(ep * 2 - 1);
    ELEV.y = 0.03 + es * (CN_H * 0.285 / 0.58 - 0.045);

    const img = new Float32Array(GW * GH * 3);
    const smask = new Float32Array(GW * GH);
    const sdep = new Float32Array(GW * GH);
    const skind = new Uint8Array(GW * GH);
    const crestBuf = new Float32Array(GW * GH);
    const waterH = 0.5 - HOR;

    // pass 1: sky + skyline above the waterline
    let jw = GH;
    for (let j = 0; j < GH; j++) {
      if (Y[j * GW] >= HOR) { jw = j; break; }
      for (let i = 0; i < GW; i++) {
        const p = j * GW + i;
        sceneAbove(X[p], Y[p], t);
        img[p * 3] = sR; img[p * 3 + 1] = sG; img[p * 3 + 2] = sB;
        smask[p] = sM;
        sdep[p] = sD;
        skind[p] = sK;
      }
    }

    // pass 2: Gerstner water. Each water pixel is a point on the lake plane seen through a perspective camera;
    // the Gerstner surface gives a normal, the view ray is reflected about it, and the reflected ray is projected
    // back into the pass-1 image to find what the water mirrors. Fresnel decides how much of it shows.
    const rowH = CH / SS, colW = CW / SS;
    const nW = WAVES.length;
    const fade = new Float32Array(nW);
    for (let j = jw; j < GH; j++) {
      const yy = Y[j * GW] - HOR;
      const d = yy / waterH;
      const zw = CAM_H / yy;                       // distance of this row from the camera
      const foot = CAM_H / (GH * yy * yy);         // world depth covered by one sub-pixel row
      for (let wi = 0; wi < nW; wi++) fade[wi] = clip(WAVES[wi].lam / (foot * 9) - 0.6, 0, 1);   // drop waves too small to resolve
      const taps = 3 + Math.floor(d * 5);
      for (let i = 0; i < GW; i++) {
        const p = j * GW + i;
        const x = X[p];
        const xw = x * zw;

        let gx = 0, gz = 0, sT = 0;
        for (let wi = 0; wi < nW; wi++) {
          const W_ = WAVES[wi];
          const th = W_.k * (W_.dx * xw + W_.dz * zw) - W_.w * t;
          const f = fade[wi] * W_.A * W_.k;
          const c = Math.cos(th), sn = Math.sin(th);
          gx += W_.dx * f * c; gz += W_.dz * f * c; sT += W_.Q * f * sn;
        }
        let nx = -gx * SLOPE, nz = -gz * SLOPE, ny = 1 - sT * SLOPE;
        const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx /= nl; ny /= nl; nz /= nl;

        const vl = Math.sqrt(x * x + yy * yy + 1);
        const vx = x / vl, vy = -yy / vl, vz = 1 / vl;                 // view ray, y up
        const dot = vx * nx + vy * ny + vz * nz;
        const rx = vx - 2 * dot * nx;
        const ry = Math.max(vy - 2 * dot * ny, 0.002);
        const rz = Math.max(vz - 2 * dot * nz, 0.05);
        const xr = rx / rz;                                            // where the reflected ray lands on screen
        const ys = HOR - ry / rz;
        const jm = clip((ys * H + H / 2) / rowH - 0.5, 0, jw - 1.001);
        const j0 = Math.floor(jm), jf = jm - j0;

        let rr = 0, gg = 0, bb = 0;
        for (let k = 0; k < taps; k++) {
          const xm = xr + (k - (taps - 1) / 2) * 0.0035 * (1 + 2 * d);
          const fi = clip((xm * H + W / 2) / colW - 0.5, 0, GW - 1.001);
          const i0 = Math.floor(fi), f = fi - i0;
          for (let ch = 0; ch < 3; ch++) {
            const a0 = img[(j0 * GW + i0) * 3 + ch] * (1 - f) + img[(j0 * GW + i0 + 1) * 3 + ch] * f;
            const a1 = img[((j0 + 1) * GW + i0) * 3 + ch] * (1 - f) + img[((j0 + 1) * GW + i0 + 1) * 3 + ch] * f;
            const v = a0 * (1 - jf) + a1 * jf;
            if (ch === 0) rr += v; else if (ch === 1) gg += v; else bb += v;
          }
        }
        rr /= taps; gg /= taps; bb /= taps;

        const cosi = clip(-dot, 0, 1);
        const F = 0.02 + 0.98 * Math.pow(1 - cosi, 5);                 // Schlick Fresnel
        const crest = clip(sT * SLOPE, 0, 1);
        const sub = crest * (1 - 0.6 * d);                             // light scattering through thin crests
        let r = 0.012 + 0.008 * (1 - d) + 0.02 * sub + rr * F * 0.80;
        let g = 0.024 + 0.014 * (1 - d) + 0.06 * sub + gg * F * 0.80;
        let b = 0.055 + 0.030 * (1 - d) + 0.08 * sub + bb * F * 0.80;
        crestBuf[p] = crest;
        const foam = clip((sT * SLOPE - 0.32) * 3, 0, 1) * (1 - d) * 0.5;   // whitecaps on steep crests
        r += foam * 0.7; g += foam * 0.8; b += foam * 0.9;
        img[p * 3] = r; img[p * 3 + 1] = g; img[p * 3 + 2] = b;
      }
    }

    const bl = bloom(img, jw);
    for (let j = 0; j < GH; j++) {
      for (let i = 0; i < GW; i++) {
        const p = j * GW + i;
        const k = (1 - 0.28 * ss(0.5, 1.1, RS[p])) * master;
        for (let ch = 0; ch < 3; ch++) {
          const v = Math.max(bl[p * 3 + ch], 0);
          bl[p * 3 + ch] = (1 - Math.exp(-2.0 * v)) * k;
        }
      }
    }

    // ---- layered cell compositor ----
    const idx = new Int32Array(ROWS * COLS);
    const fg = new Float32Array(ROWS * COLS * 3);
    const bg = new Float32Array(ROWS * COLS * 3);
    const li = new Float32Array(ROWS * COLS);
    const sky = new Float32Array(ROWS * COLS);   // building coverage per cell
    if (!waterPrev || waterPrev.length !== ROWS * COLS * 3) { waterPrev = new Float32Array(ROWS * COLS * 3); wpReady = false; }
    const inv = 1 / (SS * SS);
    const pick = (fam, v) => fam[Math.trunc(clip(v, 0, 0.999) * fam.length)];
    for (let r = 0; r < ROWS; r++) {
      const yc = ((r + 0.5) * CH - H / 2) / H;
      for (let c = 0; c < COLS; c++) {
        let R = 0, G = 0, B = 0, M = 0, DS = 0, DN = 0, nT = 0, nD = 0, crest = 0;
        for (let a = 0; a < SS; a++) {
          for (let b = 0; b < SS; b++) {
            const pp = (r * SS + a) * GW + (c * SS + b);
            R += bl[pp * 3]; G += bl[pp * 3 + 1]; B += bl[pp * 3 + 2]; M += smask[pp]; crest += crestBuf[pp];
            if (sdep[pp] > 0) { DS += sdep[pp]; DN++; if (skind[pp] === 3) nT++; else if (skind[pp] === 2) nD++; }
          }
        }
        R *= inv; G *= inv; B *= inv; M *= inv; crest *= inv;
        const cell = r * COLS + c;
        sky[cell] = M;
        if (yc > HOR + 0.004) {                                // water: smooth over time so the surface settles instead of flickering
          const wp = cell * 3;
          if (wpReady) {
            R = waterPrev[wp] += (R - waterPrev[wp]) * WSMOOTH;
            G = waterPrev[wp + 1] += (G - waterPrev[wp + 1]) * WSMOOTH;
            B = waterPrev[wp + 2] += (B - waterPrev[wp + 2]) * WSMOOTH;
          } else { waterPrev[wp] = R; waterPrev[wp + 1] = G; waterPrev[wp + 2] = B; }
        }
        const lum = 0.30 * R + 0.60 * G + 0.10 * B;
        const l = Math.pow(clip(lum, 0, 1), 0.72);
        li[cell] = l;
        const hs = HSC[cell];

        // which body layer owns this cell
        const water = yc > HOR + 0.004;
        let key = 'sky', lift = 0;
        if (water) key = 'water';
        else if (M > 0.5 && DN > 0) {
          const dep = DS / DN;
          if (nT * 2 >= DN) key = 'tower';
          else if (nD * 2 >= DN) key = 'dome';
          else if (dep <= 0.50) key = 'far';
          else if (dep <= 0.65) key = 'back';
          else if (dep <= 0.82) key = 'mid';
          else key = 'front';
          lift = { far: 0.03, back: 0.07, mid: 0.13, front: 0.22, tower: 0.20, dome: 0.15 }[key];
        }
        const L = LAYERS[key];

        // background layer: smooth colour field (black when the body layer is off)
        if (L.on) {
          // the tower's background follows its brightness: the dark shaft stays dark, lit pod windows, rims and the spire fill in
          let bk = L.bg;
          if (key === 'tower') bk += 0.28 * clip((l - 0.55) / 0.30, 0, 1);   // only the lit decks and spire keep a background fill; the shaft is left to its characters
          if (key === 'sky' && C.on) {                               // the comet keeps a background tint so its outline reads clearly
            cometRad(((c + 0.5) * CW - W / 2) / H, yc, t);
            const lc = 0.30 * cR + 0.60 * cG + 0.10 * cB;
            bk += 0.55 * Math.pow(clip(lc / 0.35, 0, 1), 0.8);
          }
          bg[cell * 3] = clip(R * bk, 0, 1); bg[cell * 3 + 1] = clip(G * bk, 0, 1); bg[cell * 3 + 2] = clip(B * bk, 0, 1);
        }

        // character layers: sparse glyphs on top, brighter than the background
        let ch = '', wop = 1, sop = 0;
        if (L.on && L.chars) {
          if (key === 'sky') {
            // sparse characters whose density, weight and brightness follow the sky gradient; the dark top fades out to black
            const hs2 = (hs * 13.7) % 1;
            if (hs < L.density * Math.pow(clip((l - 0.015) / 0.38, 0, 1), 0.9)) {
              ch = pick(SKY_FAM, l * 1.5 + (hs2 - 0.5) * 0.42);
              sop = clip(0.30 + 1.4 * l, 0.22, 1) * (0.40 + 0.60 * hs2);
            }
          }
          else if (key === 'tower') {
            const lv = clip((l - 0.25) / 0.7, 0, 1);               // shaft: few light marks; pod and spire: dense
            if (hs < L.density * (0.45 + 0.55 * lv * lv)) ch = pick(TOWER_FAM, lv * lv * 0.95 + 0.02);
          }
          else if (key === 'dome') { if (hs < L.density + (1 - L.density) * 0.45 * clip((l - 0.45) / 0.3, 0, 1)) ch = pick(DOME_FAM, (l - 0.05) / 0.9 + (hs - 0.5) * 0.15); }
          else if (key !== 'water') {
            if (hs < L.density + (1 - L.density) * 0.55 * clip((l - 0.45) / 0.3, 0, 1)) ch = pick(FAMS[{ far: 0, back: 1, mid: 2, front: 3 }[key]][1], (l - 0.08) / 0.85 + (hs - 0.5) * 0.12);
          }
        }
        if (water && LAYERS.water.on) {
          // sparse characters carry the water; brighter reflections get more characters, a heavier glyph and more opacity
          const rp = LAYERS.ripple, rf = LAYERS.reflect;
          const lw = clip((l - 0.04) / 0.5, 0, 1);
          const hs2 = (hs * 13.7) % 1;
          if (rf.on && rf.chars && l > 0.20 && hs < rf.density * lw) {
            ch = pick(REFLECT_FAM, hs2);                                   // glints of lit windows
            wop = clip(0.40 + 0.90 * l + (hs2 - 0.5) * 0.25, 0.30, 1);
          } else if (rp.on && rp.chars && hs2 < rp.density) {
            // character-led waves: crests are slanted or flat marks that follow the wave slope, troughs are faint dots
            charWave(((c + 0.5) * CW - W / 2) / H, yc - HOR, t);
            const wv = cwW, sl = cwS;
            if (wv > 0.30) {
              ch = sl > 0.55 ? '/' : (sl < -0.55 ? '\\' : (wv > 0.60 ? '=' : '~'));
              wop = clip(0.30 + 1.0 * wv, 0.25, 1);
            } else if (wv < -0.32) {
              ch = hs < 0.5 ? '.' : ',';
              wop = clip(0.18 - 0.6 * wv, 0.15, 0.6);
            }
          }
        }
        if (ch) {
          idx[cell] = CIDX[ch];
          if (key === 'sky') {                                  // muted sky characters: colour pulled toward grey, scaled by their own opacity
            const mc = (v) => clip((v + (lum - v) * 0.30) * 2.2 * sop, 0, 1);
            fg[cell * 3] = mc(R); fg[cell * 3 + 1] = mc(G); fg[cell * 3 + 2] = mc(B);
          } else if (water) {                                   // water characters: colour of the reflection, scaled by their own opacity
            fg[cell * 3] = clip((0.24 + 1.7 * R) * wop, 0, 1); fg[cell * 3 + 1] = clip((0.27 + 1.7 * G) * wop, 0, 1); fg[cell * 3 + 2] = clip((0.32 + 1.7 * B) * wop, 0, 1);
          } else {
            const tg = key === 'tower' ? 1.9 : 1.4, ta = key === 'tower' ? 0.12 : 0.06;     // tower characters are brighter so the shaft holds its shape on the dark sky
            fg[cell * 3] = clip(R * tg + lift * 0.8 + ta, 0, 1);
            fg[cell * 3 + 1] = clip(G * tg + lift * 0.9 + ta, 0, 1);
            fg[cell * 3 + 2] = clip(B * tg + lift + ta, 0, 1);
          }
        }
      }
    }

    wpReady = true;

    // top layers: stars and the comet head, drawn over the background and character layers
    if (LAYERS.stars.on) stampStars(idx, fg, li, sky, t, ease((tl - 0.5) / 3.0) * master * 0.7, tl);
    if (LAYERS.comet.on) stampCometHead(idx, fg, sky);
    stampElevator(idx, fg);

    const q = new Int16Array(ROWS * COLS * 3);
    const bq = new Int16Array(ROWS * COLS * 3);
    for (let i = 0; i < q.length; i++) {
      q[i] = clip(Math.trunc(clip(fg[i], 0, 1) * (QL - 0.01)), 0, QL - 1);
      bq[i] = clip(Math.trunc(clip(bg[i], 0, 1) * (QL - 0.01)), 0, QL - 1);
    }
    return { idx, q, bq };
  }

  const api = {
    init, renderCells, layers: LAYERS, RAMP, QL, FPS, MAXROWS, LOOP, ASPECT,
    dims: () => ({ CW, CH, ROWS, COLS, W, H }),
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
