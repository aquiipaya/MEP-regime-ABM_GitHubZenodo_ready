# make_fig6_separate_annotated.py
# Input : agg.csv
# Output: fig6a_dSigmaCumEnd.png/.pdf , fig6b_dRMST.png/.pdf
# 注記：0-crossing の値をグラフ内に表示

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

AGG_PATH = "../results/fig6/agg.csv"   # 必要なら ../results/fig23/agg.csv などに変更
DPI = 300
XMIN, XMAX = 0.088, 0.102  # Figure6 close-up range

def first_zero_crossing(x, y):
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    for i in range(len(y)-1):
        yi, yj = y[i], y[i+1]
        xi, xj = x[i], x[i+1]
        if yi == 0:
            return float(xi)
        if yi * yj < 0:
            return float(xi + (xj - xi) * (-yi) / (yj - yi))
    return None

# ---- load & select dominant slice ----
df = pd.read_csv(AGG_PATH).sort_values(["sensingNoise","intelligenceCost","inflowRate"])
noise0, cost0 = df.groupby(["sensingNoise","intelligenceCost"]).size().sort_values(ascending=False).index[0]
d0 = df[(df["sensingNoise"]==noise0) & (df["intelligenceCost"]==cost0)].sort_values("inflowRate")

# close-up
d = d0[(d0["inflowRate"]>=XMIN) & (d0["inflowRate"]<=XMAX)].copy()
x = d["inflowRate"].to_numpy(dtype=float)

# ---- (a) Δσ-CumEnd ----
sig = d["dMean_sigmaProxyCumEnd"].to_numpy(dtype=float)
sig_lo = d["ciLo_dSigmaProxyCumEnd"].to_numpy(dtype=float)
sig_hi = d["ciHi_dSigmaProxyCumEnd"].to_numpy(dtype=float)
zc_sig = first_zero_crossing(x, sig)

fig, ax = plt.subplots(figsize=(6.5, 4.2))
ax.fill_between(x, sig_lo, sig_hi, alpha=0.25, color="orange", label="95% CI")
ax.plot(x, sig, "-o", ms=2.0, lw=1.0, color="orange", label="Δσ-CumEnd")
ax.axhline(0.0, color="red", lw=1.2, zorder=0)
if zc_sig is not None:
    ax.axvline(zc_sig, ls="--", lw=1.0, color="orange")
    ax.text(zc_sig, ax.get_ylim()[1], f"  zero-crossing ≈ {zc_sig:.4f}",
            va="top", ha="left", fontsize=9, color="orange")
ax.set_xlabel("inflow")
ax.set_ylabel("Δσ-CumEnd")
ax.legend(frameon=False, loc="upper left")
plt.tight_layout()
plt.savefig("fig6a.png", dpi=DPI)
plt.savefig("fig6a.pdf")
plt.close(fig)

# ---- (b) ΔRMST ----
rmst = d["dRmst"].to_numpy(dtype=float)
rmst_lo = d["ciLo_dRmst"].to_numpy(dtype=float)
rmst_hi = d["ciHi_dRmst"].to_numpy(dtype=float)
zc_rmst = first_zero_crossing(x, rmst)

fig, ax = plt.subplots(figsize=(6.5, 4.2))
ax.fill_between(x, rmst_lo, rmst_hi, alpha=0.25, color="C0", label="95% CI")
ax.plot(x, rmst, "-o", ms=2.0, lw=1.0, color="C0", label="ΔRMST")
ax.axhline(0.0, color="red", lw=1.2, zorder=0)
if zc_rmst is not None:
    ax.axvline(zc_rmst, ls="--", lw=1.0, color="C0")
    ax.text(zc_rmst, ax.get_ylim()[1], f"  zero-crossing ≈ {zc_rmst:.4f}",
            va="top", ha="left", fontsize=9, color="C0")
ax.set_xlabel("inflow")
ax.set_ylabel("ΔRMST")
ax.legend(frameon=False, loc="upper left")
plt.tight_layout()
plt.savefig("fig6b.png", dpi=DPI)
plt.savefig("fig6b.pdf")
plt.close(fig)

print("Saved: fig6a.(png/pdf), fig6b.(png/pdf)")
print(f"Selected slice: sensingNoise={noise0}, intelligenceCost={cost0}")
print(f"Zero-crossing Δσ-CumEnd: {zc_sig}")
print(f"Zero-crossing ΔRMST    : {zc_rmst}")
