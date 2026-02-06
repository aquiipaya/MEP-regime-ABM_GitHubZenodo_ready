import pandas as pd
import matplotlib.pyplot as plt

AGG_PATH = "../results/fig4/agg.csv"  

df = pd.read_csv(AGG_PATH).sort_values("inflowRate")
x = df["inflowRate"].to_numpy()

# --- Δσ-CumEnd (95% CI) ---
y_sigma = df["dMean_sigmaProxyCumEnd"].to_numpy()
y_sigma_lo = df["ciLo_dSigmaProxyCumEnd"].to_numpy()
y_sigma_hi = df["ciHi_dSigmaProxyCumEnd"].to_numpy()

plt.figure(figsize=(7, 5))
plt.fill_between(x, y_sigma_lo, y_sigma_hi, alpha=0.25)
plt.plot(x, y_sigma, marker="o", markersize=2, linewidth=1, color="orange")
plt.axhline(0, color="red", linewidth=1.2)
plt.xlabel("inflow")
plt.ylabel("Δσ-CumEnd (95% CI)")
plt.title("Δσ-CumEnd vs inflow (95% CI)")
plt.tight_layout()
plt.savefig("fig4a.png", dpi=300)
plt.savefig("fig4a.pdf")
plt.show()

# --- ΔRMST (95% CI) ---
y_rmst = df["dRmst"].to_numpy()
y_rmst_lo = df["ciLo_dRmst"].to_numpy()
y_rmst_hi = df["ciHi_dRmst"].to_numpy()

plt.figure(figsize=(7, 5))
plt.fill_between(x, y_rmst_lo, y_rmst_hi, alpha=0.25)
plt.plot(x, y_rmst, marker="o", markersize=2, linewidth=1)
plt.axhline(0, color="red", linewidth=1.2)
plt.xlabel("inflow")
plt.ylabel("ΔRMST (95% CI)")
plt.title("ΔRMST vs inflow (95% CI)")
plt.tight_layout()
# --- 保存したい場合は以下を各plt.show()の直前に追加 ---
plt.savefig("fig4b.png", dpi=300)
plt.savefig("fig4b.pdf")
plt.show()
