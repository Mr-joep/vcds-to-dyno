/*
 * VCDS CSV log parser.
 * Handles Advanced Measuring Values logs (one STAMP column per value) and the
 * older group logs (one STAMP column per group of four values), comma- or
 * semicolon-separated. Works in the browser (window.VcdsParser) and in Node.
 */
(function (root) {
  'use strict';

  const RPM_NAME = /engine\s*speed|engine\s*rpm|motordrehzahl|drehzahl|r[ée]gime|\brpm\b/i;
  const RPM_UNIT = /^(\/min|1\/min|u\/min|rpm)$/i;
  const TORQUE_NAME = /torque|drehmoment|couple/i;
  const TORQUE_UNIT = /^nm$/i;
  const TIME_HEADER = /^(stamp|time)$/i;
  const NUMERIC = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

  function splitLine(line, delim) {
    if (line.indexOf('"') === -1) return line.split(delim);
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === delim) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }

  function countChar(str, ch) {
    let n = 0;
    for (let i = 0; i < str.length; i++) if (str[i] === ch) n++;
    return n;
  }

  // Excel re-saves CSVs with ';' and decimal commas in many European locales.
  function detectDelimiter(lines) {
    let comma = 0, semi = 0, tab = 0;
    for (const line of lines.slice(0, 40)) {
      comma += countChar(line, ',');
      semi += countChar(line, ';');
      tab += countChar(line, '\t');
    }
    if (semi > comma && semi >= tab) return ';';
    if (tab > comma && tab > semi) return '\t';
    return ',';
  }

  function toNumber(s, decimalComma) {
    if (s === undefined || s === null) return NaN;
    s = String(s).trim();
    if (!s) return NaN;
    if (decimalComma) s = s.replace(',', '.');
    return NUMERIC.test(s) ? parseFloat(s) : NaN;
  }

  function isDataRow(cells, decimalComma) {
    let filled = 0, numeric = 0;
    for (const c of cells) {
      if (!c.trim()) continue;
      filled++;
      if (!isNaN(toNumber(c, decimalComma))) numeric++;
    }
    return numeric >= 2 && numeric >= filled * 0.5;
  }

  function parseMeta(rows) {
    const meta = { date: '', time: '', vcds: '', ecu: '', part: '' };
    const first = (rows[0] || []).map(c => c.trim());
    if (first.length >= 5 && /day$/i.test(first[0])) {
      meta.date = [first[1], first[2], first[3]].join(' ');
      meta.time = (first[4].match(/^\d{1,2}:\d{2}(:\d{2})?/) || [''])[0];
    }
    const version = first.find(c => /VCDS Version/i.test(c));
    if (version) meta.vcds = version.replace(/.*VCDS Version:\s*/i, '');

    const second = (rows[1] || []).map(c => c.trim()).filter(Boolean);
    if (second.length && !second.some(c => /^G\d{3}$|group/i.test(c))) {
      const parts = second.filter(c => !/^ADV/i.test(c) && !/^\d{2}-/.test(c));
      meta.part = parts.find(c => /^[0-9A-Z]{3}\s?\d{3}\s?\d{3}/i.test(c)) || '';
      meta.ecu = parts.filter(c => c !== meta.part).join(' ').replace(/\s+/g, ' ');
    }
    return meta;
  }

  function parse(text) {
    text = text.replace(/^﻿/, '');
    const lines = text.split(/\r\n|\n|\r/);
    const delimiter = detectDelimiter(lines);
    const decimalComma = delimiter !== ',';
    const rows = lines.map(line => splitLine(line, delimiter));
    const scanEnd = Math.min(rows.length, 40);

    let namesRow = -1;
    for (let i = 0; i < scanEnd && namesRow < 0; i++) {
      if (rows[i].some(c => RPM_NAME.test(c) && isNaN(toNumber(c, decimalComma)))) namesRow = i;
    }
    if (namesRow < 0) {
      for (let i = 1; i < scanEnd && namesRow < 0; i++) {
        if (rows[i].some(c => RPM_UNIT.test(c.trim()))) namesRow = i - 1;
      }
    }

    let dataStart = -1;
    for (let i = Math.max(namesRow + 1, 0); i < rows.length; i++) {
      if (isDataRow(rows[i], decimalComma)) { dataStart = i; break; }
    }
    if (dataStart < 0) throw new Error('No measurement data found in this file.');
    if (namesRow < 0) namesRow = dataStart - 1;

    const unitsRow = namesRow + 1 < dataStart ? namesRow + 1 : -1;
    const headerRows = [namesRow - 1, namesRow, unitsRow].filter(r => r >= 0);
    const cell = (r, j) => ((rows[r] && rows[r][j]) || '').trim();
    const isTime = j => headerRows.some(r => TIME_HEADER.test(cell(r, j)));
    const isMarker = j => headerRows.some(r => /^marker$/i.test(cell(r, j)));

    const width = Math.max(rows[dataStart].length, ...headerRows.map(r => rows[r].length));
    const columns = [];
    for (let j = 0; j < width; j++) {
      if (isTime(j) || isMarker(j)) continue;
      let name = namesRow >= 0 ? cell(namesRow, j) : '';
      if (!name) {
        // Headerless numeric column: still offer it in the column pickers.
        if (namesRow >= 0 && rows.slice(namesRow, dataStart).some(r => (r[j] || '').trim())) continue;
        if (isNaN(toNumber(rows[dataStart][j], decimalComma))) continue;
        name = 'Column ' + (j + 1);
      }
      let timeIndex = -1;
      for (let k = j - 1; k >= 0; k--) {
        if (isTime(k)) { timeIndex = k; break; }
      }
      columns.push({ index: j, timeIndex, name, unit: unitsRow >= 0 ? cell(unitsRow, j) : '' });
    }

    const data = rows.slice(dataStart).filter(r => isDataRow(r, decimalComma));
    return { meta: parseMeta(rows), delimiter, decimalComma, columns, rows: data };
  }

  // Values of one column with their timestamps; blank or non-numeric cells are skipped.
  function getSeries(log, column) {
    const t = [], v = [];
    log.rows.forEach((row, i) => {
      const value = toNumber(row[column.index], log.decimalComma);
      if (isNaN(value)) return;
      const time = column.timeIndex >= 0 ? toNumber(row[column.timeIndex], log.decimalComma) : i;
      if (isNaN(time)) return;
      t.push(time);
      v.push(value);
    });
    return { t, v };
  }

  function pickBest(columns, score) {
    let best = -1, bestScore = 0;
    columns.forEach((c, i) => {
      const s = score(c);
      if (s > bestScore) { best = i; bestScore = s; }
    });
    return best;
  }

  // Returns indexes into log.columns, or -1 when nothing plausible was found.
  function detectColumns(columns) {
    const rpm = pickBest(columns, c => {
      let s = 0;
      if (RPM_NAME.test(c.name)) s += 2;
      if (RPM_UNIT.test(c.unit)) s += 1;
      if (s && /target|spec|soll|setpoint|desired|idle|max|limit/i.test(c.name)) s -= 1.5;
      return s;
    });
    const torque = pickBest(columns, c => {
      let s = 0;
      if (TORQUE_NAME.test(c.name)) s += 2;
      if (TORQUE_UNIT.test(c.unit)) s += 1;
      if (s && /actual|\bist\b|^engine torque$/i.test(c.name)) s += 1;
      if (s && /request|desired|limit|max|soll|spec|loss|friction|target|driver|wunsch|clutch/i.test(c.name)) s -= 1.5;
      return s;
    });
    return { rpm, torque };
  }

  const api = { parse, getSeries, detectColumns, toNumber };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VcdsParser = api;
})(typeof window !== 'undefined' ? window : globalThis);
