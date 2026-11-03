// ext-fakedom.js — the smallest DOM the review page (options.js) needs, so
// its render logic can be tested without jsdom. Not a test file itself.
// Covers: createElement/createTextNode, getElementById, activeElement +
// focus(), append/replaceChildren, textContent, attributes, properties
// (checked/disabled/title/className), addEventListener + dispatch, and a
// per-element `mutations` counter (to prove a live region wasn't rewritten).

class FakeText {
  constructor(text) { this.data = String(text); this.parentNode = null; }
  get textContent() { return this.data; }
}

class FakeElement {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.attributes = {};
    this.listeners = {};
    this.parentNode = null;
    this.className = "";
    this.checked = false;
    this.disabled = false;
    this.title = "";
    this.mutations = 0;
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
  get id() { return this.getAttribute("id") || ""; }
  set id(v) { this.setAttribute("id", v); }
  append(...nodes) {
    this.mutations++;
    for (let n of nodes) {
      if (n == null) continue;
      if (typeof n === "string") n = new FakeText(n);
      if (n.parentNode) n.parentNode.childNodes.splice(n.parentNode.childNodes.indexOf(n), 1);
      n.parentNode = this;
      this.childNodes.push(n);
    }
  }
  replaceChildren(...nodes) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  get children() { return this.childNodes.filter((c) => c instanceof FakeElement); }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v) { this.replaceChildren(...(String(v) === "" ? [] : [String(v)])); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type) { for (const fn of this.listeners[type] || []) fn({ type, target: this }); }
  click() { this.dispatch("click"); }
  focus() { this.ownerDocument.activeElement = this; }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === this.ownerDocument.documentElement;
  }
  *walk() { yield this; for (const c of this.children) yield* c.walk(); }
}

/** A document whose body holds one empty element per id (the page's static mount points). */
function makeDocument(ids) {
  const doc = {};
  doc.createElement = (tag) => new FakeElement(doc, tag);
  doc.createTextNode = (t) => new FakeText(t);
  doc.documentElement = new FakeElement(doc, "html");
  doc.body = new FakeElement(doc, "body");
  doc.documentElement.append(doc.body);
  for (const id of ids) {
    const n = new FakeElement(doc, "div");
    n.id = id;
    doc.body.append(n);
  }
  doc.activeElement = doc.body;
  doc.getElementById = (id) => {
    for (const n of doc.documentElement.walk()) if (n.id === id) return n;
    return null;
  };
  doc.all = () => [...doc.documentElement.walk()];
  return doc;
}

module.exports = { makeDocument, FakeElement, FakeText };
