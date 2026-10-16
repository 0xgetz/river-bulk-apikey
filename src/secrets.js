'use strict';

/**
 * Guard for files that hold secrets the tool reads (today: the IMAP app
 * password). A secret inside a git checkout is one `git add -A` away from being
 * published, so the placement gets checked and complained about out loud.
 */

const fs = require('fs');
const path = require('path');

/** Repo root = one level above src/. */
const REPO_ROOT = path.resolve(__dirname, '..');

function isIgnored(relative) {
  let patterns;
  try {
    patterns = fs
      .readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch (e) {
    return false;
  }
  return patterns.some((raw) => {
    const pattern = raw.replace(/^\//, '').replace(/\/+$/, '');
    if (!pattern) return false;
    if (relative === pattern) return true;
    if (relative.startsWith(`${pattern}/`)) return true;
    const regex = new RegExp(
      `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`
    );
    return regex.test(relative) || regex.test(path.basename(relative));
  });
}

/**
 * Prints a warning to stderr when `file` is a secret living inside this
 * checkout. Returns 'outside' | 'ignored' | 'exposed' for tests and callers.
 */
function warnIfSecretInsideRepo(file, { stream = process.stderr } = {}) {
  let resolved;
  try {
    resolved = path.resolve(String(file));
  } catch (e) {
    return 'outside';
  }
  if (!resolved.startsWith(REPO_ROOT + path.sep)) return 'outside';
  const relative = path.relative(REPO_ROOT, resolved).split(path.sep).join('/');
  if (isIgnored(relative)) {
    stream.write(
      `  ⚠ secret inside the checkout (${relative}) — this name is gitignored, but %USERPROFILE% is a safer home\n`
    );
    return 'ignored';
  }
  stream.write(
    `  ⚠ secret inside the checkout and NOT gitignored (${relative}) — "git add -A" would commit it.\n` +
      '    Move it out (e.g. $env:USERPROFILE\\.river-imap-pass) or add the name to .gitignore.\n'
  );
  return 'exposed';
}

module.exports = { warnIfSecretInsideRepo, isIgnored, REPO_ROOT };
