// Line-by-line port of eyeTutorial/eye.py (NumPy) to plain JS.
// Names follow the Python source / Glossary.txt so the two can be read side by side.
// Images are flat Float32Arrays, pixel p = j * GW + i, channels interleaved (p * 3).
const Eye = (function () {
  'use strict';

  const { MT } = (typeof module !== 'undefined' && module.exports) ? require('./rng.js') : window.RNG;
  const f32 = Math.fround;
  const PI = Math.PI;

  const FPS = 30;
  const SS = 2;
  const ASPECT = 1.40;
  const MAXROWS = 30;

  const T_OPEN = 0.9;
  const T_OPEN_D = 2.4;
  const T_BLINK = 4.0;
  const T_Z0 = 5.4;
  const T_ZD = 28.0;
  const ZEND = 14.0;
  const T_SPACE = T_Z0 + T_ZD;
  const T_HEART = T_Z0 + 3.5;
  const T_HEART_D = 26.0;

  const WO = 0.78;
  const HU = 0.30, HL = 0.20;
  const RI = 0.27;
  const RP0 = 0.098;
  const GS0 = 0.085;

  const RAMP = ' .\'`^",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$';
  const NR = RAMP.length - 1;
  const CIDX = {};
  for (let i = 0; i < RAMP.length; i++) CIDX[RAMP[i]] = i;
  const QL = 24;

  const rng = new MT().initGenrand(5);
  const prnd = new MT().initByArray([9]);

  // ---------- scalar / array helpers ----------

  function clip(x, a, b) { return x < a ? a : (x > b ? b : x); }

  function ss(a, b, x) {
    const t = clip((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function ease(t) {
    t = Math.min(Math.max(t, 0), 1);
    return t * t * (3 - 2 * t);
  }

  function zp(t) { return ease((t - T_Z0) / T_ZD); }
  function mix(a, b, k) { return a + (b - a) * k; }
  function mod(x, n) { return ((x % n) + n) % n; }

  function randArr(n) {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = rng.random();
    return a;
  }

  function uniformArr(lo, hi, n) {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = rng.uniform(lo, hi);
    return a;
  }

  // b is a g x g grid, result is n x n (smoothstep-interpolated, wraps)
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
      for (let x = 0; x < n; x++) {
        out[y * n + x] = f32(t[r0 + x] * a) + f32(t[r1 + x] * c);
      }
    }
    return out;
  }

  function norm(a, k) {
    if (k === undefined) k = 4.0;
    const n = a.length;
    let s = 0;
    for (let i = 0; i < n; i++) s += a[i];
    const mean = s / n;
    let v = 0;
    for (let i = 0; i < n; i++) { const d = a[i] - mean; v += d * d; }
    const std = Math.sqrt(v / n);
    const den = std * k + 1e-9;
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
    return norm(out);
  }

  function noise1d(n, g) {
    const base = new Float64Array(g);
    for (let i = 0; i < g; i++) base[i] = rng.random();
    const out = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const idx = (k * g) / n;
      const i0 = Math.trunc(idx) % g, i1 = (i0 + 1) % g;
      let f = idx - Math.floor(idx);
      f = f * f * (3 - 2 * f);
      out[k] = base[i0] * (1 - f) + base[i1] * f;
    }
    return out;
  }

  function bil(tex, n, u, v) {
    const u0 = Math.floor(u), v0 = Math.floor(v);
    const fu = u - u0, fv = v - v0;
    const i0 = mod(u0, n), j0 = mod(v0, n);
    const i1 = (i0 + 1) % n, j1 = (j0 + 1) % n;
    return ((tex[j0 * n + i0] * (1 - fu) + tex[j0 * n + i1] * fu) * (1 - fv)
      + (tex[j1 * n + i0] * (1 - fu) + tex[j1 * n + i1] * fu) * fv);
  }

  // ---------- module-level state, same RNG draw order as the Python ----------

  const TS = tex2d(1024, [6, 20, 64, 200]);
  const TG = tex2d(1024, [8, 24, 64, 160]);
  const TW = randArr(512 * 512);
  const TV = (() => {
    const t = tex2d(512, [5, 12, 30]);
    for (let i = 0; i < t.length; i++) t[i] = 1 - Math.abs(2 * t[i] - 1);
    return t;
  })();
  const TV2 = (() => {
    const t = tex2d(512, [3, 7, 16]);
    for (let i = 0; i < t.length; i++) t[i] = 1 - Math.abs(2 * t[i] - 1);
    return t;
  })();

  const NA = 4096;
  function angTable(n1, w1, n2, w2, n3, w3) {
    const a = noise1d(NA, n1), b = noise1d(NA, n2), c = noise1d(NA, n3);
    const s = new Float32Array(NA);
    for (let i = 0; i < NA; i++) s[i] = w1 * a[i] + w2 * b[i] + w3 * c[i];
    return norm(s, 3.0);
  }
  const A1 = angTable(900, 0.5, 300, 0.3, 120, 0.2);
  const A2 = angTable(700, 0.5, 200, 0.3, 80, 0.2);
  const A3 = norm(noise1d(NA, 13), 3.0);
  const A4 = norm(noise1d(NA, 48), 3.0);

  const NS = 3200;
  const SX = uniformArr(-1, 1, NS);
  const SY = uniformArr(-1, 1, NS);
  const SD = uniformArr(0.06, 1.0, NS);
  const SB = new Float32Array(NS);
  for (let i = 0; i < NS; i++) SB[i] = 0.10 + 0.90 * Math.pow(rng.random(), 3.5);
  const SCOL = new Float32Array(NS * 3);
  for (let i = 0; i < NS; i++) {
    const tm = Math.pow(randArr(1)[0], 1.5);
    SCOL[i * 3] = mix(0.70, 1.0, tm);
    SCOL[i * 3 + 1] = mix(0.82, 0.80, tm);
    SCOL[i * 3 + 2] = mix(1.0, 0.55, tm);
  }
  const SPH = uniformArr(0, 6.28, NS);
  const SF = uniformArr(1.0, 3.5, NS);

  const GZ = [[0.0, 0.0, 0.0]];
  {
    let tc = 1.7;
    const gr = new MT().initByArray([4]);
    while (tc < 40) {
      GZ.push([tc, gr.uniform(-0.045, 0.045), gr.uniform(-0.022, 0.02)]);
      tc += gr.uniform(0.9, 2.4);
    }
  }

  const UP_L = [], LO_L = [];
  {
    const lr = new MT().initByArray([21]);
    const NUP = 44, NLO = 20;
    for (let i = 0; i < NUP; i++) UP_L.push([-0.92 + 1.84 * i / (NUP - 1), lr.uniform(0.92, 1.08), 0.0, 1.0]);
    for (let i = 0; i < NLO; i++) LO_L.push([-0.70 + 1.40 * i / (NLO - 1), lr.uniform(0.90, 1.10), 0.0, 1.0]);
  }

  // ---------- geometry (init) ----------

  let CW, CH, ROWS, COLS, W, H, GW, GH;
  let X, Y, RS, RSC, HSC;

  function init(cw, ch, rows) {
    CW = cw; CH = ch;
    COLS = Math.trunc(rows * ch * ASPECT / cw);
    COLS = COLS - (COLS % 2);
    ROWS = rows - (rows % 2);
    W = COLS * CW; H = ROWS * CH;
    GW = COLS * SS; GH = ROWS * SS;

    X = new Float32Array(GW * GH);
    Y = new Float32Array(GW * GH);
    RS = new Float32Array(GW * GH);
    const xs = new Float32Array(GW), ys = new Float32Array(GH);
    for (let i = 0; i < GW; i++) xs[i] = f32((i + 0.5) * (CW / SS));
    for (let j = 0; j < GH; j++) ys[j] = f32((j + 0.5) * (CH / SS));
    for (let j = 0; j < GH; j++) {
      const yv = f32((ys[j] - H / 2) / H);
      for (let i = 0; i < GW; i++) {
        const xv = f32((xs[i] - W / 2) / H);
        const p = j * GW + i;
        X[p] = xv; Y[p] = yv;
        RS[p] = Math.sqrt(xv * xv + yv * yv);
      }
    }
    RSC = new Float32Array(ROWS * COLS);
    HSC = new Float32Array(ROWS * COLS);
    for (let r = 0; r < ROWS; r++) {
      const yc = f32(((r + 0.5) * CH - H / 2) / H);
      for (let c = 0; c < COLS; c++) {
        const xc = f32(((c + 0.5) * CW - W / 2) / H);
        RSC[r * COLS + c] = Math.sqrt(xc * xc + yc * yc);
        const h = (BigInt(r) * 73856093n) ^ (BigInt(c) * 19349663n) ^ 0x5bd1e995n;
        HSC[r * COLS + c] = Number(h % 1009n) / 1009.0;
      }
    }
    reset();
  }

  // ---------- timeline ----------

  function blinkC(t, tb) {
    if (tb === undefined) tb = T_BLINK;
    const d = t - tb;
    if (d < 0 || d > 0.36) return 0.0;
    if (d < 0.09) return ease(d / 0.09);
    if (d < 0.12) return 1.0;
    return 1 - ease((d - 0.12) / 0.24);
  }

  function lidOpen(t) {
    let k = ease((t - T_OPEN) / T_OPEN_D);
    k = k * (1 + 0.035 * Math.sin(PI * k));
    return Math.min(1.0, k) * (1 - 0.985 * blinkC(t));
  }

  function gaze(t) {
    let prev = [0.0, 0.0], cur = [0.0, 0.0], te = 0.0;
    for (const [t_, gx_, gy_] of GZ) {
      if (t_ <= t) { prev = cur; cur = [gx_, gy_]; te = t_; } else break;
    }
    const k = ease((t - te) / 0.09);
    let gx = prev[0] + (cur[0] - prev[0]) * k;
    let gy = prev[1] + (cur[1] - prev[1]) * k;
    gx += 0.003 * Math.sin(t * 1.3);
    gy += 0.002 * Math.sin(t * 1.1 + 1);
    const amp = 1 - ease((t - T_Z0) / 2.5);
    gy -= 0.03 * blinkC(t);
    return [gx * amp, gy * amp];
  }

  function lidEdgesScalar(u0, ou) {
    const s = u0 / WO;
    const wu = s < -0.12 ? 0.88 : 1.12;
    const cu = Math.pow(Math.max(0.0, 1 - Math.pow((s + 0.12) / wu, 2)), 0.8);
    const cl = Math.pow(Math.max(0.0, 1 - (s - 0.08) * (s - 0.08)), 0.9);
    const vc = 0.03 * cl;
    const vl = vc + (HL * cl - vc) * (0.35 + 0.65 * ou);
    const vu = vl + (-HU * cu - vl) * ou;
    return [vu, vl, cu, cl];
  }

  // ---------- nebula ----------

  function heartNebulaAdd(sp, shiftX, shiftY, sz, hm, t, gain) {
    const wob = 1 - 0.65 * hm;
    const k = 3.0 + 2.5 * hm;
    const qd = 0.80 - 0.35 * hm;
    for (let p = 0; p < GW * GH; p++) {
      const hx = (X[p] - shiftX) / sz;
      const hy = -(Y[p] - shiftY) / sz;
      const nC = bil(TG, 1024, hx * 16 + 400, hy * 16 + 100);
      const nD = bil(TG, 1024, hx * 16 + 90, hy * 16 + 530);
      const nA = bil(TG, 1024, hx * 42 + 300, hy * 42 + 700 + t * 0.8);
      const nB = bil(TG, 1024, hx * 110 + 80, hy * 110 + 200);
      const hxw = hx + wob * 0.40 * (nC - 0.5) + 0.05 * (nA - 0.5);
      const hyw = hy + wob * 0.40 * (nD - 0.5) + 0.05 * (nA - 0.5);
      const qc = Math.sqrt(hxw * hxw + hyw * hyw) / 0.80 - 1.0;
      const hyh = hyw + 0.12;
      const e = hxw * hxw + hyh * hyh - 1.0;
      const fh = e * e * e - hxw * hxw * hyh * hyh * hyh;
      const qh = 0.5 * Math.cbrt(fh);
      const q = qc * (1 - hm) + qh * hm;
      const ins = clip(-q / qd, 0, 1);
      const qp = clip(q, 0, 10);
      const body = q < 0 ? 0.50 + 0.50 * Math.sqrt(ins) : Math.exp(-qp * k) * 0.50;
      const tex = 1 + (0.62 + 0.80 * nB - 1) * 0.8;
      const hk = Math.pow(ins, 0.8);
      const bt = body * tex;
      let r = bt * mix(0.92, 1.0, hk);
      let g = bt * mix(0.16, 0.58, hk);
      let b = bt * mix(0.40, 0.78, hk);

      const halo = q > 0 ? Math.exp(-qp * 1.6) * 0.20 * (0.5 + nA) : 0;
      r += halo * 0.78; g += halo * 0.10; b += halo * 0.30;

      const rim = Math.exp(-Math.pow((q + 0.04) / 0.14, 2));
      const rid = clip((bil(TV, 512, hxw * 120 + 50, hyw * 120 + 300 + t * 0.6) - 0.86) * 7, 0, 1);
      const wr = rim * (0.20 + 0.9 * rid) * (0.5 + nA) + rid * clip(-q, 0, 1) * 0.25;
      r += wr * 0.95; g += wr * 0.16; b += wr * 0.34;

      sp[p * 3] += r * gain;
      sp[p * 3 + 1] += g * gain;
      sp[p * 3 + 2] += b * gain;
    }
  }

  // ---------- eye ----------

  function eyeScene(t, z, ou, gx, gy, Rp, sp, img, pm) {
    const iz = 1.0 / z;
    const px = iz / GH;
    const near = z < 3.4;
    const Rps = Rp * z;
    const fade = Math.max(0.0, Math.min(1.0, 1 - (z - 1.6) / 2.4));
    const cr_pos = 0.075 + 0.03 * (1 - ou);

    for (let j = 0; j < GH; j++) {
      for (let i = 0; i < GW; i++) {
        const p = j * GW + i;
        const u = X[p] * iz, v = Y[p] * iz;
        const pm_u = u - gx, pm_v = v - gy;
        const r = Math.sqrt(pm_u * pm_u + pm_v * pm_v);

        let s = 0, vt = 0, vu = 0, vl = 0, du_in = 0, dl_in = 0, m_in = 0;
        if (near) {
          s = u / WO;
          const sa = clip(s, -1.3, 1.3);
          const wu = sa < -0.12 ? 0.88 : 1.12;
          const cu = Math.pow(clip(1 - Math.pow((sa + 0.12) / wu, 2), 0, 1), 0.8);
          const cl = Math.pow(clip(1 - (sa - 0.08) * (sa - 0.08), 0, 1), 0.9);
          vt = v + 0.055 * s;
          const vc = 0.03 * cl;
          vl = vc + (HL * cl - vc) * (0.35 + 0.65 * ou);
          vu = vl + (-HU * cu - vl) * ou;
          du_in = vt - vu;
          dl_in = vl - vt;
          const d_in = Math.min(du_in, dl_in);
          m_in = clip(d_in / (1.6 * px) + 0.5, 0, 1);
        }

        // iris
        let angf = Math.atan2(pm_v, pm_u) / (2 * PI);
        angf = angf - Math.floor(angf);
        const ia = Math.trunc(angf * NA) % NA;
        const rn = clip((r - Rp) / (RI - Rp), 0, 1.3);
        const rb = rn * 14;
        const i0 = Math.floor(rb);
        const fr = rb - i0;
        const fib = 0.55 * A1[ia] + 0.45 * (A2[(ia + i0 * 131) % NA] * (1 - fr) + A2[(ia + (i0 + 1) * 131) % NA] * fr);
        const zz = angf * 34;
        const zig = Math.abs((zz - Math.floor(zz)) - 0.5) * 2 - 0.5;
        const cr = 0.34 + 0.20 * (A3[ia] - 0.5) + 0.035 * zig;
        const mm = ss(-0.10, 0.22, rn - cr);
        let iR = mix(0.80, 0.42, mm), iG = mix(0.45, 0.20, mm), iB = mix(0.10, 0.06, mm);
        const fk = 0.45 + 1.05 * fib;
        iR *= fk; iG *= fk; iB *= fk;
        const ring = Math.exp(-Math.pow((rn - cr) / 0.07, 2)) * (0.2 + fib);
        iR += 0.22 * ring; iG += 0.11 * ring;
        const cry = (A4[ia] > 0.72 ? 1 : 0) * ss(0.65, 0.18, rn);
        let km = (1 - 0.55 * cry) * (1 - 0.82 * ss(0.62, 1.0, rn)) * (0.55 + 0.45 * ss(0, 0.07, rn));
        if (near) km *= 0.30 + 0.70 * ss(0, 0.16, du_in);
        iR *= km; iG *= km; iB *= km;

        let inR, inG, inB;
        if (near) {
          const cw = ss(0.40, 0.95, Math.abs(s));
          const sh = (0.38 + 0.62 * ss(0, 0.22, du_in)) * (0.72 + 0.28 * ss(0, 0.10, dl_in)) * (1 - 0.30 * cw);
          let sR = 0.80 * sh, sG = 0.82 * sh, sB = 0.86 * sh;
          const cwk = cw * 0.35;
          sR = mix(sR, 0.86 * sh, cwk); sG = mix(sG, 0.50 * sh, cwk); sB = mix(sB, 0.46 * sh, cwk);
          const vein = clip((bil(TV2, 512, u * 85 + 40, v * 85 + 70) - 0.925) * 14, 0, 1)
            * (0.25 + 0.75 * cw) * ss(0.12, 0.32, Math.abs(pm_u));
          const vk = vein * 0.65;
          sR = mix(sR, 0.62, vk); sG = mix(sG, 0.15, vk); sB = mix(sB, 0.14, vk);
          const im = clip((RI - r) / (1.6 * px) + 0.5, 0, 1);
          inR = mix(sR, iR, im); inG = mix(sG, iG, im); inB = mix(sB, iB, im);
        } else {
          inR = iR; inG = iG; inB = iB;
        }

        // pupil = window into space
        const vig = 0.25 + 0.75 * ss(0, 0.30 * Rps, Rps - RS[p]);
        const pmv = clip((Rp - r) / (1.6 * px) + 0.5, 0, 1);
        pm[p] = pmv;
        inR = mix(inR, sp[p * 3] * vig, pmv);
        inG = mix(inG, sp[p * 3 + 1] * vig, pmv);
        inB = mix(inB, sp[p * 3 + 2] * vig, pmv);

        // catchlights
        if (fade > 0) {
          const dd = Math.sqrt((pm_u - 0.075) * (pm_u - 0.075) + (pm_v + 0.040) * (pm_v + 0.040));
          const win = clip(1 - (dd - 0.030) / (1.4 * px + 0.004), 0, 1);
          const dd2 = Math.sqrt((pm_u + 0.045) * (pm_u + 0.045) + (pm_v - 0.050) * (pm_v - 0.050));
          const win2 = clip(1 - (dd2 - 0.009) / (1.4 * px + 0.003), 0, 1) * 0.5;
          const wk = (win + win2) * fade * 1.4;
          inR += wk * 1.0; inG += wk * 0.98; inB += wk * 0.95;
        }

        if (!near || z >= 2.6) {
          img[p * 3] = inR; img[p * 3 + 1] = inG; img[p * 3 + 2] = inB;
          continue;
        }

        // skin, lids, brow
        const mid = 0.5 * (vu + vl);
        const upper = vt < mid;
        const du = Math.max(vu - vt, 0);
        const dl = Math.max(vt - vl, 0);
        const dd = upper ? du : dl;
        const tx = bil(TS, 1024, u * 120 + 100, v * 120 + 100);
        const bk = 0.90 + 0.20 * tx;
        let kR = 0.62 * bk, kG = 0.40 * bk, kB = 0.29 * bk;
        let sh = 0.50 + 0.50 * ss(0, 0.30, dd);
        sh *= 1 + 0.10 * Math.exp(-Math.pow((v + 0.20) / 0.09, 2));
        if (upper) sh *= 1 - 0.42 * Math.exp(-Math.pow((du - cr_pos) / 0.020, 2));
        else sh *= 1 + 0.08 * Math.exp(-Math.pow((dl - 0.09) / 0.04, 2));
        kR *= sh; kG *= sh; kB *= sh;
        const lidzone = upper ? ss(cr_pos, cr_pos * 0.4, du) : 0;
        const lk = lidzone * 0.5;
        kR = mix(kR, 0.68 * sh, lk); kG = mix(kG, 0.40 * sh, lk); kB = mix(kB, 0.31 * sh, lk);

        const sb = clip(1 - Math.abs(s), 0, 1);
        const eb = Math.exp(-Math.pow((vt + 0.42 + 0.10 * s * s) / (0.040 + 0.012 * sb), 2));
        const hair = 0.55 + 0.9 * bil(TW, 512, u * 90, v * 30);
        const ek = clip(eb * hair, 0, 0.92);
        kR = mix(kR, 0.10, ek); kG = mix(kG, 0.06, ek); kB = mix(kB, 0.04, ek);

        const line = upper ? Math.exp(-Math.pow(du / 0.010, 2)) : 0;
        const lnk = clip(line * (1.0 - 0.3 * ou) * 0.9, 0, 1);
        kR = mix(kR, 0.05, lnk); kG = mix(kG, 0.03, lnk); kB = mix(kB, 0.022, lnk);

        const wl = upper ? 0 : ss(0.014, 0.0, dl);
        const wk2 = wl * 0.7;
        kR = mix(kR, 0.74, wk2); kG = mix(kG, 0.34, wk2); kB = mix(kB, 0.30, wk2);

        const gl = upper ? 0 : Math.exp(-Math.pow((dl - 0.016) / 0.006, 2)) * (0.35 + 0.65 * bil(TW, 512, u * 60, v * 60));
        const gk = gl * 0.55 * ss(0.12, 0.5, ou);
        kR += gk * 1.0; kG += gk * 0.85; kB += gk * 0.75;

        const spk = (bil(TW, 512, u * 150 + 7, v * 150 + 3) > 0.985 ? 1 : 0) * 0.35 * (0.4 + tx) * ss(0.0, 0.3, dd);
        kR += spk * 1.0; kG += spk * 0.9; kB += spk * 0.8;

        let cR = mix(kR, inR, m_in), cG = mix(kG, inG, m_in), cB = mix(kB, inB, m_in);

        const cg = Math.exp(-(Math.pow((u + WO * 0.90) / 0.045, 2) + Math.pow((vt - 0.025) / 0.032, 2))) * ss(0.1, 0.5, ou);
        const cgk = cg * 0.85;
        cR = mix(cR, 0.82, cgk); cG = mix(cG, 0.42, cgk); cB = mix(cB, 0.38, cgk);

        img[p * 3] = cR; img[p * 3 + 1] = cG; img[p * 3 + 2] = cB;
      }
    }
  }

  // ---------- world: stars, streaks, comet ----------

  const streaks = [];
  const S = { last: 0.0, next_shoot: 1.0e9, comet: false };

  function makeStreak(x, y, vx, vy, life, tail, col, soft) {
    return { x, y, vx, vy, life, tail, col, soft: !!soft, age: 0.0 };
  }

  function reset() {
    S.last = 0.0; S.next_shoot = 1.0e9; S.comet = false;
    streaks.length = 0;
    for (let i = 0; i < NS; i++) SD[i] = rng.uniform(0.06, 1.0);
  }

  function updateWorld(t, dt, prog) {
    const vf = 0.010 + 0.05 * prog + (t > T_SPACE ? 0.015 : 0.0);
    const step = f32(vf * dt);
    const dead = [];
    const add = f32(0.94);
    for (let i = 0; i < NS; i++) {
      SD[i] = SD[i] - step;
      if (SD[i] < 0.06) dead.push(i);
    }
    if (dead.length) {
      for (const i of dead) SD[i] = SD[i] + add;
      for (const i of dead) SX[i] = rng.uniform(-1, 1);
      for (const i of dead) SY[i] = rng.uniform(-1, 1);
    }
    if (S.next_shoot > 1e8 && t > T_SPACE - 4.0) S.next_shoot = t + 1.0;
    if (t > S.next_shoot) {
      S.next_shoot = t + prnd.uniform(2.2, 4.5);
      const ang = prnd.uniform(18, 62) * PI / 180;
      const sgn = prnd.choice2(-1, 1);
      const spd = prnd.uniform(0.7, 1.2);
      const x = prnd.uniform(-0.7, 0.7), y = prnd.uniform(-0.45, -0.15);
      const life = prnd.uniform(0.9, 1.4), tail = prnd.uniform(0.14, 0.26);
      streaks.push(makeStreak(x, y, sgn * Math.cos(ang) * spd, Math.sin(ang) * spd,
        life, tail, [0.88, 0.94, 1.0], false));
    }
    if (t > T_SPACE + 1.5 && !S.comet) {
      S.comet = true;
      streaks.push(makeStreak(-0.95, -0.28, 0.030, 0.008, 70.0, 0.22, [0.70, 0.86, 1.0], true));
    }
    for (const s_ of streaks) s_.age += dt;
    for (let i = streaks.length - 1; i >= 0; i--) if (streaks[i].age >= streaks[i].life) streaks.splice(i, 1);
  }

  // ---------- character stamping ----------

  function put(idx, fg, r, c, ch, color, a) {
    if (a === undefined) a = 1.0;
    if (r >= 0 && r < ROWS && c >= 0 && c < COLS) {
      const p = r * COLS + c;
      idx[p] = CIDX[ch];
      fg[p * 3] = color[0] * a; fg[p * 3 + 1] = color[1] * a; fg[p * 3 + 2] = color[2] * a;
    }
  }

  function stampStreak(s_, idx, fg, pmc, vigc) {
    const hx = s_.x + s_.vx * s_.age;
    const hy = s_.y + s_.vy * s_.age;
    const sp = Math.hypot(s_.vx, s_.vy);
    const dx = s_.vx / sp, dy = s_.vy / sp;
    const fade = Math.pow(Math.sin(PI * Math.min(1.0, s_.age / s_.life)), 0.7);
    if (fade < 0.02) return;
    let tc;
    if (Math.abs(dy) < 0.38 * Math.abs(dx)) tc = '-';
    else if (Math.abs(dx) < 0.38 * Math.abs(dy)) tc = '|';
    else if (dx * dy > 0) tc = '\\';
    else tc = '/';
    const n = Math.max(6, Math.trunc(s_.tail * H / (CW * 0.8)));
    for (let k = 0; k < n; k++) {
      const f = k / n;
      const c = Math.trunc((W / 2 + (hx - dx * s_.tail * f) * H) / CW);
      const r = Math.trunc((H / 2 + (hy - dy * s_.tail * f) * H) / CH);
      const b = Math.pow(1 - f, 1.3) * fade;
      if (b < 0.08 || !(r >= 0 && r < ROWS && c >= 0 && c < COLS) || pmc[r * COLS + c] < 0.5) continue;
      let ch;
      if (k === 0) ch = s_.soft ? '*' : '@';
      else if (s_.soft) ch = b > 0.35 ? ':' : '.';
      else ch = b > 0.30 ? tc : '.';
      put(idx, fg, r, c, ch, s_.col, Math.min(1.0, 0.3 + b) * vigc[r * COLS + c]);
    }
  }

  function stampStars(idx, fg, L, t, gs, amt, pmc, vigc, offx, offy) {
    if (amt <= 0.003) return;
    // visible stars, in index order (numpy fancy-assign: later index wins)
    const sel = [];
    for (let i = 0; i < NS; i++) {
      const d = SD[i];
      const c = Math.trunc((W * 0.5 + (SX[i] * gs / d + offx) * H) / CW);
      const r = Math.trunc((H * 0.5 + (SY[i] * gs / d + offy) * H) / CH);
      const alpha = ss(1.0, 0.82, d) * (0.80 + 0.20 * Math.sin(t * SF[i] + SPH[i])) * amt;
      if (!(c >= 0 && c < COLS && r >= 0 && r < ROWS && alpha > 0.04)) continue;
      const b = SB[i] * alpha * (1 + 0.05 / d);
      const cell = r * COLS + c;
      if (!(pmc[cell] > 0.5)) continue;
      if (!(b > L[cell] * 0.7)) continue;
      sel.push([i, r, c, b]);
    }
    if (!sel.length) return;
    for (const [i, r, c, b] of sel) {
      const cell = r * COLS + c;
      idx[cell] = b < 0.20 ? CIDX['.'] : (b < 0.42 ? CIDX['+'] : CIDX['*']);
      const kk = clip(0.35 + 0.9 * b, 0, 1) * vigc[cell];
      fg[cell * 3] = SCOL[i * 3] * kk; fg[cell * 3 + 1] = SCOL[i * 3 + 1] * kk; fg[cell * 3 + 2] = SCOL[i * 3 + 2] * kk;
    }

    let nbig = 0;
    for (const [i, rr_, cc_, bb] of sel) {
      if (!(bb > 0.55)) continue;
      if (nbig++ >= 40) break;
      const cell = rr_ * COLS + cc_;
      const col = [SCOL[i * 3] * vigc[cell], SCOL[i * 3 + 1] * vigc[cell], SCOL[i * 3 + 2] * vigc[cell]];
      idx[cell] = bb > 0.85 ? CIDX['@'] : CIDX['*'];
      const ln = Math.trunc(2 + 6 * (bb - 0.5));
      for (let k = 1; k <= ln; k++) {
        const a = (1 - k / (ln + 1)) * bb;
        const v = Math.floor(k / 2) + (k > 2 ? 1 : 0);
        const arms = [[0, k, '-'], [0, -k, '-'], [v, 0, '|'], [-v, 0, '|']];
        for (const [dr, dc, chh] of arms) {
          if (dr === 0 && dc === 0) continue;
          const r2 = rr_ + dr, c2 = cc_ + dc;
          if (r2 >= 0 && r2 < ROWS && c2 >= 0 && c2 < COLS && pmc[r2 * COLS + c2] > 0.5 && L[r2 * COLS + c2] < a * 0.8) {
            const p2 = r2 * COLS + c2;
            idx[p2] = CIDX[a > 0.18 ? chh : '.'];
            const m_ = Math.min(1.0, 0.25 + a);
            fg[p2 * 3] = col[0] * m_; fg[p2 * 3 + 1] = col[1] * m_; fg[p2 * 3 + 2] = col[2] * m_;
          }
        }
      }
    }
  }

  function stampLashes(idx, fg, t, z, ou, gx, gy) {
    if (z > 2.6 || ou < 0.0) return;
    const cl = 1 - Math.pow(ou, 0.8);

    const toCell = (ue, ve) => [Math.trunc((W / 2 + ue * z * H) / CW), Math.trunc((H / 2 + ve * z * H) / CH)];

    const pick = (aa) => {
      const deg = Math.atan2(-Math.sin(aa), Math.cos(aa)) * 180 / PI;
      const ang = mod(deg, 180);
      if (ang < 25 || ang >= 155) return '-';
      if (ang < 70) return '/';
      if (ang < 110) return '|';
      return '\\';
    };

    const draw = (base_u, base_v, a0, L, curl, c_root, c_tip, nmax, tip) => {
      const n = Math.trunc(Math.max(2, Math.min(nmax, L * z * H / (CW * 0.85))));
      const step = L / n;
      let ue = base_u, ve = base_v;
      for (let k = 0; k < n; k++) {
        const tt = k / Math.max(1, n - 1);
        const aa = a0 + curl * tt * tt;
        ue += Math.cos(aa) * step;
        ve += Math.sin(aa) * step;
        const [c, r] = toCell(ue, ve);
        if (!(r >= 0 && r < ROWS && c >= 0 && c < COLS)) continue;
        const ch = (k === n - 1 && n >= 4) ? tip : pick(aa);
        const p = r * COLS + c;
        idx[p] = CIDX[ch];
        fg[p * 3] = c_root[0] + (c_tip[0] - c_root[0]) * tt;
        fg[p * 3 + 1] = c_root[1] + (c_tip[1] - c_root[1]) * tt;
        fg[p * 3 + 2] = c_root[2] + (c_tip[2] - c_root[2]) * tt;
      }
    };

    const up_root = [0.16, 0.10, 0.07], up_tip = [0.30, 0.19, 0.13];
    const lo_root = [0.17, 0.11, 0.08], lo_tip = [0.30, 0.20, 0.14];
    const rad = (d) => d * PI / 180;

    for (const [s0, lf_] of UP_L) {
      const u0 = s0 * WO;
      const [vu] = lidEdgesScalar(u0, ou);
      const bv = vu - 0.055 * s0;
      const a_open = rad(-90 + 26 * s0);
      const a_closed = s0 >= 0 ? rad(90 - 20 * s0) : rad(-270 - 20 * s0);
      const a0 = a_open + (a_closed - a_open) * cl;
      const edge = Math.sqrt(Math.max(0.0, 1 - s0 * s0));
      const Lh = (0.070 + 0.050 * edge) * lf_;
      const curl = rad(-22 * s0) * (1 - cl);
      draw(u0, bv, a0, Lh, curl, up_root, up_tip, 14, "'");
    }
    for (const [s0, lf_] of LO_L) {
      const u0 = s0 * WO;
      const [, vl, , cl_] = lidEdgesScalar(u0, ou);
      const bv = vl - 0.055 * s0;
      const a0 = rad(90 - 20 * s0);
      const Lh = 0.034 * (0.5 + 0.8 * cl_) * lf_;
      draw(u0, bv, a0, Lh, rad(12 * (s0 > 0 ? 1 : -1)), lo_root, lo_tip, 6, '.');
    }
  }

  // ---------- post ----------

  function bloom(img) {
    const out = Float32Array.from(img);
    const b = new Float32Array(img.length);
    for (let i = 0; i < img.length; i++) b[i] = Math.max(img[i] - 0.45, 0);
    for (const [f, w_] of [[2, 0.40], [4, 0.30]]) {
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

  function renderCells(t, dt) {
    S.last = t;
    const prog = zp(t);
    const idle = ease(t / T_Z0);
    const z = Math.exp(Math.log(ZEND) * prog) * (1 + 0.05 * idle + 0.004 * Math.sin(t * 0.9));
    const zsp = t < T_SPACE ? z : ZEND * Math.exp(0.03 * (t - T_SPACE));
    const gs = Math.min(6.0, GS0 * Math.pow(zsp, 1.25));
    const gh = Math.min(1.15, GS0 * Math.pow(z, 1.25));
    const ou = lidOpen(t);
    const [gx, gy] = gaze(t);
    const Rp = RP0 * (0.76 + 0.24 * ease((t - 1.8) / 3.5)) * (1 + 0.025 * Math.sin(1.9 * t)) * (1 + 0.30 * prog);
    const Rps = Rp * z;
    const full = Rps * 0.72 > 1.03;

    const star_amt = ease((t - (T_Z0 + 1.5)) / 4.5);
    const neb_amt = ease((t - (T_Z0 + 3.5)) / 8.0);
    updateWorld(t, dt, prog);

    const offx = gx * z, offy = gy * z;
    const sp = new Float32Array(GW * GH * 3);
    for (let p = 0; p < GW * GH; p++) { sp[p * 3] = 0.004; sp[p * 3 + 1] = 0.005; sp[p * 3 + 2] = 0.012; }
    if (neb_amt > 0.002) {
      const drift = ease((t - T_SPACE) / 20.0);
      const hm = ease((t - T_HEART) / T_HEART_D);
      const beat = 1 + 0.03 * Math.sin(t * 2.6) * hm * hm;
      heartNebulaAdd(sp, offx + 0.03 * drift * Math.sin(t * 0.07), offy,
        0.17 * gh * beat, hm, t, 1.25 * Math.pow(neb_amt, 1.3));
    }

    let img;
    const pmc = new Float32Array(ROWS * COLS);
    const solid = new Uint8Array(ROWS * COLS);
    if (full) {
      img = sp;
      pmc.fill(1);
    } else {
      img = new Float32Array(GW * GH * 3);
      const pm = new Float32Array(GW * GH);
      eyeScene(t, z, ou, gx, gy, Rp, sp, img, pm);
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          let acc = 0;
          for (let a = 0; a < SS; a++) for (let b = 0; b < SS; b++) acc += pm[(r * SS + a) * GW + (c * SS + b)];
          const v = acc / (SS * SS);
          pmc[r * COLS + c] = v;
          solid[r * COLS + c] = v < 0.5 ? 1 : 0;
        }
      }
    }

    img = bloom(img);
    const ek = ease(t / 1.2);
    for (let j = 0; j < GH; j++) {
      for (let i = 0; i < GW; i++) {
        const p = j * GW + i;
        const k = (1 - 0.30 * ss(0.4, 1.0, RS[p])) * ek;
        for (let ch = 0; ch < 3; ch++) {
          const v = Math.max(img[p * 3 + ch], 0);
          img[p * 3 + ch] = (1 - Math.exp(-2.0 * v)) * k;
        }
      }
    }

    const idx = new Int32Array(ROWS * COLS);
    const fg = new Float32Array(ROWS * COLS * 3);
    const li = new Float32Array(ROWS * COLS);
    const inv = 1 / (SS * SS);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        let R = 0, G = 0, B = 0;
        for (let a = 0; a < SS; a++) {
          for (let b = 0; b < SS; b++) {
            const p = ((r * SS + a) * GW + (c * SS + b)) * 3;
            R += img[p]; G += img[p + 1]; B += img[p + 2];
          }
        }
        R *= inv; G *= inv; B *= inv;
        const cell = r * COLS + c;
        const lum = 0.30 * R + 0.60 * G + 0.10 * B;
        const l = Math.pow(clip(lum, 0, 1), 0.72);
        li[cell] = l;
        let ri = Math.trunc(clip((l + (HSC[cell] - 0.5) * 0.07) * NR, 0, NR));
        if (solid[cell]) ri = Math.max(ri, 3);
        idx[cell] = ri;
        fg[cell * 3] = clip(R * 1.15, 0, 1);
        fg[cell * 3 + 1] = clip(G * 1.15, 0, 1);
        fg[cell * 3 + 2] = clip(B * 1.15, 0, 1);
      }
    }

    const vigc = new Float32Array(ROWS * COLS);
    for (let c = 0; c < vigc.length; c++) vigc[c] = 0.25 + 0.75 * ss(0, 0.30 * Rps, Rps - RSC[c]);

    stampStars(idx, fg, li, t, gs, star_amt, pmc, vigc, offx, offy);
    for (const s_ of streaks) stampStreak(s_, idx, fg, pmc, vigc);
    if (!full) stampLashes(idx, fg, t, z, ou, gx, gy);

    const q = new Int16Array(ROWS * COLS * 3);
    for (let i = 0; i < q.length; i++) q[i] = clip(Math.trunc(clip(fg[i], 0, 1) * (QL - 0.01)), 0, QL - 1);
    return { idx, q };
  }

  const api = {
    init, renderCells, reset, RAMP, QL, FPS, MAXROWS, S,
    dims: () => ({ CW, CH, ROWS, COLS, W, H }),
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
