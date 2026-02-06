# make_overlay_with_crossings_estimated.py
# 出力: overlay_with_crossings_estimated.pdf / .png(300dpi)
import pandas as pd
import matplotlib.pyplot as plt

# ===== settings =====
AGG_CSV = "../results/fig1/agg.csv"   # 同じフォルダに置く
SCALE_SIGMA = 200.0   # Δσ-CumEnd を縦方向に200倍
DPI = 300
VLINES = [0.0103, 0.0925, 0.1466]  # 推定0-crossing（縦破線）
# ====================

df = pd.read_csv(AGG_CSV).sort_values("inflowRate")

x = df["inflowRate"].to_numpy()

# Δσ-CumEnd (mean & 95% CI)  ※×200
sig = df["dMean_sigmaProxyCumEnd"].to_numpy() * SCALE_SIGMA
sig_lo = df["ciLo_dSigmaProxyCumEnd"].to_numpy() * SCALE_SIGMA
sig_hi = df["ciHi_dSigmaProxyCumEnd"].to_numpy() * SCALE_SIGMA

# ΔRMST (mean & 95% CI)
rmst = df["dRmst"].to_numpy()
rmst_lo = df["ciLo_dRmst"].to_numpy()
rmst_hi = df["ciHi_dRmst"].to_numpy()

fig, ax = plt.subplots(figsize=(7.2, 4.2))

# 95% CI bands
ax.fill_between(x, sig_lo, sig_hi, alpha=0.18, color="orange",
                label="Δσ-CumEnd 95% CI (×200)")
ax.fill_between(x, rmst_lo, rmst_hi, alpha=0.18, color="blue",
                label="ΔRMST 95% CI")

# mean curves (small markers)
ax.plot(x, sig, "-o", ms=1.8, lw=1.0, color="orange",
        label="Δσ-CumEnd (×200)")
ax.plot(x, rmst, "-o", ms=1.8, lw=1.0, color="blue",
        label="ΔRMST")

# y=0 red line (shared)
ax.axhline(0.0, color="red", lw=1.2, zorder=0)

# vertical dashed lines (estimated zero-crossings)
for v in VLINES:
    ax.axvline(v, ls="--", lw=1.0)

ax.set_xlabel("inflow")
ax.set_ylabel("value (ΔRMST; Δσ-CumEnd scaled)")

# scaling note inside the plot
ax.text(
    0.02, 0.95,
    f"Δσ-CumEnd is multiplied by {int(SCALE_SIGMA)} for visibility/scale matching.",
    transform=ax.transAxes, va="top", ha="left", fontsize=9
)

# legend (lower-left)
ax.legend(frameon=False, loc="lower left")

plt.tight_layout()

fig.savefig("fig1.pdf")
fig.savefig("fig1.png", dpi=DPI)
plt.close(fig)

print("Saved: fig1.pdf / fig1.png")
