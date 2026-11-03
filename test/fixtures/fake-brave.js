// fake-brave.js — a node stand-in for brave.exe, used by brave-supervisor.test.js.
//
// Speaks just enough CDP for BraveSupervisor: GET /json/version, browser
// websockets, Browser.close, SystemInfo.getProcessInfo. Every start appends
// {pid, args, t} to <user-data-dir>/fake-launches.jsonl so tests can count
// launches and read the exact command line; every CDP call is appended to
// <user-data-dir>/fake-cdp.jsonl as {pid, method, params}.
//
//   node fake-brave.js [--fake-mode=a,b] [--fake-delay=ms] <brave args...>
//
// Modes:
//   ignore-close  ack Browser.close but keep running
//   slow-close    ack Browser.close, drop CDP at once (as Brave does), exit
//                 after --fake-exit-ms (default 1200): a slow shutdown
//   close-hang    ack Browser.close, drop CDP, then keep running until killed
//   exit-early    exit 0 after 100 ms without serving CDP (a profile handoff)
//   no-cdp        run without ever serving CDP
//   foreign-pid   getProcessInfo reports a browser pid that is not ours
//   linger        after Fake.drop, keep running 1500 ms, then exit 0
//   hang          after Fake.drop, keep running until killed
// Test-only CDP method: Fake.drop closes every websocket (a CDP disconnect
// while the process stays up); without linger/hang the process then exits.

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { WebSocketServer } = require("ws");

const argv = process.argv.slice(2);
const opt = (name) => {
  const a = argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};
const modes = new Set((opt("fake-mode") || "").split(",").filter(Boolean));
const delay = Number(opt("fake-delay") || 0);
const exitMs = Number(opt("fake-exit-ms") || 1200);
const port = Number(opt("remote-debugging-port"));
const userDataDir = opt("user-data-dir");
const braveArgs = argv.filter((a) => !a.startsWith("--fake-"));

fs.mkdirSync(userDataDir, { recursive: true });
fs.appendFileSync(path.join(userDataDir, "fake-launches.jsonl"), JSON.stringify({ pid: process.pid, args: braveArgs, t: Date.now() }) + "\n");

setInterval(() => {}, 1 << 30); // stay alive until told to exit (or killed)

if (modes.has("exit-early")) setTimeout(() => process.exit(0), 100);
else if (!modes.has("no-cdp")) setTimeout(serve, delay);

function serve() {
  const wsUrl = `ws://127.0.0.1:${port}/devtools/browser/fake`;
  const server = http.createServer((req, res) => {
    if (req.url === "/json/version") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ Browser: "FakeBrave/1.0", webSocketDebuggerUrl: wsUrl }));
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      const msg = JSON.parse(data);
      fs.appendFileSync(path.join(userDataDir, "fake-cdp.jsonl"), JSON.stringify({ pid: process.pid, method: msg.method, params: msg.params || null }) + "\n");
      const reply = (result) => ws.send(JSON.stringify({ id: msg.id, result }));
      if (msg.method === "Browser.close") {
        reply({});
        if (modes.has("slow-close") || modes.has("close-hang")) {
          for (const c of wss.clients) c.close();
          if (modes.has("slow-close")) setTimeout(() => process.exit(0), exitMs);
        } else if (!modes.has("ignore-close")) setTimeout(() => process.exit(0), 50);
      } else if (msg.method === "SystemInfo.getProcessInfo") {
        const id = modes.has("foreign-pid") ? process.pid + 100000 : process.pid;
        reply({ processInfo: [{ type: "browser", id, cpuTime: 0 }, { type: "GPU", id: id + 1, cpuTime: 0 }] });
      } else if (msg.method === "Fake.drop") {
        for (const c of wss.clients) c.terminate();
        if (modes.has("hang")) return;
        setTimeout(() => process.exit(0), modes.has("linger") ? 1500 : 50);
      } else {
        reply({});
      }
    });
  });
  server.listen(port, "127.0.0.1");
}
