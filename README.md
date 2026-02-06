# Regime Mapping of MEP-like Dissipation–Persistence Relations in an Information-Using ABM

This repository contains the full simulation code, data-generation commands, analysis scripts, and figure-generation pipelines used in the paper:

> Akihiko Itaya,  
> *Regime Mapping of MEP-like Dissipation–Persistence Relations in an Information-Using Artificial Life ABM with Information Cost*  
> (submitted to Complex Systems)

The project provides a fully reproducible pipeline from simulation runs to aggregated statistics, boundary estimation, and final figures.

---

## Requirements

### Runtime
- Node.js >= 18  
- npm  
- Python >= 3.10  

### Python packages
Create a virtual environment (optional) and install:
```bash
pip install numpy pandas matplotlib
```

---

## Installation
```bash
npm install
```

---
## Project structure
```
.
├── paper/        # LaTeX source and PDF of the manuscript
├── results/      # Output directories (fig1, fig4, ...; each contains raw.csv, agg.csv, survival.csv, logrank.json, meta.json)
├── scripts/      # Python scripts for figure generation and boundary estimation
├── src/          # TypeScript simulation code
├── package.json
├── package-lock.json
├── README.md
└── tsconfig.json
```

## Reproducing the simulation data

### Entry points

The two experiment entry points are:
- `npm run exp`   — σ-proxy experiments (via `src/runner.ts`)
- `npm run expAE` — AE proxy experiments (via `src/runnerAE.ts`)

All experiments use a paired design (random vs informed strategies) with fixed seeds.

### Fig.1 (global inflow scan; σ-proxy vs RMST)
```bash
npm run exp -- --outDir results/fig1 --seedBase 1000 --seeds 50 --maxAgents 1000 --noise 0 --inflowStart 0 --inflowEnd 0.172 --inflowStep 0.002
```

### Fig.2–3 (AE proxy)
```bash
npm run expAE -- --outDir results/fig23 --seedBase 1000 --seeds 50 --maxAgents 1000 --noise 0 --inflowStart 0.0 --inflowEnd 0.172 --inflowStep 0.002
```

### Fig.4 (Boundary A close-ups)
```bash
npm run exp   -- --outDir results/fig4 --seedBase 1000 --seeds 50 --maxAgents 1000 --noise 0 --inflowStart 0.006 --inflowEnd 0.014 --inflowStep 0.0002
```

### Fig.5 (Boundary A close-ups, AE proxy)
```bash
npm run expAE -- --outDir results/fig5 --seedBase 1000 --seeds 50 --maxAgents 1000 --noise 0 --inflowStart 0.006 --inflowEnd 0.014 --inflowStep 0.0002
```

### Fig.6 (Boundary B close-up)
```bash
npm run exp -- --outDir results/fig6 --seedBase 1000 --seeds 50 --maxAgents 1000 --noise 0 --inflowStart 0.08 --inflowEnd 0.11 --inflowStep 0.002
```

### Fig.7 (Boundary C close-up)
```bash
npm run exp -- --outDir results/fig7 --seedBase 1000 --seeds 50 --maxAgents 1000 --noise 0 --inflowStart 0.085 --inflowEnd 0.17 --inflowStep 0.005
```

### Fig.8 (robustness across cost)
```bash
npm run exp -- --outDir results/fig8 --seedBase 1000 --seeds 50 --maxAgents 1000 --noise 0 --costStart_i 0 --costEnd_i 300 --costStep_i 50 --inflowStart 0.0 --inflowEnd 0.2 --inflowStep 0.005
```

### Fig.9 (robustness across noise)
```bash
npm run exp -- --outDir results/fig9 --seedBase 1000 --seeds 50 --maxAgents 1000 --inflowStart 0.0 --inflowEnd 0.2 --inflowStep 0.005 --noiseList 0.0,0.02,0.04,0.06,0.08,0.1
```

**Notes:**
- All runs use fixed seeds (`seedBase=1000`, `seeds=50`) for paired comparisons.  
- If both `--noise` and `--noiseList` are provided, `--noiseList` takes precedence.

---

## Outputs

Each run writes the following files to the specified output directory (e.g., `results/fig1/`):

- `raw.csv`      : per-run raw outputs  
- `agg.csv`      : aggregated statistics (means, 95% CI) used for figures  
- `survival.csv` : survival tables used for RMST  
- `logrank.json` : supplementary log-rank test results (descriptive only)  
- `meta.json`    : full run configuration and metadata


The `meta.json` file records:
- full CLI command,  
- effective parameters and sweep ranges,  
- seed list,  
- runtime environment (Node/platform),  

providing an auditable record for exact reproduction.

---
### logrank.json (supplementary)

Each run additionally outputs `logrank.json`, which contains the results of a log-rank test comparing the survival curves
of the informed and random strategies.

**Fields:**
- `logrank_z`: Z-statistic of the log-rank test
- `logrank_pApprox`: approximate p-value
- `note_logrank`: notes on assumptions (e.g., independence)

**Interpretation and limitations:**
The log-rank test is reported as a supplementary descriptive statistic to indicate whether the two survival curves
(informed vs random) are distinguishable over the full time horizon.  
Because the experiments use a paired design with shared environmental stochasticity (matched seeds), the independence
assumption of the standard log-rank test is not strictly satisfied. Therefore, log-rank results should be interpreted
qualitatively and not as primary inferential evidence.

In the main analysis and figures, we rely on paired differences in RMST (ΔRMST) with bootstrap confidence intervals
as the primary measure of persistence advantage. The log-rank statistics are provided for transparency and exploratory
comparison with conventional survival-analysis practice.


## Reproducing the figures

```bash
python scripts/make_fig1.py
python scripts/make_fig23.py
python scripts/make_fig4.py
python scripts/make_fig5.py
python scripts/make_fig6.py
python scripts/make_fig7.py
python scripts/make_fig8.py
python scripts/make_fig9.py
```

All figures (Fig.1–Fig.9) are generated directly from `results/fig*/agg.csv`
(the aggregated summary CSV in each output directory).

Note: the Python scripts write figure files to the current working directory from which they are executed.


**Scaling note:**  
Some figures apply vertical scaling for visual alignment only (e.g., ×200 for Δσ-CumEnd in Fig.1, ×20 for ΔAE in Fig.3).  
Scaling does not affect sign or boundary inference.

---

## Boundary (zero-crossing) estimation

Boundary estimates (zero-crossings of Δσ-CumEnd and ΔRMST) are computed by:

```bash
python scripts/zero_crossings_sigmaCumEnd_RMST.py
```

Zero-crossings are estimated by sign-change detection with linear interpolation between adjacent inflow grid points.

**Notes:**
- Fig.6 reports the first zero-crossing.  
- Fig.7 reports the right-most zero-crossing by design.

---

## CLI help

```bash
npm run exp -- --help
npm run expAE -- --help
```

---

## Reproducibility and transparency

This project is designed for full reproducibility:
- fixed seeds,  
- machine-readable metadata (`meta.json`) for every run,  
- scripts to regenerate all figures and boundary estimates.

All responsibility for modeling assumptions and interpretation rests with the author.  
AI tools were used to assist development; see the manuscript for disclosure.

---

## License
MIT License (or replace with your preferred license).
