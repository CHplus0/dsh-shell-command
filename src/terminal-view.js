import React from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

/** A single emulator survives live/history tab switches for the whole PTY epoch. */
export function TerminalView({ controller, visible, status }) {
  const container = React.useRef(null);
  const terminal = React.useRef(null);
  const fit = React.useRef(null);

  React.useEffect(() => {
    const element = container.current;
    const term = new Terminal({
      cursorBlink: true, scrollback: 3000, fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      theme: { background: "#141414", foreground: "#e5e5e5" },
      allowProposedApi: false,
    });
    const addon = new FitAddon();
    term.loadAddon(addon);
    term.open(element);
    terminal.current = term;
    controller.terminal = term;
    fit.current = addon;
    const data = term.onData((value) => controller.sendRaw(value));
    const binary = term.onBinary((value) => {
      // Legacy mouse reporting may emit non-UTF8 bytes. Send byte values intact.
      controller.sendFrame({ type: "binary", data: Array.from(value, (c) => c.charCodeAt(0)) });
    });
    const resize = term.onResize(({ cols, rows }) => controller.resize(cols, rows));
    const unsubscribe = controller.subscribeOutput((value) => term.write(value));
    // Device-status responses also emit onData. Only DOM input gestures set
    // hasInput; merely receiving a shell prompt/query leaves an empty session.
    const activity = (event) => {
      if (event.type === "keydown" && ["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(event.key)) return;
      if (["pointerdown", "wheel"].includes(event.type) && term.modes.mouseTrackingMode === "none") return;
      controller.markActivity();
    };
    const events = ["keydown", "paste", "beforeinput", "compositionend", "pointerdown", "wheel"];
    for (const name of events) element.addEventListener(name, activity, true);
    let frame;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (element.clientWidth && element.clientHeight) addon.fit();
      });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      for (const name of events) element.removeEventListener(name, activity, true);
      unsubscribe(); data.dispose(); binary.dispose(); resize.dispose();
      terminal.current = null;
      if (controller.terminal === term) controller.terminal = null;
      fit.current = null;
      term.dispose();
    };
  }, [controller]);

  React.useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    term.options.disableStdin = status !== "open";
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      if (!container.current?.clientWidth || !container.current?.clientHeight) return;
      fit.current?.fit();
      // Opening at an already-fitted size does not emit onResize again.
      if (status === "open") {
        controller.resize(term.cols, term.rows);
        term.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [controller, visible, status]);

  return React.createElement("div", {
    ref: container, "data-terminal-view": "",
    style: { display: visible ? "block" : "none", flex: "1 1 0", minHeight: 0, minWidth: 0, overflow: "hidden" },
  });
}
