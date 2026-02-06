// src/stats.ts
// （変更なし：あなたが貼ったものをそのまま使ってOK）
export function mean(xs: number[]) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function sd(xs: number[]) {
  if (xs.length <= 1) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

// Hedges' g (small-sample corrected Cohen's d)
export function hedgesG(x: number[], y: number[]) {
  const nx = x.length, ny = y.length;
  if (nx < 2 || ny < 2) return 0;

  const mx = mean(x), my = mean(y);
  const sx = sd(x), sy = sd(y);
  const sp = Math.sqrt(((nx - 1) * sx * sx + (ny - 1) * sy * sy) / (nx + ny - 2));
  if (!isFinite(sp) || sp === 0) return 0;

  const d = (mx - my) / sp;
  const J = 1 - (3 / (4 * (nx + ny) - 9));
  return d * J;
}

export function bootstrapCI(
  xs: number[],
  fn: (sample: number[]) => number,
  B = 2000,
  alpha = 0.05,
  rng = mulberry32(12345)
) {
  if (xs.length === 0) return { lo: 0, hi: 0 };
  const stats: number[] = [];
  for (let b = 0; b < B; b++) {
    const sample = new Array(xs.length);
    for (let i = 0; i < xs.length; i++) {
      sample[i] = xs[Math.floor(rng() * xs.length)];
    }
    stats.push(fn(sample));
  }
  stats.sort((a, b) => a - b);
  const lo = stats[Math.floor((alpha / 2) * (B - 1))];
  const hi = stats[Math.floor((1 - alpha / 2) * (B - 1))];
  return { lo, hi };
}

// Survival: log-rank test (two groups) with normal approximation
export function logRankTest(data: { time: number; event: 0 | 1; group: 0 | 1 }[]) {
  const times = Array.from(new Set(data.filter(d => d.event === 1).map(d => d.time))).sort((a,b)=>a-b);
  if (times.length === 0) return { z: 0, pApprox: 1, O1: 0, E1: 0, V: 0 };

  let O1 = 0, E1 = 0, V = 0;

  for (const t of times) {
    const risk = data.filter(d => d.time >= t);
    const n = risk.length;
    const n1 = risk.filter(d => d.group === 1).length;

    const events = data.filter(d => d.time === t && d.event === 1);
    const d = events.length;
    const d1 = events.filter(d => d.group === 1).length;

    if (n <= 1) continue;

    const e1 = d * (n1 / n);
    const v = (d * (n1 / n) * (1 - n1 / n) * (n - d)) / (n - 1);

    O1 += d1;
    E1 += e1;
    V += v;
  }

  const z = V > 0 ? (O1 - E1) / Math.sqrt(V) : 0;
  const pApprox = 2 * (1 - normalCdf(Math.abs(z)));
  return { z, pApprox, O1, E1, V };
}

export type KMPoint = { t: number; S: number };

export function kmCurve(data: { time: number; event: 0 | 1 }[]) : KMPoint[] {
  const times = Array.from(new Set(data.filter(d => d.event === 1).map(d => d.time))).sort((a,b)=>a-b);

  let S = 1.0;
  const curve: KMPoint[] = [{ t: 0, S: 1.0 }];

  for (const t of times) {
    const atRisk = data.filter(d => d.time >= t);
    const n = atRisk.length;
    if (n <= 0) continue;

    const events = data.filter(d => d.time === t && d.event === 1);
    const d = events.length;

    S *= (1 - d / n);
    curve.push({ t, S });
  }

  return curve;
}

export function rmstFromKM(curve: KMPoint[], tau: number) {
  if (tau <= 0) return 0;

  let area = 0;
  for (let i = 0; i < curve.length; i++) {
    const t0 = curve[i].t;
    const S0 = curve[i].S;
    const t1 = (i + 1 < curve.length) ? curve[i + 1].t : tau;

    const a = Math.max(t0, 0);
    const b = Math.min(t1, tau);
    if (b > a) area += (b - a) * S0;

    if (t1 >= tau) break;
  }

  if (curve.length === 0) return tau;
  return area;
}

export function rmstKM(data: { time: number; event: 0 | 1 }[], tau: number) {
  const curve = kmCurve(data);
  return rmstFromKM(curve, tau);
}

function normalCdf(x: number) {
  const t = 1 / (1 + 0.2316419 * x);
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x >= 0 ? 1 - p : p;
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function bootstrapRmstDiffCI(
  group0: { time: number; event: 0 | 1 }[],
  group1: { time: number; event: 0 | 1 }[],
  tau: number,
  B = 2000,
  alpha = 0.05,
  rng = mulberry32(54321)
) {
  if (group0.length === 0 || group1.length === 0) return { lo: 0, hi: 0 };

  const stats: number[] = [];
  for (let b = 0; b < B; b++) {
    const s0 = new Array(group0.length);
    const s1 = new Array(group1.length);

    for (let i = 0; i < group0.length; i++) s0[i] = group0[Math.floor(rng() * group0.length)];
    for (let i = 0; i < group1.length; i++) s1[i] = group1[Math.floor(rng() * group1.length)];

    const rm0 = rmstKM(s0, tau);
    const rm1 = rmstKM(s1, tau);
    stats.push(rm1 - rm0);
  }

  stats.sort((a, b) => a - b);
  const lo = stats[Math.floor((alpha / 2) * (B - 1))];
  const hi = stats[Math.floor((1 - alpha / 2) * (B - 1))];
  return { lo, hi };
}