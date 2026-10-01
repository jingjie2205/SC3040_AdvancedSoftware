from typing import Dict, List, Literal, Optional, Tuple
from pydantic import BaseModel, Field
import numpy as np


class AthleteParams(BaseModel):
    rest_hr: int = Field(default=60, ge=30, le=120)
    max_hr: int = Field(default=190, ge=100, le=240)
    gender: Literal["male", "female"] = "male"


class HrZoneDistribution(BaseModel):
    zone1_seconds: int = 0
    zone2_seconds: int = 0
    zone3_seconds: int = 0
    zone4_seconds: int = 0
    zone5_seconds: int = 0
    zone_percentages: Tuple[int, int, int, int, int] = (0, 0, 0, 0, 0)


class AcwrResult(BaseModel):
    acute_load_7d: float
    chronic_load_28d: float
    acwr: float
    status: Literal["undertraining", "sweet_spot", "overreaching", "danger"]


def calculate_banister_trimp(
    duration_seconds: int,
    avg_hr: Optional[float],
    athlete: AthleteParams,
    time_stream: Optional[List[int]] = None,
    hr_stream: Optional[List[int]] = None,
) -> float:
    """
    Calculates Banister's Training Impulse (TRIMP).
    Uses NumPy-vectorized calculation when second-by-second telemetry is available;
    otherwise falls back to summary duration and average heart rate.
    """
    hr_range = max(1.0, float(athlete.max_hr - athlete.rest_hr))
    gender_factor = 1.67 if athlete.gender == "female" else 1.92
    gender_coeff = 0.86 if athlete.gender == "female" else 0.64

    if time_stream and hr_stream and len(time_stream) > 1 and len(time_stream) == len(hr_stream):
        t_arr = np.array(time_stream, dtype=np.float64)
        hr_arr = np.array(hr_stream, dtype=np.float64)

        # dt in minutes between consecutive readings
        dt_minutes = np.maximum(0.0, np.diff(t_arr) / 60.0)

        # Fractional heart rate elevation (HR reserve fraction)
        delta_hr_ratio = np.clip((hr_arr[1:] - athlete.rest_hr) / hr_range, 0.0, 1.0)

        # Exponential weighting factor
        exp_multiplier = gender_coeff * np.exp(gender_factor * delta_hr_ratio)

        total_trimp = np.sum(dt_minutes * delta_hr_ratio * exp_multiplier)
        return round(float(total_trimp), 1)

    if not avg_hr or avg_hr <= athlete.rest_hr:
        return 0.0

    duration_minutes = duration_seconds / 60.0
    delta_hr_ratio = min(1.0, max(0.0, (avg_hr - athlete.rest_hr) / hr_range))
    exp_multiplier = gender_coeff * np.exp(gender_factor * delta_hr_ratio)
    trimp = duration_minutes * delta_hr_ratio * exp_multiplier

    return round(float(trimp), 1)


def calculate_hr_zones(
    max_hr: int,
    time_stream: Optional[List[int]] = None,
    hr_stream: Optional[List[int]] = None,
) -> HrZoneDistribution:
    """
    Computes 5-zone HR time distribution using NumPy-vectorized thresholding.
    Zone 1: <60%
    Zone 2: 60-70%
    Zone 3: 70-80%
    Zone 4: 80-90%
    Zone 5: >=90%
    """
    if not time_stream or not hr_stream or len(time_stream) < 2 or len(time_stream) != len(hr_stream):
        return HrZoneDistribution()

    t_arr = np.array(time_stream, dtype=np.float64)
    hr_arr = np.array(hr_stream, dtype=np.float64)

    dt = np.maximum(0.0, np.diff(t_arr))
    hrs = hr_arr[1:]
    total_time = np.sum(dt)

    if total_time <= 0:
        return HrZoneDistribution()

    z1_thresh = max_hr * 0.60
    z2_thresh = max_hr * 0.70
    z3_thresh = max_hr * 0.80
    z4_thresh = max_hr * 0.90

    # Vectorized zone masks
    mask_z1 = hrs < z1_thresh
    mask_z2 = (hrs >= z1_thresh) & (hrs < z2_thresh)
    mask_z3 = (hrs >= z2_thresh) & (hrs < z3_thresh)
    mask_z4 = (hrs >= z3_thresh) & (hrs < z4_thresh)
    mask_z5 = hrs >= z4_thresh

    z1_sec = int(np.sum(dt[mask_z1]))
    z2_sec = int(np.sum(dt[mask_z2]))
    z3_sec = int(np.sum(dt[mask_z3]))
    z4_sec = int(np.sum(dt[mask_z4]))
    z5_sec = int(np.sum(dt[mask_z5]))

    pcts = (
        int(round((z1_sec / total_time) * 100)),
        int(round((z2_sec / total_time) * 100)),
        int(round((z3_sec / total_time) * 100)),
        int(round((z4_sec / total_time) * 100)),
        int(round((z5_sec / total_time) * 100)),
    )

    return HrZoneDistribution(
        zone1_seconds=z1_sec,
        zone2_seconds=z2_sec,
        zone3_seconds=z3_sec,
        zone4_seconds=z4_sec,
        zone5_seconds=z5_sec,
        zone_percentages=pcts,
    )


def calculate_acwr(daily_loads_28d: List[float]) -> AcwrResult:
    """
    Computes 7-day Acute Load, 28-day Chronic Load, and the Acute:Chronic Workload Ratio (ACWR).
    Expects daily TRIMP values ordered chronologically (index 0 = 27 days ago, index 27 = today).
    """
    arr = np.array(daily_loads_28d, dtype=np.float64)

    # Pad or slice to exactly 28 days
    if len(arr) < 28:
        pad_size = 28 - len(arr)
        arr = np.pad(arr, (pad_size, 0), mode="constant", constant_values=0.0)
    else:
        arr = arr[-28:]

    past_7d = arr[-7:]
    acute_sum = np.sum(past_7d)
    acute_load_7d = round(float(acute_sum / 7.0), 1)

    chronic_sum = np.sum(arr)
    chronic_load_28d = round(float(chronic_sum / 28.0), 1)

    if chronic_load_28d > 0:
        raw_acwr = acute_load_7d / chronic_load_28d
    elif acute_load_7d > 0:
        raw_acwr = 1.0
    else:
        raw_acwr = 0.0

    acwr = round(float(raw_acwr), 2)

    if acwr < 0.8:
        status: Literal["undertraining", "sweet_spot", "overreaching", "danger"] = "undertraining"
    elif acwr <= 1.3:
        status = "sweet_spot"
    elif acwr <= 1.5:
        status = "overreaching"
    else:
        status = "danger"

    return AcwrResult(
        acute_load_7d=acute_load_7d,
        chronic_load_28d=chronic_load_28d,
        acwr=acwr,
        status=status,
    )
