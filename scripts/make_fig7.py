# make_fig7_separate_annotated_right_crossing.py
# Input : agg.csv
# Output: fig7a_dSigmaCumEnd.(png/pdf), fig7b_dRMST.(png/pdf)
# 仕様: Δσ-CumEnd の「右側 0-crossing（≈0.15付近）」を縦破線＋数値注記

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

AGG_PATH = "../results/fig7/agg.csv"   # 例: ../results/fig23/agg.csv
DPI = 300
XMIN, XMAX = 0.095, 0.17   # Figure7 close-up range

def last_zero_crossing(x, y):
    """右側（最後）の符号反転点を線形補間で返す。無ければ None."""
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    zc = None
    for i in range(len(y) - 1):
        yi, yj = y[i], y[i + 1]
        xi, xj = x[i], x[i + 1]
        if yi == 0:
            zc = float(xi)
        elif yi * yj < 0:
            zc = float(xi + (xj - xi) * (-yi) / (yj - yi))
    return zc

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
zc_sig_right = last_zero_crossing(x, sig)

fig, ax = plt.subplots(figsize=(6.5, 4.2))
ax.fill_between(x, sig_lo, sig_hi, alpha=0.25, color="orange", label="95% CI")
ax.plot(x, sig, "-o", ms=2.0, lw=1.0, color="orange", label="Δσ-CumEnd")
ax.axhline(0.0, color="red", lw=1.2, zorder=0)
if zc_sig_right is not None:
    ax.axvline(zc_sig_right, ls="--", lw=1.0, color="orange")
    ax.text(zc_sig_right, ax.get_ylim()[1], f"  right 0-crossing ≈ {zc_sig_right:.4f}",
            va="top", ha="left", fontsize=9, color="orange")
ax.set_xlabel("inflow")
ax.set_ylabel("Δσ-CumEnd")
ax.legend(frameon=False, loc="upper left")
plt.tight_layout()
plt.savefig("fig7a.png", dpi=DPI)
plt.savefig("fig7a.pdf")
plt.close(fig)

# ---- (b) ΔRMST（そのまま。右側 0-crossing が無ければ破線なし） ----
rmst = d["dRmst"].to_numpy(dtype=float)
rmst_lo = d["ciLo_dRmst"].to_numpy(dtype=float)
rmst_hi = d["ciHi_dRmst"].to_numpy(dtype=float)

fig, ax = plt.subplots(figsize=(6.5, 4.2))
ax.fill_between(x, rmst_lo, rmst_hi, alpha=0.25, color="C0", label="95% CI")
ax.plot(x, rmst, "-o", ms=2.0, lw=1.0, color="C0", label="ΔRMST")
ax.axhline(0.0, color="red", lw=1.2, zorder=0)
ax.set_xlabel("inflow")
ax.set_ylabel("ΔRMST")
ax.legend(frameon=False, loc="upper left")
plt.tight_layout()
plt.savefig("fig7b.png", dpi=DPI)
plt.savefig("fig7b.pdf")
plt.close(fig)

print("Saved: fig7a.(png/pdf), fig7b.(png/pdf)")
print(f"Selected slice: sensingNoise={noise0}, intelligenceCost={cost0}")
print(f"Right-side 0-crossing Δσ-CumEnd: {zc_sig_right}")
