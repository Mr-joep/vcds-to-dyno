/*
 * Turns aligned RPM/torque samples into dyno curves.
 * Works in the browser (window.DynoProcess) and in Node.
 */
(function (root) {
  'use strict';

  // Power = torque x angular speed. Divisors give power from Nm x rpm.
  const POWER_UNITS = {
    hp: { label: 'HP', divisor: 7120.91 },  // 745.7 W mechanical horsepower
    ps: { label: 'PS', divisor: 7023.52 },  // 735.5 W metric horsepower
    kw: { label: 'kW', divisor: 9549.30 }
  };
  const TORQUE_UNITS = {
    nm: { label: 'Nm', factor: 1 },
    lbft: { label: 'lb-ft', factor: 0.737562 }
  };

  const PULL = {
    torqueShare: 0.5,  // samples below this share of the log's peak torque are off-throttle
    peakShare: 0.9,    // a pull must reach close to the log's peak torque
    maxDip: 75,        // rpm the engine may sag without ending the pull
    maxGap: 1.5,       // seconds without data that end a pull
    maxBadRun: 2,      // consecutive low-torque glitches tolerated inside a pull
    minSpan: 1500,     // rpm; part-throttle accelerations in normal driving are shorter
    minEndRpm: 3000,   // a dyno pull runs well past the torque peak
    minPoints: 8
  };

  function power(nm, rpm, unit) {
    return nm * rpm / POWER_UNITS[unit].divisor;
  }

  function sortByTime(series) {
    let sorted = true;
    for (let i = 1; i < series.t.length && sorted; i++) sorted = series.t[i] >= series.t[i - 1];
    if (sorted) return series;
    const order = series.t.map((_, i) => i).sort((a, b) => series.t[a] - series.t[b]);
    return { t: order.map(i => series.t[i]), v: order.map(i => series.v[i]) };
  }

  // Pairs each RPM sample with the torque at that moment (interpolated when the
  // two values were logged on different timestamps).
  function align(rpmSeries, torqueSeries) {
    const r = sortByTime(rpmSeries);
    const q = sortByTime(torqueSeries);
    const out = { t: [], rpm: [], tq: [] };
    let j = 0;
    for (let i = 0; i < r.t.length; i++) {
      const t = r.t[i];
      while (j < q.t.length - 1 && q.t[j + 1] <= t) j++;
      let value;
      if (q.t[j] === t) value = q.v[j];
      else if (q.t[j] < t && j < q.t.length - 1) {
        const k = (t - q.t[j]) / (q.t[j + 1] - q.t[j]);
        value = q.v[j] + k * (q.v[j + 1] - q.v[j]);
      } else continue;
      out.t.push(t);
      out.rpm.push(r.v[i]);
      out.tq.push(value);
    }
    return out;
  }

  // Finds the widest stretch where RPM climbs steadily under high torque.
  function detectPull(s) {
    const n = s.t.length;
    if (n < PULL.minPoints) return null;
    let peakTq = -Infinity;
    for (let i = 0; i < n; i++) if (s.tq[i] > peakTq) peakTq = s.tq[i];
    if (!(peakTq > 0)) return null;
    const threshold = peakTq * PULL.torqueShare;

    const pulls = [];
    let start = -1, lastGood = -1, top = 0, bad = 0;

    const close = () => {
      if (start < 0) return;
      let end = start;
      for (let i = start; i <= lastGood; i++) if (s.rpm[i] >= s.rpm[end]) end = i;
      let begin = start;
      for (let i = start; i <= end; i++) if (s.rpm[i] < s.rpm[begin]) begin = i;
      let maxTq = -Infinity;
      for (let i = begin; i <= end; i++) if (s.tq[i] > maxTq) maxTq = s.tq[i];
      const span = s.rpm[end] - s.rpm[begin];
      if (span >= PULL.minSpan && s.rpm[end] >= PULL.minEndRpm && end - begin + 1 >= PULL.minPoints) {
        pulls.push({ t0: s.t[begin], t1: s.t[end], rpm0: s.rpm[begin], rpm1: s.rpm[end], span, maxTq });
      }
      start = -1;
    };
    const open = i => { start = i; lastGood = i; top = s.rpm[i]; bad = 0; };

    for (let i = 0; i < n; i++) {
      const good = s.tq[i] >= threshold;
      if (start < 0) {
        if (good) open(i);
        continue;
      }
      const gap = s.t[i] - s.t[i - 1] > PULL.maxGap;
      const falling = s.rpm[i] < top - PULL.maxDip;
      if (gap || falling) {
        close();
        if (good) open(i);
      } else if (good) {
        lastGood = i;
        bad = 0;
        if (s.rpm[i] > top) top = s.rpm[i];
      } else if (++bad > PULL.maxBadRun) {
        close();
      }
    }
    close();

    const candidates = pulls.filter(p => p.maxTq >= peakTq * PULL.peakShare);
    if (!candidates.length) return null;
    return candidates.reduce((a, b) => (b.span > a.span ? b : a));
  }

  function median(values) {
    const v = values.slice().sort((a, b) => a - b);
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }

  // Drops single-sample torque dropouts (e.g. a 0.0 Nm read mid-pull).
  function dropGlitches(points) {
    return points.filter((p, i) => {
      const around = points.slice(Math.max(0, i - 3), i + 4).map(q => q.tq);
      return p.tq >= 0.6 * median(around);
    });
  }

  function smooth(values, half) {
    if (half <= 0) return values.slice();
    return values.map((_, i) => {
      const k = Math.min(half, i, values.length - 1 - i);
      let sum = 0;
      for (let j = i - k; j <= i + k; j++) sum += values[j];
      return sum / (2 * k + 1);
    });
  }

  /*
   * opts.mode    'pull'     -> average torque per RPM step (one clean WOT pull)
   *              'envelope' -> highest torque per RPM step (general driving logs)
   * opts.window  { t0, t1 } in seconds, or null for the whole log
   * opts.bin     RPM step size
   * opts.smooth  moving-average half-width in steps (0 = off)
   * Returns { rpm: [], tq: [] } with torque in Nm, or null when nothing is left.
   */
  function buildCurve(samples, opts) {
    const win = opts.window;
    let points = [];
    for (let i = 0; i < samples.t.length; i++) {
      if (win && (samples.t[i] < win.t0 || samples.t[i] > win.t1)) continue;
      if (samples.rpm[i] <= 0) continue;
      points.push({ rpm: samples.rpm[i], tq: samples.tq[i] });
    }
    if (opts.mode === 'pull') points = dropGlitches(points);
    if (points.length < 2) return null;

    const bin = opts.bin;
    const bins = new Map();
    for (const p of points) {
      const key = Math.round(p.rpm / bin);
      const b = bins.get(key) || { sum: 0, n: 0, max: -Infinity };
      b.sum += p.tq;
      b.n++;
      if (p.tq > b.max) b.max = p.tq;
      bins.set(key, b);
    }
    const keys = [...bins.keys()].sort((a, b) => a - b);
    const first = keys[0], last = keys[keys.length - 1];
    if (first === last) return null;

    // Fast pulls at a low sample rate skip RPM steps; fill those by interpolation.
    const rpm = [], tq = [];
    let prevKey = null;
    for (const key of keys) {
      const b = bins.get(key);
      const value = opts.mode === 'pull' ? b.sum / b.n : b.max;
      if (prevKey !== null && key - prevKey > 1) {
        const prevValue = tq[tq.length - 1];
        for (let k = prevKey + 1; k < key; k++) {
          rpm.push(k * bin);
          tq.push(prevValue + (value - prevValue) * (k - prevKey) / (key - prevKey));
        }
      }
      rpm.push(key * bin);
      tq.push(value);
      prevKey = key;
    }
    return { rpm, tq: smooth(tq, opts.smooth) };
  }

  function peaks(curve, powerUnit) {
    let p = 0, t = 0;
    const pw = curve.rpm.map((r, i) => power(curve.tq[i], r, powerUnit));
    for (let i = 1; i < pw.length; i++) {
      if (pw[i] > pw[p]) p = i;
      if (curve.tq[i] > curve.tq[t]) t = i;
    }
    return {
      power: { value: pw[p], rpm: curve.rpm[p], index: p },
      torque: { value: curve.tq[t], rpm: curve.rpm[t], index: t }
    };
  }

  const api = { POWER_UNITS, TORQUE_UNITS, power, align, detectPull, buildCurve, peaks };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DynoProcess = api;
})(typeof window !== 'undefined' ? window : globalThis);
