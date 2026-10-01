'use strict';
const fs = require('node:fs');
const path = require('node:path');

function ensureDefaultSettings(settingsPath, defaultsPath) {
  if (!fs.existsSync(settingsPath)) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.copyFileSync(defaultsPath, settingsPath);
    return;
  }
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (!settings || Array.isArray(settings) || typeof settings !== 'object') {
      throw new Error('settings.json must contain an object');
    }
  } catch (error) {
    // A malformed user file must not prevent the IDE from starting.
    process.stderr.write(`Cannot extend existing IDE settings: ${error.message}\n`);
    return;
  }
  const defaults = JSON.parse(fs.readFileSync(defaultsPath, 'utf8'));
  let changed = false;
  for (const [key, value] of Object.entries(defaults)) {
    if (!Object.hasOwn(settings, key)) {
      settings[key] = value;
      changed = true;
    }
  }
  if (!changed) return;
  const temporary = `${settingsPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`);
    fs.renameSync(temporary, settingsPath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

module.exports = { ensureDefaultSettings };
if (require.main === module) ensureDefaultSettings(process.argv[2], process.argv[3]);
