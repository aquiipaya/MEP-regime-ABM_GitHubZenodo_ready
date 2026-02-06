import pandas as pd
import matplotlib.pyplot as plt
from pathlib import Path

# ===== 設定 =====
CSV_PATH = "../results/fig9/agg.csv"          # 手元のパスに変更
OUT_DIR = Path(".") # 出力先
OUT_DIR.mkdir(parents=True, exist_ok=True)

# ===== 読み込み =====
df = pd.read_csv(CSV_PATH)

# ===== フィルタ（cost固定したい場合はここで指定）=====
# 例: cost=0.2 に固定
if "intelligenceCost" in df.columns:
    df = df[df["intelligenceCost"] == 0.2]

# ===== 数値化 =====
num_cols = [
    "inflowRate", "sensingNoise",
    "dMean_sigmaProxyCumEnd", "ciLo_dSigmaProxyCumEnd", "ciHi_dSigmaProxyCumEnd",
    "dRmst", "ciLo_dRmst", "ciHi_dRmst",
]
for c in num_cols:
    if c in df.columns:
        df[c] = pd.to_numeric(df[c], errors="coerce")

df = df.dropna(subset=["inflowRate", "sensingNoise"]).sort_values(["sensingNoise", "inflowRate"])
noises = sorted(df["sensingNoise"].unique())

# ===== 図1：ΔσCumEnd（noise別・重ね書き）=====
plt.figure(figsize=(9, 5))
for nz in noises:
    d = df[df["sensingNoise"] == nz].sort_values("inflowRate")
    x = d["inflowRate"].to_numpy()
    y = d["dMean_sigmaProxyCumEnd"].to_numpy()
    ylo = d["ciLo_dSigmaProxyCumEnd"].to_numpy()
    yhi = d["ciHi_dSigmaProxyCumEnd"].to_numpy()

    plt.plot(x, y, linewidth=2, label=f"noise={nz}")
    plt.fill_between(x, ylo, yhi, alpha=0.15)

plt.axhline(0, color="red", linewidth=1.5)  # y=0（赤）
plt.xlabel("inflow")
plt.ylabel("ΔσCumEnd (95% CI)")
plt.title("ΔσCumEnd vs inflow (overlaid by noise)")
plt.legend(ncol=2, fontsize=8)
plt.tight_layout()

png1 = OUT_DIR / "fig9a.png"
pdf1 = OUT_DIR / "fig9a.pdf"
plt.savefig(png1, dpi=300, bbox_inches="tight")
plt.savefig(pdf1, bbox_inches="tight")
plt.close()

# ===== 図2：ΔRMST（noise別・重ね書き）=====
plt.figure(figsize=(9, 5))
for nz in noises:
    d = df[df["sensingNoise"] == nz].sort_values("inflowRate")
    x = d["inflowRate"].to_numpy()
    y = d["dRmst"].to_numpy()
    ylo = d["ciLo_dRmst"].to_numpy()
    yhi = d["ciHi_dRmst"].to_numpy()

    plt.plot(x, y, linewidth=2, label=f"noise={nz}")
    plt.fill_between(x, ylo, yhi, alpha=0.15)

plt.axhline(0, color="red", linewidth=1.5)  # y=0（赤）
plt.xlabel("inflow")
plt.ylabel("ΔRMST (95% CI)")
plt.title("ΔRMST vs inflow (overlaid by noise)")
plt.legend(ncol=2, fontsize=8)
plt.tight_layout()

png2 = OUT_DIR / "fig9b.png"
pdf2 = OUT_DIR / "fig9b.pdf"
plt.savefig(png2, dpi=300, bbox_inches="tight")
plt.savefig(pdf2, bbox_inches="tight")
plt.close()

print("Saved:")
print(png1, pdf1)
print(png2, pdf2)
