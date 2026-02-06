// src/types.ts AE version

// ------------------------------
// Core types
// ------------------------------
export type BoundaryMode = 'isothermal' | 'open' | 'reflect';

// runner / engine が想定している Mode
export type Mode = 'off' | 'random' | 'informed';

export interface UserConfig {
  // field / world
  gridSize: number;
  diffusionKappa: number;
  bathTemp: number;
  boundary: BoundaryMode;

  // environment
  inflowRate: number;

  // agents
  consumptionRate: number;
  initialAgents: number;
  initialSpread: number;
  seed: number;

  // sensing / control
  intelligenceCost: number;
  lookDist: number;
  sensingNoise?: number;
  clampSensing?: boolean;

  // population dynamics
  divisionThreshold?: number;
  divisionCost?: number;
  divisionJitter?: number;
  maxAgents?: number;

  // physics-ish
  friction?: number;
  dt?: number;
}

// ------------------------------
// EngineStepStats
// (simulationEngine.ts が返すものを完全列挙)
// ------------------------------
export interface EngineStepStats {
  // time
  tick: number;

  // flows (per tick)
  inflow: number;
  outflowPhysical: number;
  outflowNumerical: number;
  outflowAct: number;

  // energies (diagnostics)
  energyPrev: number;
  energyTotal: number;
  deltaU: number;
  energyResidual: number;

  // heat (per tick)
  actHeat: number;

  // --- A: dissipation proxies (primary) ---
  sigmaProxyDiff: number;
  sigmaProxyAct: number;
  sigmaProxyTotal: number;

  sigmaProxyCumulative: number;
  sigmaProxyDiffCumulative: number;
  sigmaProxyActCumulative: number;

  // decomposition (per tick)
  actHeatMaintenance: number;
  actHeatInfo: number;
  actHeatDivision: number;

  // cumulative decomposition
  outflowPhysicalCumulative: number;
  outflowNumericalCumulative: number;
  outflowActCumulative: number;

  actHeatMaintenanceCumulative: number;
  actHeatInfoCumulative: number;
  actHeatDivisionCumulative: number;

  // uptake / costs (per tick)
  uptake: number;

  infoCost: number;
  controlCost: number;       // alias (runner uses infoCost primarily)
  maintenanceCost: number;
  divisionCost: number;

  // --- NEW: alternative proxy (per tick) ---
  agentExpenditure: number;  // maintenanceCost + infoCost + divisionCost

  // demographics (per tick)
  births: number;
  deaths: number;

  // summary
  efficiency: number;
  agentCount: number;

  // ------------------------------
  // Deprecated legacy fields kept for backward compatibility.
  // These MUST NOT be interpreted as thermodynamic entropy.
  // ------------------------------
  /** @deprecated */
  entropyFlow: number;
  /** @deprecated */
  entropyProd: number;
  /** @deprecated */
  entropyChange: number;
  /** @deprecated */
  entropyFlowCumulative: number;
  /** @deprecated */
  entropyProdCumulative: number;
  /** @deprecated */
  entropyChangeCumulative: number;

  /** @deprecated */
  sigmaDiff: number;       // alias of sigmaProxyDiff
  /** @deprecated */
  sigmaAct: number;        // alias of sigmaProxyAct
  /** @deprecated */
  sigmaOut: number;        // unused (kept as 0)
  /** @deprecated */
  sigmaTotal: number;      // alias of sigmaProxyTotal
  /** @deprecated */
  sigmaCumulative: number; // alias of sigmaProxyCumulative

  /** @deprecated */
  deltaHeat: number;
  /** @deprecated */
  externalEntropy: number;
  /** @deprecated */
  internalEntropy: number;
  /** @deprecated */
  totalEntropy: number;
}
