# print_zero_crossings_AE_RMST.py
import numpy as np
import pandas as pd

AGG_PATH = "../results/fig23/agg.csv"

def first_zero_crossing_linear(x: np.ndarray, y: np.ndarray):
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

dAE = df["dMean_agentExpenditureCum"].to_numpy(dtype=float)
dRMST = df["dRmst"].to_numpy(dtype=float)

zc_AE = first_zero_crossing_linear(x, dAE)
zc_RMST = first_zero_crossing_linear(x, dRMST)

print(f"agg: {AGG_PATH}")
print(f"0-crossing (ΔAE)  : {zc_AE}")
print(f"0-crossing (ΔRMST): {zc_RMST}")
