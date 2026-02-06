// src/simulationEngine.ts
import type { UserConfig, Mode, EngineStepStats } from './types';

type Cell = {
  x: number; y: number;
  energy: number;
  vx: number; vy: number;
};

export class SimulationEngine {
  public grid: Float32Array;
  public cells: Cell[] = [];

  private rng: () => number;
  private tick = 0;

  // --- A: "entropy" vocabulary is removed internally ---
  // We track cumulative *dissipation proxies* instead.
  private sigmaProxyCum = 0;        // cumulative sigmaProxyTotal
  private sigmaProxyDiffCum = 0;    // cumulative sigmaProxyDiff
  private sigmaProxyActCum = 0;     // cumulative sigmaProxyAct

  private outflowPhysicalCum = 0;
  private outflowNumericalCum = 0;
  private outflowActCum = 0;

  private actHeatMaintCum = 0;
  private actHeatInfoCum = 0;
  private actHeatDivCum = 0;

  // --- B: movement-distance proxy (total action amount) ---
  private moveDistCum = 0;

  private hasSpare = false;
  private spare = 0;

  // --- per-cell last-step maps for visualization ---
  private lastSigmaDiffMap: Float32Array | null = null;  // sigmaProxyDiff per cell (already /T0)
  private lastActHeatMap: Float32Array | null = null;    // act heat per cell (NOT /T0)
  private lastSigmaActMap: Float32Array | null = null;   // sigmaProxyAct per cell (already /T0)
  private lastSigmaTotalMap: Float32Array | null = null; // sigmaProxyTotal per cell

  private lastN: number | null = null;

  constructor(config: UserConfig) {
    this.grid = new Float32Array(config.gridSize * config.gridSize).fill(0);
    this.rng = this.mulberry32(config.seed);
    this.lastN = config.gridSize;
  }

  private mulberry32(a: number) {
    return () => {
      let t = (a += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  private randn() {
    if (this.hasSpare) {
      this.hasSpare = false;
      return this.spare;
    }
    let u = 0, v = 0;
    while (u === 0) u = this.rng();
    while (v === 0) v = this.rng();
    const r = Math.sqrt(-2 * Math.log(u));
    const theta = 2 * Math.PI * v;
    this.spare = r * Math.sin(theta);
    this.hasSpare = true;
    return r * Math.cos(theta);
  }

  public generateMasterState(config: UserConfig) {
    const N = config.gridSize;
    const grid = new Float32Array(N * N).fill(0);

    const cells: Cell[] = [];
    for (let i = 0; i < config.initialAgents; i++) {
      const cx = N / 2;
      const cy = N / 2;
      const spread = Math.max(1, config.initialSpread);
      const x = cx + (this.rng() - 0.5) * spread;
      const y = cy + (this.rng() - 0.5) * spread;
      cells.push({ x, y, energy: 30.0, vx: 0, vy: 0 });
    }
    return { grid, cells };
  }

  public importState(state: { grid: Float32Array; cells: Cell[] }) {
    this.grid = new Float32Array(state.grid);
    this.cells = state.cells.map(c => ({ ...c }));
    this.tick = 0;

    // reset cumulative proxies
    this.sigmaProxyCum = 0;
    this.sigmaProxyDiffCum = 0;
    this.sigmaProxyActCum = 0;

    this.outflowPhysicalCum = 0;
    this.outflowNumericalCum = 0;
    this.outflowActCum = 0;

    this.actHeatMaintCum = 0;
    this.actHeatInfoCum = 0;
    this.actHeatDivCum = 0;

    // reset movement proxy
    this.moveDistCum = 0;

    this.hasSpare = false;
    this.spare = 0;

    // reset maps
    const N = Math.round(Math.sqrt(this.grid.length));
    this.lastN = N;
    this.lastSigmaDiffMap = new Float32Array(N * N).fill(0);
    this.lastActHeatMap = new Float32Array(N * N).fill(0);
    this.lastSigmaActMap = new Float32Array(N * N).fill(0);
    this.lastSigmaTotalMap = new Float32Array(N * N).fill(0);
  }

  // --- getters for snapshot export ---
  public getSnapshot() {
    const N = this.lastN ?? Math.round(Math.sqrt(this.grid.length));
    const grid = new Float32Array(this.grid);
    const cells = this.cells.map(c => ({ ...c }));

    const sigmaDiffMap = this.lastSigmaDiffMap ? new Float32Array(this.lastSigmaDiffMap) : new Float32Array(N * N).fill(0);
    const sigmaActMap = this.lastSigmaActMap ? new Float32Array(this.lastSigmaActMap) : new Float32Array(N * N).fill(0);
    const sigmaTotalMap = this.lastSigmaTotalMap ? new Float32Array(this.lastSigmaTotalMap) : new Float32Array(N * N).fill(0);

    return { N, grid, cells, sigmaDiffMap, sigmaActMap, sigmaTotalMap };
  }

  private computeEnergyTotal() {
    let fieldEnergy = 0;
    for (let i = 0; i < this.grid.length; i++) fieldEnergy += this.grid[i];
    let cellEnergy = 0;
    for (const c of this.cells) cellEnergy += c.energy;
    return fieldEnergy + cellEnergy;
  }

  public update(config: UserConfig & { mode: Mode }): EngineStepStats {
    const N = config.gridSize;
    const T0 = Math.max(1e-9, config.bathTemp);

    // ensure maps exist
    if (!this.lastSigmaDiffMap || !this.lastActHeatMap || !this.lastSigmaActMap || !this.lastSigmaTotalMap || this.lastN !== N) {
      this.lastN = N;
      this.lastSigmaDiffMap = new Float32Array(N * N).fill(0);
      this.lastActHeatMap = new Float32Array(N * N).fill(0);
      this.lastSigmaActMap = new Float32Array(N * N).fill(0);
      this.lastSigmaTotalMap = new Float32Array(N * N).fill(0);
    }

    // clear per-step maps
    this.lastSigmaDiffMap.fill(0);
    this.lastActHeatMap.fill(0);
    this.lastSigmaActMap.fill(0);
    this.lastSigmaTotalMap.fill(0);

    const dt = config.dt ?? 1.0;
    const energyPrev = this.computeEnergyTotal();

    // resource inflow (field injection)
    const mid = Math.floor(N / 2);
    const inflow = Math.max(0, config.inflowRate) * dt;
    this.grid[mid * N + mid] += inflow;

    // diffusion step => sigmaProxyDiff, outflowPhysical, outflowNumerical
    const { sigmaProxyDiff, outflowPhysical, outflowNumerical, sigmaDiffMap } = this.diffuseOneStep(config, dt);

    // sigmaDiffMap is already /T0
    this.lastSigmaDiffMap.set(sigmaDiffMap);

    // agent step => outflowAct and its decomposition + movement proxy
    let outflowAct = 0;
    let uptake = 0;
    let infoCost = 0;
    let maintenanceCost = 0;
    let divisionCost = 0;

    let births = 0;
    let deaths = 0;

    let moveDist = 0;

    if (config.mode !== 'off') {
      const r = this.updateCells(config, dt, T0, this.lastActHeatMap);
      outflowAct = r.outflowAct;
      uptake = r.uptake;
      infoCost = r.infoCost;
      maintenanceCost = r.maintenanceCost;
      divisionCost = r.divisionCost;
      births = r.births;
      deaths = r.deaths;
      moveDist = r.moveDist;
    }

    const actHeat = outflowAct;

    const energyTotal = this.computeEnergyTotal();
    const deltaU = energyTotal - energyPrev;

    // energy residual (diagnostic only; not "entropy")
    const energyResidual = deltaU - (inflow - outflowPhysical - outflowNumerical - outflowAct);

    // --- A: define dissipation proxies (NOT thermodynamic entropy production) ---
    const sigmaProxyAct = outflowAct / T0;
    const sigmaProxyTotal = sigmaProxyDiff + sigmaProxyAct;

    // update cumulative proxies
    this.sigmaProxyDiffCum += sigmaProxyDiff;
    this.sigmaProxyActCum += sigmaProxyAct;
    this.sigmaProxyCum += sigmaProxyTotal;

    this.outflowPhysicalCum += outflowPhysical;
    this.outflowNumericalCum += outflowNumerical;
    this.outflowActCum += outflowAct;

    this.actHeatMaintCum += maintenanceCost;
    this.actHeatInfoCum += infoCost;
    this.actHeatDivCum += divisionCost;

    // --- B: movement proxy cumulative ---
    this.moveDistCum += moveDist;

    const efficiency = uptake / (infoCost + maintenanceCost + 1e-9);

    // build sigmaActMap, sigmaTotalMap
    for (let i = 0; i < this.lastActHeatMap.length; i++) {
      const sAct = this.lastActHeatMap[i] / T0;
      this.lastSigmaActMap[i] = sAct;
      this.lastSigmaTotalMap[i] = this.lastSigmaDiffMap[i] + sAct;
    }

    // robust finite checks
    if (
      !Number.isFinite(energyTotal) ||
      !Number.isFinite(deltaU) ||
      !Number.isFinite(energyResidual) ||
      !Number.isFinite(sigmaProxyDiff) ||
      !Number.isFinite(sigmaProxyAct) ||
      !Number.isFinite(sigmaProxyTotal) ||
      !Number.isFinite(this.sigmaProxyCum) ||
      !Number.isFinite(outflowPhysical) ||
      !Number.isFinite(outflowNumerical) ||
      !Number.isFinite(outflowAct) ||
      !Number.isFinite(uptake) ||
      !Number.isFinite(infoCost) ||
      !Number.isFinite(maintenanceCost) ||
      !Number.isFinite(divisionCost) ||
      !Number.isFinite(efficiency) ||
      !Number.isFinite(moveDist) ||
      !Number.isFinite(this.moveDistCum)
    ) {
      throw new Error(
        `NaN/Inf detected (tick=${this.tick}) ` +
        `Uprev=${energyPrev} U=${energyTotal} dU=${deltaU} res=${energyResidual} ` +
        `Qin=${inflow} Qphys=${outflowPhysical} Qnum=${outflowNumerical} Qact=${outflowAct} ` +
        `sigmaDiff=${sigmaProxyDiff} sigmaAct=${sigmaProxyAct} sigmaTotal=${sigmaProxyTotal} ` +
        `uptake=${uptake} info=${infoCost} maint=${maintenanceCost} div=${divisionCost} eff=${efficiency} ` +
        `moveDist=${moveDist} moveDistCum=${this.moveDistCum}`
      );
    }

    // NOTE: keep legacy-named fields in EngineStepStats for compatibility,
    // but they now mean "proxy" and are explicitly labeled in names below.
    const stats: EngineStepStats = {
      tick: this.tick,

      inflow,
      outflowPhysical,
      outflowNumerical,
      outflowAct,

      energyPrev,
      energyTotal,
      deltaU,
      energyResidual,

      actHeat,

      // --- A: proxy fields (use these in analysis/plots/paper) ---
      sigmaProxyDiff,
      sigmaProxyAct,
      sigmaProxyTotal,
      sigmaProxyCumulative: this.sigmaProxyCum,
      sigmaProxyDiffCumulative: this.sigmaProxyDiffCum,
      sigmaProxyActCumulative: this.sigmaProxyActCum,

      // --- B: movement proxy (primary when used) ---
      moveDist,
      moveDistCumulative: this.moveDistCum,

      // diagnostics / decomposition
      actHeatMaintenance: maintenanceCost,
      actHeatInfo: infoCost,
      actHeatDivision: divisionCost,

      outflowPhysicalCumulative: this.outflowPhysicalCum,
      outflowNumericalCumulative: this.outflowNumericalCum,
      outflowActCumulative: this.outflowActCum,

      actHeatMaintenanceCumulative: this.actHeatMaintCum,
      actHeatInfoCumulative: this.actHeatInfoCum,
      actHeatDivisionCumulative: this.actHeatDivCum,

      uptake,

      infoCost,
      controlCost: infoCost,
      maintenanceCost,
      divisionCost,

      births,
      deaths,

      efficiency,
      agentCount: this.cells.length,

      // legacy / compatibility fields (deprecated)
      // These remain finite but should not be used as "thermodynamic entropy".
      entropyFlow: 0,
      entropyProd: 0,
      entropyChange: 0,
      entropyFlowCumulative: 0,
      entropyProdCumulative: 0,
      entropyChangeCumulative: 0,

      sigmaDiff: sigmaProxyDiff,          // deprecated alias
      sigmaAct: sigmaProxyAct,            // deprecated alias
      sigmaOut: 0,                        // deprecated
      sigmaTotal: sigmaProxyTotal,        // deprecated alias
      sigmaCumulative: this.sigmaProxyCum, // deprecated alias

      deltaHeat: outflowAct + outflowPhysical,
      externalEntropy: 0,
      internalEntropy: 0,
      totalEntropy: 0,
    };

    this.tick++;
    return stats;
  }

  private diffuseOneStep(config: UserConfig, dt: number) {
    const N = config.gridSize;
    const T0 = Math.max(1e-9, config.bathTemp);
    const kappa = Math.max(0, config.diffusionKappa);

    const alpha = kappa * dt;
    if (alpha > 0.25) {
      throw new Error(`Unstable diffusion: kappa*dt=${alpha} > 0.25 (reduce kappa or dt)`);
    }

    const next = new Float32Array(this.grid);
    let sigmaProxyDiff = 0;

    // per-cell sigmaDiff map (already /T0 units)
    const sigmaDiffMap = new Float32Array(N * N).fill(0);

    // edge-based updates: split contribution between the two cells
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = x + y * N;
        const u = this.grid[i];

        if (x + 1 < N) {
          const j = (x + 1) + y * N;
          const v = this.grid[j];
          const du = u - v;

          const flow = alpha * du;
          next[i] -= flow;
          next[j] += flow;

          // proxy dissipation for diffusion step (non-negative by construction)
          const contrib = (kappa * du * du * dt) / T0;
          sigmaProxyDiff += contrib;
          sigmaDiffMap[i] += 0.5 * contrib;
          sigmaDiffMap[j] += 0.5 * contrib;
        }

        if (y + 1 < N) {
          const j = x + (y + 1) * N;
          const v = this.grid[j];
          const du = u - v;

          const flow = alpha * du;
          next[i] -= flow;
          next[j] += flow;

          const contrib = (kappa * du * du * dt) / T0;
          sigmaProxyDiff += contrib;
          sigmaDiffMap[i] += 0.5 * contrib;
          sigmaDiffMap[j] += 0.5 * contrib;
        }
      }
    }

    // numerical clipping (diagnostic; not physical)
    let outflowNumerical = 0;
    for (let i = 0; i < next.length; i++) {
      if (next[i] < 0) {
        outflowNumerical += -next[i];
        next[i] = 0;
      }
    }

    // boundary handling
    let outflowPhysical = 0;
    if (config.boundary === 'isothermal') {
      for (let x = 0; x < N; x++) {
        const top = x;
        const bot = x + (N - 1) * N;
        outflowPhysical += next[top];
        outflowPhysical += next[bot];
        next[top] = 0;
        next[bot] = 0;
      }
      for (let y = 1; y < N - 1; y++) {
        const left = y * N;
        const right = (N - 1) + y * N;
        outflowPhysical += next[left];
        outflowPhysical += next[right];
        next[left] = 0;
        next[right] = 0;
      }
    } else if (config.boundary === 'open') {
      // open: keep as-is
    } else if (config.boundary === 'reflect') {
      // reflect: keep as-is
    }

    this.grid = next;
    return { sigmaProxyDiff, outflowPhysical, outflowNumerical, sigmaDiffMap };
  }

  private updateCells(
    config: UserConfig & { mode: Mode },
    dt: number,
    T0: number,
    actHeatMap: Float32Array
  ) {
    const N = config.gridSize;

    const friction = config.friction ?? 0.6;
    const damping = (friction > 0 && friction < 1) ? Math.pow(friction, dt) : friction;

    const lookDist = Math.max(1, Math.floor(config.lookDist));
    const sensingNoise = Math.max(0, config.sensingNoise ?? 0);
    const clampSensing = config.clampSensing ?? false;

    const uptakeRate = Math.max(0, config.consumptionRate);
    const infoCostRate = Math.max(0, config.intelligenceCost);

    const divisionThreshold = Math.max(0, config.divisionThreshold ?? Infinity);
    const divisionCost = Math.max(0, config.divisionCost ?? 0);
    const divisionJitter = Math.max(0, config.divisionJitter ?? 0.25);
    const maxAgents = Math.max(1, Math.floor(config.maxAgents ?? 1e9));

    const sense = (val: number) => {
      const noisy = val + sensingNoise * this.randn();
      return clampSensing ? Math.max(0, noisy) : noisy;
    };

    const clampPos = (p: number) => Math.min(Math.max(p, 0), N - 1e-6);

    const nextCells: Cell[] = [];
    let outflowAct = 0;

    let uptakeTotal = 0;
    let infoCostTotal = 0;
    let maintenanceTotal = 0;
    let divisionTotal = 0;

    let births = 0;
    let deaths = 0;

    // --- movement proxy (sum of Euclidean step distances over surviving agents, per tick) ---
    let moveDist = 0;

    const baseMaintenance = 0.2;

    const addActHeatAtCell = (ix: number, iy: number, heat: number) => {
      const x = Math.min(Math.max(ix, 0), N - 1);
      const y = Math.min(Math.max(iy, 0), N - 1);
      actHeatMap[x + y * N] += heat; // NOT divided by T0 here
    };

    for (const c of this.cells) {
      c.x = clampPos(c.x);
      c.y = clampPos(c.y);

      const ix = Math.floor(c.x);
      const iy = Math.floor(c.y);
      const gi = ix + iy * N;

      // uptake
      const available = this.grid[gi];
      const uptake = Math.min(available, uptakeRate * dt);
      this.grid[gi] -= uptake;
      c.energy += uptake;
      uptakeTotal += uptake;

      // maintenance cost => heat
      const maintenance = baseMaintenance * dt;
      c.energy -= maintenance;
      outflowAct += maintenance;
      maintenanceTotal += maintenance;
      addActHeatAtCell(ix, iy, maintenance);

      if (config.mode === 'informed') {
        const upY = Math.max(0, iy - lookDist);
        const dnY = Math.min(N - 1, iy + lookDist);
        const lfX = Math.max(0, ix - lookDist);
        const rtX = Math.min(N - 1, ix + lookDist);

        const eUp = sense(this.grid[ix + upY * N]);
        const eDn = sense(this.grid[ix + dnY * N]);
        const eLf = sense(this.grid[lfX + iy * N]);
        const eRt = sense(this.grid[rtX + iy * N]);

        const gx = (eRt - eLf);
        const gy = (eDn - eUp);

        const alpha = 0.5;
        c.vx += alpha * gx * dt;
        c.vy += alpha * gy * dt;

        const variableCost = (Math.abs(gx) + Math.abs(gy)) * infoCostRate * dt;
        const fixedCost = (infoCostRate * 0.2) * dt;

        const cost = Math.max(0, variableCost + fixedCost);
        c.energy -= cost;
        outflowAct += cost;
        infoCostTotal += cost;
        addActHeatAtCell(ix, iy, cost);
      } else if (config.mode === 'random') {
        const drift = 0.4;
        c.vx += (this.rng() - 0.5) * drift * Math.sqrt(dt);
        c.vy += (this.rng() - 0.5) * drift * Math.sqrt(dt);
      }

      // movement (track pre/post for moveDist)
      const x0 = c.x;
      const y0 = c.y;

      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.vx *= damping;
      c.vy *= damping;

      c.x = clampPos(c.x);
      c.y = clampPos(c.y);

      const dx = c.x - x0;
      const dy = c.y - y0;
      // Always non-negative; includes boundary clamping effects.
      moveDist += Math.sqrt(dx * dx + dy * dy);

      if (c.energy <= 0) {
        deaths += 1;
        continue;
      }

      // division
      if (c.energy >= divisionThreshold && nextCells.length + 2 <= maxAgents) {
        const eAfter = c.energy - divisionCost;

        if (eAfter <= 0) {
          const paid = Math.min(divisionCost, c.energy);
          outflowAct += paid;
          divisionTotal += paid;
          addActHeatAtCell(ix, iy, paid);

          deaths += 1;
          continue;
        }

        outflowAct += divisionCost;
        divisionTotal += divisionCost;
        addActHeatAtCell(ix, iy, divisionCost);

        const eChild = eAfter / 2;

        const jx = (this.rng() - 0.5) * 2 * divisionJitter;
        const jy = (this.rng() - 0.5) * 2 * divisionJitter;

        const a: Cell = {
          x: clampPos(c.x + jx),
          y: clampPos(c.y + jy),
          energy: eChild,
          vx: c.vx,
          vy: c.vy,
        };

        const b: Cell = {
          x: clampPos(c.x - jx),
          y: clampPos(c.y - jy),
          energy: eChild,
          vx: -c.vx,
          vy: -c.vy,
        };

        nextCells.push(a, b);

        births += 1;
        continue;
      }

      nextCells.push(c);
    }

    this.cells = nextCells;

    return {
      outflowAct,
      uptake: uptakeTotal,
      infoCost: infoCostTotal,
      maintenanceCost: maintenanceTotal,
      divisionCost: divisionTotal,
      births,
      deaths,
      moveDist,
    };
  }
}
