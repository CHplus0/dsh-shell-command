// Small host-service fixture; the production bundle itself is loaded unchanged.
import React from "react";
import ReactDOM from "react-dom";
import { createRoot } from "react-dom/client";

const cleanups = [];
const root = createRoot(document.getElementById("root"));
const sources = new Map();
const fixture = window.fixture = { controller: null, sources, root };
function createSnapshotStore(initial) {
  let snapshot = initial;
  const listeners = new Set();
  return { getSnapshot: () => snapshot, set(next) { snapshot = next; for (const fn of listeners) fn(); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
}
const effect = (fn) => { const dispose = fn(); if (typeof dispose === "function") cleanups.push(dispose); return dispose; };
const connection = { rpc: { async call(channel, endpoint, payload) {
  return (await fetch("/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel, endpoint, payload }) })).json();
} } };
window.__ModuleLoader__ = { load(registration) {
  fixture.registration = registration;
} };
window.mountShell = () => {
  const dependencies = { react: React, "react-dom": ReactDOM,
    "@deepseek-ai/dsh-client-runtime/client": { createSnapshotStore } };
  // Match DSH's two stages: script evaluation registers, then materialize with host requires.
  fixture.plugin = fixture.registration.factory((id) => {
    if (!(id in dependencies)) throw new Error(`Unexpected external dependency: ${id}`);
    return dependencies[id];
  });
  const slots = {
    inject(_name, fn) { effect(fn); },
    register(descriptor, Component) {
      const props = descriptor.inject("browser-session");
      fixture.controller = props.controller;
      root.render(React.createElement(Component, props));
      return () => root.unmount();
    },
  };
  fixture.plugin.apply({ effect, slots, get(name) {
    return { connection, inputTriggers: { registerSource(source) { sources.set(source.name, source); return () => sources.delete(source.name); } },
      sessions: { scope() { return { effect }; } } }[name];
  } });
};
fixture.open = async () => {
  const result = await sources.get("terminal").matchEnter({ sessionId: "browser-session" }, "/terminal");
  await result.claim.submit();
};
fixture.dispose = () => { for (const dispose of cleanups.splice(0).reverse()) dispose(); };
