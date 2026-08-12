"""Layers - a dashboard that tells you what to wear, using your own
temperature thresholds and the Open-Meteo forecast API.

The server holds no state. Thresholds and location live in the browser and
arrive as query parameters, so this runs unchanged on a read-only serverless
filesystem.

Run locally:  python app.py    then open http://127.0.0.1:5000
"""

import time
from datetime import datetime, timedelta

import requests
from flask import Flask, jsonify, render_template, request

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"

DEFAULT_SETTINGS = {
    "jacket_f": 60,
    "coat_f": 40,
    "rain_probability_pct": 40,
    "day_start_hour": 7,
    "day_end_hour": 21,
}

CACHE_SECONDS = 600
_cache = {}

app = Flask(__name__)


# ---------------------------------------------------------------- settings

LIMITS = {
    "jacket_f": (-60, 120),
    "coat_f": (-60, 120),
    "rain_probability_pct": (0, 100),
    "day_start_hour": (0, 23),
    "day_end_hour": (1, 24),
}


def settings_from_args(args):
    """Read thresholds off the query string, falling back to the defaults.

    Raises ValueError with a message meant to be shown to the person.
    """
    settings = dict(DEFAULT_SETTINGS)
    for field, (low, high) in LIMITS.items():
        if field not in args:
            continue
        try:
            value = int(args[field])
        except (TypeError, ValueError):
            raise ValueError(f"{field} must be a whole number")
        if not low <= value <= high:
            raise ValueError(f"{field} must be between {low} and {high}")
        settings[field] = value

    if settings["coat_f"] >= settings["jacket_f"]:
        raise ValueError("Coat temperature must be lower than jacket temperature")
    if settings["day_end_hour"] <= settings["day_start_hour"]:
        raise ValueError("Day end must be later than day start")
    return settings


# ---------------------------------------------------------------- forecast

def fetch_forecast(lat, lon):
    key = (round(lat, 3), round(lon, 3))
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_SECONDS:
        return hit[1]

    response = requests.get(
        FORECAST_URL,
        params={
            "latitude": lat,
            "longitude": lon,
            "hourly": "temperature_2m,apparent_temperature,precipitation_probability,precipitation",
            "current": "temperature_2m,apparent_temperature",
            "temperature_unit": "fahrenheit",
            "wind_speed_unit": "mph",
            "precipitation_unit": "inch",
            "timezone": "auto",
            "forecast_days": 2,
        },
        timeout=12,
    )
    response.raise_for_status()
    payload = response.json()
    _cache[key] = (time.time(), payload)
    return payload


def select_window(payload, start_hour, end_hour):
    """Return the hours we actually care about, and which day they fall on.

    If the current time is already past the end of today's window, roll
    forward to tomorrow rather than reporting on a day that is over.
    """
    hourly = payload["hourly"]
    times = [datetime.fromisoformat(t) for t in hourly["time"]]

    now = datetime.fromisoformat(payload["current"]["time"])
    target_day = now.date()
    rolled = False
    if now.hour >= end_hour:
        target_day = target_day + timedelta(days=1)
        rolled = True

    rows = []
    for i, stamp in enumerate(times):
        if stamp.date() != target_day:
            continue
        if not start_hour <= stamp.hour < end_hour:
            continue
        if not rolled and stamp < now.replace(minute=0, second=0, microsecond=0):
            continue
        apparent = hourly["apparent_temperature"][i]
        air = hourly["temperature_2m"][i]
        if apparent is None or air is None:
            continue
        rows.append(
            {
                "time": stamp.isoformat(),
                "hour": stamp.hour,
                "air": round(air),
                "apparent": round(apparent),
                "precip_prob": hourly["precipitation_probability"][i] or 0,
                "precip_in": hourly["precipitation"][i] or 0.0,
            }
        )
    return rows, rolled


def clock(hour):
    suffix = "AM" if hour < 12 else "PM"
    display = hour % 12 or 12
    return f"{display} {suffix}"


def build_verdict(rows, settings):
    coldest = min(rows, key=lambda r: r["apparent"])
    wettest = max(rows, key=lambda r: r["precip_prob"])
    total_precip = round(sum(r["precip_in"] for r in rows), 2)

    low = coldest["apparent"]
    wet = wettest["precip_prob"] >= settings["rain_probability_pct"]

    if low <= settings["coat_f"]:
        layer = "coat"
    elif low <= settings["jacket_f"]:
        layer = "jacket"
    else:
        layer = "none"

    headlines = {
        ("coat", True): "Coat, and make it waterproof.",
        ("coat", False): "Coat.",
        ("jacket", True): "Jacket, with a rain shell over it.",
        ("jacket", False): "Jacket.",
        ("none", True): "No jacket, but take a rain shell.",
        ("none", False): "No jacket.",
    }

    reason = f"Feels like {low}\u00b0 at {clock(coldest['hour'])}"
    if wet:
        reason += f" \u00b7 {wettest['precip_prob']}% rain around {clock(wettest['hour'])}"
    elif wettest["precip_prob"] > 0:
        reason += f" \u00b7 rain unlikely, peaks at {wettest['precip_prob']}%"
    else:
        reason += " \u00b7 dry all window"

    return {
        "layer": layer,
        "wet": wet,
        "headline": headlines[(layer, wet)],
        "reason": reason,
        "low": low,
        "high": max(r["apparent"] for r in rows),
        "coldest_hour": coldest["hour"],
        "peak_rain_pct": wettest["precip_prob"],
        "peak_rain_hour": wettest["hour"],
        "total_precip_in": total_precip,
    }


# ---------------------------------------------------------------- routes

@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/geocode")
def geocode():
    query = (request.args.get("q") or "").strip()
    if len(query) < 2:
        return jsonify({"error": "Type at least two characters to search"}), 400
    try:
        response = requests.get(
            GEOCODE_URL,
            params={"name": query, "count": 5, "language": "en", "format": "json"},
            timeout=10,
        )
        response.raise_for_status()
        results = response.json().get("results") or []
    except requests.RequestException:
        return jsonify({"error": "Could not reach the location search service"}), 502

    return jsonify(
        [
            {
                "name": ", ".join(
                    part
                    for part in (r.get("name"), r.get("admin1"), r.get("country_code"))
                    if part
                ),
                "latitude": r["latitude"],
                "longitude": r["longitude"],
            }
            for r in results
        ]
    )


@app.get("/api/forecast")
def forecast():
    try:
        settings = settings_from_args(request.args)
    except ValueError as err:
        return jsonify({"error": str(err)}), 400

    lat_arg, lon_arg = request.args.get("lat"), request.args.get("lon")
    if not lat_arg or not lon_arg:
        return jsonify({"error": "No location set"}), 409
    try:
        lat, lon = float(lat_arg), float(lon_arg)
    except ValueError:
        return jsonify({"error": "Latitude and longitude must be numbers"}), 400
    if not -90 <= lat <= 90 or not -180 <= lon <= 180:
        return jsonify({"error": "Those coordinates are out of range"}), 400

    name = request.args.get("name") or f"{lat:.3f}, {lon:.3f}"

    try:
        payload = fetch_forecast(lat, lon)
    except requests.RequestException:
        return jsonify({"error": "Could not reach the forecast service"}), 502

    rows, rolled = select_window(
        payload, settings["day_start_hour"], settings["day_end_hour"]
    )
    if not rows:
        return jsonify({"error": "No forecast hours fall inside your day window"}), 502

    return jsonify(
        {
            "location": {"name": name[:120], "latitude": lat, "longitude": lon},
            "timezone": payload.get("timezone"),
            "for_tomorrow": rolled,
            "current": {
                "air": round(payload["current"]["temperature_2m"]),
                "apparent": round(payload["current"]["apparent_temperature"]),
            },
            "hours": rows,
            "verdict": build_verdict(rows, settings),
            "thresholds": {
                "jacket_f": settings["jacket_f"],
                "coat_f": settings["coat_f"],
            },
        }
    )


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
