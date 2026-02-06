// src/runner.ts version MD

import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { SimulationEngine } from './simulationEngine.ts';
import type { UserConfig, Mode, EngineStepStats } from './types.ts';
import * as StatsNS from './stats.ts';

// ------------------------------
// Stats loader (default export / namespace both ok)
// ------------------------------
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

// ------------------------------
// CSV
// ------------------------------
function toCSV(headers: string[], rows: (string | number)[][]) {
  const h = headers.join(',');
  const body = rows.map(r => r.join(',')).join('\n');
  return h + '\n' + body + '\n';
}

// ------------------------------
// Validation (A: use proxy fields as primary)
// ------------------------------
function assertFiniteStats(s: EngineStepStats, ctx: string) {
  const bad =
    !Number.isFinite(s.energyTotal) ||
    !Number.isFinite(s.energyPrev) ||
    !Number.isFinite(s.deltaU) ||
    !Number.isFinite(s.energyResidual) ||
    !Number.isFinite(s.sigmaProxyTotal) ||
    !Number.isFinite(s.sigmaProxyCumulative) ||
    !Number.isFinite(s.outflowPhysical) ||
    !Number.isFinite(s.outflowNumerical) ||
    !Number.isFinite(s.outflowAct) ||
    !Number.isFinite(s.uptake) ||
    !Number.isFinite(s.infoCost) ||
    !Number.isFinite(s.maintenanceCost) ||
    !Number.isFinite(s.divisionCost) ||
    !Number.isFinite(s.moveDist) ||
    !Number.isFinite(s.moveDistCumulative);

  if (bad) {
    throw new Error(
      `NaN/Inf detected (${ctx}): ` +
      `Uprev=${s.energyPrev} U=${s.energyTotal} dU=${s.deltaU} res=${s.energyResidual} ` +
      `sigmaProxy=${s.sigmaProxyTotal} sigProxyCum=${s.sigmaProxyCumulative} ` +
      `uptake=${s.uptake} info=${s.infoCost} maint=${s.maintenanceCost} div=${s.divisionCost} ` +
      `moveDist=${s.moveDist} moveDistCum=${s.moveDistCumulative}`
    );
  }

  if (
    typeof s.births !== 'number' ||
    typeof s.deaths !== 'number' ||
    !Number.isFinite(s.births) ||
    !Number.isFinite(s.deaths)
  ) {
    throw new Error(
      `EngineStepStats.births/deaths missing or non-finite (${ctx}). ` +
      `This runner expects births/deaths per tick in EngineStepStats.`
    );
  }
}

// ------------------------------
// Types
// ------------------------------
type RunSummary = {
  survivedTicks: number;
  event: 0 | 1;
  maxPop: number;

  // --- A: proxies ---
  sigmaProxyCumEnd: number;
  sigmaProxyDiffCumEnd: number;
  sigmaProxyActCumEnd: number;

  // --- B: movement proxy ---
  moveDistCumEnd: number;

  // cumulative outflows (diagnostics / decomposition)
  outflowPhysCum: number;
  outflowNumCum: number;
  outflowActCum: number;

  actHeatMaintCum: number;
  actHeatInfoCum: number;
  actHeatDivCum: number;

  totalUptakeCum: number;
  infoCostCum: number;
  maintenanceCostCum: number;
  divisionCostCum: number;
  efficiencyEnd: number;

  birthsCum: number;
  deathsCum: number;
  netCum: number;

  meanAbsEnergyResidual: number;

  measuredTicks: number;
  mean_agentCount_window: number;
  mean_sigmaProxyTotal_window: number;

  mean_moveDist_window: number;

  mean_uptake_window: number;
  mean_infoCost_window: number;
  mean_maintenance_window: number;
  mean_divisionCost_window: number;
  mean_efficiency_window: number;

  mean_births_window: number;
  mean_deaths_window: number;
  mean_net_window: number;

  tailTicksUsed: number;

  mean_moveDist_tail: number;

  mean_uptake_tail: number;
  mean_infoCost_tail: number;
  mean_maintenance_tail: number;
  mean_divisionCost_tail: number;
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
  maxAgents: number;
  lookDist: number;

  burnIn: number;
  measureTicks: number;
  maxTicks: number;
  tailTicks: number;

  survivedTicks: number;
  event: 0 | 1;
  max_agentCount: number;

  // --- A: proxies ---
  sigmaProxyCumEnd: number;
  sigmaProxyDiffCumEnd: number;
  sigmaProxyActCumEnd: number;

  // --- B: movement proxy ---
  moveDistCumEnd: number;

  // cumulative outflows
  outflowPhysCum: number;
  outflowNumCum: number;
  outflowActCum: number;

  actHeatMaintCum: number;
  actHeatInfoCum: number;
  actHeatDivCum: number;

  totalUptakeCum: number;
  infoCostCum: number;
  maintenanceCostCum: number;
  divisionCostCum: number;
  efficiencyEnd: number;

  birthsCum: number;
  deathsCum: number;
  netCum: number;

  meanAbsEnergyResidual: number;

  measuredTicks: number;
  mean_agentCount_window: number;
  mean_sigmaProxyTotal_window: number;

  mean_moveDist_window: number;

  mean_uptake_window: number;
  mean_infoCost_window: number;
  mean_maintenance_window: number;
  mean_divisionCost_window: number;
  mean_efficiency_window: number;

  mean_births_window: number;
  mean_deaths_window: number;
  mean_net_window: number;

  tailTicksUsed: number;

  mean_moveDist_tail: number;

  mean_uptake_tail: number;
  mean_infoCost_tail: number;
  mean_maintenance_tail: number;
  mean_divisionCost_tail: number;
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

type SnapshotSpec = {
  enabled: boolean;
  outDir: string;
  targetInflows: number[];
  targetCost: number;
  targetNoise: number;
  targetSeed: number;
  snapshotTicks: number[];
};

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
  snapshot?: SnapshotSpec;
};

type JobResult = {
  jobId: number;
  rand: RunRecordNoId;
  inf: RunRecordNoId;
  survRand: { time: number; event: 0 | 1; group: 0 | 1; inflow: number; cost: number; noise: number; seed: number };
  survInf: { time: number; event: 0 | 1; group: 0 | 1; inflow: number; cost: number; noise: number; seed: number };
};

// ------------------------------
// Base config & default sweep
// ------------------------------
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

const argv = parseArgs(process.argv.slice(2));

const sweep: Sweep = {
  inflowStart: 0.0, inflowEnd: 0.2, inflowStep: 0.005,

  costScale: 1000,
  costStart_i: 200,
  costEnd_i: 201,
  costStep_i: 1,

  noiseList: argv.noiseList? argv.noiseList.split(',').map(Number).filter(Number.isFinite): [parseNumber(argv.noise, 0.0)],

  seeds: 50,
  seedBase: 1000,

  maxTicks: 3000,
  burnIn: 100,
  measureTicks: 300,

  tailTicks: 30,
};

// ------------------------------
// CLI parsing
// ------------------------------
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
// Snapshot utilities
// ------------------------------
function writeMatrixCSV(path: string, mat: Float32Array, N: number) {
  const lines: string[] = [];
  for (let y = 0; y < N; y++) {
    const row: string[] = [];
    for (let x = 0; x < N; x++) row.push(String(mat[x + y * N]));
    lines.push(row.join(','));
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
}

function writeAgentsCSV(path: string, cells: { x: number; y: number; energy: number; vx: number; vy: number }[]) {
  const headers = ['id', 'x', 'y', 'energy', 'vx', 'vy'];
  const rows = cells.map((c, i) => [i, c.x, c.y, c.energy, c.vx, c.vy]);
  writeFileSync(path, toCSV(headers, rows), 'utf-8');
}

function approxEq(a: number, b: number, tol: number) {
  return Math.abs(a - b) <= tol;
}

function shouldSnapshotJob(spec: SnapshotSpec, inflow: number, cost: number, noise: number, seed: number) {
  if (!spec.enabled) return false;
  if (seed !== spec.targetSeed) return false;
  if (!approxEq(cost, spec.targetCost, 1e-12)) return false;
  if (!approxEq(noise, spec.targetNoise, 1e-12)) return false;
  for (const t of spec.targetInflows) if (approxEq(inflow, t, 5e-7)) return true;
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

// ------------------------------
// Core sim: runOne
// ------------------------------
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
  let sumSigmaProxyTotal = 0;

  let sumMoveDist = 0;

  let sumUptake = 0;
  let sumInfo = 0;
  let sumMaint = 0;
  let sumDiv = 0;
  let sumEff = 0;

  let sumBirthsW = 0;
  let sumDeathsW = 0;
  let sumNetW = 0;

  let outflowPhysCum = 0;
  let outflowNumCum = 0;
  let outflowActCum = 0;

  let actHeatMaintCum = 0;
  let actHeatInfoCum = 0;
  let actHeatDivCum = 0;

  let lastSigmaProxyCum = 0;
  let lastSigmaProxyDiffCum = 0;
  let lastSigmaProxyActCum = 0;

  let lastMoveDistCum = 0;

  let totalUptakeCum = 0;
  let infoCostCum = 0;
  let maintenanceCostCum = 0;
  let divisionCostCum = 0;

  let birthsCum = 0;
  let deathsCum = 0;

  let sumAbsRes = 0;
  let resCount = 0;

  const tailCap = Math.max(1, Math.floor(tailTicks));
  const tailMoveDist: number[] = [];

  const tailUptake: number[] = [];
  const tailInfo: number[] = [];
  const tailMaint: number[] = [];
  const tailDiv: number[] = [];
  const tailEff: number[] = [];

  const tailBirths: number[] = [];
  const tailDeaths: number[] = [];
  const tailNet: number[] = [];

  function pushTail(moveDistTick: number, uptakeTick: number, infoTick: number, maintTick: number, divTick: number, birthsTick: number, deathsTick: number) {
    const eff = uptakeTick / (infoTick + maintTick + 1e-9);
    const net = birthsTick - deathsTick;

    tailMoveDist.push(moveDistTick);
    if (tailMoveDist.length > tailCap) tailMoveDist.shift();

    tailUptake.push(uptakeTick);
    tailInfo.push(infoTick);
    tailMaint.push(maintTick);
    tailDiv.push(divTick);
    tailEff.push(eff);

    tailBirths.push(birthsTick);
    tailDeaths.push(deathsTick);
    tailNet.push(net);

    if (tailUptake.length > tailCap) tailUptake.shift();
    if (tailInfo.length > tailCap) tailInfo.shift();
    if (tailMaint.length > tailCap) tailMaint.shift();
    if (tailDiv.length > tailCap) tailDiv.shift();
    if (tailEff.length > tailCap) tailEff.shift();

    if (tailBirths.length > tailCap) tailBirths.shift();
    if (tailDeaths.length > tailCap) tailDeaths.shift();
    if (tailNet.length > tailCap) tailNet.shift();
  }

  const snapshotTicksSet = new Set<number>(snapshot?.spec?.snapshotTicks ?? []);

  while (t < maxTicks) {
    const s = engine.update({ ...conf, mode });
    assertFiniteStats(s, `mode=${mode} t=${t}`);

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

    const birthsTick = s.births;
    const deathsTick = s.deaths;

    if (s.agentCount > maxPop) maxPop = s.agentCount;

    outflowActCum += s.outflowAct;
    outflowPhysCum += s.outflowPhysical;
    outflowNumCum += s.outflowNumerical;

    actHeatMaintCum += s.actHeatMaintenance;
    actHeatInfoCum += s.actHeatInfo;
    actHeatDivCum += s.actHeatDivision;

    lastSigmaProxyCum = s.sigmaProxyCumulative;
    lastSigmaProxyDiffCum = s.sigmaProxyDiffCumulative;
    lastSigmaProxyActCum = s.sigmaProxyActCumulative;

    lastMoveDistCum = s.moveDistCumulative;

    totalUptakeCum += s.uptake;
    infoCostCum += s.infoCost;
    maintenanceCostCum += s.maintenanceCost;
    divisionCostCum += s.divisionCost;

    birthsCum += birthsTick;
    deathsCum += deathsTick;

    sumAbsRes += Math.abs(s.energyResidual);
    resCount++;

    pushTail(s.moveDist, s.uptake, s.infoCost, s.maintenanceCost, s.divisionCost, birthsTick, deathsTick);

    if (t >= burnIn && t < burnIn + measureTicks) {
      sumAgents += s.agentCount;
      sumSigmaProxyTotal += s.sigmaProxyTotal;

      sumMoveDist += s.moveDist;

      sumUptake += s.uptake;
      sumInfo += s.infoCost;
      sumMaint += s.maintenanceCost;
      sumDiv += s.divisionCost;

      const denom = (s.infoCost + s.maintenanceCost + 1e-9);
      sumEff += s.uptake / denom;

      sumBirthsW += birthsTick;
      sumDeathsW += deathsTick;
      sumNetW += (birthsTick - deathsTick);

      measuredTicksDone++;
    }

    if (s.agentCount === 0) {
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

      const tailTicksUsed = tailMoveDist.length;
      return {
        survivedTicks: t,
        event: 1,
        maxPop,

        sigmaProxyCumEnd: lastSigmaProxyCum,
        sigmaProxyDiffCumEnd: lastSigmaProxyDiffCum,
        sigmaProxyActCumEnd: lastSigmaProxyActCum,

        moveDistCumEnd: lastMoveDistCum,

        outflowPhysCum,
        outflowNumCum,
        outflowActCum,

        actHeatMaintCum,
        actHeatInfoCum,
        actHeatDivCum,

        totalUptakeCum,
        infoCostCum,
        maintenanceCostCum,
        divisionCostCum,
        efficiencyEnd,

        birthsCum,
        deathsCum,
        netCum,

        meanAbsEnergyResidual: resCount ? (sumAbsRes / resCount) : 0,

        measuredTicks: measuredTicksDone,
        mean_agentCount_window: measuredTicksDone ? (sumAgents / measuredTicksDone) : 0,
        mean_sigmaProxyTotal_window: measuredTicksDone ? (sumSigmaProxyTotal / measuredTicksDone) : 0,

        mean_moveDist_window: measuredTicksDone ? (sumMoveDist / measuredTicksDone) : 0,

        mean_uptake_window: measuredTicksDone ? (sumUptake / measuredTicksDone) : 0,
        mean_infoCost_window: measuredTicksDone ? (sumInfo / measuredTicksDone) : 0,
        mean_maintenance_window: measuredTicksDone ? (sumMaint / measuredTicksDone) : 0,
        mean_divisionCost_window: measuredTicksDone ? (sumDiv / measuredTicksDone) : 0,
        mean_efficiency_window: measuredTicksDone ? (sumEff / measuredTicksDone) : 0,

        mean_births_window: measuredTicksDone ? (sumBirthsW / measuredTicksDone) : 0,
        mean_deaths_window: measuredTicksDone ? (sumDeathsW / measuredTicksDone) : 0,
        mean_net_window: measuredTicksDone ? (sumNetW / measuredTicksDone) : 0,

        tailTicksUsed,
        mean_moveDist_tail: tailTicksUsed ? mean(tailMoveDist) : 0,

        mean_uptake_tail: tailTicksUsed ? mean(tailUptake) : 0,
        mean_infoCost_tail: tailTicksUsed ? mean(tailInfo) : 0,
        mean_maintenance_tail: tailTicksUsed ? mean(tailMaint) : 0,
        mean_divisionCost_tail: tailTicksUsed ? mean(tailDiv) : 0,
        mean_efficiency_tail: tailTicksUsed ? mean(tailEff) : 0,

        mean_births_tail: tailTicksUsed ? mean(tailBirths) : 0,
        mean_deaths_tail: tailTicksUsed ? mean(tailDeaths) : 0,
        mean_net_tail: tailTicksUsed ? mean(tailNet) : 0,
      };
    }

    t++;
  }

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
  const tailTicksUsed = tailMoveDist.length;

  return {
    survivedTicks: maxTicks,
    event: 0,
    maxPop,

    sigmaProxyCumEnd: lastSigmaProxyCum,
    sigmaProxyDiffCumEnd: lastSigmaProxyDiffCum,
    sigmaProxyActCumEnd: lastSigmaProxyActCum,

    moveDistCumEnd: lastMoveDistCum,

    outflowPhysCum,
    outflowNumCum,
    outflowActCum,

    actHeatMaintCum,
    actHeatInfoCum,
    actHeatDivCum,

    totalUptakeCum,
    infoCostCum,
    maintenanceCostCum,
    divisionCostCum,
    efficiencyEnd,

    birthsCum,
    deathsCum,
    netCum,

    meanAbsEnergyResidual: resCount ? (sumAbsRes / resCount) : 0,

    measuredTicks: measuredTicksDone,
    mean_agentCount_window: measuredTicksDone ? (sumAgents / measuredTicksDone) : 0,
    mean_sigmaProxyTotal_window: measuredTicksDone ? (sumSigmaProxyTotal / measuredTicksDone) : 0,

    mean_moveDist_window: measuredTicksDone ? (sumMoveDist / measuredTicksDone) : 0,

    mean_uptake_window: measuredTicksDone ? (sumUptake / measuredTicksDone) : 0,
    mean_infoCost_window: measuredTicksDone ? (sumInfo / measuredTicksDone) : 0,
    mean_maintenance_window: measuredTicksDone ? (sumMaint / measuredTicksDone) : 0,
    mean_divisionCost_window: measuredTicksDone ? (sumDiv / measuredTicksDone) : 0,
    mean_efficiency_window: measuredTicksDone ? (sumEff / measuredTicksDone) : 0,

    mean_births_window: measuredTicksDone ? (sumBirthsW / measuredTicksDone) : 0,
    mean_deaths_window: measuredTicksDone ? (sumDeathsW / measuredTicksDone) : 0,
    mean_net_window: measuredTicksDone ? (sumNetW / measuredTicksDone) : 0,

    tailTicksUsed,
    mean_moveDist_tail: tailTicksUsed ? mean(tailMoveDist) : 0,

    mean_uptake_tail: tailTicksUsed ? mean(tailUptake) : 0,
    mean_infoCost_tail: tailTicksUsed ? mean(tailInfo) : 0,
    mean_maintenance_tail: tailTicksUsed ? mean(tailMaint) : 0,
    mean_divisionCost_tail: tailTicksUsed ? mean(tailDiv) : 0,
    mean_efficiency_tail: tailTicksUsed ? mean(tailEff) : 0,

    mean_births_tail: tailTicksUsed ? mean(tailBirths) : 0,
    mean_deaths_tail: tailTicksUsed ? mean(tailDeaths) : 0,
    mean_net_tail: tailTicksUsed ? mean(tailNet) : 0,
  };
}

// ------------------------------
// Records
// ------------------------------
function makeRunRecordNoId(
  conf: UserConfig,
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
    maxAgents: conf.maxAgents ?? -1,
    lookDist: conf.lookDist ?? -1,

    burnIn,
    measureTicks,
    maxTicks,
    tailTicks,

    survivedTicks: sum.survivedTicks,
    event: sum.event,
    max_agentCount: sum.maxPop,

    sigmaProxyCumEnd: sum.sigmaProxyCumEnd,
    sigmaProxyDiffCumEnd: sum.sigmaProxyDiffCumEnd,
    sigmaProxyActCumEnd: sum.sigmaProxyActCumEnd,

    moveDistCumEnd: sum.moveDistCumEnd,

    outflowPhysCum: sum.outflowPhysCum,
    outflowNumCum: sum.outflowNumCum,
    outflowActCum: sum.outflowActCum,

    actHeatMaintCum: sum.actHeatMaintCum,
    actHeatInfoCum: sum.actHeatInfoCum,
    actHeatDivCum: sum.actHeatDivCum,

    totalUptakeCum: sum.totalUptakeCum,
    infoCostCum: sum.infoCostCum,
    maintenanceCostCum: sum.maintenanceCostCum,
    divisionCostCum: sum.divisionCostCum,
    efficiencyEnd: sum.efficiencyEnd,

    birthsCum: sum.birthsCum,
    deathsCum: sum.deathsCum,
    netCum: sum.netCum,

    meanAbsEnergyResidual: sum.meanAbsEnergyResidual,

    measuredTicks: sum.measuredTicks,
    mean_agentCount_window: sum.mean_agentCount_window,
    mean_sigmaProxyTotal_window: sum.mean_sigmaProxyTotal_window,

    mean_moveDist_window: sum.mean_moveDist_window,

    mean_uptake_window: sum.mean_uptake_window,
    mean_infoCost_window: sum.mean_infoCost_window,
    mean_maintenance_window: sum.mean_maintenance_window,
    mean_divisionCost_window: sum.mean_divisionCost_window,
    mean_efficiency_window: sum.mean_efficiency_window,

    mean_births_window: sum.mean_births_window,
    mean_deaths_window: sum.mean_deaths_window,
    mean_net_window: sum.mean_net_window,

    tailTicksUsed: sum.tailTicksUsed,
    mean_moveDist_tail: sum.mean_moveDist_tail,

    mean_uptake_tail: sum.mean_uptake_tail,
    mean_infoCost_tail: sum.mean_infoCost_tail,
    mean_maintenance_tail: sum.mean_maintenance_tail,
    mean_divisionCost_tail: sum.mean_divisionCost_tail,
    mean_efficiency_tail: sum.mean_efficiency_tail,

    mean_births_tail: sum.mean_births_tail,
    mean_deaths_tail: sum.mean_deaths_tail,
    mean_net_tail: sum.mean_net_tail,
  };
}

// ------------------------------
// Job exec
// ------------------------------
function doJob(job: Job): JobResult {
  const { inflow, cost, noise, seed, conf, maxTicks, burnIn, measureTicks, tailTicks, snapshot } = job;

  const masterEngine = new SimulationEngine(conf);
  const master = masterEngine.generateMasterState(conf);

  const snapEnabled = !!(snapshot && shouldSnapshotJob(snapshot, inflow, cost, noise, seed));

  const randSum = runOne(conf, 'random', master, maxTicks, burnIn, measureTicks, tailTicks, snapEnabled ? {
    spec: snapshot!,
    inflow, cost, noise, seed,
  } : undefined);

  const infSum = runOne(conf, 'informed', master, maxTicks, burnIn, measureTicks, tailTicks, snapEnabled ? {
    spec: snapshot!,
    inflow, cost, noise, seed,
  } : undefined);

  const rand = makeRunRecordNoId(conf, 'random', seed, inflow, cost, noise, burnIn, measureTicks, maxTicks, tailTicks, randSum);
  const inf = makeRunRecordNoId(conf, 'informed', seed, inflow, cost, noise, burnIn, measureTicks, maxTicks, tailTicks, infSum);

  const survRand = { time: randSum.survivedTicks, event: randSum.event, group: 0 as 0, inflow, cost, noise, seed };
  const survInf = { time: infSum.survivedTicks, event: infSum.event, group: 1 as 1, inflow, cost, noise, seed };

  return { jobId: job.jobId, rand, inf, survRand, survInf };
}

// ------------------------------
// Progress helper
// ------------------------------
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

// ------------------------------
// Parallel runner
// ------------------------------
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

// ------------------------------
// Worker loop
// ------------------------------
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

// ------------------------------
// Main
// ------------------------------
async function main() {
  console.log('availableParallelism=', (os as any).availableParallelism?.() ?? 'n/a');
  console.log('cpus.length=', os.cpus().length);

  const args = parseArgs(process.argv.slice(2).filter(a => a !== '--worker'));

  const outDirRaw = (args.outDir ?? 'out').trim();
  const outDir = outDirRaw.length ? outDirRaw : 'out';

  const inflowStart = parseNumber(args.inflowStart, sweep.inflowStart);
  const inflowEnd = parseNumber(args.inflowEnd, sweep.inflowEnd);
  const inflowStep = parseNumber(args.inflowStep, sweep.inflowStep);

  const costScale = Math.floor(parseNumber(args.costScale, sweep.costScale));
  const costStart_i = Math.floor(parseNumber(args.costStart_i, sweep.costStart_i));
  const costEnd_i = Math.floor(parseNumber(args.costEnd_i, sweep.costEnd_i));
  const costStep_i = Math.floor(parseNumber(args.costStep_i, sweep.costStep_i));

  const maxAgentsCli = Math.floor(parseNumber(args.maxAgents, baseConfig.maxAgents ?? 500));
  const lookDistCli = Math.floor(parseNumber(args.lookDist, baseConfig.lookDist ?? 3));

  const seedBase = Math.floor(parseNumber(args.seedBase, sweep.seedBase));
  const seedsSpec = args.seeds;
  const seedsParsed = parseSeedsSpec(seedsSpec, seedBase, sweep.seeds);
  const seedsList = seedsParsed.seeds;

  const workers = Math.max(1, Math.floor(parseNumber(
    args.workers,
    Math.max(1, (os.cpus()?.length ?? 2) - 1)
  )));
  console.log('workers=', workers);

  // Snapshot flags
  const snapshotEnabled = (args.snapshot ?? 'false') === 'true';
  const snapshotInflows = (args.snapshotInflows ?? '').trim()
    ? (args.snapshotInflows!.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n)))
    : [0.0108, 0.01094, 0.0111];

  const snapshotSeed = Math.floor(parseNumber(args.snapshotSeed, seedsList[0] ?? sweep.seedBase));
  const snapshotCost = parseNumber(args.snapshotCost, (costStart_i / costScale));
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
    costScale,
    costStart_i,
    costEnd_i,
    costStep_i,
  };

  mkdirSync(outDir, { recursive: true });
  if (snapshotSpec.enabled) mkdirSync(snapshotSpec.outDir, { recursive: true });

  writeFileSync(
    `${outDir}/meta.json`,
    JSON.stringify(
      {
        note: 'MoveDist-mode: includes moveDist (total movement distance) proxy in addition to dissipation proxies.',
        effectiveParams: {
          maxAgents: maxAgentsCli,
          lookDist: lookDistCli,
          gridSize: baseConfig.gridSize,
          consumptionRate: baseConfig.consumptionRate,
          divisionThreshold: baseConfig.divisionThreshold,
          divisionCost: baseConfig.divisionCost,
        },
        baseConfig,
        sweep: effSweep,
        seedsList,
        cli: {
          inflowStart, inflowEnd, inflowStep,
          seeds: seedsSpec ?? '(default)',
          seedBase: seedsParsed.seedBaseUsed,
          workers,
          outDir,
          snapshot: snapshotSpec,
        },
        costSweepSpec: {
          costScale: effSweep.costScale,
          costStart_i: effSweep.costStart_i,
          costEnd_i: effSweep.costEnd_i,
          costStep_i: effSweep.costStep_i,
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
    maxAgents: number;
    lookDist: number;
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
            maxAgents: maxAgentsCli,
            lookDist: lookDistCli,
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
    console.log(`Snapshots will be written to ${snapshotSpec.outDir}/ ONLY for (seed,cost,noise,inflow list) matches.`);
  }

  const results = await runParallel(jobs, workers);

  let runId = 1;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];

    raw.push({ runId: runId++, ...r.rand });
    raw.push({ runId: runId++, ...r.inf });

    survivalRows.push({
      time: r.survRand.time,
      event: r.survRand.event,
      group: 0,
      inflow: r.survRand.inflow,
      cost: r.survRand.cost,
      noise: r.survRand.noise,
      seed: r.survRand.seed,
      maxAgents: r.rand.maxAgents,
      lookDist: r.rand.lookDist,
    });

    survivalRows.push({
      time: r.survInf.time,
      event: r.survInf.event,
      group: 1,
      inflow: r.survInf.inflow,
      cost: r.survInf.cost,
      noise: r.survInf.noise,
      seed: r.survInf.seed,
      maxAgents: r.inf.maxAgents,
      lookDist: r.inf.lookDist,
    });
  }

  // ------------------------------
  // raw.csv
  // ------------------------------
  writeFileSync(
    `${outDir}/raw.csv`,
    toCSV(
      [
        'runId', 'mode', 'seed', 'inflowRate', 'intelligenceCost', 'sensingNoise', 'maxAgents', 'lookDist',
        'burnIn', 'measureTicks', 'maxTicks', 'tailTicks',
        'survivedTicks', 'event', 'max_agentCount',

        'sigmaProxyCumEnd', 'sigmaProxyDiffCumEnd', 'sigmaProxyActCumEnd',
        'moveDistCumEnd',

        'outflowPhysCum', 'outflowNumCum', 'outflowActCum',
        'actHeatMaintCum', 'actHeatInfoCum', 'actHeatDivCum',

        'totalUptakeCum', 'infoCostCum', 'maintenanceCostCum', 'divisionCostCum', 'efficiencyEnd',

        'birthsCum', 'deathsCum', 'netCum',

        'meanAbsEnergyResidual',

        'measuredTicks', 'mean_agentCount_window', 'mean_sigmaProxyTotal_window',
        'mean_moveDist_window',

        'mean_uptake_window', 'mean_infoCost_window', 'mean_maintenance_window', 'mean_divisionCost_window', 'mean_efficiency_window',
        'mean_births_window', 'mean_deaths_window', 'mean_net_window',

        'tailTicksUsed',
        'mean_moveDist_tail',

        'mean_uptake_tail', 'mean_infoCost_tail', 'mean_maintenance_tail', 'mean_divisionCost_tail', 'mean_efficiency_tail',
        'mean_births_tail', 'mean_deaths_tail', 'mean_net_tail',
      ],
      raw.map(r => [
        r.runId, r.mode, r.seed, r.inflowRate, r.intelligenceCost.toFixed(6), r.sensingNoise, r.maxAgents, r.lookDist,
        r.burnIn, r.measureTicks, r.maxTicks, r.tailTicks,
        r.survivedTicks, r.event, r.max_agentCount,

        r.sigmaProxyCumEnd.toFixed(6),
        r.sigmaProxyDiffCumEnd.toFixed(6),
        r.sigmaProxyActCumEnd.toFixed(6),
        r.moveDistCumEnd.toFixed(6),

        r.outflowPhysCum.toFixed(6),
        r.outflowNumCum.toFixed(6),
        r.outflowActCum.toFixed(6),

        r.actHeatMaintCum.toFixed(6),
        r.actHeatInfoCum.toFixed(6),
        r.actHeatDivCum.toFixed(6),

        r.totalUptakeCum.toFixed(6),
        r.infoCostCum.toFixed(6),
        r.maintenanceCostCum.toFixed(6),
        r.divisionCostCum.toFixed(6),
        r.efficiencyEnd.toFixed(6),

        r.birthsCum.toFixed(6),
        r.deathsCum.toFixed(6),
        r.netCum.toFixed(6),

        r.meanAbsEnergyResidual.toFixed(12),

        r.measuredTicks,
        r.mean_agentCount_window.toFixed(6),
        r.mean_sigmaProxyTotal_window.toFixed(6),
        r.mean_moveDist_window.toFixed(6),

        r.mean_uptake_window.toFixed(6),
        r.mean_infoCost_window.toFixed(6),
        r.mean_maintenance_window.toFixed(6),
        r.mean_divisionCost_window.toFixed(6),
        r.mean_efficiency_window.toFixed(6),
        r.mean_births_window.toFixed(6),
        r.mean_deaths_window.toFixed(6),
        r.mean_net_window.toFixed(6),

        r.tailTicksUsed,
        r.mean_moveDist_tail.toFixed(6),

        r.mean_uptake_tail.toFixed(6),
        r.mean_infoCost_tail.toFixed(6),
        r.mean_maintenance_tail.toFixed(6),
        r.mean_divisionCost_tail.toFixed(6),
        r.mean_efficiency_tail.toFixed(6),
        r.mean_births_tail.toFixed(6),
        r.mean_deaths_tail.toFixed(6),
        r.mean_net_tail.toFixed(6),
      ])
    ),
    'utf-8'
  );

  // ------------------------------
  // survival.csv
  // ------------------------------
  writeFileSync(
    `${outDir}/survival.csv`,
    toCSV(
      ['time', 'event', 'group', 'inflowRate', 'intelligenceCost', 'sensingNoise', 'seed', 'maxAgents', 'lookDist'],
      survivalRows.map(s => [s.time, s.event, s.group, s.inflow, s.cost.toFixed(6), s.noise, s.seed, s.maxAgents, s.lookDist])
    ),
    'utf-8'
  );

  // ------------------------------
  // Grouping (KEY MUST BE FIXED STRING to prevent float mismatch)
  // ------------------------------
  type Key = string;
  const groups = new Map<Key, {
    inflow: number;
    cost: number;
    noise: number;
    maxAgents: number;
    lookDist: number;
    rand: RunRecord[];
    inf: RunRecord[];
    surv: typeof survivalRows;
  }>();

  for (const r of raw) {
    const inflowKey = r.inflowRate.toFixed(6);
    const costKey = r.intelligenceCost.toFixed(6);
    const key = `${r.sensingNoise}|${inflowKey}|${costKey}|${r.maxAgents}|${r.lookDist}`;

    if (!groups.has(key)) {
      groups.set(key, {
        inflow: r.inflowRate,
        cost: r.intelligenceCost,
        noise: r.sensingNoise,
        maxAgents: r.maxAgents,
        lookDist: r.lookDist,
        rand: [],
        inf: [],
        surv: [] as any
      });
    }
    const g = groups.get(key)!;
    if (r.mode === 'random') g.rand.push(r);
    else g.inf.push(r);
  }

  for (const s of survivalRows) {
    const inflowKey = s.inflow.toFixed(6);
    const costKey = s.cost.toFixed(6);
    const key = `${s.noise}|${inflowKey}|${costKey}|${s.maxAgents}|${s.lookDist}`;
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
    const dSigmaProxyCum: number[] = [];
    const dSigmaProxyDiffCum: number[] = [];
    const dSigmaProxyActCum: number[] = [];

    const dMoveDistCum: number[] = [];
    const dMoveDistW: number[] = [];

    const dOutflowNumCum: number[] = [];

    const dUptakeCum: number[] = [];
    const dEffEnd: number[] = [];

    const dBirthsCum: number[] = [];
    const dDeathsCum: number[] = [];
    const dNetCum: number[] = [];

    const randSurv: number[] = [];
    const infSurv: number[] = [];

    const dBirthsW: number[] = [];
    const dDeathsW: number[] = [];
    const dNetW: number[] = [];

    for (const pair of bySeed.values()) {
      if (!pair.rand || !pair.inf) continue;

      dSurv.push(pair.inf.survivedTicks - pair.rand.survivedTicks);

      dSigmaProxyCum.push(pair.inf.sigmaProxyCumEnd - pair.rand.sigmaProxyCumEnd);
      dSigmaProxyDiffCum.push(pair.inf.sigmaProxyDiffCumEnd - pair.rand.sigmaProxyDiffCumEnd);
      dSigmaProxyActCum.push(pair.inf.sigmaProxyActCumEnd - pair.rand.sigmaProxyActCumEnd);

      dMoveDistCum.push(pair.inf.moveDistCumEnd - pair.rand.moveDistCumEnd);
      dMoveDistW.push(pair.inf.mean_moveDist_window - pair.rand.mean_moveDist_window);

      dOutflowNumCum.push(pair.inf.outflowNumCum - pair.rand.outflowNumCum);

      dUptakeCum.push(pair.inf.totalUptakeCum - pair.rand.totalUptakeCum);
      dEffEnd.push(pair.inf.efficiencyEnd - pair.rand.efficiencyEnd);

      dBirthsCum.push(pair.inf.birthsCum - pair.rand.birthsCum);
      dDeathsCum.push(pair.inf.deathsCum - pair.rand.deathsCum);
      dNetCum.push(pair.inf.netCum - pair.rand.netCum);

      dBirthsW.push(pair.inf.mean_births_window - pair.rand.mean_births_window);
      dDeathsW.push(pair.inf.mean_deaths_window - pair.rand.mean_deaths_window);
      dNetW.push(pair.inf.mean_net_window - pair.rand.mean_net_window);

      randSurv.push(pair.rand.survivedTicks);
      infSurv.push(pair.inf.survivedTicks);
    }

    const nPairs = dSurv.length;
    if (nPairs === 0) continue;

    // paired bootstrap CI (unit = seed pair)
    const ciSurv = bootstrapCI(dSurv, mean, 2000);

    const ciSigmaProxyCum = bootstrapCI(dSigmaProxyCum, mean, 2000);
    const ciSigmaProxyDiffCum = bootstrapCI(dSigmaProxyDiffCum, mean, 2000);
    const ciSigmaProxyActCum = bootstrapCI(dSigmaProxyActCum, mean, 2000);

    const ciMoveDistCum = bootstrapCI(dMoveDistCum, mean, 2000);
    const ciMoveDistW = bootstrapCI(dMoveDistW, mean, 2000);

    const ciOutflowNumCum = bootstrapCI(dOutflowNumCum, mean, 2000);

    const ciUptakeCum = bootstrapCI(dUptakeCum, mean, 2000);
    const ciEffEnd = bootstrapCI(dEffEnd, mean, 2000);

    const ciBirthsCum = bootstrapCI(dBirthsCum, mean, 2000);
    const ciDeathsCum = bootstrapCI(dDeathsCum, mean, 2000);
    const ciNetCum = bootstrapCI(dNetCum, mean, 2000);

    const ciBirthsW = bootstrapCI(dBirthsW, mean, 2000);
    const ciDeathsW = bootstrapCI(dDeathsW, mean, 2000);
    const ciNetW = bootstrapCI(dNetW, mean, 2000);

    const gSurv = hedgesG(infSurv, randSurv);

    const surv0 = (g.surv as any).filter((s: any) => s.group === 0).map((s: any) => ({ time: s.time, event: s.event as (0 | 1) }));
    const surv1 = (g.surv as any).filter((s: any) => s.group === 1).map((s: any) => ({ time: s.time, event: s.event as (0 | 1) }));

    if (surv0.length === 0 || surv1.length === 0) {
      throw new Error(`EMPTY SURV GROUP noise=${g.noise} inflow=${g.inflow} cost=${g.cost} surv0=${surv0.length} surv1=${surv1.length}`);
    }

    // NOTE: logrank assumes independent groups; we keep it as *supplementary* output only.
    const lr = logRankTest((g.surv as any).map((s: any) => ({ time: s.time, event: s.event, group: s.group })));

    const tau = effSweep.maxTicks;
    const rmst0 = rmstKM(surv0, tau);
    const rmst1 = rmstKM(surv1, tau);
    const dRmst = rmst1 - rmst0;
    const ciRmst = bootstrapRmstDiffCI(surv0, surv1, tau, 2000);

    logrankOut.push({
      sensingNoise: g.noise,
      inflowRate: g.inflow,
      intelligenceCost: g.cost,
      nPairs,

      dMean_survivedTicks: mean(dSurv),
      ciLo_dSurv: ciSurv.lo,
      ciHi_dSurv: ciSurv.hi,

      dMean_sigmaProxyCumEnd: mean(dSigmaProxyCum),
      ciLo_dSigmaProxyCumEnd: ciSigmaProxyCum.lo,
      ciHi_dSigmaProxyCumEnd: ciSigmaProxyCum.hi,

      dMean_moveDistCumEnd: mean(dMoveDistCum),
      ciLo_dMoveDistCumEnd: ciMoveDistCum.lo,
      ciHi_dMoveDistCumEnd: ciMoveDistCum.hi,

      dMean_moveDist_window: mean(dMoveDistW),
      ciLo_dMoveDist_window: ciMoveDistW.lo,
      ciHi_dMoveDist_window: ciMoveDistW.hi,

      rmst_random: rmst0,
      rmst_informed: rmst1,
      dRmst,
      ciLo_dRmst: ciRmst.lo,
      ciHi_dRmst: ciRmst.hi,

      logrank_z: lr.z,
      logrank_pApprox: lr.pApprox,
      note_logrank: 'supplementary_only_independence_assumed',
    });

    aggRows.push([
      g.noise,
      g.inflow,
      g.cost.toFixed(6),
      nPairs,

      effSweep.costScale,
      effSweep.costStart_i,
      effSweep.costEnd_i,
      effSweep.costStep_i,

      mean(dSurv).toFixed(6),
      sd(dSurv).toFixed(6),
      ciSurv.lo.toFixed(6),
      ciSurv.hi.toFixed(6),

      mean(dSigmaProxyCum).toFixed(6),
      sd(dSigmaProxyCum).toFixed(6),
      ciSigmaProxyCum.lo.toFixed(6),
      ciSigmaProxyCum.hi.toFixed(6),

      mean(dMoveDistCum).toFixed(6),
      sd(dMoveDistCum).toFixed(6),
      ciMoveDistCum.lo.toFixed(6),
      ciMoveDistCum.hi.toFixed(6),

      mean(dMoveDistW).toFixed(6),
      sd(dMoveDistW).toFixed(6),
      ciMoveDistW.lo.toFixed(6),
      ciMoveDistW.hi.toFixed(6),

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
        'sensingNoise', 'inflowRate', 'intelligenceCost', 'nPairs',
        'costScale', 'costStart_i', 'costEnd_i', 'costStep_i',

        'dMean_survivedTicks', 'sd_dSurv', 'ciLo_dSurv', 'ciHi_dSurv',

        'dMean_sigmaProxyCumEnd', 'sd_dSigmaProxyCum', 'ciLo_dSigmaProxyCumEnd', 'ciHi_dSigmaProxyCumEnd',

        'dMean_moveDistCumEnd', 'sd_dMoveDistCum', 'ciLo_dMoveDistCumEnd', 'ciHi_dMoveDistCumEnd',
        'dMean_moveDist_window', 'sd_dMoveDistW', 'ciLo_dMoveDistW', 'ciHi_dMoveDistW',

        'rmst_random_tau', 'rmst_informed_tau', 'dRmst', 'ciLo_dRmst', 'ciHi_dRmst',

        'hedgesG_survival_ref',

        'logrank_z', 'logrank_pApprox',
      ],
      aggRows
    ),
    'utf-8'
  );

  writeFileSync(`${outDir}/logrank.json`, JSON.stringify(logrankOut, null, 2), 'utf-8');

  console.log(`Done. Wrote ${outDir}/raw.csv ${outDir}/agg.csv ${outDir}/survival.csv ${outDir}/logrank.json ${outDir}/meta.json`);
  if (snapshotSpec.enabled) console.log(`Snapshots written under ${snapshotSpec.outDir}/`);
}

// ------------------------------
// Entrypoint
// ------------------------------
if (!isMainThread && process.argv.includes('--worker')) {
  workerLoop();
} else {
  main();
}
