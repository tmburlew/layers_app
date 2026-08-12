const $ = (id) => document.getElementById(id);

const SETTING_FIELDS = [
  "jacket_f",
  "coat_f",
  "rain_probability_pct",
  "day_start_hour",
  "day_end_hour",
];

let settings = null;

/* ------------------------------------------------------------ helpers */

function clock(hour) {
  const suffix = hour < 12 ? "AM" : "PM";
  return `${hour % 12 || 12} ${suffix}`;
}

function showState(message) {
  $("state-text").textContent = message;
  $("state").hidden = false;
  $("verdict").hidden = true;
  $("ribbon").hidden = true;
}

async function api(path, options) {
  const response = await fetch(path, options);
  let body = null;
  try {
    body = await response.json();
  } catch (err) {
    body = null;
  }
  if (!response.ok) {
    const error = new Error((body && body.error) || "Request failed");
    error.status = response.status;
    throw error;
  }
  return body;
}

/* ------------------------------------------------------------ chart */

function drawChart(data) {
  const svg = $("chart");
  const hours = data.hours;
  const W = 900;
  const H = 340;
  const pad = { l: 46, r: 46, t: 26, b: 50 };
  const rainBand = 44;
  const gap = 14;

  const plotW = W - pad.l - pad.r;
  const tempTop = pad.t;
  const tempBottom = H - pad.b - rainBand - gap;
  const tempH = tempBottom - tempTop;

  const temps = hours.flatMap((h) => [h.apparent, h.air]);
  let lo = Math.min(...temps);
  let hi = Math.max(...temps);

  // Only stretch the scale to reach a threshold line if it sits close enough
  // to the day's range that including it keeps the curve readable.
  const near = (value) => value >= lo - 15 && value <= hi + 15;
  const inScale = { coat: near(data.thresholds.coat_f), jacket: near(data.thresholds.jacket_f) };
  if (inScale.coat) {
    lo = Math.min(lo, data.thresholds.coat_f);
    hi = Math.max(hi, data.thresholds.coat_f);
  }
  if (inScale.jacket) {
    lo = Math.min(lo, data.thresholds.jacket_f);
    hi = Math.max(hi, data.thresholds.jacket_f);
  }
  lo -= 4;
  hi += 4;
  if (hi - lo < 10) {
    const mid = (hi + lo) / 2;
    lo = mid - 5;
    hi = mid + 5;
  }

  const x = (i) =>
    hours.length === 1 ? pad.l + plotW / 2 : pad.l + (i / (hours.length - 1)) * plotW;
  const y = (t) => tempBottom - ((t - lo) / (hi - lo)) * tempH;

  const parts = [];

  // Threshold lines: the point of the whole chart.
  const thresholdLine = (value, label, dash) => {
    const yy = y(value);
    parts.push(
      `<line x1="${pad.l}" y1="${yy}" x2="${W - pad.r}" y2="${yy}"
         style="stroke: var(--accent)" stroke-width="1" stroke-dasharray="${dash}" opacity="0.55"/>`,
      `<text x="${pad.l}" y="${yy - 7}" style="font-family: var(--mono); fill: var(--accent)" font-size="11" opacity="0.9">${label} ${value}&#176;</text>`
    );
  };

  if (inScale.jacket) thresholdLine(data.thresholds.jacket_f, "jacket", "5 4");
  if (inScale.coat) thresholdLine(data.thresholds.coat_f, "coat", "2 3");

  // A threshold too far from the day's range would flatten the curve, so it is
  // pinned to the edge as a note rather than dropped without explanation.
  const offScale = { above: [], below: [] };
  if (!inScale.jacket) {
    offScale[data.thresholds.jacket_f > hi ? "above" : "below"].push(
      `jacket ${data.thresholds.jacket_f}\u00b0`
    );
  }
  if (!inScale.coat) {
    offScale[data.thresholds.coat_f > hi ? "above" : "below"].push(
      `coat ${data.thresholds.coat_f}\u00b0`
    );
  }
  [
    ["above", tempTop + 12],
    ["below", tempBottom - 6],
  ].forEach(([side, yy]) => {
    if (!offScale[side].length) return;
    const names = offScale[side].join(" and ");
    const verb = offScale[side].length > 1 ? "are" : "is";
    parts.push(
      `<text x="${W - pad.r}" y="${yy}" text-anchor="end"
         style="font-family: var(--mono); fill: var(--ink-soft)" font-size="11"
         opacity="0.8">${names} ${verb} ${side} this range</text>`
    );
  });

  // Rain probability along the bottom.
  const rainTop = H - pad.b - rainBand;
  const barW = Math.max(4, (plotW / hours.length) * 0.55);
  hours.forEach((h, i) => {
    if (!h.precip_prob) return;
    const barH = (h.precip_prob / 100) * rainBand;
    parts.push(
      `<rect x="${x(i) - barW / 2}" y="${rainTop + rainBand - barH}" width="${barW}"
         height="${barH}" style="fill: var(--rain)" opacity="0.32" rx="1"/>`
    );
  });
  parts.push(
    `<line x1="${pad.l}" y1="${rainTop + rainBand}" x2="${W - pad.r}" y2="${
      rainTop + rainBand
    }" style="stroke: var(--rule)" stroke-width="1"/>`
  );

  // Temperature traces.
  const path = (key) => hours.map((h, i) => `${i ? "L" : "M"}${x(i)},${y(h[key])}`).join(" ");
  parts.push(
    `<path d="${path("air")}" fill="none" style="stroke: var(--ink-soft)" stroke-width="1.5" stroke-dasharray="2 4" opacity="0.7"/>`,
    `<path d="${path("apparent")}" fill="none" style="stroke: var(--accent)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`
  );

  // Mark the hour the verdict is based on.
  const coldIndex = hours.reduce(
    (best, h, i) => (h.apparent < hours[best].apparent ? i : best),
    0
  );
  const cold = hours[coldIndex];
  parts.push(
    `<circle cx="${x(coldIndex)}" cy="${y(cold.apparent)}" r="5" style="fill: var(--card); stroke: var(--accent)" stroke-width="3"/>`,
    `<text x="${Math.min(
      Math.max(x(coldIndex), pad.l + 16),
      W - pad.r - 16
    )}" y="${y(cold.apparent) - 14}" text-anchor="middle"
       style="font-family: var(--mono); fill: var(--accent)" font-size="12" font-weight="500">${cold.apparent}&#176;</text>`
  );

  // Hour labels, thinned out so they never collide.
  const last = hours.length - 1;
  const step = Math.max(1, Math.ceil(hours.length / 8));
  hours.forEach((h, i) => {
    const isLast = i === last;
    if (i % step && !isLast) return;
    // Drop a regular label that would sit right next to the final one.
    if (!isLast && last - i < step) return;
    parts.push(
      `<text x="${x(i)}" y="${H - pad.b + 20}" text-anchor="middle"
         style="font-family: var(--mono); fill: var(--ink-soft)" font-size="11">${clock(h.hour)}</text>`
    );
  });

  svg.innerHTML = parts.join("\n");
  $("chart-title").textContent =
    `Apparent temperature from ${clock(hours[0].hour)} to ${clock(
      hours[hours.length - 1].hour
    )}, low of ${cold.apparent} degrees, against a jacket line at ${
      data.thresholds.jacket_f
    } and a coat line at ${data.thresholds.coat_f}.`;
}

/* ------------------------------------------------------------ render */

function render(data) {
  document.documentElement.dataset.layer = data.verdict.layer;

  $("scope").textContent = data.for_tomorrow ? "Tomorrow" : "Today";
  $("headline").textContent = data.verdict.headline;
  $("reason").textContent = data.verdict.reason;
  $("place-name").textContent = data.location.name;
  $("ribbon-window").textContent = `${clock(data.hours[0].hour)} \u2013 ${clock(
    data.hours[data.hours.length - 1].hour
  )}`;

  $("state").hidden = true;
  $("verdict").hidden = false;
  $("ribbon").hidden = false;

  drawChart(data);
}

async function loadForecast(coords) {
  const query = coords ? `?lat=${coords.lat}&lon=${coords.lon}` : "";
  showState("Reading the forecast.");
  try {
    render(await api(`/api/forecast${query}`));
  } catch (err) {
    if (err.status === 409) {
      showState("Pick a location to get started.");
      openSheet();
    } else {
      showState(err.message);
    }
  }
}

/* ------------------------------------------------------------ settings */

function fillSettingsForm() {
  SETTING_FIELDS.forEach((field) => {
    $(field).value = settings[field];
  });
}

async function saveSettings() {
  const payload = {};
  SETTING_FIELDS.forEach((field) => {
    payload[field] = $(field).value;
  });
  $("settings-status").textContent = "Saving";
  try {
    settings = await api("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    $("settings-status").textContent = "Saved";
    await loadForecast();
  } catch (err) {
    $("settings-status").textContent = err.message;
  }
}

/* ------------------------------------------------------------ location */

function openSheet() {
  $("sheet").hidden = false;
  $("search-input").focus();
}

function closeSheet() {
  $("sheet").hidden = true;
  $("sheet-status").textContent = "";
  $("results").innerHTML = "";
}

async function commitLocation(location) {
  $("sheet-status").textContent = "Saving location";
  try {
    settings = await api("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location }),
    });
    closeSheet();
    await loadForecast();
  } catch (err) {
    $("sheet-status").textContent = err.message;
  }
}

function useDeviceLocation() {
  if (!navigator.geolocation) {
    $("sheet-status").textContent = "This browser has no location support. Search instead.";
    return;
  }
  $("sheet-status").textContent = "Asking your browser for coordinates";
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const lat = Number(position.coords.latitude.toFixed(4));
      const lon = Number(position.coords.longitude.toFixed(4));
      commitLocation({
        name: `${lat.toFixed(3)}, ${lon.toFixed(3)}`,
        latitude: lat,
        longitude: lon,
      });
    },
    () => {
      $("sheet-status").textContent =
        "Your browser blocked the location request. Search for a place instead.";
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
  );
}

async function searchPlaces() {
  const query = $("search-input").value.trim();
  $("results").innerHTML = "";
  $("sheet-status").textContent = "Searching";
  try {
    const results = await api(`/api/geocode?q=${encodeURIComponent(query)}`);
    if (!results.length) {
      $("sheet-status").textContent = "Nothing matched that. Try a different spelling.";
      return;
    }
    $("sheet-status").textContent = "";
    results.forEach((place) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.innerHTML = `${place.name}<span class="coords">${place.latitude.toFixed(
        3
      )}, ${place.longitude.toFixed(3)}</span>`;
      button.addEventListener("click", () => commitLocation(place));
      li.appendChild(button);
      $("results").appendChild(li);
    });
  } catch (err) {
    $("sheet-status").textContent = err.message;
  }
}

/* ------------------------------------------------------------ wiring */

$("panel-toggle").addEventListener("click", () => {
  const toggle = $("panel-toggle");
  const open = toggle.getAttribute("aria-expanded") === "true";
  toggle.setAttribute("aria-expanded", String(!open));
  $("panel-body").hidden = open;
  $("settings-status").textContent = "";
});

$("save-settings").addEventListener("click", saveSettings);
$("place-button").addEventListener("click", openSheet);
$("sheet-close").addEventListener("click", closeSheet);
$("use-device").addEventListener("click", useDeviceLocation);
$("search-go").addEventListener("click", searchPlaces);
$("search-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") searchPlaces();
});
$("sheet").addEventListener("click", (event) => {
  if (event.target === $("sheet")) closeSheet();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("sheet").hidden) closeSheet();
});

(async function start() {
  try {
    settings = await api("/api/settings");
  } catch (err) {
    showState("Could not load your settings.");
    return;
  }
  fillSettingsForm();
  if (!settings.location) {
    showState("Pick a location to get started.");
    openSheet();
    return;
  }
  await loadForecast();
})();
