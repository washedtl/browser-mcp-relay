// remove-dir.js — rm -rf that waits out Windows file locks.
//
// Brave's helper processes (GPU, crashpad, utility), or a just-killed
// broker, can hold files for a few seconds after the main process exits.
// rmSync's own retry (maxRetries) does not cover EPERM on Node 24's native
// rm, so retry here.

"use strict";

const fs = require("node:fs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function removeDir(dir, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (!["EPERM", "EBUSY", "ENOTEMPTY", "EACCES"].includes(e.code) || Date.now() > deadline) throw e;
      await sleep(Math.min(100 * attempt, 1000)); // back off: 100 ms, 200 ms, ... 1 s
    }
  }
}

module.exports = { removeDir };
