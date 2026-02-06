# make_fig5_dAE_closeup_vline.py
# Input : raw.csv（同じフォルダに置く想定）
# Output: fig5_dAE_closeup_vline.png / .pdf
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt

RAW_PATH = "../results/fig5/raw.csv"
DPI = 300
B = 2000
ALPHA = 0.05

# close-up range (Figure5)
XMIN, XMAX = 0.006, 0.014

raw = pd.read_csv(RAW_PATH)

# ΔAE = (maint + info + div) cumulative
raw["AE_cum"] = raw["actHeatMaintCum"] + raw["actHeatInfoCum"] + raw["actHeatDivCum"]

# pick dominant settings (most frequent combo)
key_cols = ["intelligenceCost", "sensingNoise", "maxAgents"]
ic0, noise0, maxA0 = raw.groupby(key_cols).size().sort_values(ascending=False).index[0]
f = raw[(raw["intelligenceCost"] == ic0) &
        (raw["sensingNoise"] == noise0) &
        (raw["maxAgents"] == maxA0)].copy()

# pair informed vs random by (inflowRate, seed)
pv = f.pivot_table(index=["inflowRate", "seed"], columns="mode", values="AE_cum", aggfunc="first")
pv = pv.dropna(subset=["informed", "random"])
pv["dAE"] = pv["informed"] - pv["random"]

p2 = pv.reset_index()
p2 = p2[(p2["inflowRate"] >= XMIN) & (p2["inflowRate"] <= XMAX)]

def bootstrap_ci(vals, B=2000, alpha=0.05, seed=0):
    rng = np.random.default_rng(seed)
    vals = np.asarray(vals, dtype=float)
    n = len(vals)
    boot = np.empty(B)
    for b in range(B):
        boot[b] = rng.choice(vals, size=n, replace=True).mean()
    lo = np.quantile(boot, alpha/2)
    hi = np.quantile(boot, 1 - alpha/2)
    return vals.mean(), lo, hi

rows = []
for inflow, grp in p2.groupby("inflowRate"):
    vals = grp["dAE"].to_numpy()
    mean, lo, hi = bootstrap_ci(vals, B=B, alpha=ALPHA, seed=0)
    rows.append((inflow, len(vals), mean, lo, hi))

ae = pd.DataFrame(rows, columns=["inflowRate", "nPairs", "dAE_mean", "dAE_ciLo", "dAE_ciHi"]).sort_values("inflowRate")

x = ae["inflowRate"].to_numpy()
y = ae["dAE_mean"].to_numpy()
ylo = ae["dAE_ciLo"].to_numpy()
yhi = ae["dAE_ciHi"].to_numpy()

# 0-crossing (first sign change) via linear interpolation
zc = None
for i in range(len(y) - 1):
    yi, yj = y[i], y[i + 1]
    xi, xj = x[i], x[i + 1]
    if yi == 0:
        zc = float(xi)
        break
    if yi * yj < 0:
        zc = float(xi + (xj - xi) * (-yi) / (yj - yi))
        break

fig, ax = plt.subplots(figsize=(7.0, 4.5))
ax.fill_between(x, ylo, yhi, alpha=0.25, color="orange", label="95% CI (ΔAE)")
ax.plot(x, y, "-o", ms=2.0, lw=1.0, color="orange", label="ΔAE")

ax.axhline(0.0, color="red", lw=1.2, zorder=0)

if zc is not None:
    ax.axvline(zc, ls="--", lw=1.0, color="orange")
    ax.text(zc, ax.get_ylim()[1], f"  zero-crossing ≈ {zc:.4f}",
            va="top", ha="left", fontsize=9, color="orange")

ax.set_xlabel("inflow")
ax.set_ylabel("ΔAE (CumEnd)")
ax.legend(frameon=False, loc="upper left")
plt.tight_layout()

plt.savefig("fig5_dAE_closeup_vline.png", dpi=DPI)
plt.savefig("fig5_dAE_closeup_vline.pdf")
plt.close(fig)

print("Saved: fig5_dAE_closeup_vline.png / fig5_dAE_closeup_vline.pdf")
print(f"zero-crossing ≈ {zc}")
print(f"Used settings: intelligenceCost={ic0}, sensingNoise={noise0}, maxAgents={maxA0}")
