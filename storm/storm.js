// A thunderstorm over a wet street at night, rendered as coloured ASCII.
// Rain falls in perspective and every drop that lands in a puddle drops a disturbance into a real 2D
// damped wave-equation grid laid out on the ground plane, so the puddles fill with expanding rings.
// Drops that land on dry road splash instead. A single street lamp is the only light: it throws a cone down through the rain,
// a pool of light on the road and a shimmering reflection in the puddles.
// Fully procedural, no image files.
const Storm = (function () {
  'use strict';

  const FPS = 30;
  const SUB = 2;
  const DT = 1 / (FPS * SUB);

  // ---- layout (screen-height units, 0 = centre, +y down) ----------------------------------------------------
  const HOR = -0.02;                  // horizon
  const GREF = 0.32;                  // y where the ground-plane perspective scale s = 1
  const WIND = 0.30;                  // rain drifts left by this much per unit of fall
  let LAMP, ASP;                      // the lamp's position (set in init from the frame's aspect ratio); ASP = frame width in height units

  // the building: only its lower-left corner is in frame, a gothic stone facade standing behind the road and a far pavement
  const ZB = 3.25, BX0 = 0.0;                    // depth of its base and the x of its left corner
  const YB = HOR + (GREF - HOR) / ZB;            // screen y where the facade meets the ground
  // only the entryway is visible: the arched door, a little wall around it and a lantern above; the rest of the building is lost in the dark
  const ENT_X0 = 0.055, ENT_X1 = 0.29, ENT_H = 0.34, DOORX = 0.1725;
  function entryFade(sx, sy) {
    const fx = sx - BX0, fy = YB - sy;
    return smooth(0, 0.045, Math.min(fx - ENT_X0, ENT_X1 - fx)) * smooth(-0.01, 0.06, Math.min(fy + 0.01, ENT_H - fy));
  }

  // ---- wave grid on the ground plane (u across, z depth; s = 1/z) ---------------------------------------------
  const DU = 0.02, UHALF = 2.0, NX = Math.round(2 * UHALF / DU) + 1;
  const ZMIN = 0.55, DZ = 0.03, NZ = 116, ZMAX = ZMIN + (NZ - 1) * DZ;
  const CPHYS = 0.6;
  const CX2 = (CPHYS * DT / DU) ** 2, CZ2 = (CPHYS * DT / DZ) ** 2;
  const GAMMA = 0.018;

  const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const lerp = (a, b, t) => a + (b - a) * t;

  function hash(x, y) {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function vnoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  let seed = 1;
  const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

  const pick = (s, v) => s[clamp(Math.floor(v * s.length), 0, s.length - 1)];
  const CLOUD_CH = " .:-~;";
  const WAVE_CH = " .,-~=+*";
  const RIPPLE_CH = ".,-~";          // ripples are drawn with the lightest marks
  const GLOW_CH = "`.',:;+*";       // halo glyphs, as in the campfire: faint at the edge, heavier near the lamp
  const GROUND_CH = ".,:;'`";

  // ---- dims -------------------------------------------------------------------------------------------------
  let CW, CH, COLS, ROWS, N, CPU;
  let sxArr, syArr, rowS, rowZ;
  let chOut, fgOut, bgOut;

  function init(cw, chh, cols, rows) {
    CW = cw; CH = chh; COLS = cols; ROWS = rows; N = COLS * ROWS;
    CPU = ROWS * CH / CW;
    ASP = COLS / CPU;
    LAMP = { x: -0.26 * ASP, yb: 0.32, hx: -0.26 * ASP + 0.06, hy: -0.22 };      // near lamp: base and lamp-head position
    sxArr = new Float32Array(COLS); syArr = new Float32Array(ROWS);
    for (let c = 0; c < COLS; c++) sxArr[c] = (c + 0.5 - COLS / 2) / CPU;
    for (let r = 0; r < ROWS; r++) syArr[r] = (r + 0.5) / ROWS - 0.5;
    rowS = new Float32Array(ROWS); rowZ = new Float32Array(ROWS);
    for (let r = 0; r < ROWS; r++) { rowS[r] = Math.max(0.02, (syArr[r] - HOR) / (GREF - HOR)); rowZ[r] = 1 / rowS[r]; }
    chOut = new Uint8Array(N); fgOut = new Uint8ClampedArray(N * 3); bgOut = new Uint8ClampedArray(N * 3);
    buildStars();
    resetSim();
  }

  // ---- puddle mask ------------------------------------------------------------------------------------------
  function puddle(u, z) {
    const n = vnoise(u * 2.0 + 11, z * 2.4 + 5) * 0.65 + vnoise(u * 5.5 + 3, z * 5.5) * 0.35;
    return smooth(0.46, 0.58, n);
  }

  // ---- simulation: wave grid + rain + splashes --------------------------------------------------------------
  let hA, hB, gxF, gzF, spongeU, spongeZ, simT = 0;
  let dX, dY, dV, dGY, NDROPS = 0;

  function resetSim() {
    hA = new Float32Array(NX * NZ); hB = new Float32Array(NX * NZ);
    gxF = new Float32Array(NX * NZ); gzF = new Float32Array(NX * NZ);
    spongeU = new Float32Array(NX); spongeZ = new Float32Array(NZ);
    for (let i = 0; i < NX; i++) spongeU[i] = 1 - 0.12 * Math.pow(Math.max(0, 1 - Math.min(i, NX - 1 - i) / 20), 2);
    for (let j = 0; j < NZ; j++) spongeZ[j] = 1 - 0.12 * Math.pow(Math.max(0, 1 - Math.min(j, NZ - 1 - j) / 10), 2);
    simT = 0; seed = 7;
    NDROPS = Math.round(N * 0.007);
    dX = new Float32Array(NDROPS); dY = new Float32Array(NDROPS); dV = new Float32Array(NDROPS); dGY = new Float32Array(NDROPS);
    for (let i = 0; i < NDROPS; i++) newDrop(i, true);
  }

  function newDrop(i, scatter) {
    const gy = 0.04 + rnd() * 0.46;                         // where this drop will land (its depth)
    const s = (gy - HOR) / (GREF - HOR);
    dGY[i] = gy; dV[i] = 0.22 + 0.46 * s;
    dX[i] = -ASP / 2 + rnd() * (ASP + 0.4);
    dY[i] = scatter ? -0.6 + rnd() * (gy + 0.6) : -0.6 - rnd() * 0.15;
  }

  function bump(u, z, amp, rad) {
    const ci = (u + UHALF) / DU, cj = (z - ZMIN) / DZ, ri = rad / DU, rj = rad / DZ;
    for (let j = Math.max(1, Math.floor(cj - rj * 2)); j <= Math.min(NZ - 2, Math.ceil(cj + rj * 2)); j++) {
      for (let i = Math.max(1, Math.floor(ci - ri * 2)); i <= Math.min(NX - 2, Math.ceil(ci + ri * 2)); i++) {
        const v = amp * Math.exp(-(((i - ci) / ri) ** 2 + ((j - cj) / rj) ** 2));
        hA[j * NX + i] += v; hB[j * NX + i] += v;          // displacement only, no initial velocity
      }
    }
  }

  function stepSim() {
    simT += DT;

    // rain
    for (let i = 0; i < NDROPS; i++) {
      dY[i] += dV[i] * DT;
      dX[i] -= WIND * dV[i] * DT;
      if (dY[i] < dGY[i]) continue;
      const gy = dGY[i], s = (gy - HOR) / (GREF - HOR), z = 1 / s, u = dX[i] / s;
      if (Math.abs(dX[i]) < ASP / 2 + 0.1) {
        if (z < ZMAX && puddle(u, z) > 0.5) {
          bump(u, z, -(0.003 + 0.004 * rnd()), 0.04 + 0.02 * rnd());
        } else if (z < ZMAX && rnd() < 0.5) {
          bump(u, z, -(0.0010 + 0.0012 * rnd()), 0.03);          // a thin film of water on the road: a much fainter ripple
        }
      }
      newDrop(i, false);
    }

    // wave equation
    for (let j = 1; j < NZ - 1; j++) {
      const row = j * NX, sz = spongeZ[j];
      for (let i = 1; i < NX - 1; i++) {
        const k = row + i, h = hA[k];
        const lapU = hA[k - 1] + hA[k + 1] - 2 * h, lapZ = hA[k - NX] + hA[k + NX] - 2 * h;
        hB[k] = (h + (h - hB[k]) * (1 - GAMMA) + CX2 * lapU + CZ2 * lapZ) * spongeU[i] * sz;
      }
    }
    const tmp = hA; hA = hB; hB = tmp;
  }

  function updateGrad() {
    for (let j = 1; j < NZ - 1; j++) for (let i = 1; i < NX - 1; i++) {
      const k = j * NX + i;
      gxF[k] = (hA[k + 1] - hA[k - 1]) / (2 * DU);
      gzF[k] = (hA[k + NX] - hA[k - NX]) / (2 * DZ);
    }
  }

  // ---- lamp light -------------------------------------------------------------------------------------------
  function lampLight(x, y) {
    const dx = x - LAMP.hx, dy = y - LAMP.hy, d2 = dx * dx + dy * dy;
    const up = lerp(0.12, 1, smooth(-0.03, 0.02, dy));              // the hood blocks the light going up, with a soft edge
    let L = (1.0 * Math.exp(-d2 / 0.012) + 0.22 * Math.exp(-d2 / 0.07)) * up;
    if (dy > -0.03) { const q = Math.max(dy, 0); L += 0.95 * smooth(-0.03, 0.09, dy) * Math.exp(-((dx / (0.05 + 0.62 * q)) ** 2)) * Math.exp(-q * 1.05); }    // wide cone pouring down to the road
    return L;
  }

  // ---- building ----------------------------------------------------------------------------------------------
  function building(i, sx, sy, t, e) {
    buildingRaw(i, sx, sy, t);
    if (e < 0.999) {                                              // dissolve into the dark at the edges of the entryway
      for (let k = 0; k < 3; k++) { fgOut[i * 3 + k] *= e; bgOut[i * 3 + k] *= e; }
      if (hash(i, 60) > e) chOut[i] = 32;
    }
  }

  function buildingRaw(i, sx, sy, t) {
    const fx = sx - BX0, fy = YB - sy, dx = fx - DOORX;
    const flick = 0.9 + 0.1 * Math.sin(t * 13) * Math.sin(t * 4.7);
    // two wall lanterns beside the door, and the warm glow of the fanlight above it
    const LX = 0.080, LY = 0.135;
    const dL1 = (dx + LX) ** 2 + (fy - LY) ** 2, dL2 = (dx - LX) ** 2 + (fy - LY) ** 2;
    if (dL1 < 0.00006 || dL2 < 0.00006) { put(i, '@', 255, 246, 210, 255, 205, 120); return; }
    if ((Math.abs(dx + LX) < 0.007 || Math.abs(dx - LX) < 0.007) && fy > LY + 0.009 && fy < LY + 0.015) { put(i, '^', 60, 52, 44, 14, 12, 10); return; }   // lantern caps
    const Lb = clamp(lampLight(sx, sy) * 1.0 + 0.18 * Math.exp(-(sx - BX0) * 2.2) + 1.3 * (Math.exp(-dL1 / 0.0045) + Math.exp(-dL2 / 0.0045)) * flick + 0.6 * Math.exp(-(dx * dx + (fy - 0.17) ** 2) / 0.010), 0.10, 2.0);
    const lit = (alb, tr = 1, tg = 1, tb = 1) => [(1.0 + 150 * Lb * 0.62) * alb * 1.7 * tr, (1.3 + 105 * Lb * 0.62) * alb * 1.7 * tg, (2.2 + 52 * Lb * 0.62) * alb * 1.7 * tb];
    const out = (c, ch, solid, boost) => put(i, ch, c[0] * boost + 4, c[1] * boost + 4, c[2] * boost + 6, c[0] * solid, c[1] * solid, c[2] * solid * 1.1);

    // the doorway opening: straight jambs, then a pointed arch (rho = 1 on the edge of the opening)
    const AY = 0.150, AW = 0.034, AH = 0.055;
    const rho = fy > AY ? Math.sqrt((dx / AW) ** 2 + ((fy - AY) / AH) ** 2) : Math.abs(dx) / AW;
    const th = Math.atan2(fy - AY, dx / AW * AH);                    // angle round the arch, for the voussoir joints

    // --- steps up to the door ---
    if (fy < 0.042) {
      const j = Math.floor(fy / 0.014), half = 0.082 - 0.009 * j, ff = fy / 0.014 - j;
      if (Math.abs(dx) < half) {
        if (ff > 0.72) { out(lit(1.1), '_', 0.45, 2.2); return; }                      // the lit nosing of each step
        const c = lit(0.42 + 0.1 * hash(j, 7)); out(c, hash(i, 8) < 0.4 ? '=' : ' ', 0.30, 1.8); return;
      }
    }
    // --- the doors ---
    if (rho < 1 && fy >= 0.0) {
      if (fy > AY) {                                                // fanlight: warm glass with radial bars
        const spoke = ((th / (Math.PI / 7)) % 1 + 1) % 1 < 0.10 || (fy - AY) < 0.004;
        if (spoke) { put(i, ' ', 0, 0, 0, 12, 8, 4); return; }
        const gl = (0.65 + 0.35 * flick) * (1 - 0.25 * rho);
        put(i, hash(i, 3) < 0.5 ? ':' : '.', 255 * gl, 175 * gl, 70 * gl, 105 * gl, 58 * gl, 16 * gl); return;
      }
      const lx = Math.abs(dx);
      const seam = lx < 0.0016;
      if (seam) { put(i, ' ', 0, 0, 0, 120 * flick, 64 * flick, 14 * flick); return; }                          // light leaking through the gap between the leaves
      const stile = lx < 0.0055 || lx > 0.029, rail = fy < 0.012 || (fy > 0.068 && fy < 0.076) || fy > 0.139;
      const strap = (Math.abs(fy - 0.040) < 0.003 || Math.abs(fy - 0.108) < 0.003) && lx > 0.012;
      const handle = (lx - 0.0085) ** 2 + (fy - 0.082) ** 2 < 0.000012;
      if (handle) { put(i, 'o', 215, 170, 100, 40, 28, 12); return; }
      if (strap) { const c = lit(0.55, 0.9, 0.9, 1.0); out(c, '=', 0.35, 2.0); return; }                         // iron straps
      const wood = (stile || rail) ? 0.34 : 0.17;                    // raised frame, recessed panel
      const grain = 0.8 + 0.4 * vnoise(dx * 400, fy * 9);
      const c = lit(wood * grain, 1.0, 0.62, 0.34); out(c, (stile || rail) ? '|' : (hash(i, 5) < 0.35 ? ':' : ' '), 0.40, 2.0); return;
    }
    // --- the arch moulding (archivolt): two rings of voussoir stones, with a keystone ---
    if (rho >= 1 && rho < 1.52 && fy > 0.0) {
      const ring2 = rho > 1.26;
      const joint = fy > AY && (((th / (Math.PI / 13)) % 1 + 1) % 1 < 0.07);
      const key = fy > 0.195 && Math.abs(dx) < 0.009;
      let alb = (ring2 ? 0.78 : 0.95) * (0.9 + 0.2 * hash(Math.floor(th * 6 + 20), ring2 ? 1 : 2));
      if (key) alb = 1.2;
      if (joint && !key) alb *= 0.3;
      const c = lit(alb); out(c, key ? '#' : (joint ? ' ' : (hash(i, 8) < 0.7 ? '=' : '_')), 0.22, 2.4); return;
    }
    // --- fluted columns on each side, with a base and a capital ---
    const ax = Math.abs(dx);
    if (ax > 0.055 && ax < 0.072 && fy > 0.014 && fy < 0.19) {
      const cap = fy > 0.172, base = fy < 0.028;
      if (cap || base || ax < 0.069) {
        const flute = (ax / 0.0034 - Math.floor(ax / 0.0034)) < 0.5;
        const c = lit((cap || base ? 1.0 : (flute ? 0.82 : 0.5)) * (0.9 + 0.2 * hash(Math.floor(fy / 0.02), 3)));
        out(c, cap ? '=' : (base ? '_' : '|'), 0.26, 2.2); return;
      }
    }
    // --- entablature above the door: a frieze with dentils, then a projecting cornice ---
    if (ax < 0.090 && fy > 0.238 && fy < 0.272) {
      if (fy > 0.264) { const c = lit(1.15); out(c, '_', 0.4, 2.4); return; }                                  // the lit top of the cornice
      const dent = fy > 0.250 && (fx / 0.010 - Math.floor(fx / 0.010)) < 0.55;
      const c = lit(dent ? 0.92 : 0.5); out(c, dent ? '#' : '=', 0.22, 2.2); return;
    }
    // --- the wall: ashlar blocks with dark joints, wet streaks running down from every ledge ---
    const cH = 0.026, cr = Math.floor(fy / cH), cf = fy / cH - cr;
    const bW = 0.075, bu = fx / bW + (cr & 1) * 0.5, bc = Math.floor(bu), bf = bu - bc;
    let alb = 0.36 + 0.26 * hash(bc, cr);
    if (cf < 0.14 || bf < 0.05) alb *= 0.35;
    alb *= 1 - 0.40 * smooth(0.58, 0.9, vnoise(fx * 70, 3));                                       // rain staining
    if (ax > 0.112 && fy < 0.2) alb = Math.max(alb, 0.55 * (0.8 + 0.4 * hash(bc, cr + 40)));        // heavier rusticated blocks beside the portal
    const c = lit(alb);
    const lum = Math.max(c[0], c[1], c[2]) / 255, h1 = hash(i, 8), h2 = hash(i, 10);
    if (h1 < clamp(Math.pow(lum, 0.8) * 5, 0, 1) * 0.85 + 0.02) put(i, pick("=_-|:'", Math.pow(lum, 0.6) + (h2 - 0.5) * 0.3), c[0] * 2.3 * (0.5 + 0.5 * h2) + 3, c[1] * 2.3 * (0.5 + 0.5 * h2) + 3, c[2] * 2.3 * (0.5 + 0.5 * h2) + 5, c[0] * 0.12, c[1] * 0.12, c[2] * 0.14);
    else put(i, ' ', 0, 0, 0, c[0] * 0.12, c[1] * 0.12, c[2] * 0.14);
  }

  // ---- scene ------------------------------------------------------------------------------------------------
  function put(i, ch, fr, fg, fb, br, bg, bb) {
    chOut[i] = ch.charCodeAt(0);
    fgOut[i * 3] = fr; fgOut[i * 3 + 1] = fg; fgOut[i * 3 + 2] = fb;
    bgOut[i * 3] = br; bgOut[i * 3 + 1] = bg; bgOut[i * 3 + 2] = bb;
  }

  // the sky is just black: like the campfire, light and stars are made of characters, not background colour
  function sky(i) { put(i, ' ', 0, 0, 0, 0, 0, 0); }

  function ground(i, sx, sy, s, z, t) {
    const u = sx / s;
    const pm = puddle(u, z);
    // simulated ripples (puddles only)
    let H = 0, hx = 0, hz = 0;
    const fi = (u + UHALF) / DU, fj = (z - ZMIN) / DZ;
    if (fi > 2 && fi < NX - 3 && fj > 2 && fj < NZ - 3) {
      const i0 = Math.floor(fi), j0 = Math.floor(fj), ti = fi - i0, tj = fj - j0;
      const k = j0 * NX + i0, w00 = (1 - ti) * (1 - tj), w10 = ti * (1 - tj), w01 = (1 - ti) * tj, w11 = ti * tj;
      const fade = smooth(ZMAX, ZMAX - 0.8, z) * smooth(UHALF, UHALF - 0.4, Math.abs(u));
      H = (hA[k] * w00 + hA[k + 1] * w10 + hA[k + NX] * w01 + hA[k + NX + 1] * w11) * fade;
      hx = (gxF[k] * w00 + gxF[k + 1] * w10 + gxF[k + NX] * w01 + gxF[k + NX + 1] * w11) * fade;
      hz = (gzF[k] * w00 + gzF[k + 1] * w10 + gzF[k + NX] * w01 + gzF[k + NX + 1] * w11) * fade;
    }
    // light the lamp throws onto the road, in world coordinates
    const du = u - LAMP.x, dz = z - 1.0;
    const Lg = Math.exp(-(du * du * 1.2 + dz * dz * 1.8) / 0.4);

    // materials, all of it wet: slabbed pavement near the camera, a kerb, then asphalt
    const pave = 1 - smooth(1.50, 1.56, z);
    const kerb = Math.exp(-(((z - 1.58) / 0.03) ** 2));
    const sU = 0.55, sZ = 0.42;
    const fu = u / sU - Math.floor(u / sU), fz = z / sZ - Math.floor(z / sZ);                     // position inside the current slab
    const seam = pave * ((fu < 0.045 || fu > 0.955 || fz < 0.07) ? 1 : 0);
    const slab = hash(Math.floor(u / sU), Math.floor(z / sZ));                                    // every slab a slightly different tone
    const grit = 0.75 + 0.5 * vnoise(u * 14 + 2, z * 20);                                         // fine aggregate in the asphalt
    let alb = lerp(0.34 * grit, 0.60 * (0.8 + 0.4 * slab) * (0.9 + 0.2 * grit), pave);
    alb *= 1 - 0.7 * seam;
    const dash = Math.abs(z - 2.32) < 0.11 && (u / 0.9 - Math.floor(u / 0.9)) < 0.55;            // centre-line dashes on the road
    const farKerb = Math.exp(-(((z - 3.04) / 0.07) ** 2));
    const farWalk = smooth(3.05, 3.1, z);                                                         // pavement on the far side, up to the building
    alb = lerp(alb, 0.46 * (0.8 + 0.4 * hash(Math.floor(u / 0.5), Math.floor(z / 0.5))), farWalk);
    if (dash) alb = 0.95;
    alb = lerp(alb, 0.95, farKerb * 0.7);
    alb = lerp(alb, 0.95, kerb * 0.8);                                                            // the kerb stone catches the light
    const hz0 = Math.exp(-(sy - HOR) * 3.0);                                                      // sky reflected near the horizon
    let rr = (1.0 + 1 * hz0 + 150 * Lg * 0.26) * alb * 1.7, gg = (1.3 + 1.5 * hz0 + 105 * Lg * 0.26) * alb * 1.7, bb = (2.2 + 3 * hz0 + 52 * Lg * 0.26) * alb * 1.7;
    const mst = vnoise(u * 0.7 + t * 0.06, z * 0.6) * Math.exp(-(sy - HOR) * 7);                 // low mist drifting over the road
    rr += 3 * mst; gg += 3.8 * mst; bb += 6 * mst;
    // the lamp's reflection: a wobbling streak below its base. Strong in puddles, a faint wet sheen on the stone and asphalt
    let refl = 0;
    if (sy > LAMP.yb - 0.01) {
      const w = 0.022 + 0.20 * (sy - LAMP.yb), dxr = sx - LAMP.x + 0.55 * hx + 0.012 * Math.sin(sy * 60 + t * 3);
      refl = Math.exp(-((dxr / w) ** 2)) * (1 - 0.7 * smooth(LAMP.yb, 0.5, sy));
      refl *= 0.55 + 0.45 * Math.sin(hz * 40 + hx * 22 + hash(i, 2) * 6.283);
    }
    const sheen = refl * 0.20 * (1 - pm) * (0.5 + 0.5 * alb) * (0.6 + 0.8 * hash(i, 3));
    rr += 255 * sheen; gg += 190 * sheen; bb += 100 * sheen;
    let ch = ' ', fr, fg, fb;
    // puddle: dark mirror with sky, lamp reflection and ripples
    if (pm > 0.01) {
      const crest = clamp(0.45 + 5.0 * hz + 2.2 * hx, 0, 1);
      let pr = lerp(1, 4.5, hz0), pg = lerp(1.5, 5.5, hz0), pb = lerp(3, 10, hz0);
      pr += 255 * refl * 0.75; pg += 190 * refl * 0.75; pb += 100 * refl * 0.75;
      if (sy > LAMP.yb && Math.abs(sx - LAMP.x + 0.5 * hx) < 0.010 * (1 - 0.6 * smooth(LAMP.yb, 0.5, sy))) { pr *= 0.2; pg *= 0.2; pb *= 0.2; }   // the shaft's reflection
      pr += 150 * Lg * 0.15; pg += 105 * Lg * 0.15; pb += 52 * Lg * 0.15;
      const m = pm;
      rr = lerp(rr, pr, m); gg = lerp(gg, pg, m); bb = lerp(bb, pb, m);
      const ring = Math.abs(crest - 0.45);
      if (m > 0.35) {
        if (ring > 0.30 && hash(i, 12) < 0.55) { ch = pick(RIPPLE_CH, clamp(ring * 2.2, 0, 0.999)); fr = 46 + 50 * refl; fg = 56 + 44 * refl; fb = 80 + 34 * refl; }
        else if (refl > 0.25) { ch = refl > 0.6 ? '|' : ':'; fr = 255; fg = 215; fb = 150; }
        else if (hash(i, 6) < 0.045) { ch = pick(WAVE_CH, crest); fr = rr * 2.0 + 10; fg = gg * 2.0 + 12; fb = bb * 1.8 + 22; }
      }
    }
    if (ch === ' ' && pm < 0.35) {                                // faint ripples on the wet road too
      const crest = clamp(0.45 + 5.0 * hz + 2.2 * hx, 0, 1), ring = Math.abs(crest - 0.45);
      if (ring > 0.2 && hash(i, 12) < 0.5) { ch = pick(RIPPLE_CH, clamp(ring * 2.5, 0, 0.999)); fr = rr * 2.4 + 18; fg = gg * 2.4 + 22; fb = bb * 2.2 + 34; }
    }
    if (ch === ' ') {
      const lum = Math.max(rr, gg, bb) / 255;                    // how much light reaches this bit of road
      const h1 = hash(i, 8), h2 = hash(i, 10);
      if (h1 < clamp(Math.pow(lum, 0.8) * 5, 0, 1) * 0.32 + 0.002) {
        ch = pick(GROUND_CH, Math.pow(lum, 0.6) + (h2 - 0.5) * 0.25);
        const op = 2.2 * (0.5 + 0.5 * h2);
        fr = rr * op + 3; fg = gg * op + 3; fb = bb * op + 5;
      } else { fr = fg = fb = 0; }
    }
    // backgrounds stay near black; the light lives in the characters
    put(i, ch, fr || 0, fg || 0, fb || 0, rr * 0.10, gg * 0.10, bb * 0.12);
  }

  function renderScene(t) {
    for (let r = 0; r < ROWS; r++) {
      const sy = syArr[r], s = rowS[r], z = rowZ[r];
      for (let c = 0; c < COLS; c++) {
        const i = r * COLS + c, sx = sxArr[c];
        const ef = (sx > BX0 && sy < YB) ? entryFade(sx, sy) : 0;
        if (ef > 0.04) building(i, sx, sy, t, ef);
        else if (sy < HOR) sky(i); else ground(i, sx, sy, s, z, t);
      }
    }
  }

  // ---- stars: twinkling, drifting slowly sideways, with short rays on the bright ones (as in the campfire) ----
  let STN = 0, stX, stY, stB, stPh, stF;
  function buildStars() {
    STN = 70; stX = new Float32Array(STN); stY = new Float32Array(STN); stB = new Float32Array(STN); stPh = new Float32Array(STN); stF = new Float32Array(STN);
    let sd = 61;
    const r = () => { sd = (sd * 1664525 + 1013904223) >>> 0; return sd / 4294967296; };
    for (let i = 0; i < STN; i++) {
      stX[i] = (r() - 0.5) * ASP; stY[i] = -0.5 + r() * (HOR + 0.5 - 0.12);
      stB[i] = 0.10 + 0.90 * Math.pow(r(), 3.2); stPh[i] = r() * 6.28; stF[i] = 1 + r() * 2.5;
    }
  }
  function drawStars(t) {
    for (let k = 0; k < STN; k++) {
      const x = ((stX[k] + 0.004 * t + ASP / 2) % ASP + ASP) % ASP - ASP / 2;
      const c = Math.floor(x * CPU + COLS / 2), r = Math.floor((stY[k] + 0.5) * ROWS);
      if (c < 0 || c >= COLS || r < 0 || r >= ROWS) continue;
      const i = r * COLS + c;
      if (chOut[i] !== 32) continue;                              // the lamp's glow drowns out the stars near it
      const b = stB[k] * (0.8 + 0.2 * Math.sin(t * stF[k] + stPh[k])) * 0.9;
      if (b < 0.08) continue;
      const v = 255 * clamp(0.35 + 0.9 * b, 0, 1);
      chOut[i] = (b > 0.85 ? '@' : b > 0.55 ? '*' : b < 0.18 ? '.' : '+').charCodeAt(0);
      fgOut[i * 3] = v * 0.85; fgOut[i * 3 + 1] = v * 0.92; fgOut[i * 3 + 2] = v;
      if (b > 0.55) for (const [dr, dc, ch] of [[0, 1, '-'], [0, -1, '-'], [1, 0, '|'], [-1, 0, '|']]) {
        const r2 = r + dr, c2 = c + dc;
        if (r2 < 0 || r2 >= ROWS || c2 < 0 || c2 >= COLS || chOut[r2 * COLS + c2] !== 32) continue;
        const j = r2 * COLS + c2;
        chOut[j] = (b > 0.7 ? ch : '.').charCodeAt(0);
        fgOut[j * 3] = v * 0.5; fgOut[j * 3 + 1] = v * 0.55; fgOut[j * 3 + 2] = v * 0.6;
      }
    }
  }

  // ---- lamps ------------------------------------------------------------------------------------------------
  function drawLamps(t) {
    const fl = 0.94 + 0.06 * Math.sin(t * 23) * Math.sin(t * 7.3);
    // halo / cone on everything behind the rain
    for (let r = 0; r < ROWS; r++) {
      const sy = syArr[r], k = lerp(1, 0.30, smooth(HOR - 0.10, HOR + 0.16, sy));
      for (let c = 0; c < COLS; c++) {
        const sx = sxArr[c], i = r * COLS + c;
        const gl = Math.min(1, (lampLight(sx, sy) * fl) * k);
        if (chOut[i] !== 32) continue;                           // road glyphs and puddles keep their own characters
        const h1 = hash(i, 33), h2 = hash(i, 34);
        if (h1 < Math.min(1, 3.0 * Math.pow(gl, 1.25)) * 0.42) {
          chOut[i] = pick(GLOW_CH, Math.pow(gl, 0.7) + (h2 - 0.5) * 0.18).charCodeAt(0);
          const op = Math.pow(gl, 0.85) * (0.45 + 0.55 * h2);
          fgOut[i * 3] = 255 * clamp(1.05 * op, 0, 1); fgOut[i * 3 + 1] = 255 * clamp(0.56 * op, 0, 1); fgOut[i * 3 + 2] = 255 * clamp(0.22 * op, 0, 1);
        }
      }
    }
    // A cast-iron street lamp: a tapered shaft that flares into a stepped plinth, collar rings, a gooseneck arm and a small
    // slanted head with the bulb under it. Everything is lit from the lamp itself: the edge facing the bulb catches warm light,
    // the far edge stays black.
    const yTop = LAMP.hy - 0.044, span = LAMP.yb - yTop;
    const ringAt = [yTop + 0.022, yTop + 0.20 * span, yTop + 0.42 * span, LAMP.yb - 0.095];       // decorative bands up the shaft
    const half = (sy) => {
      const t = (sy - yTop) / span;
      let w = 0.0105 + 0.0065 * t;                                                                  // taper: thinner at the top
      w += 0.020 * smooth(LAMP.yb - 0.085, LAMP.yb - 0.03, sy);                                     // fluted flare toward the base
      if (sy > LAMP.yb - 0.026) w = Math.max(w, 0.038);                                             // square plinth
      if (sy > LAMP.yb - 0.012) w = Math.max(w, 0.046);                                             // foot
      for (const ry of ringAt) if (Math.abs(sy - ry) < 0.004) w *= 1.32;                            // collar rings
      return w;
    };
    const shade = (sx, sy, q, base) => {                                                            // q: -1 (far edge) .. +1 (edge facing the lamp)
      const gl = Math.min(1, lampLight(sx, sy) * fl * 1.3);
      const rim = smooth(0.05, 1.0, q) * gl, mid = smooth(-0.9, 0.9, q) * 0.5;
      return [base[0] * (0.4 + mid) + 230 * rim * 0.8, base[1] * (0.4 + mid) + 130 * rim * 0.8, base[2] * (0.4 + mid) + 44 * rim * 0.8];
    };
    for (let r = Math.max(0, Math.floor((yTop + 0.5) * ROWS)); r < Math.min(ROWS, Math.ceil((LAMP.yb + 0.5) * ROWS)); r++) {
      const sy = syArr[r], w = half(sy);
      const isRing = ringAt.some((ry) => Math.abs(sy - ry) < 0.004), isPlinth = sy > LAMP.yb - 0.026;
      for (let c = 0; c < COLS; c++) {
        const dx = sxArr[c] - LAMP.x;
        if (Math.abs(dx) >= w) continue;
        const q = dx / w, i = r * COLS + c, col = shade(sxArr[c], sy, q, isRing ? [52, 55, 70] : [26, 28, 38]);
        const grain = hash(i, 51) < (isRing ? 0.5 : 0.14);
        put(i, grain ? (isRing || isPlinth ? '=' : '|') : ' ', col[0] * 1.6 + 6, col[1] * 1.6 + 6, col[2] * 1.6 + 8, col[0] * 0.55, col[1] * 0.55, col[2] * 0.6);
        if (isPlinth && (Math.abs(sy - (LAMP.yb - 0.026)) < 0.004 || Math.abs(sy - (LAMP.yb - 0.012)) < 0.003)) put(i, '_', col[0] * 2 + 10, col[1] * 2 + 10, col[2] * 2 + 12, col[0] * 0.8, col[1] * 0.8, col[2] * 0.85);   // lip of each step
      }
    }
    for (let r = Math.floor((LAMP.hy - 0.056 + 0.5) * ROWS); r <= Math.ceil((LAMP.hy + 0.024 + 0.5) * ROWS); r++) {
      if (r < 0 || r >= ROWS) continue;
      const sy = syArr[r];
      for (let c = 0; c < COLS; c++) {
        const sx = sxArr[c], i = r * COLS + c;
        // gooseneck arm: leaves the top of the shaft and arcs over to the head
        const f = (sx - LAMP.x) / (LAMP.hx - LAMP.x);
        if (f > -0.15 && f < 1.0) {
          const ay = yTop + 0.003 - 0.010 * Math.sin(Math.PI * Math.min(1, Math.max(0, f)) * 0.9) + 0.020 * f * f * f, th = 0.0080 - 0.0022 * f;
          if (Math.abs(sy - ay) < th) { const q = (sy - ay) / th, col = shade(sx, sy, -q, [26, 28, 38]); put(i, ' ', 0, 0, 0, col[0] * 0.6, col[1] * 0.6, col[2] * 0.65); continue; }
        }
        // head: slanted housing, narrow at the top and flaring toward the open mouth, with a lens rim along the bottom
        const g = (sy - (LAMP.hy - 0.040)) / 0.034;
        if (g >= 0 && g < 1) {
          const cx = LAMP.hx - 0.016 * (1 - g), hw = 0.008 + 0.021 * g;
          if (Math.abs(sx - cx) < hw) {
            const q = (sx - cx) / hw, col = shade(sx, sy, q, [30, 32, 42]);
            put(i, g > 0.82 ? '_' : ' ', col[0] * 2.2 + 8, col[1] * 2.2 + 8, col[2] * 2.2 + 10, col[0] * (g < 0.12 ? 1.3 : 0.65), col[1] * (g < 0.12 ? 1.3 : 0.65), col[2] * (g < 0.12 ? 1.3 : 0.7));
            continue;
          }
        }
        if (sy >= LAMP.hy - 0.006 && sy < LAMP.hy + 0.016 && Math.abs(sx - LAMP.hx) < 0.011 * (1 - 0.5 * smooth(0.006, 0.016, sy - LAMP.hy))) put(i, '@', 255, 248, 215, 255, 220, 140);   // bulb
      }
    }
  }

  // ---- rain, splashes ---------------------------------------------------------------------------------------
  function drawRain(t) {
    for (let i = 0; i < NDROPS; i++) {
      const x = dX[i], y = dY[i], gy = dGY[i];
      if (y < -0.5 || y > 0.5) continue;
      const s = (gy - HOR) / (GREF - HOR);
      const len = 0.018 + 0.040 * s, steps = Math.max(1, Math.ceil(len * ROWS));
      for (let k = 0; k < steps; k++) {
        const yy = y - (k / steps) * len, xx = x + WIND * (k / steps) * len;
        if (yy > gy) continue;
        const c = Math.floor(xx * CPU + COLS / 2), r = Math.floor((yy + 0.5) * ROWS);
        if (c < 0 || c >= COLS || r < 0 || r >= ROWS) continue;
        const idx = r * COLS + c;
        const L = clamp(lampLight(xx, yy) * 1.1, 0, 1.4);
        const head = k === 0 ? 1 : 1 - k / steps * 0.7;
        const dim = (0.30 + 0.70 * Math.min(1, s)) * head;
        const fr = lerp(9, 255, Math.min(1, L)) * dim + 1, fg = lerp(13, 225, Math.min(1, L)) * dim + 2, fb = lerp(22, 170, Math.min(1, L)) * dim + 5;
        chOut[idx] = (s < 0.35 ? (k === 0 ? ':' : '.') : hash(i, 5) < 0.45 ? '/' : '|').charCodeAt(0);
        fgOut[idx * 3] = fr; fgOut[idx * 3 + 1] = fg; fgOut[idx * 3 + 2] = fb;
      }
    }
  }

  function renderCells(t) {
    if (t < simT - 1e-6) resetSim();
    while (simT < t - 1e-9) stepSim();
    updateGrad();
    renderScene(t);
    drawLamps(t);
    drawRain(t);
    return { ch: chOut, fg: fgOut, bg: bgOut };
  }

  return { FPS, init, renderCells, dims: () => ({ COLS, ROWS, W: COLS * CW, H: ROWS * CH }) };
})();

if (typeof module !== 'undefined') module.exports = Storm;
