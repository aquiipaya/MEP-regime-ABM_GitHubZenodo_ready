# estimate_zero_crossings.py
# 目的: 平均曲線の0-crossingを「符号反転 + 線形補間」で推定して出力する
# 入力: agg.csv（同じフォルダに置く）
# 出力: 標準出力に 0-crossing 一覧を表示

import pandas as pd
import numpy as np

AGG_CSV = "../results/fig1/agg.csv"

# 対象系列（agg.csvの列名に合わせて指定）
XCOL = "inflowRate"
SERIES = {
    "dSigma_CumEnd": "dMean_sigmaProxyCumEnd",  # Δσ-CumEnd（平均）
    "dRMST": "dRmst",                           # ΔRMST（平均）
    # 必要なら追加:
    # "dSigma_DiffCumEnd": "dMean_sigmaProxyDiffCumEnd",
}

def zero_crossings_linear_interp(x: np.ndarray, y: np.ndarray):
    """
    隣接点で符号が変わる区間を検出し、線形補間で0-crossingを返す。
    戻り値: (x0, i) のリスト。iは区間 [i, i+1] を意味する。
    """
    out = []
    for i in range(len(y) - 1):
        yi, yj = y[i], y[i + 1]
        xi, xj = x[i], x[i + 1]

        # 完全に0（ちょうど格子点に乗る）場合
        if yi == 0:
            out.append((xi, i))
            continue

        # 符号反転
        if yi * yj < 0:
            # 直線補間: y=0となるx
            x0 = xi + (xj - xi) * (-yi) / (yj - yi)
            out.append((float(x0), i))

    return out

def main():
    df = pd.read_csv(AGG_CSV).sort_values(XCOL).reset_index(drop=True)
    x = df[XCOL].to_numpy(dtype=float)

    print(f"Loaded: {AGG_CSV}")
    print(f"n={len(df)}  inflow range: {x.min():.6f} .. {x.max():.6f}\n")

    for name, col in SERIES.items():
        if col not in df.columns:
            print(f"[SKIP] {name}: column not found: {col}")
            continue

        y = df[col].to_numpy(dtype=float)
        zc = zero_crossings_linear_interp(x, y)

        print(f"== {name} ({col}) ==")
        if not zc:
            print("  No sign-change zero-crossing detected.\n")
            continue

        for (x0, i) in zc:
            print(f"  crossing at inflow ≈ {x0:.6f}  (between index {i} and {i+1}: {x[i]:.6f}..{x[i+1]:.6f})")
        print()

if __name__ == "__main__":
    main()
