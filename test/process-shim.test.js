const test = require("node:test");
const assert = require("node:assert");

const {
  listProcessesByCommand,
  isPidAlive,
  getProcessStartTimes,
  parsePidPipeOutput,
} = require("../src/process-shim.js");

// ───── parsePidPipeOutput ─────

test("parsePidPipeOutput parses well-formed PID|cmd lines", () => {
  const stdout = [
    "1111|brave.exe --user-data-dir=/x",
    "2222|brave.exe --type=gpu",
  ].join("\r\n");
  const result = parsePidPipeOutput(stdout);
  assert.deepStrictEqual(result, [
    { pid: 1111, command: "brave.exe --user-data-dir=/x" },
    { pid: 2222, command: "brave.exe --type=gpu" },
  ]);
});

test("parsePidPipeOutput skips lines without a pipe", () => {
  const stdout = "1111|cmd\nno-pipe\n2222|cmd2";
  const result = parsePidPipeOutput(stdout);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].pid, 1111);
  assert.strictEqual(result[1].pid, 2222);
});

test("parsePidPipeOutput skips lines with non-numeric pids", () => {
  const stdout = "abc|cmd\n1111|good";
  const result = parsePidPipeOutput(stdout);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].pid, 1111);
});

test("parsePidPipeOutput returns [] on empty / null / undefined input", () => {
  assert.deepStrictEqual(parsePidPipeOutput(""), []);
  assert.deepStrictEqual(parsePidPipeOutput(null), []);
  assert.deepStrictEqual(parsePidPipeOutput(undefined), []);
});

// ───── listProcessesByCommand — input validation ─────

test("listProcessesByCommand returns [] when needle is empty / not a string", () => {
  assert.deepStrictEqual(listProcessesByCommand(""), []);
  assert.deepStrictEqual(listProcessesByCommand(null), []);
  assert.deepStrictEqual(listProcessesByCommand(undefined), []);
  assert.deepStrictEqual(listProcessesByCommand(123), []);
});

// ───── listProcessesByCommand — Windows path uses PowerShell ─────

test("listProcessesByCommand on Win shells out to PowerShell with -NoProfile", () => {
  let cmdSeen, argsSeen;
  const fakeSpawn = (cmd, args) => {
    cmdSeen = cmd;
    argsSeen = args;
    return {
      status: 0,
      stdout: "1111|brave.exe --user-data-dir=/x\r\n2222|brave.exe --type=gpu\r\n",
    };
  };
  const result = listProcessesByCommand("brave.exe", {
    _platform: "win32",
    _spawnSync: fakeSpawn,
  });
  assert.strictEqual(cmdSeen, "powershell");
  assert.ok(argsSeen.includes("-NoProfile"), "PowerShell must run with -NoProfile");
  assert.ok(
    argsSeen.some((a) => typeof a === "string" && a.includes("Win32_Process")),
    "PowerShell script must reference Win32_Process",
  );
  // Needle must be inlined into the script (escaped).
  assert.ok(
    argsSeen.some((a) => typeof a === "string" && a.includes("brave.exe")),
    "needle value must be embedded in the PowerShell script",
  );
  assert.deepStrictEqual(result, [
    { pid: 1111, command: "brave.exe --user-data-dir=/x" },
    { pid: 2222, command: "brave.exe --type=gpu" },
  ]);
});

test("listProcessesByCommand on Win escapes single quotes in the needle", () => {
  let argsSeen;
  const fakeSpawn = (_cmd, args) => {
    argsSeen = args;
    return { status: 0, stdout: "" };
  };
  listProcessesByCommand("foo'bar", { _platform: "win32", _spawnSync: fakeSpawn });
  // The script (last arg) should contain doubled-up single quotes.
  const script = argsSeen[argsSeen.length - 1];
  assert.ok(script.includes("foo''bar"), `expected escaped needle in script, got: ${script}`);
});

test("listProcessesByCommand on Win returns [] when PowerShell exits non-zero", () => {
  const result = listProcessesByCommand("brave.exe", {
    _platform: "win32",
    _spawnSync: () => ({ status: 1, stdout: "", stderr: "boom" }),
  });
  assert.deepStrictEqual(result, []);
});

// ───── listProcessesByCommand — POSIX path uses ps ─────

test("listProcessesByCommand on Linux shells out to `ps -eo pid,command -ww`", () => {
  let cmdSeen, argsSeen, optsSeen;
  const fakeSpawn = (cmd, args, opts) => {
    cmdSeen = cmd;
    argsSeen = args;
    optsSeen = opts;
    return {
      status: 0,
      stdout:
        "  PID COMMAND\n" +
        " 1111 /usr/bin/brave --user-data-dir=/x\n" +
        " 2222 /usr/bin/brave --type=gpu\n" +
        " 3333 /usr/bin/firefox\n",
    };
  };
  const result = listProcessesByCommand("brave", {
    _platform: "linux",
    _spawnSync: fakeSpawn,
  });
  assert.strictEqual(cmdSeen, "ps");
  // F0-7: -ww disables BSD ps command-column truncation; LC_ALL=C forces ASCII header.
  assert.deepStrictEqual(argsSeen, ["-eo", "pid,command", "-ww"]);
  assert.ok(optsSeen && optsSeen.env && optsSeen.env.LC_ALL === "C", "must force LC_ALL=C in spawn env");
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].pid, 1111);
  assert.strictEqual(result[1].pid, 2222);
  assert.match(result[0].command, /brave --user-data-dir=\/x/);
});

test("listProcessesByCommand on macOS uses `ps` (same POSIX path as Linux)", () => {
  let cmdSeen;
  const fakeSpawn = (cmd, _args) => {
    cmdSeen = cmd;
    return {
      status: 0,
      stdout:
        "  PID COMMAND\n" +
        " 4444 /Applications/Brave Browser.app/Contents/MacOS/Brave Browser\n",
    };
  };
  // Lowercase needle vs capital-B command — exercises case-insensitive match.
  // On macOS the binary path is "Brave Browser" with capital B but the
  // braveNeedle("darwin") helper returns lowercase "brave".
  const result = listProcessesByCommand("brave", {
    _platform: "darwin",
    _spawnSync: fakeSpawn,
  });
  assert.strictEqual(cmdSeen, "ps");
  assert.strictEqual(result.length, 1, "lowercase 'brave' must match 'Brave Browser' command");
  assert.strictEqual(result[0].pid, 4444);
});

test("listProcessesByCommand on POSIX skips the PID header and ps-self lines", () => {
  const fakeSpawn = () => ({
    status: 0,
    stdout:
      "  PID COMMAND\n" +
      " 1111 /usr/bin/brave\n" +
      " 9999 ps -eo pid,command\n",
  });
  const result = listProcessesByCommand("brave", {
    _platform: "linux",
    _spawnSync: fakeSpawn,
  });
  // Should match brave but NOT the ps invocation.
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].pid, 1111);
});

test("listProcessesByCommand on POSIX returns [] when ps exits non-zero", () => {
  const result = listProcessesByCommand("brave", {
    _platform: "linux",
    _spawnSync: () => ({ status: 1, stdout: "" }),
  });
  assert.deepStrictEqual(result, []);
});

// ───── isPidAlive ─────

test("isPidAlive returns false for invalid input without spawning", () => {
  let spawned = false;
  const fakeSpawn = () => {
    spawned = true;
    return { status: 0, stdout: "" };
  };
  assert.strictEqual(
    isPidAlive(undefined, { _platform: "win32", _spawnSync: fakeSpawn }),
    false,
  );
  assert.strictEqual(isPidAlive(null, { _platform: "win32", _spawnSync: fakeSpawn }), false);
  assert.strictEqual(isPidAlive(NaN, { _platform: "linux", _spawnSync: fakeSpawn }), false);
  assert.strictEqual(isPidAlive(0, { _platform: "linux", _spawnSync: fakeSpawn }), false);
  assert.strictEqual(isPidAlive(-5, { _platform: "win32", _spawnSync: fakeSpawn }), false);
  assert.strictEqual(spawned, false, "no child should have been spawned for invalid pids");
});

test("W0-2: isPidAlive on Win uses signal-zero and never spawns tasklist", () => {
  let spawned = false;
  const fakeSpawn = () => { spawned = true; return { status: 0, stdout: "" }; };
  let sigSeen;
  const fakeKill = (_pid, sig) => { sigSeen = sig; };
  const alive = isPidAlive(1234, { _platform: "win32", _spawnSync: fakeSpawn, _processKill: fakeKill });
  assert.strictEqual(alive, true);
  assert.strictEqual(sigSeen, 0, "must probe with signal 0");
  assert.strictEqual(spawned, false, "no child process per liveness check");
});

test("W0-2: isPidAlive on Win returns false on ESRCH, true on EPERM", () => {
  const throwing = (code) => () => { throw Object.assign(new Error(code), { code }); };
  assert.strictEqual(isPidAlive(9999, { _platform: "win32", _processKill: throwing("ESRCH") }), false);
  assert.strictEqual(isPidAlive(4, { _platform: "win32", _processKill: throwing("EPERM") }), true);
});

test("isPidAlive on POSIX uses signal-zero (process.kill(pid, 0))", () => {
  let killArgs = null;
  const fakeKill = (pid, sig) => {
    killArgs = { pid, sig };
    // Return cleanly to indicate alive.
  };
  const alive = isPidAlive(4321, { _platform: "linux", _processKill: fakeKill });
  assert.strictEqual(alive, true);
  assert.deepStrictEqual(killArgs, { pid: 4321, sig: 0 });
});

test("isPidAlive on POSIX returns false when kill throws ESRCH", () => {
  const fakeKill = () => {
    const e = new Error("no such process");
    e.code = "ESRCH";
    throw e;
  };
  assert.strictEqual(
    isPidAlive(4321, { _platform: "darwin", _processKill: fakeKill }),
    false,
  );
});

test("isPidAlive on POSIX returns true when kill throws EPERM (alive but not ours)", () => {
  const fakeKill = () => {
    const e = new Error("operation not permitted");
    e.code = "EPERM";
    throw e;
  };
  assert.strictEqual(
    isPidAlive(4321, { _platform: "linux", _processKill: fakeKill }),
    true,
  );
});

test("F1-11: isPidAlive on POSIX returns true (fail-safe = alive) on unknown errno", () => {
  // F1-11: blast-radius asymmetry — false-dead steals a slot from a live
  // Brave (corrupts the profile); false-alive only delays stale-lock TTL by
  // 5 minutes. So unknown errno (ENOSYS, EINVAL, EFAULT, EBUSY, ...) must
  // resolve to ALIVE. Only ESRCH counts as definitively dead.
  const fakeKill = () => {
    const e = new Error("weird");
    e.code = "EWEIRD";
    throw e;
  };
  assert.strictEqual(
    isPidAlive(4321, { _platform: "linux", _processKill: fakeKill }),
    true,
  );
});

test("F1-11: isPidAlive on POSIX returns false ONLY on ESRCH", () => {
  const fakeKill = () => {
    const e = new Error("no such process");
    e.code = "ESRCH";
    throw e;
  };
  assert.strictEqual(
    isPidAlive(4321, { _platform: "linux", _processKill: fakeKill }),
    false,
  );
});

test("F1-11: isPidAlive on POSIX treats unparseable throw as alive", () => {
  // No `code` field on the thrown value → unparseable → fail safe.
  const fakeKill = () => { throw null; };
  assert.strictEqual(
    isPidAlive(4321, { _platform: "linux", _processKill: fakeKill }),
    true,
  );
});

test("F1-11: isPidAlive on Win treats unknown errno as alive (fail-safe)", () => {
  const fakeKill = () => { throw Object.assign(new Error("EINVAL"), { code: "EINVAL" }); };
  assert.strictEqual(isPidAlive(4321, { _platform: "win32", _processKill: fakeKill }), true);
});

// ───── getProcessStartTimes ─────

test("getProcessStartTimes returns an empty Map without spawning for empty/invalid input", () => {
  let spawned = false;
  const fakeSpawn = () => { spawned = true; return { status: 0, stdout: "" }; };
  for (const input of [[], null, undefined, [0, -1, NaN, 1.5, "12"]]) {
    const out = getProcessStartTimes(input, { _platform: "win32", _spawnSync: fakeSpawn });
    assert.ok(out instanceof Map);
    assert.strictEqual(out.size, 0);
  }
  assert.strictEqual(spawned, false);
});

test("getProcessStartTimes on Win batches all pids into ONE PowerShell call and parses ISO times", () => {
  const calls = [];
  const fakeSpawn = (cmd, args) => {
    calls.push({ cmd, args });
    return { status: 0, stdout: "123|2026-10-30T15:39:10.0448005Z\r\n456|not-a-date\r\nnoise\r\n" };
  };
  const out = getProcessStartTimes([123, 456, 123], { _platform: "win32", _spawnSync: fakeSpawn });
  assert.strictEqual(calls.length, 1, "one child process for the whole batch");
  assert.strictEqual(calls[0].cmd, "powershell");
  assert.ok(calls[0].args.includes("-NoProfile"));
  assert.ok(calls[0].args.some((a) => a.includes("@(123,456)")), "deduped pid list in the script");
  assert.strictEqual(out.get(123), Date.parse("2026-10-30T15:39:10.0448005Z"));
  assert.strictEqual(out.has(456), false, "unparseable times are omitted, not guessed");
});

test("getProcessStartTimes on POSIX uses ps lstart with LC_ALL=C", () => {
  let seen;
  const fakeSpawn = (cmd, args, opts) => {
    seen = { cmd, args, opts };
    return { status: 1, stdout: "  123 Tue Nov  3 08:07:46 2026\n" }; // exit 1: some pids gone
  };
  const out = getProcessStartTimes([123, 999], { _platform: "linux", _spawnSync: fakeSpawn });
  assert.strictEqual(seen.cmd, "ps");
  assert.deepStrictEqual(seen.args, ["-o", "pid=,lstart=", "-p", "123,999"]);
  assert.strictEqual(seen.opts.env.LC_ALL, "C");
  assert.strictEqual(out.get(123), Date.parse("Tue Nov  3 08:07:46 2026"));
  assert.strictEqual(out.has(999), false);
});

test("getProcessStartTimes returns an empty Map when the probe fails", () => {
  const fakeSpawn = () => ({ status: null, error: new Error("ETIMEDOUT"), stdout: "" });
  assert.strictEqual(getProcessStartTimes([123], { _platform: "win32", _spawnSync: fakeSpawn }).size, 0);
});

// ───── Real-environment sanity ─────

test("isPidAlive returns true for the current process (no test seam)", () => {
  assert.strictEqual(isPidAlive(process.pid), true);
});

test("isPidAlive returns false for a child process that has exited (no test seam)", () => {
  const { spawnSync } = require("node:child_process");
  const r = spawnSync(process.execPath, ["-e", "0"]);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(isPidAlive(r.pid), false);
});

test("getProcessStartTimes resolves the current process's real start time (no test seam)", () => {
  // Generous timeout: PowerShell startup measured 5-6s on a loaded machine.
  const out = getProcessStartTimes([process.pid], { timeoutMs: 60000 });
  const t = out.get(process.pid);
  assert.ok(Number.isFinite(t), "own start time should resolve");
  const expected = Date.now() - process.uptime() * 1000;
  assert.ok(Math.abs(t - expected) < 10_000, `start time ${new Date(t).toISOString()} should be ~${new Date(expected).toISOString()}`);
});
