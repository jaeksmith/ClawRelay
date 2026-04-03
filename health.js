/**
 * Health tracking for ClawRelay (heart rate + blood pressure)
 * Reads/writes markdown table files in health/
 */

const fs = require('fs');
const path = require('path');

const HR_FILE = path.resolve(__dirname, '../health/heart-rate-log.md');
const BP_FILE = path.resolve(__dirname, '../health/blood-pressure-log.md');

function getTime() {
  return new Date().toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit',
    timeZone: 'America/New_York', hour12: true
  }) + ' EDT';
}

// Parse heart rate log → [{date, time, bpm}]
function parseHeartRate() {
  try {
    if (!fs.existsSync(HR_FILE)) return [];
    const lines = fs.readFileSync(HR_FILE, 'utf8').split('\n');
    const entries = [];
    for (const line of lines) {
      const m = line.match(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|([^|]*)\|\s*(\d+)\s*\|/);
      if (m) {
        entries.push({ date: m[1], time: m[2].trim() || null, bpm: parseInt(m[3], 10) });
      }
    }
    return entries.sort((a, b) => a.date.localeCompare(b.date));
  } catch (e) {
    console.error('[health] Failed to parse heart rate log:', e.message);
    return [];
  }
}

// Add or replace heart rate entry for a date (upsert by date)
function addHeartRate(date, bpm) {
  const time = getTime();
  const newLine = `| ${date} | ${time} | ${bpm} |`;
  try {
    if (!fs.existsSync(HR_FILE)) {
      fs.mkdirSync(path.dirname(HR_FILE), { recursive: true });
      fs.writeFileSync(HR_FILE,
        '# Heart Rate Log\n\n| Date | Time | BPM |\n|------|------|-----|\n');
    }
    let content = fs.readFileSync(HR_FILE, 'utf8');
    const dateRe = new RegExp(`^\\|\\s*${date}\\s*\\|[^\\n]*`, 'm');
    if (dateRe.test(content)) {
      content = content.replace(dateRe, newLine);
    } else {
      content = content.trimEnd() + '\n' + newLine + '\n';
    }
    fs.writeFileSync(HR_FILE, content);
    return { ok: true, entry: { date, bpm: parseInt(bpm, 10) } };
  } catch (e) {
    console.error('[health] Failed to write heart rate entry:', e.message);
    return { ok: false, error: e.message };
  }
}

// Parse blood pressure log → [{date, time, systolic, diastolic}]
function parseBloodPressure() {
  try {
    if (!fs.existsSync(BP_FILE)) return [];
    const lines = fs.readFileSync(BP_FILE, 'utf8').split('\n');
    const entries = [];
    for (const line of lines) {
      const m = line.match(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|([^|]*)\|\s*(\d+)\s*\|\s*(\d+)\s*\|/);
      if (m) {
        entries.push({
          date: m[1],
          time: m[2].trim() || null,
          systolic: parseInt(m[3], 10),
          diastolic: parseInt(m[4], 10)
        });
      }
    }
    return entries.sort((a, b) => a.date.localeCompare(b.date));
  } catch (e) {
    console.error('[health] Failed to parse blood pressure log:', e.message);
    return [];
  }
}

// Add or replace blood pressure entry for a date (upsert by date)
function addBloodPressure(date, systolic, diastolic) {
  const time = getTime();
  const newLine = `| ${date} | ${time} | ${systolic} | ${diastolic} |`;
  try {
    if (!fs.existsSync(BP_FILE)) {
      fs.mkdirSync(path.dirname(BP_FILE), { recursive: true });
      fs.writeFileSync(BP_FILE,
        '# Blood Pressure Log\n\n| Date | Time | Systolic | Diastolic |\n|------|------|----------|-----------|\n');
    }
    let content = fs.readFileSync(BP_FILE, 'utf8');
    const dateRe = new RegExp(`^\\|\\s*${date}\\s*\\|[^\\n]*`, 'm');
    if (dateRe.test(content)) {
      content = content.replace(dateRe, newLine);
    } else {
      content = content.trimEnd() + '\n' + newLine + '\n';
    }
    fs.writeFileSync(BP_FILE, content);
    return { ok: true, entry: { date, systolic: parseInt(systolic, 10), diastolic: parseInt(diastolic, 10) } };
  } catch (e) {
    console.error('[health] Failed to write blood pressure entry:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { parseHeartRate, addHeartRate, parseBloodPressure, addBloodPressure };
