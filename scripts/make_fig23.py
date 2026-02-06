# make_fig2_fig3_with_zerocross.py
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

AGG_PATH = "../results/fig23/agg.csv"
DPI = 300

def first_zero_crossing_linear(x: np.ndarray, y: np.ndarray):
    """最初の符号反転点を線形補間で推定（見つからなければ None）。"""
    for i in range(len(y) - 1):
        yi, yj = y[i], y[i + 1]
        xi, xj = x[i], x[i + 1]
        if yi == 0:
            return float(xi)
        if yi * yj < 0:
            return float(xi + (xj - xi) * (-yi) / (yj - yi))
    return None

df = pd.read_csv(AGG_PATH).sort_values("inflowRate").reset_index(drop=True)
x = df["inflowRate"].to_numpy(dtype=float)

# --- ΔAE (cum) + CI ---
dAE   = df["dMean_agentExpenditureCum"].to_numpy(dtype=float)
dAElo = df["ciLo_dAgentExpendCum"].to_numpy(dtype=float)
dAEhi = df["ciHi_dAgentExpendCum"].to_numpy(dtype=float)

# --- ΔRMST + CI ---
dRMST   = df["dRmst"].to_numpy(dtype=float)
dRMSTlo = df["ciLo_dRmst"].to_numpy(dtype=float)
dRMSThi = df["ciHi_dRmst"].to_numpy(dtype=float)

# 0-crossing 推定（今回の対象は ΔAE と ΔRMST のみ）
zc_AE = first_zero_crossing_linear(x, dAE)
zc_RMST = first_zero_crossing_linear(x, dRMST)

# --------------------
# FIG2: ΔAE vs inflow（オレンジ）
# --------------------
fig, ax = plt.subplots(figsize=(7.0, 4.0))
ax.fill_between(x, dAElo, dAEhi, alpha=0.25, color="orange", label="95% CI (ΔAE)")
ax.plot(x, dAE, "-o", ms=2.0, lw=1.0, color="orange", label="ΔAE")
ax.axhline(0.0, color="red", lw=1.2, zorder=0)

# 破線（ΔAE 0-crossing）
if zc_AE is not None:
    ax.axvline(zc_AE, ls="--", lw=1.0)

ax.set_xlabel("inflow")
ax.set_ylabel("ΔAE (cum)")
ax.legend(frameon=False, loc="upper left")
plt.tight_layout()
plt.savefig("fig2.png", dpi=DPI)
plt.savefig("fig2.pdf")
plt.close(fig)

# --------------------
# FIG3: overlay ΔAE×20（オレンジ） + ΔRMST（ブルー）
# --------------------
SCALE_AE = 20.0
dAE_s   = dAE * SCALE_AE
dAElo_s = dAElo * SCALE_AE
dAEhi_s = dAEhi * SCALE_AE

fig, ax = plt.subplots(figsize=(7.2, 4.2))

ax.fill_between(x, dAElo_s, dAEhi_s, alpha=0.18, color="orange", label="ΔAE 95% CI (×20)")
ax.fill_between(x, dRMSTlo, dRMSThi, alpha=0.18, color="blue",   label="ΔRMST 95% CI")

ax.plot(x, dAE_s,   "-o", ms=1.8, lw=1.0, color="orange", label="ΔAE (×20)")
ax.plot(x, dRMST,   "-o", ms=1.8, lw=1.0, color="blue",   label="ΔRMST")

ax.axhline(0.0, color="red", lw=1.2, zorder=0)

# 破線（ΔAE と ΔRMST の 0-crossing）
if zc_AE is not None:
    ax.axvline(zc_AE, ls="--", lw=1.0)
if zc_RMST is not None:
    ax.axvline(zc_RMST, ls="--", lw=1.0)

ax.set_xlabel("inflow")
ax.set_ylabel("value (ΔRMST; ΔAE scaled)")
ax.text(0.98, 0.98, "Note: ΔAE is multiplied by 20 solely for visibility.",
        transform=ax.transAxes, va="top", ha="right", fontsize=9)
ax.legend(frameon=False, loc="upper left")

plt.tight_layout()
plt.savefig("fig3.png", dpi=DPI)
plt.savefig("fig3.pdf")
plt.close(fig)

print("Saved: fig2.png, fig2.pdf, fig3.png, fig3.pdf")
print(f"Estimated 0-crossing ΔAE  : {zc_AE}")
print(f"Estimated 0-crossing ΔRMST: {zc_RMST}")
