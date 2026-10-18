/* Chart.js setup for the dyno sheet and the log overview. Requires Chart.js 4. */
(function (root) {
  'use strict';

  function token(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // Vertical hairline that follows the hovered RPM.
  const crosshair = {
    id: 'crosshair',
    afterDatasetsDraw(chart) {
      const active = chart.tooltip && chart.tooltip.getActiveElements();
      if (!active || !active.length) return;
      const x = active[0].element.x;
      const { top, bottom } = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.lineWidth = 1;
      ctx.strokeStyle = token('--axis');
      ctx.stroke();
      ctx.restore();
    }
  };

  // Dot + value label on each dataset's peak (dataset.peak = { index, text }).
  const peakLabels = {
    id: 'peakLabels',
    afterDatasetsDraw(chart, _args, opts) {
      if (!opts.enabled) return;
      const ctx = chart.ctx;
      const area = chart.chartArea;
      const placed = [];
      ctx.save();
      ctx.font = '600 12px ' + Chart.defaults.font.family;
      ctx.textBaseline = 'bottom';
      chart.data.datasets.forEach((ds, i) => {
        if (!ds.peak || !chart.isDatasetVisible(i)) return;
        const el = chart.getDatasetMeta(i).data[ds.peak.index];
        if (!el) return;
        const { x, y } = el;

        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = ds.borderColor;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = token('--surface-1');
        ctx.stroke();

        const w = ctx.measureText(ds.peak.text).width;
        const h = 14;
        let lx = Math.min(Math.max(x - w / 2, area.left + 2), area.right - w - 2);
        let ly = y - 8;
        const hits = box => placed.some(p => box.x < p.x + p.w && p.x < box.x + box.w && box.y - h < p.y && p.y - h < box.y);
        let box = { x: lx, y: ly, w };
        for (let n = 0; n < 6 && hits(box); n++) box = { x: lx, y: (ly -= h + 2), w };
        if (ly - h < area.top) ly = y + h + 8;
        placed.push({ x: lx, y: ly, w });

        ctx.lineWidth = 3;
        ctx.strokeStyle = token('--surface-1');
        ctx.strokeText(ds.peak.text, lx, ly);
        ctx.fillStyle = token('--text-primary');
        ctx.fillText(ds.peak.text, lx, ly);
      });
      ctx.restore();
    }
  };

  // Shaded time window (chart.$selection) and in-progress drag (chart.$brush).
  const selection = {
    id: 'selection',
    beforeDatasetsDraw(chart) {
      const x = chart.scales.x;
      const area = chart.chartArea;
      const ctx = chart.ctx;
      const draw = (range, fill, edge) => {
        const a = Math.max(area.left, x.getPixelForValue(Math.min(range.a, range.b)));
        const b = Math.min(area.right, x.getPixelForValue(Math.max(range.a, range.b)));
        if (b <= a) return;
        ctx.fillStyle = fill;
        ctx.fillRect(a, area.top, b - a, area.bottom - area.top);
        if (!edge) return;
        ctx.strokeStyle = edge;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(a + 0.5, area.top); ctx.lineTo(a + 0.5, area.bottom);
        ctx.moveTo(b - 0.5, area.top); ctx.lineTo(b - 0.5, area.bottom);
        ctx.stroke();
      };
      ctx.save();
      if (chart.$selection) draw(chart.$selection, token('--select-fill'), token('--text-secondary'));
      if (chart.$brush) draw(chart.$brush, token('--select-fill'), null);
      ctx.restore();
    }
  };

  function applyDefaults() {
    Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
    Chart.defaults.font.size = 12;
  }

  function tooltipTheme() {
    return {
      backgroundColor: token('--surface-1'),
      titleColor: token('--text-primary'),
      bodyColor: token('--text-primary'),
      borderColor: token('--border-strong'),
      borderWidth: 1,
      padding: 10,
      boxPadding: 6,
      usePointStyle: true,
      titleFont: { weight: '600' }
    };
  }

  function axisTheme(axis, withGrid) {
    axis.ticks = Object.assign(axis.ticks || {}, { color: token('--text-muted') });
    axis.title = Object.assign(axis.title || {}, { color: token('--text-secondary') });
    axis.border = { color: token('--axis') };
    axis.grid = Object.assign(axis.grid || {}, withGrid
      ? { color: token('--grid'), drawOnChartArea: true }
      : { drawOnChartArea: false, color: token('--grid') });
  }

  function createDynoChart(canvas) {
    applyDefaults();
    return new Chart(canvas, {
      type: 'line',
      data: { datasets: [] },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        normalized: true,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        elements: {
          point: { radius: 0, hoverRadius: 4, hoverBorderWidth: 2 },
          line: { borderWidth: 2, cubicInterpolationMode: 'monotone', borderCapStyle: 'round' }
        },
        scales: {
          x: { type: 'linear', title: { display: true, text: 'Engine speed (rpm)' }, ticks: { maxRotation: 0 } },
          yPower: { type: 'linear', position: 'left', min: 0, title: { display: true } },
          yTorque: { type: 'linear', position: 'right', min: 0, title: { display: true } }
        },
        plugins: {
          legend: { display: false },
          peakLabels: { enabled: true },
          tooltip: {}
        }
      },
      plugins: [crosshair, peakLabels]
    });
  }

  function createOverviewChart(canvas, onSelect) {
    applyDefaults();
    const chart = new Chart(canvas, {
      type: 'line',
      data: { datasets: [] },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        normalized: true,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        elements: { point: { radius: 0, hoverRadius: 3 }, line: { borderWidth: 1.5 } },
        scales: {
          x: { type: 'linear', title: { display: true, text: 'Time (s)' }, ticks: { maxRotation: 0 } },
          yRpm: { type: 'linear', position: 'left', stack: 'overview', stackWeight: 1, title: { display: true, text: 'rpm' } },
          yTq: { type: 'linear', position: 'left', stack: 'overview', stackWeight: 1, title: { display: true, text: 'Nm' } }
        },
        plugins: { legend: { display: false }, tooltip: {} }
      },
      plugins: [selection, crosshair]
    });

    // Drag across the chart to pick a time window.
    const valueAt = e => {
      const rect = canvas.getBoundingClientRect();
      const x = chart.scales.x;
      const v = x.getValueForPixel(e.clientX - rect.left);
      return Math.min(Math.max(v, x.min), x.max);
    };
    canvas.addEventListener('pointerdown', e => {
      if (!chart.data.datasets.length) return;
      const v = valueAt(e);
      chart.$brush = { a: v, b: v };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', e => {
      if (!chart.$brush) return;
      chart.$brush.b = valueAt(e);
      chart.draw();
    });
    const finish = () => {
      if (!chart.$brush) return;
      const a = Math.min(chart.$brush.a, chart.$brush.b);
      const b = Math.max(chart.$brush.a, chart.$brush.b);
      chart.$brush = null;
      if (b - a >= 0.3) onSelect(a, b);
      else chart.draw();
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', finish);
    return chart;
  }

  function niceStep(raw) {
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / mag;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
  }

  // Power and torque share one numeric scale, like a classic dyno sheet. Because power
  // is derived from torque, the curves then always cross where the numbers are equal
  // (5,252 rpm for HP and lb-ft) instead of wherever two independent axes happen to land.
  function sharedAxis(maxValue) {
    let best = null;
    for (let n = 5; n <= 8; n++) {
      const step = niceStep((maxValue * 1.08) / n);
      if (!best || step * n < best.max) best = { max: step * n, step };
    }
    return best;
  }

  root.DynoChart = { token, tooltipTheme, axisTheme, createDynoChart, createOverviewChart, sharedAxis };
})(window);
