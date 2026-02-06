// src/runner.ts
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { SimulationEngine } from './simulationEngine.ts';
import type { UserConfig, Mode, EngineStepStats } from './types.ts';
import * as StatsNS from './stats.ts';

const StatsAny: any = StatsNS;
const Stats: any = StatsAny.default ?? StatsNS;

const mean = Stats.mean as (xs: number[]) => number;
const sd = Stats.sd as (xs: number[]) => number;
const hedgesG = Stats.hedgesG as (x: number[], y: number[]) => number;
const bootstrapCI = Stats.bootstrapCI as (
  xs: number[],
  fn: (sample: number[]) => number,
  B?: number,
  alpha?: number,
  rng?: () => number
) => { lo: number; hi: number };
const logRankTest = Stats.logRankTest as (data: { time: number; event: 0 | 1; group: 0 | 1 }[]) => any;
const rmstKM = Stats.rmstKM as (data: { time: number; event: 0 | 1 }[], tau: number) => number;
const bootstrapRmstDiffCI = Stats.bootstrapRmstDiffCI as (
  group0: { time: number; event: 0 | 1 }[],
  group1: { time: number; event: 0 | 1 }[],
  tau: number,
  B?: number,
  alpha?: number,
  rng?: () => number
) => { lo: number; hi: number };

function toCSV(headers: string[], rows: (string | number)[][]) {
  const h = headers.join(',');
  const body = rows.map(r => r.join(',')).join('\n');
  return h + '\n' + body + '\n';
}

function assertFiniteStats(s: EngineStepStats, ctx: string) {
  const bad =
    !Number.isFinite(s.energyTotal) ||
    !Number.isFinite(s.energyPrev) ||
    !Number.isFinite(s.deltaU) ||
    !Number.isFinite(s.energyResidual) ||
    !Number.isFinite(s.sigmaTotal) ||
    !Number.isFinite(s.sigmaCumulative) ||
    !Number.isFinite(s.actHeat) ||
    !Number.isFinite(s.outflowPhysical) ||
    !Number.isFinite(s.outflowNumerical) ||
    !Number.isFinite(s.outflowAct) ||
    !Number.isFinite(s.entropyFlow) ||
    !Number.isFinite(s.entropyProd) ||
    !Number.isFinite(s.entropyChange) ||
    !Number.isFinite(s.uptake) ||
    !Number.isFinite(s.infoCost) ||
    !Number.isFinite(s.maintenanceCost);

  if (bad) {
    throw new Error(
      `NaN/Inf detected (${ctx}): ` +
      `Uprev=${s.energyPrev} U=${s.energyTotal} dU=${s.deltaU} res=${s.energyResidual} ` +
      `sigma=${s.sigmaTotal} sigCum=${s.sigmaCumulative} ` +
      `uptake=${s.uptake} info=${s.infoCost} maint=${s.maintenanceCost}`
    );
  }

  const anyS: any = s as any;
  if (
    typeof anyS.births !== 'number' ||
    typeof anyS.deaths !== 'number' ||
    !Number.isFinite(anyS.births) ||
    !Number.isFinite(anyS.deaths)
  ) {
    throw new Error(
      `EngineStepStats.births/deaths missing or non-finite (${ctx}). ` +
      `This runner expects births/deaths per tick in EngineStepStats.`
    );
  }
}

type RunSummary = {
  survivedTicks: number;
  event: 0 | 1;
  maxPop: number;

  sigmaCumEnd: number;
  actHeatCum: number;
  outflowPhysCum: number;
  outflowNumCum: number;

  totalUptakeCum: number;
  infoCostCum: number;
  maintenanceCostCum: number;
  efficiencyEnd: number;

  birthsCum: number;
  deathsCum: number;
  netCum: number;

  meanAbsEnergyResidual: number;

  measuredTicks: number;
  mean_agentCount_window: number;
  mean_sigmaTotal_window: number;

  mean_uptake_window: number;
  mean_infoCost_window: number;
  mean_maintenance_window: number;
  mean_efficiency_window: number;

  mean_births_window: number;
  mean_deaths_window: number;
  mean_net_window: number;

  tailTicksUsed: number;
  mean_uptake_tail: number;
  mean_infoCost_tail: number;
  mean_maintenance_tail: number;
  mean_efficiency_tail: number;

  mean_births_tail: number;
  mean_deaths_tail: number;
  mean_net_tail: number;
};

type RunRecord = {
  runId: number;
  mode: 'random' | 'informed';
  seed: number;
  inflowRate: number;
  intelligenceCost: number;
  sensingNoise: number;

  burnIn: number;
  measureTicks: number;
  maxTicks: number;
  tailTicks: number;

  survivedTicks: number;
  event: 0 | 1;
  max_agentCount: number;

  sigmaCumEnd: number;
  actHeatCum: number;
  outflowPhysCum: number;
  outflowNumCum: number;

  totalUptakeCum: number;
  infoCostCum: number;
  maintenanceCostCum: number;
  efficiencyEnd: number;

  birthsCum: number;
  deathsCum: number;
  netCum: number;

  meanAbsEnergyResidual: number;

  measuredTicks: number;
  mean_agentCount_window: number;
  mean_sigmaTotal_window: number;

  mean_uptake_window: number;
  mean_infoCost_window: number;
  mean_maintenance_window: number;
  mean_efficiency_window: number;

  mean_births_window: number;
  mean_deaths_window: number;
  mean_net_window: number;

  tailTicksUsed: number;
  mean_uptake_tail: number;
  mean_infoCost_tail: number;
  mean_maintenance_tail: number;
  mean_efficiency_tail: number;

  mean_births_tail: number;
  mean_deaths_tail: number;
  mean_net_tail: number;
};

type RunRecordNoId = Omit<RunRecord, 'runId'>;

type Sweep = {
  inflowStart: number; inflowEnd: number; inflowStep: number;

  costScale: number;
  costStart_i: number;
  costEnd_i: number;
  costStep_i: number;

  noiseList: number[];

  seeds: number;
  seedBase: number;

  maxTicks: number;
  burnIn: number;
  measureTicks: number;

  tailTicks: number;
};

const baseConfig: UserConfig = {
  gridSize: 60,

  diffusionKappa: 0.05,
  bathTemp: 1.0,
  boundary: 'isothermal',

  inflowRate: 10,
  consumptionRate: 18.0,
  initialAgents: 10,
  initialSpread: 15,
  seed: 42,

  intelligenceCost: 0.01,
  lookDist: 3,
  sensingNoise: 0.0,

  divisionThreshold: 200,
  divisionCost: 20,
  divisionJitter: 0.8,
  maxAgents: 500,

  friction: 0.6,
  dt: 0.1,
};

const sweep: Sweep = {
  inflowStart: 0.0107, inflowEnd: 0.0109, inflowStep: 0.0001,

  costScale: 1000,
  costStart_i: 200,
  costEnd_i: 201,
  costStep_i: 1,

  noiseList: [0.0],

  seeds: 2000,
  seedBase: 5000,

  maxTicks: 3000,
  burnIn: 100,
  measureTicks: 300,

  tailTicks: 30,
};

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const v = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[i + 1] : 'true';
    out[key] = v;
    if (v !== 'true') i++;
  }
  return out;
}

function parseNumber(s: string | undefined, fallback: number) {
  if (s == null) return fallback;
  const v = Number(s);
  if (!Number.isFinite(v)) return fallback;
  return v;
}

function parseSeedsSpec(spec: string | undefined, seedBase: number, fallbackCount: number) {
  if (!spec) {
    const seeds: number[] = [];
    for (let k = 0; k < fallbackCount; k++) seeds.push(seedBase + k);
    return { seeds, seedBaseUsed: seedBase };
  }
  const trimmed = spec.trim();
  if (trimmed.includes(',')) {
    const parts = trimmed.split(',').map(x => x.trim()).filter(Boolean);
    const seeds = parts.map(p => Number(p)).filter(v => Number.isFinite(v)).map(v => Math.floor(v));
    return { seeds, seedBaseUsed: seedBase };
  }
  const n = Number(trimmed);
  if (Number.isFinite(n) && Math.floor(n) === n && n > 0) {
    const seeds: number[] = [];
    for (let k = 0; k < n; k++) seeds.push(seedBase + k);
    return { seeds, seedBaseUsed: seedBase };
  }
  const v = Number(trimmed);
  if (Number.isFinite(v)) return { seeds: [Math.floor(v)], seedBaseUsed: seedBase };
  const seeds: number[] = [];
  for (let k = 0; k < fallbackCount; k++) seeds.push(seedBase + k);
  return { seeds, seedBaseUsed: seedBase };
}

// ------------------------------
// NEW: snapshot utilities
// ------------------------------

function writeMatrixCSV(path: string, mat: Float32Array, N: number) {
  const lines: string[] = [];
  for (let y = 0; y < N; y++) {
    const row: string[] = [];
    for (let x = 0; x < N; x++) {
      row.push(String(mat[x + y * N]));
    }
    lines.push(row.join(','));
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
}

function writeAgentsCSV(path: string, cells: { x: number; y: number; energy: number; vx: number; vy: number }[]) {
  const headers = ['id','x','y','energy','vx','vy'];
  const rows = cells.map((c, i) => [i, c.x, c.y, c.energy, c.vx, c.vy]);
  writeFileSync(path, toCSV(headers, rows), 'utf-8');
}

type SnapshotSpec = {
  enabled: boolean;
  outDir: string;
  // only snapshot when these match (to avoid exploding output)
  targetInflows: number[];
  targetCost: number;     // exact match within tol
  targetNoise: number;    // exact match within tol
  targetSeed: number;     // one seed
  // ticks to dump (relative to sim ticks)
  snapshotTicks: number[]; // e.g. [burnIn, burnIn+50, burnIn+measureTicks-1]
};

function approxEq(a: number, b: number, tol: number) {
  return Math.abs(a - b) <= tol;
}

function shouldSnapshotJob(spec: SnapshotSpec, inflow: number, cost: number, noise: number, seed: number) {
  if (!spec.enabled) return false;
  if (seed !== spec.targetSeed) return false;
  if (!approxEq(cost, spec.targetCost, 1e-12)) return false;
  if (!approxEq(noise, spec.targetNoise, 1e-12)) return false;

  // inflow match against provided list with tolerance
  for (const t of spec.targetInflows) {
    if (approxEq(inflow, t, 5e-7)) return true;
  }
  return false;
}

function dumpSnapshot(
  spec: SnapshotSpec,
  tag: {
    inflow: number; cost: number; noise: number; seed: number;
    mode: 'random' | 'informed';
    tick: number;
  },
  snap: { N: number; grid: Float32Array; cells: any[]; sigmaDiffMap: Float32Array; sigmaActMap: Float32Array; sigmaTotalMap: Float32Array }
) {
  mkdirSync(spec.outDir, { recursive: true });

  const key =
    `inflow=${tag.inflow.toFixed(6)}` +
    `_cost=${tag.cost.toFixed(6)}` +
    `_noise=${tag.noise.toFixed(6)}` +
    `_seed=${tag.seed}` +
    `_mode=${tag.mode}` +
    `_t=${tag.tick}`;

  const dir = `${spec.outDir}/${key}`;
  mkdirSync(dir, { recursive: true });

  writeFileSync(`${dir}/meta.json`, JSON.stringify({ ...tag, N: snap.N }, null, 2), 'utf-8');

  writeMatrixCSV(`${dir}/grid.csv`, snap.grid, snap.N);
  writeMatrixCSV(`${dir}/sigmaDiffMap.csv`, snap.sigmaDiffMap, snap.N);
  writeMatrixCSV(`${dir}/sigmaActMap.csv`, snap.sigmaActMap, snap.N);
  writeMatrixCSV(`${dir}/sigmaTotalMap.csv`, snap.sigmaTotalMap, snap.N);

  writeAgentsCSV(`${dir}/agents.csv`, snap.cells);
}

function runOne(
  conf: UserConfig,
  mode: Mode,
  master: { grid: Float32Array; cells: any[] },
  maxTicks: number,
  burnIn: number,
  measureTicks: number,
  tailTicks: number,
  snapshot?: {
    spec: SnapshotSpec;
    inflow: number;
    cost: number;
    noise: number;
    seed: number;
  }
): RunSummary {
  const engine = new SimulationEngine(conf);
  engine.importState(master as any);

  let t = 0;
  let maxPop = 0;

  let measuredTicksDone = 0;
  let sumAgents = 0;
  let sumSigmaTotal = 0;

  let sumUptake = 0;
  let sumInfo = 0;
  let sumMaint = 0;
  let sumEff = 0;

  let sumBirthsW = 0;
  let sumDeathsW = 0;
  let sumNetW = 0;

  let actHeatCum = 0;
  let outflowPhysCum = 0;
  let outflowNumCum = 0;
  let lastSigmaCum = 0;

  let totalUptakeCum = 0;
  let infoCostCum = 0;
  let maintenanceCostCum = 0;

  let birthsCum = 0;
  let deathsCum = 0;

  let sumAbsRes = 0;
  let resCount = 0;

  const tailCap = Math.max(1, Math.floor(tailTicks));
  const tailUptake: number[] = [];
  const tailInfo: number[] = [];
  const tailMaint: number[] = [];
  const tailEff: number[] = [];

  const tailBirths: number[] = [];
  const tailDeaths: number[] = [];
  const tailNet: number[] = [];

  function pushTail(uptakeTick: number, infoTick: number, maintTick: number, birthsTick: number, deathsTick: number) {
    const eff = uptakeTick / (infoTick + maintTick + 1e-9);
    const net = birthsTick - deathsTick;

    tailUptake.push(uptakeTick);
    tailInfo.push(infoTick);
    tailMaint.push(maintTick);
    tailEff.push(eff);

    tailBirths.push(birthsTick);
    tailDeaths.push(deathsTick);
    tailNet.push(net);

    if (tailUptake.length > tailCap) tailUptake.shift();
    if (tailInfo.length > tailCap) tailInfo.shift();
    if (tailMaint.length > tailCap) tailMaint.shift();
    if (tailEff.length > tailCap) tailEff.shift();

    if (tailBirths.length > tailCap) tailBirths.shift();
    if (tailDeaths.length > tailCap) tailDeaths.shift();
    if (tailNet.length > tailCap) tailNet.shift();
  }

  const snapshotTicksSet = new Set<number>(snapshot?.spec?.snapshotTicks ?? []);

  while (t < maxTicks) {
    const s = engine.update({ ...conf, mode });
    assertFiniteStats(s, `mode=${mode} t=${t}`);

    // NEW: dump snapshots at selected ticks
    if (snapshot && snapshot.spec.enabled && snapshotTicksSet.has(t)) {
      const snap = engine.getSnapshot();
      dumpSnapshot(snapshot.spec, {
        inflow: snapshot.inflow,
        cost: snapshot.cost,
        noise: snapshot.noise,
        seed: snapshot.seed,
        mode: mode === 'random' ? 'random' : 'informed',
        tick: t,
      }, snap);
    }

    const anyS: any = s as any;
    const birthsTick = anyS.births as number;
    const deathsTick = anyS.deaths as number;

    if (s.agentCount > maxPop) maxPop = s.agentCount;

    actHeatCum += s.outflowAct;
    outflowPhysCum += s.outflowPhysical;
    outflowNumCum += s.outflowNumerical;
    lastSigmaCum = s.sigmaCumulative;

    totalUptakeCum += s.uptake;
    infoCostCum += s.infoCost;
    maintenanceCostCum += s.maintenanceCost;

    birthsCum += birthsTick;
    deathsCum += deathsTick;

    sumAbsRes += Math.abs(s.energyResidual);
    resCount++;

    pushTail(s.uptake, s.infoCost, s.maintenanceCost, birthsTick, deathsTick);

    if (t >= burnIn && t < burnIn + measureTicks) {
      sumAgents += s.agentCount;
      sumSigmaTotal += s.sigmaTotal;

      sumUptake += s.uptake;
      sumInfo += s.infoCost;
      sumMaint += s.maintenanceCost;

      const denom = (s.infoCost + s.maintenanceCost + 1e-9);
      sumEff += s.uptake / denom;

      sumBirthsW += birthsTick;
      sumDeathsW += deathsTick;
      sumNetW += (birthsTick - deathsTick);

      measuredTicksDone++;
    }

    if (s.agentCount === 0) {
      // dump final snapshot at extinction if requested (tick=t)
      if (snapshot && snapshot.spec.enabled) {
        const snap = engine.getSnapshot();
        dumpSnapshot(snapshot.spec, {
          inflow: snapshot.inflow,
          cost: snapshot.cost,
          noise: snapshot.noise,
          seed: snapshot.seed,
          mode: mode === 'random' ? 'random' : 'informed',
          tick: t,
        }, snap);
      }

      const efficiencyEnd = totalUptakeCum / (infoCostCum + maintenanceCostCum + 1e-9);
      const netCum = birthsCum - deathsCum;

      const tailTicksUsed = tailUptake.length;
      return {
        survivedTicks: t,
        event: 1,
        maxPop,

        sigmaCumEnd: lastSigmaCum,
        actHeatCum,
        outflowPhysCum,
        outflowNumCum,

        totalUptakeCum,
        infoCostCum,
        maintenanceCostCum,
        efficiencyEnd,

        birthsCum,
        deathsCum,
        netCum,

        meanAbsEnergyResidual: resCount ? (sumAbsRes / resCount) : 0,

        measuredTicks: measuredTicksDone,
        mean_agentCount_window: measuredTicksDone ? (sumAgents / measuredTicksDone) : 0,
        mean_sigmaTotal_window: measuredTicksDone ? (sumSigmaTotal / measuredTicksDone) : 0,

        mean_uptake_window: measuredTicksDone ? (sumUptake / measuredTicksDone) : 0,
        mean_infoCost_window: measuredTicksDone ? (sumInfo / measuredTicksDone) : 0,
        mean_maintenance_window: measuredTicksDone ? (sumMaint / measuredTicksDone) : 0,
        mean_efficiency_window: measuredTicksDone ? (sumEff / measuredTicksDone) : 0,

        mean_births_window: measuredTicksDone ? (sumBirthsW / measuredTicksDone) : 0,
        mean_deaths_window: measuredTicksDone ? (sumDeathsW / measuredTicksDone) : 0,
        mean_net_window: measuredTicksDone ? (sumNetW / measuredTicksDone) : 0,

        tailTicksUsed,
        mean_uptake_tail: tailTicksUsed ? mean(tailUptake) : 0,
        mean_infoCost_tail: tailTicksUsed ? mean(tailInfo) : 0,
        mean_maintenance_tail: tailTicksUsed ? mean(tailMaint) : 0,
        mean_efficiency_tail: tailTicksUsed ? mean(tailEff) : 0,

        mean_births_tail: tailTicksUsed ? mean(tailBirths) : 0,
        mean_deaths_tail: tailTicksUsed ? mean(tailDeaths) : 0,
        mean_net_tail: tailTicksUsed ? mean(tailNet) : 0,
      };
    }

    t++;
  }

  // dump final snapshot at maxTicks if requested
  if (snapshot && snapshot.spec.enabled) {
    const snap = engine.getSnapshot();
    dumpSnapshot(snapshot.spec, {
      inflow: snapshot.inflow,
      cost: snapshot.cost,
      noise: snapshot.noise,
      seed: snapshot.seed,
      mode: mode === 'random' ? 'random' : 'informed',
      tick: maxTicks,
    }, snap);
  }

  const efficiencyEnd = totalUptakeCum / (infoCostCum + maintenanceCostCum + 1e-9);
  const netCum = birthsCum - deathsCum;
  const tailTicksUsed = tailUptake.length;

  return {
    survivedTicks: maxTicks,
    event: 0,
    maxPop,

    sigmaCumEnd: lastSigmaCum,
    actHeatCum,
    outflowPhysCum,
    outflowNumCum,

    totalUptakeCum,
    infoCostCum,
    maintenanceCostCum,
    efficiencyEnd,

    birthsCum,
    deathsCum,
    netCum,

    meanAbsEnergyResidual: resCount ? (sumAbsRes / resCount) : 0,

    measuredTicks: measuredTicksDone,
    mean_agentCount_window: measuredTicksDone ? (sumAgents / measuredTicksDone) : 0,
    mean_sigmaTotal_window: measuredTicksDone ? (sumSigmaTotal / measuredTicksDone) : 0,

    mean_uptake_window: measuredTicksDone ? (sumUptake / measuredTicksDone) : 0,
    mean_infoCost_window: measuredTicksDone ? (sumInfo / measuredTicksDone) : 0,
    mean_maintenance_window: measuredTicksDone ? (sumMaint / measuredTicksDone) : 0,
    mean_efficiency_window: measuredTicksDone ? (sumEff / measuredTicksDone) : 0,

    mean_births_window: measuredTicksDone ? (sumBirthsW / measuredTicksDone) : 0,
    mean_deaths_window: measuredTicksDone ? (sumDeathsW / measuredTicksDone) : 0,
    mean_net_window: measuredTicksDone ? (sumNetW / measuredTicksDone) : 0,

    tailTicksUsed,
    mean_uptake_tail: tailTicksUsed ? mean(tailUptake) : 0,
    mean_infoCost_tail: tailTicksUsed ? mean(tailInfo) : 0,
    mean_maintenance_tail: tailTicksUsed ? mean(tailMaint) : 0,
    mean_efficiency_tail: tailTicksUsed ? mean(tailEff) : 0,

    mean_births_tail: tailTicksUsed ? mean(tailBirths) : 0,
    mean_deaths_tail: tailTicksUsed ? mean(tailDeaths) : 0,
    mean_net_tail: tailTicksUsed ? mean(tailNet) : 0,
  };
}

type Job = {
  jobId: number;
  inflow: number;
  cost: number;
  noise: number;
  seed: number;
  conf: UserConfig;
  maxTicks: number;
  burnIn: number;
  measureTicks: number;
  tailTicks: number;

  // NEW: snapshot spec (optional)
  snapshot?: SnapshotSpec;
};

type JobResult = {
  jobId: number;
  rand: RunRecordNoId;
  inf: RunRecordNoId;
  survRand: { time: number; event: 0 | 1; group: 0 | 1; inflow: number; cost: number; noise: number; seed: number };
  survInf: { time: number; event: 0 | 1; group: 0 | 1; inflow: number; cost: number; noise: number; seed: number };
};

function makeRunRecordNoId(
  mode: 'random' | 'informed',
  seed: number,
  inflowRate: number,
  intelligenceCost: number,
  sensingNoise: number,
  burnIn: number,
  measureTicks: number,
  maxTicks: number,
  tailTicks: number,
  sum: RunSummary
): RunRecordNoId {
  return {
    mode,
    seed,
    inflowRate,
    intelligenceCost,
    sensingNoise,

    burnIn,
    measureTicks,
    maxTicks,
    tailTicks,

    survivedTicks: sum.survivedTicks,
    event: sum.event,
    max_agentCount: sum.maxPop,

    sigmaCumEnd: sum.sigmaCumEnd,
    actHeatCum: sum.actHeatCum,
    outflowPhysCum: sum.outflowPhysCum,
    outflowNumCum: sum.outflowNumCum,

    totalUptakeCum: sum.totalUptakeCum,
    infoCostCum: sum.infoCostCum,
    maintenanceCostCum: sum.maintenanceCostCum,
    efficiencyEnd: sum.efficiencyEnd,

    birthsCum: sum.birthsCum,
    deathsCum: sum.deathsCum,
    netCum: sum.netCum,

    meanAbsEnergyResidual: sum.meanAbsEnergyResidual,

    measuredTicks: sum.measuredTicks,
    mean_agentCount_window: sum.mean_agentCount_window,
    mean_sigmaTotal_window: sum.mean_sigmaTotal_window,

    mean_uptake_window: sum.mean_uptake_window,
    mean_infoCost_window: sum.mean_infoCost_window,
    mean_maintenance_window: sum.mean_maintenance_window,
    mean_efficiency_window: sum.mean_efficiency_window,

    mean_births_window: sum.mean_births_window,
    mean_deaths_window: sum.mean_deaths_window,
    mean_net_window: sum.mean_net_window,

    tailTicksUsed: sum.tailTicksUsed,
    mean_uptake_tail: sum.mean_uptake_tail,
    mean_infoCost_tail: sum.mean_infoCost_tail,
    mean_maintenance_tail: sum.mean_maintenance_tail,
    mean_efficiency_tail: sum.mean_efficiency_tail,

    mean_births_tail: sum.mean_births_tail,
    mean_deaths_tail: sum.mean_deaths_tail,
    mean_net_tail: sum.mean_net_tail,
  };
}

function doJob(job: Job): JobResult {
  const { inflow, cost, noise, seed, conf, maxTicks, burnIn, measureTicks, tailTicks, snapshot } = job;

  const masterEngine = new SimulationEngine(conf);
  const master = masterEngine.generateMasterState(conf);

  // snapshot only on selected jobs to avoid explosion
  const snapEnabled = snapshot && shouldSnapshotJob(snapshot, inflow, cost, noise, seed);

  const randSum = runOne(conf, 'random', master, maxTicks, burnIn, measureTicks, tailTicks, snapEnabled ? {
    spec: snapshot!,
    inflow, cost, noise, seed,
  } : undefined);

  const infSum = runOne(conf, 'informed', master, maxTicks, burnIn, measureTicks, tailTicks, snapEnabled ? {
    spec: snapshot!,
    inflow, cost, noise, seed,
  } : undefined);

  const rand = makeRunRecordNoId('random', seed, inflow, cost, noise, burnIn, measureTicks, maxTicks, tailTicks, randSum);
  const inf = makeRunRecordNoId('informed', seed, inflow, cost, noise, burnIn, measureTicks, maxTicks, tailTicks, infSum);

  const survRand = { time: randSum.survivedTicks, event: randSum.event, group: 0 as 0, inflow, cost, noise, seed };
  const survInf = { time: infSum.survivedTicks, event: infSum.event, group: 1 as 1, inflow, cost, noise, seed };

  return { jobId: job.jobId, rand, inf, survRand, survInf };
}

/** progress helper (stderr one-line) */
function makeProgressReporter(total: number, intervalMs: number = 200) {
  const t0 = Date.now();
  let last = 0;

  function fmtTime(sec: number) {
    if (!Number.isFinite(sec) || sec < 0) return 'n/a';
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h}h${String(m).padStart(2, '0')}m${String(r).padStart(2, '0')}s`;
    return `${m}m${String(r).padStart(2, '0')}s`;
  }

  return (done: number, force: boolean = false) => {
    const now = Date.now();
    if (!force && now - last < intervalMs && done < total) return;
    last = now;

    const pct = total > 0 ? (done / total) * 100 : 100;
    const elapsedSec = (now - t0) / 1000;
    const rate = done / Math.max(elapsedSec, 1e-9);
    const etaSec = (total - done) / Math.max(rate, 1e-9);

    process.stderr.write(
      `\rProgress: ${pct.toFixed(1)}% (${done}/${total}) ` +
      `elapsed ${fmtTime(elapsedSec)} ETA ${fmtTime(etaSec)}`
    );

    if (done >= total) process.stderr.write('\n');
  };
}

async function runParallel(jobs: Job[], workers: number): Promise<JobResult[]> {
  if (jobs.length === 0) return [];
  const n = Math.max(1, Math.floor(workers));

  const total = jobs.length;
  const report = makeProgressReporter(total, 200);

  const results = new Map<number, JobResult>();
  let nextIdx = 0;
  let done = 0;

  await new Promise<void>((resolve, reject) => {
    const pool: Worker[] = [];
    let finished = false;

    const shutdownAll = () => {
      for (const w of pool) {
        try { w.postMessage({ type: 'shutdown' }); } catch {}
        try { w.terminate(); } catch {}
      }
    };

    const fail = (err: any) => {
      if (finished) return;
      finished = true;
      report(done, true);
      process.stderr.write('\n');
      shutdownAll();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const succeed = () => {
      if (finished) return;
      finished = true;
      report(done, true);
      resolve();
    };

    const spawn = () => {
      const w = new Worker(new URL(import.meta.url), {
        argv: ['--worker'],
        execArgv: ['--import', 'tsx'],
      });

      const onMessage = (msg: any) => {
        if (!msg) return;

        if (msg.type === 'result') {
          const r: JobResult = msg.payload;
          results.set(r.jobId, r);
          done++;
          report(done);

          if (nextIdx < jobs.length) {
            const j = jobs[nextIdx++];
            w.postMessage({ type: 'job', payload: j });
          } else {
            w.postMessage({ type: 'shutdown' });
          }

          if (done === jobs.length) succeed();
          return;
        }

        if (msg.type === 'error') {
          const p = msg.payload ?? {};
          const jobId = p.jobId ?? 'n/a';
          const message = p.message ?? 'unknown error';
          const stack = p.stack ?? '';
          fail(new Error(`Worker job failed jobId=${jobId}: ${message}\n${stack}`));
          return;
        }
      };

      const onError = (err: any) => fail(err);
      const onExit = (code: number) => {
        if (code !== 0 && done < jobs.length) {
          fail(new Error(`Worker exited with code ${code}`));
        }
      };

      w.on('message', onMessage);
      w.on('error', onError);
      w.on('exit', onExit);

      pool.push(w);
    };

    for (let i = 0; i < n; i++) spawn();

    for (const w of pool) {
      if (nextIdx < jobs.length) {
        const j = jobs[nextIdx++];
        w.postMessage({ type: 'job', payload: j });
      } else {
        w.postMessage({ type: 'shutdown' });
      }
    }
  });

  report(done, true);

  const out: JobResult[] = [];
  for (let i = 0; i < jobs.length; i++) {
    const id = jobs[i].jobId;
    const r = results.get(id);
    if (!r) throw new Error(`Missing job result jobId=${id}`);
    out.push(r);
  }
  return out;
}

function workerLoop() {
  if (!parentPort) throw new Error('worker has no parentPort');

  parentPort.on('message', (msg: any) => {
    if (!msg) return;

    if (msg.type === 'shutdown') {
      process.exit(0);
      return;
    }

    if (msg.type === 'job') {
      const job: Job = msg.payload;
      try {
        const r = doJob(job);
        parentPort!.postMessage({ type: 'result', payload: r });
      } catch (e: any) {
        parentPort!.postMessage({
          type: 'error',
          payload: {
            jobId: job.jobId,
            message: String(e?.message ?? e),
            stack: String(e?.stack ?? ''),
          },
        });
        throw e;
      }
    }
  });
}

async function main() {
  console.log("availableParallelism=", (os as any).availableParallelism?.() ?? "n/a");
  console.log("cpus.length=", os.cpus().length);
  const args = parseArgs(process.argv.slice(2).filter(a => a !== '--worker'));
// NEW: output directory
// --outDir out_discovery
// default: "out"
const outDirRaw = (args.outDir ?? 'out').trim();
const outDir = outDirRaw.length ? outDirRaw : 'out';

  const inflowStart = parseNumber(args.inflowStart, sweep.inflowStart);
  const inflowEnd = parseNumber(args.inflowEnd, sweep.inflowEnd);
  const inflowStep = parseNumber(args.inflowStep, sweep.inflowStep);

  const seedBase = Math.floor(parseNumber(args.seedBase, sweep.seedBase));
  const seedsSpec = args.seeds;
  const seedsParsed = parseSeedsSpec(seedsSpec, seedBase, sweep.seeds);
  const seedsList = seedsParsed.seeds;

  const workers = Math.max(1, Math.floor(parseNumber(args.workers, Math.max(1, (os.cpus()?.length ?? 2) - 1))));
  console.log("workers=", workers);

  // NEW: snapshot flags
  // --snapshot true
  // --snapshotInflows 0.0108,0.01094,0.0111   (comma-separated)
  // --snapshotSeed 5000
  // --snapshotCost 0.200
  // --snapshotNoise 0
  // --snapshotTicks 100,150,399  (sim ticks)
  const snapshotEnabled = (args.snapshot ?? 'false') === 'true';
  const snapshotInflows = (args.snapshotInflows ?? '').trim()
    ? (args.snapshotInflows!.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n)))
    : [0.0108, 0.01094, 0.0111];

  const snapshotSeed = Math.floor(parseNumber(args.snapshotSeed, seedsList[0] ?? sweep.seedBase));
  const snapshotCost = parseNumber(args.snapshotCost, (sweep.costStart_i / sweep.costScale));
  const snapshotNoise = parseNumber(args.snapshotNoise, (sweep.noiseList[0] ?? 0));

  const snapshotTicks = (args.snapshotTicks ?? '').trim()
    ? (args.snapshotTicks!.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n)).map(n => Math.floor(n)))
    : [sweep.burnIn, sweep.burnIn + 50, sweep.burnIn + sweep.measureTicks - 1];

  const snapshotSpec: SnapshotSpec = {
    enabled: snapshotEnabled,
    outDir: `${outDir}/snapshots`,
    targetInflows: snapshotInflows,
    targetCost: snapshotCost,
    targetNoise: snapshotNoise,
    targetSeed: snapshotSeed,
    snapshotTicks,
  };

  const effSweep: Sweep = {
    ...sweep,
    inflowStart,
    inflowEnd,
    inflowStep,
    seeds: seedsList.length,
    seedBase: seedsParsed.seedBaseUsed,
  };

  mkdirSync(outDir, { recursive: true });
  if (snapshotSpec.enabled) mkdirSync(snapshotSpec.outDir, { recursive: true });

  writeFileSync(
    `${outDir}/meta.json`,
    JSON.stringify(
      {
        baseConfig,
        sweep: effSweep,
        seedsList,
        cli: {
          inflowStart, inflowEnd, inflowStep,
          seeds: seedsSpec ?? '(default)',
          seedBase: seedsParsed.seedBaseUsed,
          workers,
          snapshot: snapshotSpec,
        },
        createdAt: new Date().toISOString(),
      },
      null,
      2
    ),
    'utf-8'
  );

  const raw: RunRecord[] = [];
  const survivalRows: {
    time: number;
    event: 0 | 1;
    group: 0 | 1;
    inflow: number;
    cost: number;
    noise: number;
    seed: number;
  }[] = [];

  const inflowSteps = Math.floor((effSweep.inflowEnd - effSweep.inflowStart) / effSweep.inflowStep + 1e-12) + 1;
  const costSteps = Math.floor((effSweep.costEnd_i - effSweep.costStart_i) / effSweep.costStep_i + 1e-12) + 1;

  const jobs: Job[] = [];
  let jobId = 1;

  for (const noise of effSweep.noiseList) {
    for (let ii = 0; ii < inflowSteps; ii++) {
      const inflow = effSweep.inflowStart + ii * effSweep.inflowStep;

      for (let jj = 0; jj < costSteps; jj++) {
        const cost_i = effSweep.costStart_i + jj * effSweep.costStep_i;
        const cost = cost_i / effSweep.costScale;

        for (let k = 0; k < seedsList.length; k++) {
          const seed = seedsList[k];

          const conf: UserConfig = {
            ...baseConfig,
            inflowRate: inflow,
            intelligenceCost: cost,
            sensingNoise: noise,
            seed,
          };

          jobs.push({
            jobId: jobId++,
            inflow,
            cost,
            noise,
            seed,
            conf,
            maxTicks: effSweep.maxTicks,
            burnIn: effSweep.burnIn,
            measureTicks: effSweep.measureTicks,
            tailTicks: effSweep.tailTicks,
            snapshot: snapshotSpec,
          });
        }
      }
    }
  }

  console.log(`jobs=${jobs.length} (inflowSteps=${inflowSteps}, costSteps=${costSteps}, seeds=${seedsList.length}, noises=${effSweep.noiseList.length})`);
  if (snapshotSpec.enabled) {
    console.log('snapshotSpec=', snapshotSpec);
    console.log('Snapshots will be written to out/snapshots/ ONLY for (seed,cost,noise,inflow list) matches.');
  }

  const results = await runParallel(jobs, workers);

  let runId = 1;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];

    raw.push({ runId: runId++, ...r.rand });
    raw.push({ runId: runId++, ...r.inf });

    survivalRows.push({ time: r.survRand.time, event: r.survRand.event, group: 0, inflow: r.survRand.inflow, cost: r.survRand.cost, noise: r.survRand.noise, seed: r.survRand.seed });
    survivalRows.push({ time: r.survInf.time, event: r.survInf.event, group: 1, inflow: r.survInf.inflow, cost: r.survInf.cost, noise: r.survInf.noise, seed: r.survInf.seed });
  }

  writeFileSync(
    `${outDir}/raw.csv`,
    toCSV(
      [
        'runId','mode','seed','inflowRate','intelligenceCost','sensingNoise',
        'burnIn','measureTicks','maxTicks','tailTicks',
        'survivedTicks','event','max_agentCount',
        'sigmaCumEnd','actHeatCum','outflowPhysCum','outflowNumCum',
        'totalUptakeCum','infoCostCum','maintenanceCostCum','efficiencyEnd',
        'birthsCum','deathsCum','netCum',
        'meanAbsEnergyResidual',
        'measuredTicks','mean_agentCount_window','mean_sigmaTotal_window',
        'mean_uptake_window','mean_infoCost_window','mean_maintenance_window','mean_efficiency_window',
        'mean_births_window','mean_deaths_window','mean_net_window',
        'tailTicksUsed','mean_uptake_tail','mean_infoCost_tail','mean_maintenance_tail','mean_efficiency_tail',
        'mean_births_tail','mean_deaths_tail','mean_net_tail',
      ],
      raw.map(r => [
        r.runId, r.mode, r.seed, r.inflowRate, r.intelligenceCost.toFixed(6), r.sensingNoise,
        r.burnIn, r.measureTicks, r.maxTicks, r.tailTicks,
        r.survivedTicks, r.event, r.max_agentCount,
        r.sigmaCumEnd.toFixed(6),
        r.actHeatCum.toFixed(6),
        r.outflowPhysCum.toFixed(6),
        r.outflowNumCum.toFixed(6),
        r.totalUptakeCum.toFixed(6),
        r.infoCostCum.toFixed(6),
        r.maintenanceCostCum.toFixed(6),
        r.efficiencyEnd.toFixed(6),
        r.birthsCum.toFixed(6),
        r.deathsCum.toFixed(6),
        r.netCum.toFixed(6),
        r.meanAbsEnergyResidual.toFixed(12),
        r.measuredTicks,
        r.mean_agentCount_window.toFixed(6),
        r.mean_sigmaTotal_window.toFixed(6),
        r.mean_uptake_window.toFixed(6),
        r.mean_infoCost_window.toFixed(6),
        r.mean_maintenance_window.toFixed(6),
        r.mean_efficiency_window.toFixed(6),
        r.mean_births_window.toFixed(6),
        r.mean_deaths_window.toFixed(6),
        r.mean_net_window.toFixed(6),
        r.tailTicksUsed,
        r.mean_uptake_tail.toFixed(6),
        r.mean_infoCost_tail.toFixed(6),
        r.mean_maintenance_tail.toFixed(6),
        r.mean_efficiency_tail.toFixed(6),
        r.mean_births_tail.toFixed(6),
        r.mean_deaths_tail.toFixed(6),
        r.mean_net_tail.toFixed(6),
      ])
    ),
    'utf-8'
  );

  writeFileSync(
    `${outDir}/survival.csv`,
    toCSV(
      ['time','event','group','inflowRate','intelligenceCost','sensingNoise','seed'],
      survivalRows.map(s => [s.time, s.event, s.group, s.inflow, s.cost.toFixed(6), s.noise, s.seed])
    ),
    'utf-8'
  );

  type Key = string;
  const groups = new Map<Key, {
    inflow: number;
    cost: number;
    noise: number;
    rand: RunRecord[];
    inf: RunRecord[];
    surv: typeof survivalRows;
  }>();

  for (const r of raw) {
    const key = `${r.sensingNoise}|${r.inflowRate}|${r.intelligenceCost.toFixed(6)}`;
    if (!groups.has(key)) {
      groups.set(key, { inflow: r.inflowRate, cost: r.intelligenceCost, noise: r.sensingNoise, rand: [], inf: [], surv: [] as any });
    }
    const g = groups.get(key)!;
    if (r.mode === 'random') g.rand.push(r);
    else g.inf.push(r);
  }
  for (const s of survivalRows) {
    const key = `${s.noise}|${s.inflow}|${s.cost.toFixed(6)}`;
    const g = groups.get(key);
    if (g) (g.surv as any).push(s);
  }

  const aggRows: (string | number)[][] = [];
  const logrankOut: any[] = [];

  for (const g of groups.values()) {
    const bySeed = new Map<number, { rand?: RunRecord; inf?: RunRecord }>();
    for (const r of g.rand) {
      if (!bySeed.has(r.seed)) bySeed.set(r.seed, {});
      bySeed.get(r.seed)!.rand = r;
    }
    for (const r of g.inf) {
      if (!bySeed.has(r.seed)) bySeed.set(r.seed, {});
      bySeed.get(r.seed)!.inf = r;
    }

    const dSurv: number[] = [];
    const dSigmaCum: number[] = [];
    const dUptakeCum: number[] = [];
    const dEffEnd: number[] = [];

    const dBirthsCum: number[] = [];
    const dDeathsCum: number[] = [];
    const dNetCum: number[] = [];

    const dTailUptake: number[] = [];
    const dTailInfo: number[] = [];
    const dTailMaint: number[] = [];
    const dTailEff: number[] = [];

    const dTailBirths: number[] = [];
    const dTailDeaths: number[] = [];
    const dTailNet: number[] = [];

    const randSurv: number[] = [];
    const infSurv: number[] = [];

    const dBirthsW: number[] = [];
    const dDeathsW: number[] = [];
    const dNetW: number[] = [];

    for (const pair of bySeed.values()) {
      if (!pair.rand || !pair.inf) continue;

      dSurv.push(pair.inf.survivedTicks - pair.rand.survivedTicks);
      dSigmaCum.push(pair.inf.sigmaCumEnd - pair.rand.sigmaCumEnd);
      dUptakeCum.push(pair.inf.totalUptakeCum - pair.rand.totalUptakeCum);
      dEffEnd.push(pair.inf.efficiencyEnd - pair.rand.efficiencyEnd);

      dBirthsCum.push(pair.inf.birthsCum - pair.rand.birthsCum);
      dDeathsCum.push(pair.inf.deathsCum - pair.rand.deathsCum);
      dNetCum.push(pair.inf.netCum - pair.rand.netCum);

      dTailUptake.push(pair.inf.mean_uptake_tail - pair.rand.mean_uptake_tail);
      dTailInfo.push(pair.inf.mean_infoCost_tail - pair.rand.mean_infoCost_tail);
      dTailMaint.push(pair.inf.mean_maintenance_tail - pair.rand.mean_maintenance_tail);
      dTailEff.push(pair.inf.mean_efficiency_tail - pair.rand.mean_efficiency_tail);

      dTailBirths.push(pair.inf.mean_births_tail - pair.rand.mean_births_tail);
      dTailDeaths.push(pair.inf.mean_deaths_tail - pair.rand.mean_deaths_tail);
      dTailNet.push(pair.inf.mean_net_tail - pair.rand.mean_net_tail);

      dBirthsW.push(pair.inf.mean_births_window - pair.rand.mean_births_window);
      dDeathsW.push(pair.inf.mean_deaths_window - pair.rand.mean_deaths_window);
      dNetW.push(pair.inf.mean_net_window - pair.rand.mean_net_window);

      randSurv.push(pair.rand.survivedTicks);
      infSurv.push(pair.inf.survivedTicks);
    }

    const nPairs = dSurv.length;

    const ciSurv = bootstrapCI(dSurv, mean, 2000);
    const ciSigmaCum = bootstrapCI(dSigmaCum, mean, 2000);
    const ciUptakeCum = bootstrapCI(dUptakeCum, mean, 2000);
    const ciEffEnd = bootstrapCI(dEffEnd, mean, 2000);

    const ciBirthsCum = bootstrapCI(dBirthsCum, mean, 2000);
    const ciDeathsCum = bootstrapCI(dDeathsCum, mean, 2000);
    const ciNetCum = bootstrapCI(dNetCum, mean, 2000);

    const ciTailUptake = bootstrapCI(dTailUptake, mean, 2000);
    const ciTailInfo = bootstrapCI(dTailInfo, mean, 2000);
    const ciTailMaint = bootstrapCI(dTailMaint, mean, 2000);
    const ciTailEff = bootstrapCI(dTailEff, mean, 2000);

    const ciTailBirths = bootstrapCI(dTailBirths, mean, 2000);
    const ciTailDeaths = bootstrapCI(dTailDeaths, mean, 2000);
    const ciTailNet = bootstrapCI(dTailNet, mean, 2000);

    const ciBirthsW = bootstrapCI(dBirthsW, mean, 2000);
    const ciDeathsW = bootstrapCI(dDeathsW, mean, 2000);
    const ciNetW = bootstrapCI(dNetW, mean, 2000);

    const gSurv = hedgesG(infSurv, randSurv);

    const lr = logRankTest((g.surv as any).map((s: any) => ({ time: s.time, event: s.event, group: s.group })));

    const tau = effSweep.maxTicks;
    const surv0 = (g.surv as any).filter((s: any) => s.group === 0).map((s: any) => ({ time: s.time, event: s.event as (0|1) }));
    const surv1 = (g.surv as any).filter((s: any) => s.group === 1).map((s: any) => ({ time: s.time, event: s.event as (0|1) }));

    if (surv0.length === 0 || surv1.length === 0) {
      throw new Error(`EMPTY SURV GROUP noise=${g.noise} inflow=${g.inflow} cost=${g.cost} surv0=${surv0.length} surv1=${surv1.length}`);
    }

    const rmst0 = rmstKM(surv0, tau);
    const rmst1 = rmstKM(surv1, tau);
    const dRmst = rmst1 - rmst0;
    const ciRmst = bootstrapRmstDiffCI(surv0, surv1, tau, 2000);

    logrankOut.push({
      sensingNoise: g.noise,
      inflowRate: g.inflow,
      intelligenceCost: g.cost,
      nPairs,

      rmst_random: rmst0,
      rmst_informed: rmst1,
      dRmst,
      ciLo_dRmst: ciRmst.lo,
      ciHi_dRmst: ciRmst.hi,

      dMean_sigmaCumEnd: mean(dSigmaCum),
      ciLo_dSigmaCumEnd: ciSigmaCum.lo,
      ciHi_dSigmaCumEnd: ciSigmaCum.hi,

      dMean_birthsCum: mean(dBirthsCum),
      ciLo_dBirthsCum: ciBirthsCum.lo,
      ciHi_dBirthsCum: ciBirthsCum.hi,

      dMean_deathsCum: mean(dDeathsCum),
      ciLo_dDeathsCum: ciDeathsCum.lo,
      ciHi_dDeathsCum: ciDeathsCum.hi,

      dMean_netCum: mean(dNetCum),
      ciLo_dNetCum: ciNetCum.lo,
      ciHi_dNetCum: ciNetCum.hi,

      dMean_births_window: mean(dBirthsW),
      ciLo_dBirths_window: ciBirthsW.lo,
      ciHi_dBirths_window: ciBirthsW.hi,

      dMean_deaths_window: mean(dDeathsW),
      ciLo_dDeaths_window: ciDeathsW.lo,
      ciHi_dDeaths_window: ciDeathsW.hi,

      dMean_net_window: mean(dNetW),
      ciLo_dNet_window: ciNetW.lo,
      ciHi_dNet_window: ciNetW.hi,

      ...lr,
    });

    aggRows.push([
      g.noise,
      g.inflow,
      g.cost.toFixed(6),
      nPairs,

      mean(dSurv).toFixed(6),
      sd(dSurv).toFixed(6),
      ciSurv.lo.toFixed(6),
      ciSurv.hi.toFixed(6),

      mean(dSigmaCum).toFixed(6),
      sd(dSigmaCum).toFixed(6),
      ciSigmaCum.lo.toFixed(6),
      ciSigmaCum.hi.toFixed(6),

      mean(dUptakeCum).toFixed(6),
      sd(dUptakeCum).toFixed(6),
      ciUptakeCum.lo.toFixed(6),
      ciUptakeCum.hi.toFixed(6),

      mean(dEffEnd).toFixed(6),
      sd(dEffEnd).toFixed(6),
      ciEffEnd.lo.toFixed(6),
      ciEffEnd.hi.toFixed(6),

      mean(dBirthsCum).toFixed(6),
      sd(dBirthsCum).toFixed(6),
      ciBirthsCum.lo.toFixed(6),
      ciBirthsCum.hi.toFixed(6),

      mean(dDeathsCum).toFixed(6),
      sd(dDeathsCum).toFixed(6),
      ciDeathsCum.lo.toFixed(6),
      ciDeathsCum.hi.toFixed(6),

      mean(dNetCum).toFixed(6),
      sd(dNetCum).toFixed(6),
      ciNetCum.lo.toFixed(6),
      ciNetCum.hi.toFixed(6),

      mean(dBirthsW).toFixed(6),
      sd(dBirthsW).toFixed(6),
      ciBirthsW.lo.toFixed(6),
      ciBirthsW.hi.toFixed(6),

      mean(dDeathsW).toFixed(6),
      sd(dDeathsW).toFixed(6),
      ciDeathsW.lo.toFixed(6),
      ciDeathsW.hi.toFixed(6),

      mean(dNetW).toFixed(6),
      sd(dNetW).toFixed(6),
      ciNetW.lo.toFixed(6),
      ciNetW.hi.toFixed(6),

      rmst0.toFixed(6),
      rmst1.toFixed(6),
      dRmst.toFixed(6),
      ciRmst.lo.toFixed(6),
      ciRmst.hi.toFixed(6),

      gSurv.toFixed(6),

      lr.z.toFixed(6),
      lr.pApprox.toFixed(12),
    ]);
  }

  writeFileSync(
    `${outDir}/agg.csv`,
    toCSV(
      [
        'sensingNoise','inflowRate','intelligenceCost','nPairs',

        'dMean_survivedTicks','sd_dSurv','ciLo_dSurv','ciHi_dSurv',

        'dMean_sigmaCumEnd','sd_dSigmaCum','ciLo_dSigmaCumEnd','ciHi_dSigmaCumEnd',

        'dMean_totalUptakeCum','sd_dUptakeCum','ciLo_dUptakeCum','ciHi_dUptakeCum',
        'dMean_efficiencyEnd','sd_dEffEnd','ciLo_dEffEnd','ciHi_dEffEnd',

        'dMean_birthsCum','sd_dBirthsCum','ciLo_dBirthsCum','ciHi_dBirthsCum',
        'dMean_deathsCum','sd_dDeathsCum','ciLo_dDeathsCum','ciHi_dDeathsCum',
        'dMean_netCum','sd_dNetCum','ciLo_dNetCum','ciHi_dNetCum',

        'dMean_births_window','sd_dBirthsW','ciLo_dBirthsW','ciHi_dBirthsW',
        'dMean_deaths_window','sd_dDeathsW','ciLo_dDeathsW','ciHi_dDeathsW',
        'dMean_net_window','sd_dNetW','ciLo_dNetW','ciHi_dNetW',

        'rmst_random_tau','rmst_informed_tau','dRmst','ciLo_dRmst','ciHi_dRmst',

        'hedgesG_survival_ref',

        'logrank_z','logrank_pApprox',
      ],
      aggRows
    ),
    'utf-8'
  );

  writeFileSync(`${outDir}/logrank.json`, JSON.stringify(logrankOut, null, 2), 'utf-8');

  console.log('Done. Wrote ${outDir}/raw.csv ${outDir}/agg.csv ${outDir}/survival.csv ${outDir}/logrank.json ${outDir}/meta.json');
  if (snapshotSpec.enabled) console.log('Snapshots written under out/snapshots/');
}

if (!isMainThread && process.argv.includes('--worker')) {
  workerLoop();
} else {
  main();
}
