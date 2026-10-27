// A hypnotised eye: heavy drooping lids, and an iris replaced by a black-and-white spiral vortex.
//
// The eye (lid curves, skin, sclera, lashes) follows ../eyeTutorial/eye.py. The iris is a logarithmic spiral that spins
// and pulls inward; the same spiral ripples faintly outward across the skin. A per-pixel shader fills an image and records
// which layer owns each pixel, then a cell compositor gives every character cell a background colour and a character.
//
// Layers: skin (with faint spiral ripples), brow, sclera, vortex (the iris), lid (the lash line), lashes (stamped).
const Hypnosis = (function () {
  'use strict';

  const { MT } = (typeof module !== 'undefined' && module.exports) ? require('./rng.js') : window.RNG;
  const f32 = Math.fround;
  const PI = Math.PI;
  const TAU = 2 * PI;

  const FPS = 30;
  const MAXROWS = 30;           // same as eye.js

  // eye geometry in "eye units" (same as eye.py)
  const WO = 0.78;               // half-width of the eye opening
  const HU = 0.30, HL = 0.20;    // upper / lower lid height, as in eye.py
  const RI = 0.27;               // iris radius, as in eye.py

  const RAMP = ' .\'`^",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$';
  const CIDX = {};
  for (let i = 0; i < RAMP.length; i++) CIDX[RAMP[i]] = i;
  const QL = 32;
  const NR = RAMP.length - 1;

  const rng = new MT().initGenrand(5);

  // Layers: bg = strength of the background colour field, chars = draw characters, density = fraction of cells with a character
  const LAYERS = {
    skin:   { on: true, bg: 0, chars: true, density: 0.60 },   // bg: strength of the cell background colour
    brow:   { on: true, bg: 0, chars: true, density: 0.90 },
    sclera: { on: true, bg: 0, chars: true, density: 0.70 },   // a light field, so the white of the eye reads against the darker skin and lids
    vortex: { on: true, bg: 0, chars: true, density: 1.00 },
    lid:    { on: true, bg: 0, chars: true, density: 1.00 },
    lashes: { on: true },
  };
    const OPTS = { speed: 1.0, sat: 0.80 };   // sat: 0 = grey characters, 1 = the natural colours, above 1 = pushed

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

  const TS = tex2d(512, [6, 20, 64, 160]);                    // skin
  const TW = randArr(512 * 512);                              // white noise: brow hairs, specks
  const TV2 = (() => {                                        // veins in the sclera
    const t = tex2d(512, [3, 7, 16]);
    for (let i = 0; i < t.length; i++) t[i] = 1 - Math.abs(2 * t[i] - 1);
    return t;
  })();

  // lashes, same layout as eye.py
  const UP_L = [], LO_L = [];
  {
    const lr = new MT().initByArray([21]);
    for (let i = 0; i < 44; i++) UP_L.push([-0.92 + 1.84 * i / 43, lr.uniform(0.92, 1.08)]);
    for (let i = 0; i < 20; i++) LO_L.push([-0.70 + 1.40 * i / 19, lr.uniform(0.90, 1.10)]);
  }

  // ---------- geometry ----------

  let CW, CH, ROWS, COLS, W, H, GW, GH, SS = 1;
  let X, Y, RS, HSC;

  function init(cw, ch, rows, aspect) {
    CW = cw; CH = ch;
    ROWS = rows - (rows % 2);
    SS = 2;
    COLS = Math.trunc(ROWS * ch * 1.40 / cw);         // ASPECT 1.40 like eye.js, whatever the window shape
    COLS = COLS - (COLS % 2);
    W = COLS * CW; H = ROWS * CH;
    GW = COLS * SS; GH = ROWS * SS;
    X = new Float32Array(GW * GH);
    Y = new Float32Array(GW * GH);
    RS = new Float32Array(GW * GH);
    for (let j = 0; j < GH; j++) {
      const yv = f32(((j + 0.5) * (CH / SS) - H / 2) / H);
      for (let i = 0; i < GW; i++) {
        const xv = f32(((i + 0.5) * (CW / SS) - W / 2) / H);
        X[j * GW + i] = xv; Y[j * GW + i] = yv; RS[j * GW + i] = Math.sqrt(xv * xv + yv * yv);
      }
    }
    HSC = new Float32Array(ROWS * COLS);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const hh = (BigInt(r) * 73856093n) ^ (BigInt(c) * 19349663n) ^ 0x5bd1e995n;
        HSC[r * COLS + c] = Number(hh % 1009n) / 1009.0;
      }
    }
  }

  // ---------- motion ----------

  const BLINK_PERIOD = 7.3;
  function blinkC(t) {
    const p = (t % BLINK_PERIOD) - 5.6;                  // slow, sluggish blink: close, hold, reopen
    if (p < 0) return 0;
    if (p < 0.55) return ease(p / 0.55);
    if (p < 0.75) return 1;
    if (p < 2.10) return 1 - ease((p - 0.75) / 1.35);
    return 0;
  }

  const P = { Z: 1, ou: 0.6, gx: 0, gy: 0, spin: 0, pull: 0, t: 0 };

  function frameParams(t) {
    const s = t * OPTS.speed;
    P.t = t;
    // the lids open slowly, then sag and lift with a heavy, drowsy rhythm
    const wake = ease((t - 0.9) / 2.4);
    const sag = 0.93 + 0.05 * Math.sin(s * 0.62) + 0.02 * Math.sin(s * 1.7 + 1.0);
    P.ou = wake * sag * (1 - 0.97 * blinkC(s));
    // slow push-in toward the iris and back out, like being drawn in
    P.Z = 1 + 0.05 * ease(t / 5.4) + 0.004 * Math.sin(t * 0.9);        // idle zoom of eye.py
    // steady, unblinking stare with the smallest drift
    P.gx = 0.006 * Math.sin(s * 0.41); P.gy = 0.004 * Math.sin(s * 0.33 + 1.0);
    P.spin = s * 1.9;                                      // rotation of the spiral
    P.pull = s * 2.2;                                      // inward pull
  }

  // ---------- the vortex ----------

  // white amount (0..1) of a black-and-white logarithmic spiral at offset (dx, dy) from the iris centre, r in iris radii
  const ARMS = 2, TIGHT = 2.4;
  function vortex(dx, dy, r) {
    const th = Math.atan2(dy, dx);
    const ph = ARMS * th - P.spin * 2.0 + TIGHT * Math.log(r + 0.11) + P.pull;
    const sn = Math.sin(ph);
    // crisp bands: soften the edge a little, more toward the centre where the bands get thin
    const w = 0.04 + 0.16 * Math.exp(-r * 5);        // hard edges, so the bands stay crisp on a coarse grid
    return ss(-w, w, sn);
  }

  // ---------- the per-pixel shader ----------

  const OWN = { none: 0, skin: 1, brow: 2, sclera: 3, vortex: 4, lid: 5 };
  let sR = 0, sG = 0, sB = 0, sO = 0, sW = 0;

  function shade(x, y) {
    const Z = P.Z, ou = P.ou;
    const iz = 1 / Z;
    const px = iz / GH;
    const u = x * iz, v = y * iz;
    const gx = P.gx, gy = P.gy;
    const pmu = u - gx, pmv = v - gy;
    const r = Math.sqrt(pmu * pmu + pmv * pmv);

    // eye opening
    const s = u / WO;
    const sa = clip(s, -1.3, 1.3);
    const wu = sa < -0.12 ? 0.88 : 1.12;
    const cu = Math.pow(clip(1 - Math.pow((sa + 0.12) / wu, 2), 0, 1), 0.8);
    const cl = Math.pow(clip(1 - (sa - 0.08) * (sa - 0.08), 0, 1), 0.9);
    const vt = v + 0.055 * s;
    const vc = 0.03 * cl;
    const vl = vc + (HL * cl - vc) * (0.35 + 0.65 * ou);
    const vu = vl + (-HU * cu - vl) * ou;
    const du_in = vt - vu, dl_in = vl - vt;
    const d_in = Math.min(du_in, dl_in);
    const m_in = clip(d_in / (1.6 * px) + 0.5, 0, 1);

    // ----- inside the opening: sclera + vortex iris -----
    const cw = ss(0.40, 0.95, Math.abs(s));
    const shd = (0.38 + 0.62 * ss(0, 0.22, du_in)) * (0.72 + 0.28 * ss(0, 0.10, dl_in)) * (1 - 0.30 * cw);
    let scR = 1.0 * shd, scG = 0.99 * shd, scB = 0.97 * shd;
    scR = mix(scR, 0.86 * shd, cw * 0.35); scG = mix(scG, 0.52 * shd, cw * 0.35); scB = mix(scB, 0.48 * shd, cw * 0.35);
    const vein = clip((bil(TV2, 512, u * 85 + 40, v * 85 + 70) - 0.925) * 14, 0, 1) * (0.25 + 0.75 * cw) * ss(0.12 + RI * 0.5, 0.32 + RI * 0.5, Math.abs(pmu));
    scR = mix(scR, 0.62, vein * 0.6); scG = mix(scG, 0.18, vein * 0.6); scB = mix(scB, 0.16, vein * 0.6);

    const rn = r / RI;
    const im = clip((RI - r) / (1.6 * px) + 0.5, 0, 1);
    let vw = 0, vR = 0, vG = 0, vB = 0;
    if (im > 0) {
      vw = vortex(pmu, pmv, rn);
      // hazel: amber-brown near the pupil, shading to olive green toward the rim, with fine radial fibres
      const ang = Math.atan2(pmv, pmu);
      const fib = 0.78 + 0.22 * bil(TW, 512, ang * 40 + 7, rn * 30);
      const gr = ss(0.25, 0.85, rn);                                    // 0 = brown centre, 1 = green rim
      let lr = mix(0.92, 0.55, gr), lg = mix(0.62, 0.66, gr), lb = mix(0.22, 0.20, gr);   // light arms: gold -> yellow-green
      let dr = mix(0.26, 0.20, gr), dg = mix(0.13, 0.17, gr), db = mix(0.05, 0.06, gr);   // dark arms: deep brown -> dark olive
      let k = vw;
      const ring = ss(0.84, 0.88, rn) * (1 - ss(0.94, 0.97, rn));       // a darker limbal ring just inside the rim
      const pupil = ss(0.12, 0.05, rn);
      const edgeDark = ss(0.93, 1.0, rn);
      vR = mix(dr, lr, k) * fib; vG = mix(dg, lg, k) * fib; vB = mix(db, lb, k) * fib;
      vR *= 1 - 0.55 * ring; vG *= 1 - 0.55 * ring; vB *= 1 - 0.55 * ring;
      vR *= 1 - pupil; vG *= 1 - pupil; vB *= 1 - pupil;                // black pupil at the heart
      const lidSh = 0.62 + 0.38 * ss(0, 0.07, du_in);                    // the upper lid shades the iris
      vR *= lidSh * (1 - edgeDark); vG *= lidSh * (1 - edgeDark); vB *= lidSh * (1 - edgeDark);
      // two small wet highlights
      const g1 = Math.hypot(pmu - 0.095, pmv + 0.085), g2 = Math.hypot(pmu + 0.070, pmv - 0.080);
      const hl = clip(1 - (g1 - 0.030) / (1.4 * px + 0.004), 0, 1) + 0.5 * clip(1 - (g2 - 0.010) / (1.4 * px + 0.003), 0, 1);
      vR = Math.min(1, vR + hl); vG = Math.min(1, vG + hl); vB = Math.min(1, vB + hl);
    }
    let inR = mix(scR, vR, im), inG = mix(scG, vG, im), inB = mix(scB, vB, im);

    // ----- skin around the eye -----
    const mid = 0.5 * (vu + vl);
    const upper = vt < mid;
    const du = Math.max(vu - vt, 0), dl = Math.max(vt - vl, 0);
    const dd = upper ? du : dl;
    const tx = bil(TS, 512, u * 120 + 100, v * 120 + 100);
    const bk = 0.90 + 0.20 * tx;
    let kR = 0.72 * bk, kG = 0.52 * bk, kB = 0.40 * bk;          // slightly muted skin so the vortex is the colour-free focus
    let sh = 0.50 + 0.50 * ss(0, 0.30, dd);
    sh *= 1 + 0.10 * Math.exp(-Math.pow((v + 0.20) / 0.09, 2));
    const cr_pos = 0.075 + 0.03 * (1 - ou);
    if (upper) sh *= 1 - 0.42 * Math.exp(-Math.pow((du - cr_pos) / 0.020, 2));
    else sh *= 1 + 0.08 * Math.exp(-Math.pow((dl - 0.09) / 0.04, 2));
    kR *= sh; kG *= sh; kB *= sh;
    const lidzone = upper ? ss(cr_pos, cr_pos * 0.4, du) : 0;
    kR = mix(kR, 0.62 * sh, lidzone * 0.5); kG = mix(kG, 0.38 * sh, lidzone * 0.5); kB = mix(kB, 0.30 * sh, lidzone * 0.5);
    const rimK = upper ? ss(0.16, 0.0, du) : ss(0.06, 0.0, dl);          // the lid margin: a dark, warm band hugging the opening
    kR = mix(kR, 0.30, rimK * 0.90); kG = mix(kG, 0.10, rimK * 0.90); kB = mix(kB, 0.08, rimK * 0.90);

    // the spiral spills over the skin as very faint ripples, fading with distance from the iris
    const rr = Math.hypot(u - gx, v - gy);
    if (rr > RI) {
      const fade = Math.exp(-(rr - RI) / 0.45);
      const rp = vortex(u - gx, v - gy, rr / RI);
      const k = 1 + 0.10 * fade * (2 * rp - 1);
      kR *= k; kG *= k; kB *= k;
    }

    // brow
    const sb = clip(1 - Math.abs(s), 0, 1);
    const eb = Math.exp(-Math.pow((vt + 0.42 + 0.10 * s * s) / (0.040 + 0.012 * sb), 2));
    const hair = 0.55 + 0.9 * bil(TW, 512, u * 90, v * 30);
    const browM = clip(eb * hair, 0, 0.92);
    kR = mix(kR, 0.10, browM); kG = mix(kG, 0.06, browM); kB = mix(kB, 0.04, browM);

    // lash line and water line
    const line = upper ? Math.exp(-Math.pow(du / 0.010, 2)) : 0;
    const lnk = clip(line * (1.0 - 0.3 * ou) * 0.9, 0, 1);
    kR = mix(kR, 0.05, lnk); kG = mix(kG, 0.03, lnk); kB = mix(kB, 0.022, lnk);
    const wl = upper ? 0 : ss(0.014, 0.0, dl);
    kR = mix(kR, 0.74, wl * 0.6); kG = mix(kG, 0.34, wl * 0.6); kB = mix(kB, 0.30, wl * 0.6);

    let R_ = mix(kR, inR, m_in), G_ = mix(kG, inG, m_in), B_ = mix(kB, inB, m_in);

    // vignette: the corners fall away to black
    const vig = (1 - 0.30 * ss(0.4, 1.0, Math.hypot(x, y))) * ease(P.t / 1.2);
    R_ *= vig; G_ *= vig; B_ *= vig;

    // owner
    let own = OWN.skin;
    if (m_in > 0.5) own = im > 0.5 ? OWN.vortex : OWN.sclera;
    else if (lnk > 0.55 || rimK > 0.45) own = OWN.lid;
    else if (browM > 0.5) own = OWN.brow;
    else if (!upper && wl > 0.5) own = OWN.lid;

    sR = R_; sG = G_; sB = B_; sO = own; sW = vw;
  }

  // lid edge height at eye-space x (for lashes)
  function lidEdges(u0, ou) {
    const s = u0 / WO;
    const wu = s < -0.12 ? 0.88 : 1.12;
    const cu = Math.pow(Math.max(0, 1 - Math.pow((s + 0.12) / wu, 2)), 0.8);
    const cl = Math.pow(Math.max(0, 1 - (s - 0.08) * (s - 0.08)), 0.9);
    const vc = 0.03 * cl;
    const vl = vc + (HL * cl - vc) * (0.35 + 0.65 * ou);
    const vu = vl + (-HU * cu - vl) * ou;
    return [vu, vl, cl];
  }

  function stampLashes(idx, fg) {
    const Z = P.Z, ou = P.ou;
    if (Z > 2.6) return;
    const cl = 1 - Math.pow(Math.max(ou, 0), 0.8);
    const toCell = (ue, ve) => [Math.trunc((W / 2 + ue * Z * H) / CW), Math.trunc((H / 2 + ve * Z * H) / CH)];
    const pick = (aa) => {
      const ang = mod(Math.atan2(-Math.sin(aa), Math.cos(aa)) * 180 / PI, 180);
      if (ang < 25 || ang >= 155) return '-';
      if (ang < 70) return '/';
      if (ang < 110) return '|';
      return '\\';
    };
    const draw = (bu, bv, a0, L, curl, root, tip, nmax, tipCh) => {
      const n = Math.trunc(Math.max(2, Math.min(nmax, L * Z * H / (CW * 0.85))));
      const step = L / n;
      let ue = bu, ve = bv;
      for (let k = 0; k < n; k++) {
        const tt = k / Math.max(1, n - 1);
        const aa = a0 + curl * tt * tt;
        ue += Math.cos(aa) * step; ve += Math.sin(aa) * step;
        const [c, r] = toCell(ue, ve);
        if (!(r >= 0 && r < ROWS && c >= 0 && c < COLS)) continue;
        const ch = (k === n - 1 && n >= 4) ? tipCh : pick(aa);
        const p = r * COLS + c;
        idx[p] = CIDX[ch];
        fg[p * 3] = root[0] + (tip[0] - root[0]) * tt; fg[p * 3 + 1] = root[1] + (tip[1] - root[1]) * tt; fg[p * 3 + 2] = root[2] + (tip[2] - root[2]) * tt;
      }
    };
    const rad = (d) => d * PI / 180;
    for (const [s0, lf] of UP_L) {
      const u0 = s0 * WO;
      const [vu] = lidEdges(u0, ou);
      const bv = vu - 0.055 * s0;
      const aOpen = rad(-90 + 26 * s0), aClosed = s0 >= 0 ? rad(90 - 20 * s0) : rad(-270 - 20 * s0);
      const a0 = aOpen + (aClosed - aOpen) * cl;
      const edge = Math.sqrt(Math.max(0, 1 - s0 * s0));
      draw(u0, bv, a0, (0.070 + 0.050 * edge) * lf, rad(-22 * s0) * (1 - cl), [0.38, 0.27, 0.20], [0.66, 0.50, 0.38], 14, "'");
    }
    for (const [s0, lf] of LO_L) {
      const u0 = s0 * WO;
      const [, vl, clw] = lidEdges(u0, ou);
      draw(u0, vl - 0.055 * s0, rad(90 - 20 * s0), 0.034 * (0.5 + 0.8 * clw) * lf, rad(12 * (s0 > 0 ? 1 : -1)), [0.40, 0.29, 0.22], [0.64, 0.48, 0.37], 6, '.');
    }
  }

  // ---------- frame ----------

  const KEY = ['none', 'skin', 'brow', 'sclera', 'vortex', 'lid'];
  const PRIO = [0, 1, 3, 2, 5, 4];
  const SKIN_FAM = " .,:;+*";        // weight follows brightness
  const SCLERA_FAM = " .:-=+";
  const LID_FAM = "-=_";
  const VWHITE_FAM = "#%8&@";        // the white bands of the vortex
  const VGREY_FAM = ":;+=";          // the soft edge between bands

  function renderCells(t) {
    frameParams(t);
    const n = GW * GH;
    const img = new Float32Array(n * 3);
    const owner = new Uint8Array(n);
    const vwb = new Float32Array(n);
    for (let j = 0; j < GH; j++) {
      for (let i = 0; i < GW; i++) {
        const p = j * GW + i;
        shade(X[p], Y[p]);
        img[p * 3] = sR; img[p * 3 + 1] = sG; img[p * 3 + 2] = sB;
        owner[p] = sO; vwb[p] = sW;
      }
    }

    const idx = new Int32Array(ROWS * COLS);
    const fg = new Float32Array(ROWS * COLS * 3);
    const bg = new Float32Array(ROWS * COLS * 3);
    const inv = 1 / (SS * SS);
    const pick = (fam, v) => fam[Math.trunc(clip(v, 0, 0.999) * fam.length)];

    for (let r = 0; r < ROWS; r++) {
      const yc = ((r + 0.5) * CH - H / 2) / H;
      for (let c = 0; c < COLS; c++) {
        let R_ = 0, G_ = 0, B_ = 0, best = 0, bestP = -1;
        for (let a = 0; a < SS; a++) {
          for (let b = 0; b < SS; b++) {
            const pp = (r * SS + a) * GW + (c * SS + b);
            R_ += img[pp * 3]; G_ += img[pp * 3 + 1]; B_ += img[pp * 3 + 2];
            const o = owner[pp];
            if (PRIO[o] > bestP) { bestP = PRIO[o]; best = o; }
          }
        }
        R_ *= inv; G_ *= inv; B_ *= inv;
        const cell = r * COLS + c;
        const key = KEY[best];
        const L = LAYERS[key];
        if (!L || !L.on) continue;
        const lum = 0.30 * R_ + 0.60 * G_ + 0.10 * B_;
        const hs = HSC[cell];
        const hs2 = (hs * 13.7) % 1;

        bg[cell * 3] = clip(R_ * L.bg, 0, 1); bg[cell * 3 + 1] = clip(G_ * L.bg, 0, 1); bg[cell * 3 + 2] = clip(B_ * L.bg, 0, 1);

        let ch = '', fr = 0, fgc = 0, fb = 0;
        // colour of a character: the cell's colour with saturation applied, then scaled up (characters cover only part of a cell on black)
        const sat = OPTS.sat;
        const tint = (gain, add, sv) => {
          const sa = sv === undefined ? sat : sv;
          fr = clip((lum + (R_ - lum) * sa) * gain + add, 0, 1);
          fgc = clip((lum + (G_ - lum) * sa) * gain + add, 0, 1);
          fb = clip((lum + (B_ - lum) * sa) * gain + add, 0, 1);
        };
        if (L.chars) {
          // exactly eye.js: brightness picks a character from the whole ramp (so mostly letters and digits), a tiny per-cell dither,
          // every cell outside the vortex gets at least ramp index 3, and the character is coloured by the cell's colour
          const li = Math.pow(clip(lum, 0, 1), 0.72);
          let ri = Math.trunc(clip((li + (hs - 0.5) * 0.07) * NR, 0, NR));
          if (key === 'vortex') {
            // hazel iris: characters from the same ramp as the rest of the eye, coloured by the iris (the pupil stays empty)
            ri = Math.max(ri, 3);
            if (lum > 0.025) { ch = RAMP[ri]; tint(1.35, 0.02, Math.max(sat, 1.0)); }
          } else {
            ri = Math.max(ri, 3);
            ch = RAMP[ri];
            tint(1.15, 0.0, key === 'sclera' ? sat * 0.6 : sat);
          }
        }
        if (ch) { idx[cell] = CIDX[ch]; fg[cell * 3] = fr; fg[cell * 3 + 1] = fgc; fg[cell * 3 + 2] = fb; }
      }
    }

    if (LAYERS.lashes.on) stampLashes(idx, fg);

    const q = new Int16Array(ROWS * COLS * 3);
    const bq = new Int16Array(ROWS * COLS * 3);
    for (let i = 0; i < q.length; i++) {
      q[i] = clip(Math.trunc(clip(fg[i], 0, 1) * (QL - 0.01)), 0, QL - 1);
      bq[i] = clip(Math.trunc(clip(bg[i], 0, 1) * (QL - 1) + 0.5 * HSC[(i / 3) | 0]), 0, QL - 1);
    }
    return { idx, q, bq };
  }

  const api = {
    init, renderCells, layers: LAYERS, options: OPTS, RAMP, QL, FPS, MAXROWS,
    openness: () => P.ou,
    dims: () => ({ CW, CH, ROWS, COLS, W, H }),
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
