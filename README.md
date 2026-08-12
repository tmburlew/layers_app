# Layers

A local dashboard that tells you whether today calls for a jacket, a coat, or
rain gear, using thresholds you set yourself.

## Run it

    pip install -r requirements.txt
    python app.py

Open http://127.0.0.1:5000. On first load it asks for a location. Either let the
browser share your coordinates or search for a place by name.

## Deploying

Runs on Vercel with no configuration. The server keeps no state at all: your
thresholds and location live in the browser's localStorage and travel as query
parameters on each forecast request, so nothing is ever written to disk. That
matters because serverless filesystems are read-only.

## How the verdict is decided

It compares **apparent temperature**, not air temperature, so wind and humidity
are already accounted for. The comparison uses the **coldest hour inside your
day window**, not the daily low, so a 4 AM trough never puts you in a coat on a
mild afternoon. If you open the page after your window has closed, it rolls
forward and reports on tomorrow instead.

Rain is called separately: if the chance of precipitation in any hour of your
window meets your cutoff, the verdict adds a waterproof layer on top of
whatever the temperature already called for.

## Settings

Everything is editable in the page under "Your thresholds" and persists in
your browser.

    jacket_f              jacket at or below this apparent temperature
    coat_f                coat at or below this apparent temperature
    rain_probability_pct  chance of rain that counts as rain
    day_start_hour        first hour you are outside (24h)
    day_end_hour          hour you are back in (24h, exclusive)
    location              name plus latitude and longitude

Settings are per-browser, so clearing site data resets them.

## Data source

Open-Meteo, which is free, needs no API key, and takes raw lat/lon. Forecasts
are cached in memory for ten minutes so a page refresh does not re-query.
`api.open-meteo.com` and `geocoding-api.open-meteo.com` are the only two
external hosts the app touches.

## Tests

    python test_logic.py

Covers the window selection and verdict rules against a mocked forecast payload,
plus settings validation. No network needed.
