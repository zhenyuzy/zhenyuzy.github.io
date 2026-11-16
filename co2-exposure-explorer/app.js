(() => {
  "use strict";

  const model = window.MODEL_DATA;
  if (!model) {
    document.body.innerHTML = "<p style='padding:2rem'>Model data are missing. Run 12_build_daily_exposure_app_models.R first.</p>";
    return;
  }

  const OFFICE_WORKDAY_EXPOSURE = 200000;
  const ventilationColors = {
    Auto: "#5c6f7b",
    "Outside Air": "#2b7a78",
    Recirculation: "#d17b0f",
  };

  const createId = () =>
    globalThis.crypto?.randomUUID?.() ?? `trip-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const defaultTrips = () => [
    {
      id: createId(), duration: 25, occupancy: "1 occupant",
      ventilation: "Auto", vehicleType: "Sedan", parkingDuration: 0,
      parkingEnvironment: "Likely outdoor", overrideEnabled: false, overrideInitial: 700,
    },
    {
      id: createId(), duration: 30, occupancy: "2 occupants",
      ventilation: "Recirculation", vehicleType: "Sedan", parkingDuration: 75,
      parkingEnvironment: "Likely indoor", overrideEnabled: false, overrideInitial: 900,
    },
    {
      id: createId(), duration: 20, occupancy: "3+ occupants",
      ventilation: "Outside Air", vehicleType: "SUV", parkingDuration: 180,
      parkingEnvironment: "Likely outdoor", overrideEnabled: false, overrideInitial: 800,
    },
  ];

  const state = {
    firstInitial: 600,
    simulationDays: 1,
    overnightDuration: 720,
    overnightEnvironment: "Likely outdoor",
    trips: defaultTrips(),
  };

  const $ = (selector) => document.querySelector(selector);
  const tripList = $("#tripList");
  const firstInitialInput = $("#firstInitial");
  const simulationDaysInput = $("#simulationDays");
  const overnightSettings = $("#overnightSettings");
  const overnightDurationInput = $("#overnightDuration");
  const overnightEnvironmentInput = $("#overnightEnvironment");

  const formatNumber = (value, digits = 0) =>
    new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value);

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const logistic = (value) => 1 / (1 + Math.exp(-value));

  function coefficientValue(coefs, name) {
    const value = coefs[name];
    return typeof value === "number" ? value : Number(value);
  }

  function predictNextInitial(previousEnd, parkingDuration, environment) {
    const coefs = model.intertrip_continuous.coefficients;
    const raw =
      coefficientValue(coefs, "(Intercept)") +
      coefficientValue(coefs, "previous_end_co2_per_1000ppm") * (previousEnd / 1000) +
      coefficientValue(coefs, "parking_duration_per_100min") * (parkingDuration / 100) +
      (environment === "Likely indoor"
        ? coefficientValue(coefs, "parking_environmentLikely indoor")
        : 0);
    return {
      raw,
      bounded: clamp(
        raw,
        model.metadata.concentration_floor_ppm,
        model.metadata.concentration_ceiling_ppm,
      ),
    };
  }

  function predictHighStartProbability(previousEnd, parkingDuration, environment) {
    const coefs = model.intertrip_logistic.coefficients;
    const link =
      coefficientValue(coefs, "(Intercept)") +
      coefficientValue(coefs, "previous_end_co2_per_1000ppm") * (previousEnd / 1000) +
      coefficientValue(coefs, "parking_duration_per_100min") * (parkingDuration / 100) +
      (environment === "Likely indoor"
        ? coefficientValue(coefs, "parking_environmentLikely indoor")
        : 0);
    return logistic(link);
  }

  function trajectoryFor(trip, initial) {
    const grid = model.grids.initial_co2_ppm;
    const boundedInitial = clamp(initial, grid[0], grid[grid.length - 1]);
    const key = `${trip.vehicleType}|${trip.ventilation}|${trip.occupancy}`;
    const curves = model.trajectories[key];
    if (!curves) throw new Error(`Prediction grid unavailable for ${key}.`);

    let upper = grid.findIndex((value) => value >= boundedInitial);
    if (upper < 0) upper = grid.length - 1;
    const lower = Math.max(0, upper - 1);
    const denominator = grid[upper] - grid[lower];
    const weight = denominator === 0 ? 0 : (boundedInitial - grid[lower]) / denominator;
    const duration = clamp(Math.round(trip.duration), 1, model.metadata.prediction_max_min);
    const trajectory = [];
    for (let minute = 0; minute <= duration; minute += 1) {
      const lowerValue = Number(curves[lower][minute]);
      const upperValue = Number(curves[upper][minute]);
      trajectory.push(lowerValue + (upperValue - lowerValue) * weight);
    }
    return { trajectory, boundedInitial, key };
  }

  function trapezoid(values) {
    let total = 0;
    for (let i = 1; i < values.length; i += 1) {
      total += (values[i - 1] + values[i]) / 2;
    }
    return total;
  }

  function timeAbove(values, threshold) {
    let minutes = 0;
    for (let i = 1; i < values.length; i += 1) {
      const a = values[i - 1];
      const b = values[i];
      if (a >= threshold && b >= threshold) minutes += 1;
      else if (a < threshold && b >= threshold && b !== a) minutes += (b - threshold) / (b - a);
      else if (a >= threshold && b < threshold && a !== b) minutes += (a - threshold) / (a - b);
    }
    return minutes;
  }

  function calculateScenario() {
    const warnings = new Set();
    const results = [];
    const daySummaries = [];
    let previousEnd = null;

    for (let day = 1; day <= state.simulationDays; day += 1) {
      const dayResults = [];
      state.trips.forEach((trip, tripIndex) => {
        const isFirstObservation = day === 1 && tripIndex === 0;
        const isMorningCarryOver = day > 1 && tripIndex === 0;
        const parkingDuration = isMorningCarryOver ? state.overnightDuration : trip.parkingDuration;
        const parkingEnvironment = isMorningCarryOver
          ? state.overnightEnvironment
          : trip.parkingEnvironment;
        let initial;
        let highStartProbability = null;
        let chainedRaw = null;

        if (isFirstObservation) {
          initial = state.firstInitial;
        } else if (!isMorningCarryOver && trip.overrideEnabled) {
          initial = trip.overrideInitial;
          highStartProbability = predictHighStartProbability(
            previousEnd,
            parkingDuration,
            parkingEnvironment,
          );
        } else {
          const chained = predictNextInitial(
            previousEnd,
            parkingDuration,
            parkingEnvironment,
          );
          initial = chained.bounded;
          chainedRaw = chained.raw;
          highStartProbability = predictHighStartProbability(
            previousEnd,
            parkingDuration,
            parkingEnvironment,
          );
          if (chained.raw < model.metadata.concentration_floor_ppm) {
            warnings.add(
              `At least one chained initial prediction fell below ${formatNumber(model.metadata.concentration_floor_ppm)} ppm and was displayed at the configured lower bound.`,
            );
          }
        }

        const prediction = trajectoryFor(trip, initial);
        const support = model.trajectory_support[prediction.key];
        const exposure = trapezoid(prediction.trajectory);
        const duration = prediction.trajectory.length - 1;
        const end = prediction.trajectory[prediction.trajectory.length - 1];
        const mean = exposure / duration;
        const above1000 = timeAbove(prediction.trajectory, 1000);
        const above2000 = timeAbove(prediction.trajectory, 2000);
        const scheduleLabel = `Daily Trip ${tripIndex + 1}`;

        if (!isFirstObservation) {
          const parkingSupport = model.intertrip_continuous.parking_duration_range_min;
          if (parkingDuration < parkingSupport[0] || parkingDuration > parkingSupport[1]) {
            const parkingLabel = isMorningCarryOver ? "Overnight parking" : `${scheduleLabel} parking`;
            warnings.add(
              `${parkingLabel} (${formatNumber(parkingDuration)} min) is outside the continuous inter-trip model range of ${formatNumber(parkingSupport[0])}–${formatNumber(parkingSupport[1])} min.`,
            );
          }
        }

        if (initial < model.grids.initial_co2_ppm[0] || initial > model.grids.initial_co2_ppm.at(-1)) {
          warnings.add(`${scheduleLabel} has an initial CO₂ outside the 400–6,000 ppm prediction grid and was evaluated at the nearest boundary.`);
        }
        if (support) {
          if (support.trip_count < 5) {
            warnings.add(`${scheduleLabel} has only ${support.trip_count} training trips for its vehicle × ventilation × occupancy combination.`);
          }
          if (
            support.initial_min_ppm != null &&
            (initial < support.initial_min_ppm || initial > support.initial_max_ppm)
          ) {
            warnings.add(
              `${scheduleLabel} uses initial CO₂ values outside the observed joint range of ${formatNumber(support.initial_min_ppm)}–${formatNumber(support.initial_max_ppm)} ppm on at least one simulated day.`,
            );
          }
        }

        const result = {
          ...trip,
          day,
          tripIndex,
          initial,
          chainedRaw,
          highStartProbability,
          parkingDuration,
          parkingEnvironment,
          trajectory: prediction.trajectory,
          duration,
          exposure,
          end,
          mean,
          above1000,
          above2000,
        };
        results.push(result);
        dayResults.push(result);
        previousEnd = end;
      });

      const dayExposure = dayResults.reduce((sum, item) => sum + item.exposure, 0);
      const dayDuration = dayResults.reduce((sum, item) => sum + item.duration, 0);
      daySummaries.push({
        day,
        exposure: dayExposure,
        duration: dayDuration,
        mean: dayExposure / dayDuration,
      });
    }

    const totalDuration = results.reduce((sum, item) => sum + item.duration, 0);
    const totalExposure = results.reduce((sum, item) => sum + item.exposure, 0);
    return {
      results,
      daySummaries,
      warnings: [...warnings],
      totalDuration,
      totalExposure,
      timeWeightedMean: totalExposure / totalDuration,
      above1000: results.reduce((sum, item) => sum + item.above1000, 0),
      above2000: results.reduce((sum, item) => sum + item.above2000, 0),
      officeEquivalent: totalExposure / OFFICE_WORKDAY_EXPOSURE,
    };
  }

  function option(value, label, selected) {
    return `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`;
  }

  function renderTrips() {
    tripList.innerHTML = state.trips.map((trip, index) => `
      <article class="trip-card" data-id="${trip.id}">
        <div class="trip-card-header">
          <h3><span class="trip-number">${index + 1}</span>Daily Trip ${index + 1}</h3>
          ${state.trips.length > 1 ? `<button class="button button-danger remove-trip" type="button" data-id="${trip.id}">Remove</button>` : ""}
        </div>
        ${index > 0 ? `
          <div class="parking-block">
            <strong>Parking after the previous trip</strong>
            <div class="field-grid">
              <div class="field">
                <label>Parking duration (min)</label>
                <input data-field="parkingDuration" type="number" min="6" max="1200" step="5" value="${trip.parkingDuration}" />
              </div>
              <div class="field">
                <label>Parking environment</label>
                <select data-field="parkingEnvironment">
                  ${option("Likely outdoor", "Outdoor", trip.parkingEnvironment)}
                  ${option("Likely indoor", "Indoor", trip.parkingEnvironment)}
                </select>
              </div>
            </div>
            <label class="override-row">
              <input data-field="overrideEnabled" type="checkbox" ${trip.overrideEnabled ? "checked" : ""} />
              Manually override this trip’s initial CO₂
            </label>
            ${trip.overrideEnabled ? `
              <div class="field" style="margin-top:.55rem">
                <label>Override value (ppm)</label>
                <input data-field="overrideInitial" type="number" min="400" max="6000" step="50" value="${trip.overrideInitial}" />
              </div>` : ""}
          </div>` : ""}
        <div class="field-grid">
          <div class="field">
            <label>Trip duration (min)</label>
            <input data-field="duration" type="number" min="1" max="60" step="1" value="${trip.duration}" />
          </div>
          <div class="field">
            <label>Vehicle type</label>
            <select data-field="vehicleType">
              ${option("Sedan", "Sedan", trip.vehicleType)}
              ${option("SUV", "SUV", trip.vehicleType)}
            </select>
          </div>
          <div class="field">
            <label>Occupancy</label>
            <select data-field="occupancy">
              ${option("1 occupant", "1 person", trip.occupancy)}
              ${option("2 occupants", "2 people", trip.occupancy)}
              ${option("3+ occupants", "3+ people", trip.occupancy)}
            </select>
          </div>
          <div class="field">
            <label>Ventilation</label>
            <select data-field="ventilation">
              ${option("Auto", "Auto", trip.ventilation)}
              ${option("Outside Air", "Outside Air", trip.ventilation)}
              ${option("Recirculation", "Recirculation", trip.ventilation)}
            </select>
          </div>
        </div>
      </article>
    `).join("");

    tripList.querySelectorAll("input, select").forEach((element) => {
      element.addEventListener("change", (event) => {
        const card = event.target.closest(".trip-card");
        const trip = state.trips.find((item) => item.id === card.dataset.id);
        const field = event.target.dataset.field;
        if (event.target.type === "checkbox") trip[field] = event.target.checked;
        else if (event.target.type === "number") trip[field] = Number(event.target.value);
        else trip[field] = event.target.value;
        render();
      });
    });

    tripList.querySelectorAll(".remove-trip").forEach((button) => {
      button.addEventListener("click", () => {
        state.trips = state.trips.filter((trip) => trip.id !== button.dataset.id);
        render();
      });
    });
  }

  function renderTrajectoryChart(scenario) {
    const width = 940;
    const height = 370;
    const margin = { top: 22, right: 26, bottom: 56, left: 64 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const totalMinutes = Math.max(1, scenario.totalDuration);
    const allValues = scenario.results.flatMap((result) => result.trajectory);
    const yMax = Math.max(2500, Math.ceil(Math.max(...allValues) / 500) * 500);
    const x = (value) => margin.left + (value / totalMinutes) * plotWidth;
    const y = (value) => margin.top + plotHeight - (value / yMax) * plotHeight;

    const yTicks = [];
    const tickStep = yMax <= 3000 ? 500 : 1000;
    for (let value = 0; value <= yMax; value += tickStep) yTicks.push(value);

    let accumulated = 0;
    const paths = [];
    const separators = [];
    const labels = [];
    const dayStarts = new Map();
    const dayEnds = new Map();

    scenario.results.forEach((result, index) => {
      if (!dayStarts.has(result.day)) dayStarts.set(result.day, accumulated);
      const points = result.trajectory.map((value, minute) => `${x(accumulated + minute)},${y(value)}`);
      paths.push(`<polyline points="${points.join(" ")}" fill="none" stroke="${ventilationColors[result.ventilation]}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" />`);
      accumulated += result.duration;
      dayEnds.set(result.day, accumulated);
      const next = scenario.results[index + 1];
      if (next) {
        const dayBoundary = next.day !== result.day;
        separators.push(`<line x1="${x(accumulated)}" x2="${x(accumulated)}" y1="${margin.top}" y2="${margin.top + plotHeight}" stroke="${dayBoundary ? "#4c625a" : "#9aaba5"}" stroke-width="${dayBoundary ? 1.6 : 1}" stroke-dasharray="${dayBoundary ? "6 4" : "3 4"}" />`);
      }
      if (state.simulationDays === 1) {
        const start = accumulated - result.duration;
        labels.push(`<text x="${x(start + result.duration / 2)}" y="${height - 18}" text-anchor="middle" class="svg-trip-label">T${result.tripIndex + 1}</text>`);
      }
    });

    if (state.simulationDays > 1) {
      for (const [day, start] of dayStarts.entries()) {
        const end = dayEnds.get(day);
        labels.push(`<text x="${x((start + end) / 2)}" y="${height - 18}" text-anchor="middle" class="svg-trip-label">Day ${day}</text>`);
      }
    }

    const thresholdLines = [
      { value: 1000, color: "#d17b0f", label: "1,000 ppm · indoor standard" },
      { value: 2000, color: "#b4473d", label: "2,000 ppm · cognitive-impact reference" },
    ].filter((item) => item.value <= yMax).map((item) => `
      <line x1="${margin.left}" x2="${width - margin.right}" y1="${y(item.value)}" y2="${y(item.value)}" class="svg-threshold" stroke="${item.color}" />
      <text x="${width - margin.right - 4}" y="${y(item.value) - 5}" text-anchor="end" class="svg-label">${item.label}</text>
    `).join("");

    $("#trajectoryChart").innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Predicted in-vehicle carbon dioxide trajectory">
        ${yTicks.map((value) => `
          <line x1="${margin.left}" x2="${width - margin.right}" y1="${y(value)}" y2="${y(value)}" class="svg-grid" />
          <text x="${margin.left - 10}" y="${y(value) + 4}" text-anchor="end" class="svg-label">${formatNumber(value)}</text>
        `).join("")}
        <line x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${margin.top + plotHeight}" class="svg-axis" />
        <line x1="${margin.left}" x2="${width - margin.right}" y1="${margin.top + plotHeight}" y2="${margin.top + plotHeight}" class="svg-axis" />
        ${thresholdLines}
        ${separators.join("")}
        ${paths.join("")}
        ${labels.join("")}
        <text transform="translate(17 ${margin.top + plotHeight / 2}) rotate(-90)" text-anchor="middle" class="svg-label">Predicted CO₂ (ppm)</text>
        <text x="${margin.left + plotWidth / 2}" y="${height - 2}" text-anchor="middle" class="svg-label">Cumulative driving time (min)</text>
      </svg>`;
  }

  function renderContributionBars(scenario) {
    const items = state.simulationDays === 1
      ? scenario.results.map((item) => ({ label: `Trip ${item.tripIndex + 1}`, exposure: item.exposure }))
      : scenario.daySummaries.map((item) => ({ label: `Day ${item.day}`, exposure: item.exposure }));
    const maxExposure = Math.max(...items.map((item) => item.exposure), 1);
    $("#contributionTitle").textContent = state.simulationDays === 1
      ? "Trip contributions to daily exposure"
      : "Daily contributions to weekly exposure";
    $("#contributionSubtitle").textContent = "Bar length represents ppm·min and the label shows the share of the scenario total.";
    $("#contributionBars").innerHTML = items.map((item) => `
      <div class="bar-row">
        <strong>${item.label}</strong>
        <div class="bar-track"><div class="bar-fill" style="width:${(item.exposure / maxExposure) * 100}%"></div></div>
        <span class="bar-value">${formatNumber(item.exposure)} · ${formatNumber((item.exposure / scenario.totalExposure) * 100, 1)}%</span>
      </div>
    `).join("");
  }

  function renderResults(scenario) {
    $("#totalExposure").textContent = formatNumber(scenario.totalExposure);
    $("#dailyMean").textContent = formatNumber(scenario.timeWeightedMean);
    $("#minutes1000").textContent = formatNumber(scenario.above1000, 1);
    $("#minutes2000").textContent = formatNumber(scenario.above2000, 1);
    $("#officeEquivalent").textContent = formatNumber(scenario.officeEquivalent, 2);
    $("#scenarioStatus").textContent = `${state.simulationDays} ${state.simulationDays === 1 ? "day" : "days"} · ${scenario.results.length} trips · ${scenario.totalDuration} driving min`;

    $("#warningList").innerHTML = scenario.warnings.length
      ? scenario.warnings.map((warning) => `<div class="warning-item">${warning}</div>`).join("")
      : `<div class="warning-item info">No major model-support warning was triggered by the current settings.</div>`;

    $("#trajectoryTitle").textContent = state.simulationDays === 1
      ? "Predicted daily in-vehicle CO₂ trajectory"
      : "Predicted seven-day in-vehicle CO₂ trajectory";
    $("#trajectorySubtitle").textContent = "The horizontal axis is cumulative driving time; parking durations are excluded.";
    renderTrajectoryChart(scenario);
    renderContributionBars(scenario);

    $("#resultRows").innerHTML = scenario.results.map((item) => `
      <tr>
        <td><strong>${state.simulationDays === 1 ? `Trip ${item.tripIndex + 1}` : `Day ${item.day} · Trip ${item.tripIndex + 1}`}</strong><br><span style="color:#61706b">${item.duration} min · ${item.ventilation}</span></td>
        <td>${formatNumber(item.initial)} ppm${item.overrideEnabled && item.tripIndex > 0 ? "*" : ""}</td>
        <td>${formatNumber(item.end)} ppm</td>
        <td>${formatNumber(item.mean)} ppm</td>
        <td>${formatNumber(item.exposure)} ppm·min</td>
        <td>${formatNumber(item.above1000, 1)} min</td>
        <td>${formatNumber(item.above2000, 1)} min</td>
        <td>${item.highStartProbability == null ? "—" : `${formatNumber(item.highStartProbability * 100, 1)}%`}</td>
      </tr>
    `).join("");
  }

  function render() {
    firstInitialInput.value = state.firstInitial;
    simulationDaysInput.value = String(state.simulationDays);
    overnightDurationInput.value = state.overnightDuration / 60;
    overnightEnvironmentInput.value = state.overnightEnvironment;
    overnightSettings.hidden = state.simulationDays === 1;
    renderTrips();
    try {
      renderResults(calculateScenario());
    } catch (error) {
      $("#warningList").innerHTML = `<div class="warning-item">Calculation failed: ${error.message}</div>`;
      console.error(error);
    }
  }

  firstInitialInput.addEventListener("change", () => {
    state.firstInitial = Number(firstInitialInput.value);
    render();
  });

  const updateSimulationPeriod = () => {
    state.simulationDays = Number(simulationDaysInput.value);
    render();
  };

  simulationDaysInput.addEventListener("change", updateSimulationPeriod);
  simulationDaysInput.addEventListener("input", updateSimulationPeriod);

  overnightDurationInput.addEventListener("change", () => {
    state.overnightDuration = Number(overnightDurationInput.value) * 60;
    render();
  });

  overnightEnvironmentInput.addEventListener("change", () => {
    state.overnightEnvironment = overnightEnvironmentInput.value;
    render();
  });

  $("#addTrip").addEventListener("click", () => {
    const previous = state.trips.at(-1);
    state.trips.push({
      id: createId(),
      duration: 20,
      occupancy: previous?.occupancy ?? "1 occupant",
      ventilation: previous?.ventilation ?? "Auto",
      vehicleType: previous?.vehicleType ?? "Sedan",
      parkingDuration: 60,
      parkingEnvironment: "Likely outdoor",
      overrideEnabled: false,
      overrideInitial: 800,
    });
    render();
  });

  $("#resetScenario").addEventListener("click", () => {
    state.firstInitial = 600;
    state.simulationDays = 1;
    state.overnightDuration = 720;
    state.overnightEnvironment = "Likely outdoor";
    state.trips = defaultTrips();
    render();
  });

  $("#modelMeta").textContent = `GAMM: ${model.gamm.trips} trips / ${model.gamm.vehicles} vehicles · Inter-trip: ${model.intertrip_continuous.sample_pairs} pairs`;
  window.TRDExposureCalculator = { calculateScenario, state };
  render();
})();
