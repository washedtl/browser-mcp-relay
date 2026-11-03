// deelevate.js — start the broker WITHOUT administrator rights when the
// session that launches it is elevated (Windows).
//
// Claude Code often runs elevated. A broker started from it would be elevated
// too, and so would its Brave: any medium-integrity process able to reach the
// pipe could then drive an administrator browser. So the launcher starts the
// broker with the desktop shell's own token (explorer.exe: the same user,
// medium integrity, not elevated) through CreateProcessWithTokenW and
// CREATE_NO_WINDOW. Measured (W2A spike): medium integrity, no window, and it
// survives a tree-kill of the shim. `runas /trustlevel:0x20000` does NOT do
// this: its token stays high-integrity and elevated, and it opens a console.
//
// A process started that way gets the user's default environment, not ours,
// so the broker's settings travel in a user-private file it reads and deletes
// (--env-file). Windows only; built-ins only (the launcher must start fast).

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const HIGH_INTEGRITY_SID = "S-1-16-12288";

const system32 = (env) => path.join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32");

/** Is this process elevated (high integrity)? Windows only; false elsewhere or if unknown. */
function isElevated(env = process.env, run = spawnSync) {
  if (process.platform !== "win32") return false;
  // full path: Git Bash puts a different whoami first on PATH
  const r = run(path.join(system32(env), "whoami.exe"), ["/groups"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  return r.status === 0 && typeof r.stdout === "string" && r.stdout.includes(HIGH_INTEGRITY_SID);
}

/** One argument, quoted so CommandLineToArgvW (and node) read it back exactly. */
function quoteArg(arg) {
  const s = String(arg);
  if (s !== "" && !/[\s"]/.test(s)) return s;
  let out = '"';
  let slashes = 0;
  for (const ch of s) {
    if (ch === "\\") { slashes++; continue; }
    if (ch === '"') { out += "\\".repeat(slashes * 2 + 1) + '"'; slashes = 0; continue; }
    out += "\\".repeat(slashes) + ch;
    slashes = 0;
  }
  return out + "\\".repeat(slashes * 2) + '"';
}

const commandLine = (args) => args.map(quoteArg).join(" ");

/** Write the broker's env to a user-private file in `dir`; returns its path. */
function writeEnvFile(dir, env) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `launch-${process.pid}-${crypto.randomBytes(4).toString("hex")}.json`);
  fs.writeFileSync(file, JSON.stringify({ env }), { mode: 0o600, flag: "wx" });
  return file;
}

// C# via PowerShell: duplicate the shell's token, check it is ours and not
// elevated, CreateProcessWithTokenW(CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT).
const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class BmrDeelevate {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct SI { public int cb; public string r; public string d; public string t; public int x,y,xs,ys,xc,yc,fa,fl; public short sw, r2; public IntPtr r3, i, o, e; }
  [StructLayout(LayoutKind.Sequential)] public struct PIn { public IntPtr hp, ht; public int pid, tid; }
  [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint a, bool i, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr p, uint a, out IntPtr t);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool DuplicateTokenEx(IntPtr t, uint a, IntPtr sa, int il, int tt, out IntPtr n);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr t, int c, out int v, int l, out int r);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern bool CreateProcessWithTokenW(IntPtr t, int lf, string app, string cmd, uint flags, IntPtr env, string cwd, ref SI si, out PIn pi);
  static string Fail(string why) { return "{\"ok\":false,\"why\":\"" + why.Replace("\\", "\\\\").Replace("\"", "'") + "\"}"; }
  public static string Run(string cmd, string cwd) {
    int shellPid; GetWindowThreadProcessId(GetShellWindow(), out shellPid);
    if (shellPid == 0) return Fail("no desktop shell (explorer.exe) to take a token from");
    IntPtr hp = OpenProcess(0x1000, false, shellPid);
    if (hp == IntPtr.Zero) return Fail("OpenProcess(shell) failed: " + Marshal.GetLastWin32Error());
    IntPtr tok, dup;
    try {
      if (!OpenProcessToken(hp, 0x0002 | 0x0008, out tok)) return Fail("OpenProcessToken(shell) failed: " + Marshal.GetLastWin32Error());
    } finally { CloseHandle(hp); }
    try {
      using (var shellId = new WindowsIdentity(tok)) {
        if (shellId.User != WindowsIdentity.GetCurrent().User) return Fail("the desktop shell runs as another user (" + shellId.Name + ")");
      }
      int elevated, len;
      if (GetTokenInformation(tok, 20, out elevated, 4, out len) && elevated != 0) return Fail("the desktop shell itself runs elevated (UAC off?)");
      if (!DuplicateTokenEx(tok, 0x02000000, IntPtr.Zero, 2, 1, out dup)) return Fail("DuplicateTokenEx failed: " + Marshal.GetLastWin32Error());
    } finally { CloseHandle(tok); }
    try {
      SI si = new SI(); si.cb = Marshal.SizeOf(si);
      PIn pi;
      if (!CreateProcessWithTokenW(dup, 0, null, cmd, 0x08000000 | 0x00000400, IntPtr.Zero, cwd, ref si, out pi)) {
        return Fail("CreateProcessWithTokenW failed: " + Marshal.GetLastWin32Error());
      }
      CloseHandle(pi.hp); CloseHandle(pi.ht);
      return "{\"ok\":true,\"pid\":" + pi.pid + "}";
    } finally { CloseHandle(dup); }
  }
}
"@
[Console]::Out.WriteLine([BmrDeelevate]::Run($env:BMR_DEELEVATE_CMDLINE, $env:BMR_DEELEVATE_CWD))
`;

/**
 * Start `node <args>` de-elevated (shell token, no window). Throws with the
 * reason when that is impossible; the caller falls back to a normal launch.
 * @returns {{pid: number}}
 */
function launchDeelevated({ args, cwd, env = process.env, run = spawnSync }) {
  const r = run(path.join(system32(env), "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(PS_SCRIPT, "utf16le").toString("base64")], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      env: { ...env, BMR_DEELEVATE_CMDLINE: commandLine([process.execPath, ...args]), BMR_DEELEVATE_CWD: cwd },
    });
  const last = String(r.stdout || "").trim().split(/\r?\n/).pop() || "";
  let res = null;
  try { res = JSON.parse(last); } catch { /* below */ }
  if (!res) {
    const err = String(r.stderr || "").trim().split(/\r?\n/).slice(-2).join(" ");
    throw new Error(`PowerShell gave no result (status ${r.status}${r.error ? `, ${r.error.message}` : ""}${err ? `: ${err}` : ""})`);
  }
  if (!res.ok) throw new Error(res.why);
  return { pid: res.pid };
}

module.exports = { isElevated, launchDeelevated, writeEnvFile, quoteArg, commandLine, HIGH_INTEGRITY_SID };
