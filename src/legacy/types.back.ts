// src/types.ts
export type Mode = 'off' | 'random' | 'informed';

export type Boundary = 'isothermal' | 'open' | 'reflect';

export interface UserConfig {
  gridSize: number;

  diffusionKappa: number;
  bathTemp: number;
  inflowRate: number;
  boundary: Boundary;

  consumptionRate: number;
  initialAgents: number;
  initialSpread: number;
  seed: number;

  intelligenceCost: number;
  lookDist: number;

  sensingNoise?: number;
  clampSensing?: boolean;

  friction?: number;
  dt?: number;

  divisionThreshold?: number;
  divisionCost?: number;
  divisionJitter?: number;
  maxAgents?: number;
}

export interface EngineStepStats {
  tick: number;

  inflow: number;
  outflowPhysical: number;
  outflowNumerical: number;
  outflowAct: number;

  energyPrev: number;
  energyTotal: number;
  deltaU: number;
  energyResidual: number;

  actHeat: number;

  entropyFlow: number;
  entropyProd: number;
  entropyChange: number;

  entropyFlowCumulative: number;
  entropyProdCumulative: number;
  entropyChangeCumulative: number;

  sigmaDiff: number;
  sigmaAct: number;
  sigmaOut: number;
  sigmaTotal: number;
  sigmaCumulative: number;

  uptake: number;

  infoCost: number;
  controlCost: number;

  maintenanceCost: number;

  births: number;
  deaths: number;

  efficiency: number;

  agentCount: number;

  deltaHeat: number;
  externalEntropy: number;
  internalEntropy: number;
  totalEntropy: number;
}
