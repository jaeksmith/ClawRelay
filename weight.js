/**
 * Weight tracking for ClawRelay
 * Reads/writes health/weight-log.md (markdown table format)
 */

const fs = require('fs');
const path = require('path');

const WEIGHT_FILE = path.resolve(__dirname, '../health/weight-log.md');

// Parse the markdown table → [{date, weight, notes}]
function parseEntries() {
  try {
    if (!fs.existsSync(WEIGHT_FILE)) return [];
    const lines = fs.readFileSync(WEIGHT_FILE, 'utf8').split('\n');
    const entries = [];
    for (const line of lines) {
      // Match: | 2026-03-08 | ~6:45 PM EDT | 253.5 | Some notes |
      const m = line.match(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|([^|]*)\|\s*([\d.]+)\s*\|([^|]*)\|/);
      if (m) {
        entries.push({
          date: m[1],
          time: m[2].trim() || null,
          weight: parseFloat(m[3]),
          notes: m[4].trim() || null
        });
      }
    }
    return entries.sort((a, b) => a.date.localeCompare(b.date));
  } catch (e) {
    console.error('[weight] Failed to parse weight log:', e.message);
    return [];
  }
}

// Add or replace entry for a date
function addEntry(date, weight, notes = '', timeStr = null) {
  const now = new Date();
  const time = timeStr || now.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit',
    timeZone: 'America/New_York', hour12: true
  }) + ' EDT';
  const newLine = `| ${date} | ${time} | ${weight} | ${notes} |`;

  try {
    if (!fs.existsSync(WEIGHT_FILE)) {
      fs.mkdirSync(path.dirname(WEIGHT_FILE), { recursive: true });
      fs.writeFileSync(WEIGHT_FILE,
        '# Weight Log\n\n| Date | Time | Weight (lbs) | Notes |\n|------|------|--------------|-------|\n');
    }

    let content = fs.readFileSync(WEIGHT_FILE, 'utf8');
    const dateRe = new RegExp(`^\\|\\s*${date}\\s*\\|[^\\n]*`, 'm');
    if (dateRe.test(content)) {
      content = content.replace(dateRe, newLine);
    } else {
      content = content.trimEnd() + '\n' + newLine + '\n';
    }
    fs.writeFileSync(WEIGHT_FILE, content);
    return { ok: true, entry: { date, weight: parseFloat(weight), notes } };
  } catch (e) {
    console.error('[weight] Failed to write entry:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { parseEntries, addEntry };
