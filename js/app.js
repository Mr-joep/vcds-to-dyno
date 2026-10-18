/* VCDS Dyno page: state, UI wiring and PNG export. */
(function () {
  'use strict';

  const $ = sel => document.querySelector(sel);

  if (typeof Chart === 'undefined') {
    const msg = $('#message');
    msg.hidden = false;
    msg.textContent = 'The chart library could not be loaded. The page needs an internet connection the first time it opens.';
    return;
  }

  const P = window.VcdsParser;
  const D = window.DynoProcess;
  const C = window.DynoChart;

  const MAX_RUNS = 8;
  const SETTINGS_KEY = 'vcds-dyno-settings';
  const NO_PULL_TEXT = 'No full-throttle pull was found, so this shows the highest torque recorded at each RPM. ' +
    'For a real dyno curve, log a full-throttle pull in 3rd gear from about 1,500 rpm to the limiter.';

  const ICONS = {
    eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
    eyeOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4l16 16M9.9 6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.6M6.6 7.6A16.7 16.7 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.4-1.1" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    remove: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
  };

  const fmt0 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const fmt1 = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  const settings = Object.assign({
    powerUnit: 'hp', torqueUnit: 'nm', smooth: 3, bin: 100,
    showPower: true, showTorque: true, showPeaks: true
  }, loadSettings());

  const state = { runs: [], selectedId: null, nextId: 1, titleTouched: false, notesTouched: false };

  const dyno = C.createDynoChart($('#dyno-chart'));
  const overview = C.createOverviewChart($('#overview-chart'), onBrush);

  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* storage unavailable */ }
  }

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) Object.assign(node, props);
    if (children) node.append(...children);
    return node;
  }

  function seriesColor(slot) {
    return C.token('--series-' + slot);
  }

  function showMessage(text, kind) {
    const msg = $('#message');
    msg.hidden = !text;
    msg.textContent = text || '';
    msg.className = 'message' + (kind ? ' ' + kind : '');
  }

  /* ---------- Loading logs ---------- */

  async function readText(file) {
    const buf = await file.arrayBuffer();
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch (e) {
      return new TextDecoder('windows-1252').decode(buf);
    }
  }

  async function addFiles(fileList) {
    const files = [...fileList].filter(f => /\.(csv|txt)$/i.test(f.name) || f.type === 'text/csv');
    if (!files.length) {
      showMessage('Drop a VCDS log in .csv format.');
      return;
    }
    const problems = [];
    for (const file of files) {
      if (state.runs.length >= MAX_RUNS) {
        problems.push(`Only ${MAX_RUNS} runs fit on one sheet, so ${file.name} was skipped.`);
        continue;
      }
      try {
        const log = P.parse(await readText(file));
        const run = createRun(file.name, log);
        state.runs.push(run);
        state.selectedId = run.id;
        prefillSheet(log.meta);
        if (run.rpmCol < 0 || run.tqCol < 0) {
          problems.push(`Engine speed and torque weren't found in ${file.name}. Pick the columns in its run card.`);
        }
      } catch (err) {
        problems.push(`${file.name}: ${err.message}`);
      }
    }
    showMessage(problems.join(' '));
    renderAll();
  }

  function createRun(fileName, log) {
    const used = new Set(state.runs.map(r => r.slot));
    let slot = 1;
    while (used.has(slot)) slot++;
    const cols = P.detectColumns(log.columns);
    const run = {
      id: state.nextId++,
      slot,
      name: fileName.replace(/\.[^.]+$/, ''),
      log,
      rpmCol: cols.rpm,
      tqCol: cols.torque,
      visible: true
    };
    analyse(run);
    return run;
  }

  // Rebuilds the aligned samples and looks for a full-throttle pull.
  function analyse(run) {
    run.samples = null;
    run.pull = null;
    run.window = null;
    run.mode = 'envelope';
    if (run.rpmCol < 0 || run.tqCol < 0) return;
    const cols = run.log.columns;
    run.samples = D.align(P.getSeries(run.log, cols[run.rpmCol]), P.getSeries(run.log, cols[run.tqCol]));
    run.pull = D.detectPull(run.samples);
    if (run.pull) {
      run.mode = 'pull';
      run.window = { t0: run.pull.t0, t1: run.pull.t1 };
    }
  }

  function curveOf(run) {
    if (!run.samples || !run.samples.t.length) return null;
    return D.buildCurve(run.samples, { mode: run.mode, window: run.window, bin: settings.bin, smooth: settings.smooth });
  }

  function prefillSheet(meta) {
    const title = $('#sheet-title');
    const notes = $('#sheet-notes');
    if (!state.titleTouched && !title.textContent.trim()) title.textContent = 'Dyno sheet';
    if (!state.notesTouched && !notes.textContent.trim()) {
      notes.textContent = [meta.ecu, meta.part && 'ECU ' + meta.part, meta.date && 'logged ' + meta.date]
        .filter(Boolean).join(' · ');
    }
  }

  function removeRun(run) {
    state.runs = state.runs.filter(r => r !== run);
    if (state.selectedId === run.id) {
      const last = state.runs[state.runs.length - 1];
      state.selectedId = last ? last.id : null;
    }
    showMessage('');
    renderAll();
  }

  function selectRun(id) {
    if (state.selectedId === id) return;
    state.selectedId = id;
    document.querySelectorAll('.run').forEach(n => n.classList.toggle('is-selected', Number(n.dataset.id) === id));
    renderOverview();
  }

  /* ---------- Rendering ---------- */

  function renderAll() {
    const curves = new Map(state.runs.map(r => [r.id, curveOf(r)]));
    renderRuns(curves);
    renderSheet(curves);
    renderOverview();
  }

  function renderRuns(curves) {
    $('#runs-empty').hidden = state.runs.length > 0;
    $('#run-list').replaceChildren(...state.runs.map(run => runCard(run, curves.get(run.id))));
    $('#save-png').disabled = !state.runs.length;
  }

  function columnSelect(run, current, label, onPick) {
    const select = el('select');
    select.setAttribute('aria-label', label + ' column for ' + run.name);
    select.append(el('option', { value: '-1', textContent: 'Choose a column' }));
    run.log.columns.forEach((c, i) => {
      select.append(el('option', { value: String(i), textContent: c.unit ? `${c.name} (${c.unit})` : c.name }));
    });
    select.value = String(current);
    select.addEventListener('change', () => onPick(Number(select.value)));
    return el('label', null, [document.createTextNode(label), select]);
  }

  function runCard(run, curve) {
    const li = el('li', { className: 'run' });
    li.dataset.id = run.id;
    li.classList.toggle('is-selected', run.id === state.selectedId);
    li.classList.toggle('is-hidden', !run.visible);
    li.style.setProperty('--c', `var(--series-${run.slot})`);
    li.addEventListener('click', () => selectRun(run.id));

    const name = el('input', { className: 'run-name', value: run.name, type: 'text' });
    name.setAttribute('aria-label', 'Run name');
    name.addEventListener('input', () => {
      run.name = name.value;
      renderSheet(new Map(state.runs.map(r => [r.id, curveOf(r)])));
      if (run.id === state.selectedId) $('#overview-run').textContent = '· ' + run.name;
    });

    const eye = el('button', { type: 'button', className: 'icon-btn', innerHTML: run.visible ? ICONS.eye : ICONS.eyeOff });
    eye.setAttribute('aria-label', run.visible ? 'Hide run on the sheet' : 'Show run on the sheet');
    eye.setAttribute('aria-pressed', String(run.visible));
    eye.title = run.visible ? 'Hide' : 'Show';
    eye.addEventListener('click', () => { run.visible = !run.visible; renderAll(); });

    const remove = el('button', { type: 'button', className: 'icon-btn', innerHTML: ICONS.remove, title: 'Remove' });
    remove.setAttribute('aria-label', 'Remove run');
    remove.addEventListener('click', e => { e.stopPropagation(); removeRun(run); });

    li.append(el('div', { className: 'run-row' }, [el('span', { className: 'run-key' }), name, eye, remove]));

    if (run.samples) {
      const range = curve
        ? `${fmt0.format(curve.rpm[0])}–${fmt0.format(curve.rpm[curve.rpm.length - 1])} rpm`
        : 'no data in the selected window';
      const span = run.window ? `${fmt1.format(run.window.t0)}–${fmt1.format(run.window.t1)} s` : 'whole log';
      li.append(el('p', { className: 'run-status' }, [
        el('span', { className: 'badge', textContent: run.mode === 'pull' ? 'Pull' : 'Envelope' }),
        document.createTextNode(`${range} · ${span}`)
      ]));
    }

    if (run.rpmCol < 0 || run.tqCol < 0) {
      li.append(el('p', { className: 'run-warn error', textContent: 'Pick the engine speed and torque columns below.' }));
    } else if (!run.pull) {
      li.append(el('p', { className: 'run-warn', textContent: NO_PULL_TEXT }));
    }

    const mode = el('select');
    mode.setAttribute('aria-label', 'Curve mode for ' + run.name);
    mode.append(
      el('option', { value: 'pull', textContent: 'Pull (average per step)' }),
      el('option', { value: 'envelope', textContent: 'Envelope (highest per step)' })
    );
    mode.value = run.mode;
    mode.addEventListener('change', () => {
      run.mode = mode.value;
      if (run.mode === 'pull' && !run.window && run.pull) run.window = { t0: run.pull.t0, t1: run.pull.t1 };
      renderAll();
    });

    li.append(el('div', { className: 'run-fields' }, [
      el('label', null, [document.createTextNode('Mode'), mode]),
      columnSelect(run, run.rpmCol, 'RPM', i => { run.rpmCol = i; analyse(run); renderAll(); }),
      columnSelect(run, run.tqCol, 'Torque', i => { run.tqCol = i; analyse(run); renderAll(); })
    ]));
    return li;
  }

  function renderSheet(curves) {
    const pu = D.POWER_UNITS[settings.powerUnit];
    const tu = D.TORQUE_UNITS[settings.torqueUnit];
    const surface = C.token('--surface-1');
    const datasets = [];
    const rows = [];
    let maxP = 0, maxT = 0, minR = Infinity, maxR = -Infinity;

    for (const run of state.runs) {
      const curve = run.visible ? curves.get(run.id) : null;
      if (!curve) continue;
      const color = seriesColor(run.slot);
      const pk = D.peaks(curve, settings.powerUnit);
      const common = {
        runName: run.name,
        borderColor: color,
        backgroundColor: color,
        pointHoverBackgroundColor: color,
        pointHoverBorderColor: surface
      };
      if (settings.showPower) {
        datasets.push(Object.assign({}, common, {
          label: run.name + ' power',
          kind: 'power',
          unit: pu.label,
          yAxisID: 'yPower',
          data: curve.rpm.map((r, i) => ({ x: r, y: D.power(curve.tq[i], r, settings.powerUnit) })),
          peak: { index: pk.power.index, text: `${fmt1.format(pk.power.value)} ${pu.label}` }
        }));
      }
      if (settings.showTorque) {
        datasets.push(Object.assign({}, common, {
          label: run.name + ' torque',
          kind: 'torque',
          unit: tu.label,
          yAxisID: 'yTorque',
          borderDash: [7, 4],
          data: curve.rpm.map((r, i) => ({ x: r, y: curve.tq[i] * tu.factor })),
          peak: { index: pk.torque.index, text: `${fmt1.format(pk.torque.value * tu.factor)} ${tu.label}` }
        }));
      }
      maxP = Math.max(maxP, pk.power.value);
      maxT = Math.max(maxT, pk.torque.value * tu.factor);
      minR = Math.min(minR, curve.rpm[0]);
      maxR = Math.max(maxR, curve.rpm[curve.rpm.length - 1]);
      rows.push({ run, pk });
    }

    const hasData = rows.length > 0;
    const o = dyno.config.options;  // raw config; chart.options is a resolver proxy
    const x = o.scales.x, yP = o.scales.yPower, yT = o.scales.yTorque;

    // Both y axes get the same range; an empty sheet still shows a believable grid.
    const ax = C.sharedAxis(hasData
      ? Math.max(maxP, maxT, 1)
      : Math.max(150 * D.POWER_UNITS.ps.divisor / pu.divisor, 250 * tu.factor));
    yP.max = yT.max = ax.max;
    yP.ticks = { stepSize: ax.step };
    yT.ticks = { stepSize: ax.step };
    x.min = hasData ? Math.floor(minR / 500) * 500 : 1000;
    x.max = hasData ? Math.ceil(maxR / 500) * 500 : 7000;
    const xRange = x.max - x.min;
    x.ticks = { maxRotation: 0, stepSize: xRange <= 2500 ? 250 : xRange <= 6000 ? 500 : 1000, callback: v => fmt0.format(v) };

    yP.display = settings.showPower;
    yT.display = settings.showTorque;
    yP.title.text = `Power (${pu.label})`;
    yT.title.text = `Torque (${tu.label})`;
    C.axisTheme(x, true);
    C.axisTheme(yP, settings.showPower);
    C.axisTheme(yT, !settings.showPower);
    yP.title.display = yT.title.display = true;

    o.plugins.peakLabels.enabled = settings.showPeaks;
    o.plugins.tooltip = Object.assign(C.tooltipTheme(), {
      callbacks: {
        title: items => `${fmt0.format(items[0].parsed.x)} rpm`,
        label: item => `${fmt1.format(item.parsed.y)} ${item.dataset.unit}   ${item.dataset.runName} ${item.dataset.kind}`,
        labelPointStyle: () => ({ pointStyle: 'line', rotation: 0 }),
        labelColor: item => ({ borderColor: item.dataset.borderColor, backgroundColor: item.dataset.borderColor, borderWidth: 3 })
      }
    });
    dyno.data.datasets = datasets;
    dyno.update('none');

    const empty = $('#chart-empty');
    empty.hidden = hasData;
    empty.textContent = state.runs.length
      ? 'Nothing to draw yet: show a run, or choose its columns or time window'
      : 'Drop a VCDS log to draw the curves';

    $('#sheet-key').hidden = !hasData;
    $('#sheet-key').children[0].hidden = !settings.showPower;
    $('#sheet-key').children[1].hidden = !settings.showTorque;

    const table = $('#peaks');
    table.hidden = !hasData;
    table.tBodies[0].replaceChildren(...rows.map(({ run, pk }) => el('tr', null, [
      el('td', null, [el('span', { className: 'run-cell' }, [
        keyLine(run.slot), document.createTextNode(run.name)
      ])]),
      el('td', null, [
        el('strong', { textContent: `${fmt1.format(pk.power.value)} ${pu.label}` }),
        el('span', { className: 'at', textContent: ` @ ${fmt0.format(pk.power.rpm)} rpm` })
      ]),
      el('td', null, [
        el('strong', { textContent: `${fmt1.format(pk.torque.value * tu.factor)} ${tu.label}` }),
        el('span', { className: 'at', textContent: ` @ ${fmt0.format(pk.torque.rpm)} rpm` })
      ]),
      el('td', { textContent: run.mode === 'pull' ? 'Pull' : 'Envelope' })
    ])));

    $('#sheet-settings').textContent =
      `Smoothing ${settings.smooth || 'off'} · ${settings.bin} rpm steps`;

    renderDataTable(curves, pu, tu);
  }

  function keyLine(slot) {
    const key = el('span', { className: 'run-key' });
    key.style.setProperty('--c', `var(--series-${slot})`);
    return key;
  }

  function renderDataTable(curves, pu, tu) {
    const runs = state.runs.filter(r => r.visible && curves.get(r.id));
    const panel = $('#data-panel');
    panel.hidden = !runs.length;
    if (!runs.length) return;

    const rpms = [...new Set(runs.flatMap(r => curves.get(r.id).rpm))].sort((a, b) => a - b);
    const lookup = runs.map(r => {
      const c = curves.get(r.id);
      return new Map(c.rpm.map((rpm, i) => [rpm, c.tq[i]]));
    });

    const head = el('tr', null, [el('th', { textContent: 'RPM' })]);
    runs.forEach(r => head.append(
      el('th', { textContent: `${r.name} power (${pu.label})` }),
      el('th', { textContent: `${r.name} torque (${tu.label})` })
    ));
    const body = rpms.map(rpm => {
      const tr = el('tr', null, [el('td', { textContent: fmt0.format(rpm) })]);
      lookup.forEach(m => {
        const tq = m.get(rpm);
        const has = tq !== undefined;
        tr.append(
          el('td', { textContent: has ? fmt1.format(D.power(tq, rpm, settings.powerUnit)) : '' }),
          el('td', { textContent: has ? fmt1.format(tq * tu.factor) : '' })
        );
      });
      return tr;
    });
    $('#data-table').replaceChildren(el('thead', null, [head]), el('tbody', null, body));
  }

  function renderOverview() {
    const run = state.runs.find(r => r.id === state.selectedId);
    const panel = $('#overview');
    panel.hidden = !run || !run.samples || !run.samples.t.length;
    if (panel.hidden) return;

    const tu = D.TORQUE_UNITS[settings.torqueUnit];
    const s = run.samples;
    const color = seriesColor(run.slot);
    $('#overview-run').textContent = '· ' + run.name;

    overview.data.datasets = [
      { label: 'Engine speed', unit: 'rpm', digits: 0, yAxisID: 'yRpm', borderColor: color, backgroundColor: color,
        data: s.t.map((t, i) => ({ x: t, y: s.rpm[i] })) },
      { label: 'Engine torque', unit: tu.label, digits: 1, yAxisID: 'yTq', borderColor: color, backgroundColor: color,
        data: s.t.map((t, i) => ({ x: t, y: s.tq[i] * tu.factor })) }
    ];
    overview.$selection = run.window ? { a: run.window.t0, b: run.window.t1 } : null;

    const o = overview.config.options;
    o.scales.x.min = Math.floor(s.t[0]);
    o.scales.x.max = Math.ceil(s.t[s.t.length - 1]);
    o.scales.yTq.title.text = tu.label;
    // The two panels share a border; headroom and a blank top label keep them apart.
    const panelTicks = { callback: (v, i, ticks) => (i === ticks.length - 1 ? '' : fmt0.format(v)) };
    o.scales.yRpm.ticks = Object.assign({}, panelTicks);
    o.scales.yTq.ticks = Object.assign({}, panelTicks);
    o.scales.yRpm.grace = o.scales.yTq.grace = '12%';
    o.scales.yRpm.min = o.scales.yTq.min = 0;
    C.axisTheme(o.scales.x, true);
    C.axisTheme(o.scales.yRpm, true);
    C.axisTheme(o.scales.yTq, true);
    o.plugins.tooltip = Object.assign(C.tooltipTheme(), {
      callbacks: {
        title: items => `${fmt1.format(items[0].parsed.x)} s`,
        label: item => `${(item.dataset.digits ? fmt1 : fmt0).format(item.parsed.y)} ${item.dataset.unit}   ${item.dataset.label}`,
        labelPointStyle: () => ({ pointStyle: 'line', rotation: 0 })
      }
    });
    overview.update('none');

    $('#win-start').value = run.window ? run.window.t0.toFixed(1) : '';
    $('#win-end').value = run.window ? run.window.t1.toFixed(1) : '';
    $('#win-start').placeholder = s.t[0].toFixed(1);
    $('#win-end').placeholder = s.t[s.t.length - 1].toFixed(1);
    $('#auto-pull').disabled = !run.pull;
    $('#auto-pull').title = run.pull ? '' : 'No full-throttle pull was found in this log';
  }

  function selectedRun() {
    return state.runs.find(r => r.id === state.selectedId);
  }

  function onBrush(t0, t1) {
    const run = selectedRun();
    if (!run) return;
    run.window = { t0, t1 };
    renderAll();
  }

  /* ---------- Controls ---------- */

  function syncToolbar() {
    document.querySelectorAll('.segmented').forEach(group => {
      const value = settings[group.dataset.setting];
      group.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.value === value)));
    });
    $('#smooth').value = settings.smooth;
    $('#smooth-out').textContent = settings.smooth ? String(settings.smooth) : 'off';
    $('#bin').value = String(settings.bin);
    $('#show-power').checked = settings.showPower;
    $('#show-torque').checked = settings.showTorque;
    $('#show-peaks').checked = settings.showPeaks;
  }

  function updateSetting(key, value) {
    settings[key] = value;
    saveSettings();
    syncToolbar();
    renderAll();
  }

  document.querySelectorAll('.segmented').forEach(group => {
    group.addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (btn) updateSetting(group.dataset.setting, btn.dataset.value);
    });
  });
  $('#smooth').addEventListener('input', e => updateSetting('smooth', Number(e.target.value)));
  $('#bin').addEventListener('change', e => updateSetting('bin', Number(e.target.value)));
  $('#show-power').addEventListener('change', e => updateSetting('showPower', e.target.checked));
  $('#show-torque').addEventListener('change', e => updateSetting('showTorque', e.target.checked));
  $('#show-peaks').addEventListener('change', e => updateSetting('showPeaks', e.target.checked));

  function onWindowInput() {
    const run = selectedRun();
    if (!run) return;
    const a = parseFloat($('#win-start').value.replace(',', '.'));
    const b = parseFloat($('#win-end').value.replace(',', '.'));
    if (isNaN(a) && isNaN(b)) run.window = null;
    else if (!isNaN(a) && !isNaN(b) && b > a) run.window = { t0: a, t1: b };
    else return;
    renderAll();
  }
  $('#win-start').addEventListener('change', onWindowInput);
  $('#win-end').addEventListener('change', onWindowInput);

  $('#auto-pull').addEventListener('click', () => {
    const run = selectedRun();
    if (!run || !run.pull) return;
    run.mode = 'pull';
    run.window = { t0: run.pull.t0, t1: run.pull.t1 };
    renderAll();
  });
  $('#whole-log').addEventListener('click', () => {
    const run = selectedRun();
    if (!run) return;
    run.window = null;
    renderAll();
  });

  // Title and notes: plain text only; Enter in the title finishes editing.
  [['#sheet-title', 'titleTouched'], ['#sheet-notes', 'notesTouched']].forEach(([sel, flag]) => {
    const node = $(sel);
    node.addEventListener('input', () => {
      state[flag] = true;
      if (!node.textContent.trim()) node.textContent = '';
    });
    node.addEventListener('paste', e => {
      e.preventDefault();
      document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
    });
  });
  $('#sheet-title').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
  });

  /* ---------- Drag & drop ---------- */

  const overlay = $('#drop-overlay');
  const zone = $('#dropzone');
  let dragDepth = 0;
  const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');

  window.addEventListener('dragenter', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    overlay.hidden = false;
    zone.classList.add('is-over');
  });
  window.addEventListener('dragover', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', e => {
    if (!hasFiles(e)) return;
    if (--dragDepth <= 0) {
      dragDepth = 0;
      overlay.hidden = true;
      zone.classList.remove('is-over');
    }
  });
  window.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    zone.classList.remove('is-over');
    addFiles(e.dataTransfer.files);
  });

  const input = $('#file-input');
  input.addEventListener('change', () => {
    addFiles(input.files);
    input.value = '';
  });

  /* ---------- PNG export ---------- */

  $('#save-png').addEventListener('click', async () => {
    const btn = $('#save-png');
    const sheet = $('#sheet');
    btn.disabled = true;
    dyno.tooltip.setActiveElements([], { x: 0, y: 0 });
    // Redraw the chart at export resolution so the PNG stays sharp.
    dyno.config.options.devicePixelRatio = Math.max(2, window.devicePixelRatio || 1);
    dyno.resize();
    dyno.update('none');
    sheet.classList.add('exporting');
    try {
      if (typeof html2canvas !== 'function') throw new Error('the export library could not be loaded.');
      const canvas = await html2canvas(sheet, { scale: 2, backgroundColor: C.token('--surface-1'), logging: false });
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const title = $('#sheet-title').textContent.trim() || 'dyno sheet';
      const link = el('a', {
        href: URL.createObjectURL(blob),
        download: title.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '-').slice(0, 80) + '.png'
      });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } catch (err) {
      showMessage('Could not save the PNG: ' + err.message);
    } finally {
      sheet.classList.remove('exporting');
      delete dyno.config.options.devicePixelRatio;
      dyno.resize();
      dyno.update('none');
      btn.disabled = !state.runs.length;
    }
  });

  // Follow the OS light/dark setting.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderAll);

  syncToolbar();
  renderAll();
})();
