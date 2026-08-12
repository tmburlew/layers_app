"""Offline checks for the window/verdict logic, using a mocked Open-Meteo payload."""

from datetime import datetime, timedelta

import app as layerup


def payload(day, temps, feels, probs, current_hour):
    times, t2m, appt, pp, precip = [], [], [], [], []
    for offset in range(48):
        stamp = datetime.combine(day, datetime.min.time()) + timedelta(hours=offset)
        times.append(stamp.isoformat(timespec="minutes"))
        t2m.append(temps[offset % 24])
        appt.append(feels[offset % 24])
        pp.append(probs[offset % 24])
        precip.append(0.05 if probs[offset % 24] > 50 else 0.0)
    return {
        "timezone": "America/Los_Angeles",
        "current": {
            "time": (
                datetime.combine(day, datetime.min.time()) + timedelta(hours=current_hour)
            ).isoformat(timespec="minutes"),
            "temperature_2m": t2m[current_hour],
            "apparent_temperature": appt[current_hour],
        },
        "hourly": {
            "time": times,
            "temperature_2m": t2m,
            "apparent_temperature": appt,
            "precipitation_probability": pp,
            "precipitation": precip,
        },
    }


DAY = datetime(2026, 8, 12).date()
SETTINGS = dict(layerup.DEFAULT_SETTINGS, location={"name": "x", "latitude": 0, "longitude": 0})


def case(name, feels, probs, current_hour=5, settings=SETTINGS):
    temps = [f + 3 for f in feels]
    rows, rolled = layerup.select_window(
        payload(DAY, temps, feels, probs, current_hour),
        settings["day_start_hour"],
        settings["day_end_hour"],
    )
    verdict = layerup.build_verdict(rows, settings)
    print(f"{name:22} rolled={str(rolled):5} hours={len(rows):3}  {verdict['headline']}")
    print(f"{'':22} {verdict['reason']}")
    return rows, rolled, verdict


flat = lambda v: [v] * 24
dry = flat(0)

# Cold morning that warms up: daily low is 30 at 4 AM, but window starts at 7.
cold_dawn = [30] * 7 + [52, 58, 63, 68, 72, 74, 75, 74, 71, 67, 63, 59, 56, 54, 52, 50, 48, 46]
rows, _, v = case("dawn trough ignored", cold_dawn, dry)
assert v["layer"] == "jacket", v
assert min(r["hour"] for r in rows) == 7

_, _, v = case("mild and dry", flat(72), dry)
assert v["layer"] == "none" and not v["wet"]

_, _, v = case("mild and wet", flat(72), [70] * 24)
assert v["layer"] == "none" and v["wet"]

_, _, v = case("cold and wet", flat(34), [80] * 24)
assert v["layer"] == "coat" and v["wet"]

_, _, v = case("exactly on jacket", flat(60), dry)
assert v["layer"] == "jacket", "threshold is inclusive"

_, _, v = case("exactly on coat", flat(40), dry)
assert v["layer"] == "coat", "threshold is inclusive"

_, _, v = case("rain below cutoff", flat(72), [35] * 24)
assert not v["wet"]

# Past the end of the window: should roll to tomorrow and show the full day.
rows, rolled, v = case("after hours rolls", flat(50), dry, current_hour=22)
assert rolled and len(rows) == 14

# Mid-afternoon: past hours dropped.
rows, rolled, _ = case("midday trims past", cold_dawn, dry, current_hour=15)
assert not rolled and min(r["hour"] for r in rows) == 15

print("\nvalidation:")
for bad, why in [
    ({"coat_f": 70}, "coat above jacket"),
    ({"day_end_hour": 5}, "end before start"),
    ({"jacket_f": "warm"}, "non-numeric"),
    ({"rain_probability_pct": 150}, "out of range"),
    ({"location": {"name": "x", "latitude": 200, "longitude": 0}}, "bad latitude"),
]:
    try:
        layerup.coerce_settings(bad, SETTINGS)
    except ValueError as err:
        print(f"  rejected {why:20} -> {err}")
    else:
        raise AssertionError(f"should have rejected {why}")

good = layerup.coerce_settings({"jacket_f": "58", "day_start_hour": 6}, SETTINGS)
assert good["jacket_f"] == 58 and good["day_start_hour"] == 6 and good["coat_f"] == 40
print("  accepted valid partial update")

print("\nall logic checks passed")
