/**
 * dsh-shell-command — host side of the multi-command terminal mode.
 *
 * Bridges the client popup to a persistent PTY:
 * - control RPC (`connection.rpc`) for open / transcript preview / close+inject;
 * - a WebSocket (`ctx.webServer.registerUpgrade`) for the live terminal byte
 *   stream (real-time, replaying the transcript on connect).
 *
 * The native/transport deps (`node-pty`, `ws`) are imported lazily so the
 * bundle still loads (terminal mode degrades with a warning) when they are
 * absent, and so the rest of the plugin stays testable with mocks.
 *
 * @module dsh-shell-command/rpc
 */
import { createTerminalManager } from "./terminal.js";
import { buildFollowupMessage, buildPointerMessage } from "./inject.js";
import { formatSummary } from "./format.js";
import { agentCwd } from "./util.js";

const RPC_CHANNEL = "/shell-term-rpc";
const WS_PATH = "/shell-term/ws";

/** Resolve the owning agent from a client-supplied session id. */
function resolveAgent(agents, sessionId) {
	return typeof sessionId === "string" ? agents?.get(sessionId) : undefined;
}

/** One request/response RPC result envelope (mirrors dsh-btw). */
function ok(value) {
	return { ok: true, value };
}
function fail(code, message) {
	return { ok: false, error: { code, message, details: { issues: [] } } };
}

/**
 * Register the control RPC endpoints. Returns the disposer.
 * @param deps.manager - terminal registry.
 * @param deps.agents - live agent registry.
 * @param deps.connection - host client-connection service.
 * @param deps.config - effective plugin config.
 */
export function registerTerminalRpc(deps) {
	const { manager, agents, connection, config, logger } = deps;
	return connection.rpc.handle(RPC_CHANNEL, async (endpoint, payload, _signal) => {
		const agent = resolveAgent(agents, payload?.sessionId);
		if (agent === undefined) return fail("session-not-found", `no live agent owns session "${String(payload?.sessionId)}"`);

		switch (endpoint) {
			case "open": {
				const cwd = agentCwd(agent);
				const handle = manager.open(String(agent.id), {
					cwd,
					cols: payload?.cols ?? 80,
					rows: payload?.rows ?? 24,
				});
				return ok({ streamId: handle.streamId, cwd });
			}
			case "transcript": {
				const handle = manager.get(String(agent.id));
				if (handle === undefined) return ok({ transcript: "", truncated: false, exitCode: null });
				return ok({
					transcript: handle.transcript,
					truncated: handle.transcriptTruncated,
					exitCode: handle.exitCode,
				});
			}
			case "close": {
				return await closeEndpoint({ manager, agent, config, logger, payload });
			}
			default:
				return fail("bad-request", `unknown endpoint: ${String(endpoint)}`);
		}
	}, { authority: "trusted-host" });
}

/**
 * Close the terminal and honor the consent gate:
 * - persist the transcript to the session workspace (always, for later reads);
 * - inject "yes" → `agent.followup` (synchronous analysis);
 * - inject "no" → `agent.inject` pointer (no wake).
 */
async function closeEndpoint({ manager, agent, config, logger, payload }) {
	const id = String(agent.id);
	const { transcript, truncated, exitCode } = manager.close(id);
	const cwd = agentCwd(agent);
	const bytes = Buffer.byteLength(transcript, "utf8");

	let transcriptPath;
	try {
		transcriptPath = manager.persist(cwd, id, transcript);
	} catch (error) {
		logger?.warn?.(`dsh-shell-command: transcript persist failed: ${error?.message ?? error}`);
		transcriptPath = null;
	}

	// Strict boolean contract: the client always sends a real boolean (see
	// TerminalController.exit in client.js). Anything else is a contract
	// violation — warn loudly rather than silently falling through to "no".
	if (payload?.inject !== undefined && typeof payload.inject !== "boolean") {
		logger?.warn?.(`dsh-shell-command: non-boolean inject value ${JSON.stringify(payload.inject)}, treating as false`);
	}
	const inject = payload?.inject === true;
	if (inject) {
		const message = buildFollowupMessage({
			cwd,
			command: "terminal session",
			transcript,
			truncated,
			exitCode,
			notes: typeof payload?.notes === "string" ? payload.notes : "",
			injectMaxBytes: config.terminalInjectMaxBytes,
		});
		agent.followup(message);
	} else if (transcriptPath !== null) {
		agent.inject(buildPointerMessage({ cwd, transcriptPath, bytes }));
	}

	return ok({ transcriptPath, bytes, injected: inject ? "followup" : "pointer", exitCode });
}

/**
 * Register the terminal byte-stream WebSocket. Returns the disposer.
 * @param deps.manager - terminal registry.
 * @param deps.WebSocketServer - `ws` WebSocketServer constructor.
 * @param deps.webServer - host webserver service (may be undefined).
 * @param deps.ctx - cordis context (for effect-scoped registration).
 */
export function registerTerminalWs(deps) {
	const { manager, WebSocketServer, webServer, ctx } = deps;
	if (webServer === undefined) return () => {};
	const wss = new WebSocketServer({ noServer: true });
	ctx.effect(() => webServer.registerUpgrade({
		path: WS_PATH,
		handler: (req, socket, head) => {
			const url = new URL(req.url ?? "/", "http://dsh.internal");
			const sessionId = url.searchParams.get("sessionId");
			if (sessionId === null) {
				socket.destroy();
				return;
			}
			wss.handleUpgrade(req, socket, head, (ws) => {
				manager.attachWs(sessionId, ws);
			});
		},
	}), "shell-command terminal WebSocket");
	return () => {
		wss.close();
	};
}

/**
 * Best-effort setup of the whole terminal mode. Loads `node-pty`/`ws` lazily,
 * warns (and returns a no-op disposer) when any required piece is missing.
 */
export async function setupTerminalMode(ctx, config) {
	try {
		const connection = ctx.get("connection");
		const agents = ctx.get("agents");
		const webServer = ctx.get("webServer");
		if (connection === undefined || agents === undefined) {
			ctx.logger?.warn?.("dsh-shell-command: terminal mode disabled (missing connection/agents services)");
			return () => {};
		}

		let pty;
		let WebSocketServer;
		try {
			const [ptyNs, wsNs] = await Promise.all([import("node-pty"), import("ws")]);
			pty = ptyNs;
			// `ws` is a CJS module whose namespace exposes only `default`; the
			// server constructor hangs off the default export.
			WebSocketServer = wsNs.WebSocketServer ?? wsNs.default?.WebSocketServer ?? wsNs.default?.Server;
			if (WebSocketServer === undefined) throw new Error("no WebSocketServer export on ws");
		} catch (error) {
			ctx.logger?.warn?.(`dsh-shell-command: terminal mode disabled (${error?.message ?? error})`);
			return () => {};
		}

		const manager = createTerminalManager({
			pty,
			shell: config.shell || undefined,
			maxTranscriptBytes: config.terminalMaxTranscriptBytes,
			transcriptDir: config.terminalTranscriptDir,
			transcriptKeep: config.terminalTranscriptKeep,
			logger: ctx.logger,
		});

		const disposeRpc = registerTerminalRpc({ manager, agents, connection, config, logger: ctx.logger });
		const disposeWs = registerTerminalWs({ manager, WebSocketServer, webServer, ctx });

		return () => {
			disposeRpc();
			disposeWs();
			manager.disposeAll();
		};
	} catch (error) {
		// Never let a terminal-mode failure take down the whole bundle: the
		// single-command /shell path stays live regardless.
		ctx.logger?.warn?.(`dsh-shell-command: terminal mode disabled (${error?.message ?? error})`);
		return () => {};
	}
}

export { RPC_CHANNEL, WS_PATH, formatSummary };
