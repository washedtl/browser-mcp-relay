// ext-manifest.test.js — W2F-ext: the extension's manifest and static files.
// The fixed public `key` pins the extension ID that bridge:install puts in
// the native host's allowed_origins; no private key may live in the repo;
// the review page loads nothing from outside the extension.

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const EXT = path.join(__dirname, "..", "..", "extensions", "cookie-bridge");
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));

// Drift guard: change the key → this ID changes → the owner must re-load the
// extension AND re-run `npm run bridge:install`. Update both deliberately.
const EXPECTED_ID = "dfcccancdkogdddemhecnffcjllbjmba";

/** Chrome's rule: first 32 hex chars of sha256(public key DER), 0-f mapped to a-p. */
function extensionId(keyB64) {
  const hex = crypto.createHash("sha256").update(Buffer.from(keyB64, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((h) => String.fromCharCode(97 + parseInt(h, 16))).join("");
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

test("MV3 manifest: module service worker, the three permissions, all-hosts access, options page, action", () => {
  assert.strictEqual(manifest.manifest_version, 3);
  assert.deepStrictEqual([...manifest.permissions].sort(), ["cookies", "nativeMessaging", "storage"]);
  assert.deepStrictEqual(manifest.host_permissions, ["<all_urls>"]);
  assert.deepStrictEqual(manifest.background, { service_worker: "background.js", type: "module" });
  assert.strictEqual(manifest.options_ui.page, "options.html");
  assert.ok(manifest.action, "an action, so the pending-review badge has an icon to sit on");
  assert.strictEqual(manifest.content_scripts, undefined, "no content scripts: cookies come from chrome.cookies only");
  assert.strictEqual(manifest.externally_connectable, undefined, "no web page may message the extension");
});

test("fixed key: a 2048-bit RSA public key (SPKI DER) that yields the documented extension ID", () => {
  const der = Buffer.from(manifest.key, "base64");
  const pub = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
  assert.strictEqual(pub.asymmetricKeyType, "rsa");
  assert.strictEqual(pub.asymmetricKeyDetails.modulusLength, 2048);
  assert.strictEqual(extensionId(manifest.key), EXPECTED_ID);
  assert.match(EXPECTED_ID, /^[a-p]{32}$/);
});

test("no private key material anywhere in the extension directory", () => {
  for (const f of walk(EXT)) {
    assert.ok(!/\.(pem|key|crx)$/i.test(f), `${f} looks like key material`);
    const src = fs.readFileSync(f, "utf8");
    assert.ok(!/PRIVATE KEY/.test(src), `${f} contains a private key`);
  }
});

test("every file the manifest and the review page reference exists", () => {
  const html = fs.readFileSync(path.join(EXT, "options.html"), "utf8");
  const refs = [manifest.background.service_worker, manifest.options_ui.page,
    ...[...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1])];
  for (const r of refs) {
    if (r === "policy.js") continue; // W2F-core's file
    assert.ok(fs.existsSync(path.join(EXT, r)), `missing ${r}`);
  }
  assert.match(html, /<script type="module" src="options\.js"><\/script>/);
});

test("the review page and the worker load nothing from outside the extension", () => {
  for (const f of ["options.html", "options.css", "options.js", "background.js", "bridge-core.js"]) {
    const src = fs.readFileSync(path.join(EXT, f), "utf8");
    assert.ok(!/(?:https?:)?\/\/[a-z0-9-]+\.[a-z]/i.test(src.replace(/^\s*\/\/.*$/gm, "")), `${f} references an external URL`);
    if (f.endsWith(".css")) assert.ok(!/@import|url\(/.test(src), `${f} pulls an external stylesheet/asset`);
  }
});

test("background.js imports the policy and the core as sibling modules", () => {
  const src = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  assert.match(src, /import\s+(?:\*\s+as\s+\w+\s+from\s+)?"\.\/policy\.js"/);
  assert.match(src, /import\s+"\.\/bridge-core\.js"/);
});
