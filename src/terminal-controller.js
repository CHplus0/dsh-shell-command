import { createSnapshotStore } from "@deepseek-ai/dsh-client-runtime/client";
const RPC_CHANNEL = "/shell-term-rpc";

/** Owns one PTY stream; rendering never buffers input or replays on tab switches. */
class TerminalController {
  constructor(connection, sessionId) {
    this.connection = connection;
    this.sessionId = sessionId;
    this.ws = null;
    this.streamId = null;
    this.transcript = "";
    this.outputListeners = new Set();
    this.generation = 0;
    this.disposed = false;
    this.activitySent = false;
    this.closing = null;
    this.previewRequest = 0;
    this.historyRequest = 0;
    this.state = createSnapshotStore({
      status: "closed", tab: "live", epoch: 0, x: null, y: null,
      width: 640, height: 440,
      history: { entries: [], loading: false, error: null },
      preview: null, pendingSelectPath: null, error: null,
    });
  }

  async call(endpoint, payload = {}) {
    return this.connection.rpc.call(RPC_CHANNEL, endpoint, { sessionId: this.sessionId, ...payload }, undefined);
  }

  async open() {
    if (this.disposed || !["closed", "ended"].includes(this.state.getSnapshot().status)) return;
    const generation = ++this.generation;
    this.closeWs();
    this.transcript = "";
    this.activitySent = false;
    this.setState({ status: "opening", tab: "live", epoch: generation, error: null, preview: null, pendingSelectPath: null });
    try {
      const result = await this.call("open");
      if (!result?.ok) throw new Error(result?.error?.message || "open failed");
      const { streamId } = result.value;
      if (this.disposed || generation !== this.generation) {
        await this.call("close", { streamId });
        return;
      }
      this.streamId = streamId;
      this.connectWs(generation);
    } catch (error) {
      if (generation === this.generation) this.fail(error);
    }
  }

  connectWs(generation) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const query = new URLSearchParams({ sessionId: this.sessionId, streamId: this.streamId, protocol: "2" });
    const ws = new WebSocket(`${proto}//${location.host}/shell-term/ws?${query}`);
    this.ws = ws;
    const current = () => !this.disposed && generation === this.generation && this.ws === ws;
    ws.onopen = () => { if (current()) this.setState({ status: "open" }); };
    ws.onmessage = (event) => {
      if (!current()) return;
      let message;
      try { message = JSON.parse(event.data); } catch { this.fail("Invalid terminal stream"); return; }
      if (message === null || typeof message !== "object") { this.fail("Invalid terminal stream"); return; }
      if (message.type === "output" && typeof message.data === "string") {
        this.transcript += message.data;
        if (this.transcript.length > 65536) {
          let cut = this.transcript.length - 65536;
          if (this.transcript.charCodeAt(cut) >= 0xdc00 && this.transcript.charCodeAt(cut) <= 0xdfff) cut++;
          this.transcript = this.transcript.slice(cut);
        }
        for (const listener of this.outputListeners) listener(message.data);
      } else if (message.type === "exit") {
        this.exit();
      }
    };
    ws.onerror = () => { if (current()) this.fail("终端连接失败，请结束会话后重新打开。"); };
    ws.onclose = () => {
      if (!current()) return;
      this.ws = null;
      if (!["closed", "ended", "exiting"].includes(this.state.getSnapshot().status)) {
        this.fail("终端连接已断开，请结束会话后重新打开。");
      }
    };
  }

  subscribeOutput(listener) {
    if (this.transcript) listener(this.transcript);
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  sendFrame(frame) {
    if (this.state.getSnapshot().status !== "open" || this.ws?.readyState !== 1) return;
    this.ws.send(JSON.stringify(frame));
  }

  // Called only by DOM input gestures, never by xterm's automatic device replies.
  markActivity() {
    if (this.activitySent || this.state.getSnapshot().status !== "open") return;
    this.sendFrame({ type: "activity" });
    this.activitySent = true;
  }

  sendRaw(data) { this.sendFrame({ type: "input", data }); }

  async resize(cols, rows) {
    if (this.state.getSnapshot().status !== "open") return;
    const generation = this.generation;
    try {
      const result = await this.call("resize", { streamId: this.streamId, cols, rows });
      // Exit notification travels over WS and may arrive after this RPC reply.
      if (!result?.ok && result?.error?.code === "terminal-ended") return;
      // A late resize rejection during normal exit must not undo the close state.
      if (!result?.ok && generation === this.generation && this.state.getSnapshot().status === "open") {
        this.fail(result?.error?.message || "Terminal resize failed");
      }
    } catch (error) {
      if (generation === this.generation && this.state.getSnapshot().status === "open") this.fail(error);
    }
  }

  exit({ dismiss = false } = {}) {
    if (this.closing) return this.closing;
    if (!this.streamId) {
      this.closeWs();
      if (dismiss) this.setState({ status: "closed" });
      return Promise.resolve();
    }
    const generation = this.generation;
    const streamId = this.streamId;
    this.setState({ status: "exiting" });
    this.closing = (async () => {
      try {
        const result = await this.call("close", { streamId });
        // Another client/host cleanup may have already removed this generation.
        // Dismiss locally without ever closing the replacement generation.
        if (!result?.ok && result?.error?.code === "terminal-stale") {
          if (generation !== this.generation) return;
          this.closeWs();
          this.streamId = null;
          this.setState({ status: "closed", error: null });
          return;
        }
        if (!result?.ok) throw new Error(result?.error?.message || "close failed");
        if (generation !== this.generation) return;
        this.closeWs();
        this.streamId = null;
        const { transcriptPath } = result.value;
        this.setState({ status: dismiss || !transcriptPath ? "closed" : "ended",
          tab: "history", preview: null, pendingSelectPath: transcriptPath, error: null });
      } catch (error) {
        if (generation === this.generation) this.fail(error);
      } finally { this.closing = null; }
    })();
    return this.closing;
  }

  dismiss() { return this.exit({ dismiss: true }); }

  closeWs() {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(); } catch { /* already closed */ }
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    ++this.generation;
    ++this.previewRequest;
    ++this.historyRequest;
    this.closeWs();
    this.outputListeners.clear();
    if (this.streamId && !this.closing) this.call("close", { streamId: this.streamId }).catch(() => {});
    this.streamId = null;
  }

  fail(error) {
    this.closeWs();
    this.setState({ status: "error", error: error instanceof Error ? error.message : String(error) });
  }

  setState(next) {
    if (next.preview === null) ++this.previewRequest;
    if (!this.disposed) this.state.set({ ...this.state.getSnapshot(), ...next });
  }
  setGeometry(patch) { this.setState(patch); }

	/* ---- history tab ---- */
	setTab(tab) {
		// HistoryTab's own mount effect calls loadHistory() when it mounts
		// (it unmounts/remounts on every tab switch), so no need to trigger
		// a second fetch here.
		++this.previewRequest;
		this.setState({ tab, preview: null });
	}

	loadHistory() {
		const request = ++this.historyRequest;
		this.setState({ history: { ...this.state.getSnapshot().history, loading: true, error: null } });
		this.connection.rpc.call(RPC_CHANNEL, "historyList", { sessionId: this.sessionId }, undefined)
			.then((result) => {
				if (request !== this.historyRequest) return;
				if (result === undefined || !result.ok) {
					this.setState({ history: { entries: [], loading: false, error: result && result.error ? result.error.message : "load failed" } });
					return;
				}
				this.setState({ history: { entries: result.value.entries, loading: false, error: null } });
			})
			.catch((error) => {
				if (request === this.historyRequest) this.setState({ history: { entries: [], loading: false, error: error instanceof Error ? error.message : String(error) } });
			});
	}

	togglePreview(path) {
		const request = ++this.previewRequest;
		const current = this.state.getSnapshot().preview;
		if (current !== null && current.path === path) {
			this.setState({ preview: null });
			return;
		}
		this.setState({ preview: { path, transcript: null, loading: true } });
		this.connection.rpc.call(RPC_CHANNEL, "historyRead", { sessionId: this.sessionId, path }, undefined)
			.then((result) => {
				if (request !== this.previewRequest) return;
				if (result === undefined || !result.ok) {
					this.setState({ preview: { path, transcript: result && result.error ? result.error.message : "read failed", loading: false } });
					return;
				}
				this.setState({ preview: { path, transcript: result.value.transcript, loading: false } });
			})
			.catch((error) => {
				if (request === this.previewRequest) this.setState({ preview: { path, transcript: error instanceof Error ? error.message : String(error), loading: false } });
			});
	}

	/** Reference-inject the given transcript paths (multi-select) + notes; non-waking. */
	referenceInject(paths, notes) {
		return this.connection.rpc.call(RPC_CHANNEL, "historyInject", { sessionId: this.sessionId, paths, notes: notes || "" }, undefined)
			.then((result) => {
				if (result === undefined || !result.ok) {
					throw new Error(result && result.error ? result.error.message : "reference-inject failed");
				}
				return result.value;
			});
	}
}

export { TerminalController };
