// fake-brave.js — a node stand-in for brave.exe, used by brave-supervisor.test.js.
//
// Speaks just enough CDP for BraveSupervisor, over --remote-debugging-pipe
// as Brave does (W2G): NUL-delimited JSON, read on fd 3, written on fd 4.
// Answers Browser.getVersion, Browser.close, SystemInfo.getProcessInfo, and
// {} to anything else. It never opens a TCP port. Every start appends
// {pid, args, t} to <user-data-dir>/fake-launches.jsonl so tests can count
// launches and read the exact command line; every CDP call is appended to
// <user-data-dir>/fake-cdp.jsonl as {pid, method, params}.
//
//   node fake-brave.js [--fake-mode=a,b] [--fake-delay=ms] <brave args...>
//
// Modes:
//   ignore-close  ack Browser.close but keep running (pipe stays open)
//   slow-close    ack Browser.close, close the pipe at once (as Brave does),
//                 exit after --fake-exit-ms (default 1200): a slow shutdown
//   close-hang    ack Browser.close, close the pipe, then keep running until killed
//   exit-early    exit 0 after 100 ms without answering CDP (a profile handoff)
//   no-cdp        run without ever answering CDP
//   foreign-pid   getProcessInfo reports a browser pid that is not ours
//   slow-certs    answer Security.setIgnoreCertificateErrors after --fake-exit-ms (the
//                 window between "CDP up" and "launch done")
//   linger        after Fake.drop, keep running 1500 ms, then exit 0
//   hang          after Fake.drop, keep running until killed
// Test-only CDP method: Fake.drop closes the pipe (a CDP disconnect while the
// process stays up); without linger/hang the process then exits.

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const argv = process.argv.slice(2);
const opt = (name) => {
  const a = argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};
const modes = new Set((opt("fake-mode") || "").split(",").filter(Boolean));
const delay = Number(opt("fake-delay") || 0);
const exitMs = Number(opt("fake-exit-ms") || 1200);
const userDataDir = opt("user-data-dir");
const braveArgs = argv.filter((a) => !a.startsWith("--fake-"));

fs.mkdirSync(userDataDir, { recursive: true });
fs.appendFileSync(path.join(userDataDir, "fake-launches.jsonl"), JSON.stringify({ pid: process.pid, args: braveArgs, t: Date.now() }) + "\n");

setInterval(() => {}, 1 << 30); // stay alive until told to exit (or killed)

if (modes.has("exit-early")) setTimeout(() => process.exit(0), 100);
else if (!modes.has("no-cdp") && braveArgs.includes("--remote-debugging-pipe")) setTimeout(serve, delay);

function serve() {
  const inp = new net.Socket({ fd: 3, readable: true, writable: false });
  const out = new net.Socket({ fd: 4, readable: false, writable: true });
  inp.on("error", () => {});
  out.on("error", () => {});
  const drop = () => { out.end(); inp.destroy(); };
  let buf = "";
  inp.setEncoding("utf8");
  inp.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\0")) >= 0;) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      onMessage(msg);
    }
  });
  function onMessage(msg) {
    fs.appendFileSync(path.join(userDataDir, "fake-cdp.jsonl"), JSON.stringify({ pid: process.pid, method: msg.method, params: msg.params || null }) + "\n");
    const reply = (result) => out.write(JSON.stringify({ id: msg.id, result, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) }) + "\0");
    if (msg.method === "Browser.close") {
      reply({});
      if (modes.has("slow-close") || modes.has("close-hang")) {
        drop();
        if (modes.has("slow-close")) setTimeout(() => process.exit(0), exitMs);
      } else if (!modes.has("ignore-close")) setTimeout(() => process.exit(0), 50);
    } else if (msg.method === "Security.setIgnoreCertificateErrors" && modes.has("slow-certs")) {
      setTimeout(() => reply({}), exitMs);
    } else if (msg.method === "Browser.getVersion") {
      reply({ product: "FakeBrave/1.0", protocolVersion: "1.3" });
    } else if (msg.method === "SystemInfo.getProcessInfo") {
      const id = modes.has("foreign-pid") ? process.pid + 100000 : process.pid;
      reply({ processInfo: [{ type: "browser", id, cpuTime: 0 }, { type: "GPU", id: id + 1, cpuTime: 0 }] });
    } else if (msg.method === "Fake.drop") {
      drop();
      if (modes.has("hang")) return;
      setTimeout(() => process.exit(0), modes.has("linger") ? 1500 : 50);
    } else {
      reply({});
    }
  }
}
