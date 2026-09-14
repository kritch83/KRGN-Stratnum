'use strict';
// Leveled logger. All secret redaction happens here, in one place.

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

let currentLevel = LEVELS.info;
const secrets = [];

function setLevel(name) {
  if (name in LEVELS) currentLevel = LEVELS[name];
}

// Register a secret (e.g. the RPC password) so it never appears in output.
function addSecret(value) {
  if (typeof value === 'string' && value.length >= 3) secrets.push(value);
}

function redact(text) {
  let out = text;
  for (const s of secrets) out = out.split(s).join('***');
  return out;
}

function render(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'object' && value !== null) {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

function emit(level, tag, args) {
  if (LEVELS[level] > currentLevel) return;
  const line = args.map(render).join(' ');
  const text = redact(`${new Date().toISOString()} [${level.toUpperCase().padEnd(5)}] ${tag}: ${line}`);
  (level === 'error' ? process.stderr : process.stdout).write(text + '\n');
}

function make(tag) {
  return {
    error: (...a) => emit('error', tag, a),
    warn: (...a) => emit('warn', tag, a),
    info: (...a) => emit('info', tag, a),
    debug: (...a) => emit('debug', tag, a),
  };
}

module.exports = { make, setLevel, addSecret, LEVELS };
