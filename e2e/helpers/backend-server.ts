/**
 * Controllable backend server for e2e tests.
 *
 * Endpoints:
 *   POST /internal/issue-token   ← Key0 Docker calls this after payment
 *   POST /test/set-mode          ← Tests switch between "success" / "fail"
 *   GET  /api/resource/:id       ← Protected resource, validates Bearer JWT
 *
 * PPR routes (proxied to by the standalone gateway after payment):
 *   GET  /api/weather/:city      ← Returns mock weather data
 *   GET  /api/joke               ← Returns a mock joke
 *   POST /test/set-ppr-mode      ← Controls PPR route behaviour: "success" | "fail" | "error"
 */

import type { Server } from "node:http";
import express from "express";
import { jwtVerify, SignJWT } from "jose";

export const BACKEND_PORT = 3001;
export const BACKEND_JWT_SECRET = "e2e-backend-jwt-secret-for-testing-1234567890";

const secretBytes = new TextEncoder().encode(BACKEND_JWT_SECRET);

let mode: "success" | "fail" = "success";
/** Per-challengeId failure set — avoids poisoning the global mode for concurrent tests. */
const failForChallengeIds: Set<string> = new Set();

/** PPR route mode: "success" = 200, "error" = 500 (backend error). */
let pprMode: "success" | "error" = "success";

/** Internal token for gateway proxy tests — unset means validation is skipped. */
let pprInternalSecret: string | undefined;

export function startBackend(): Promise<Server> {
	const app = express();
	app.use(express.json());

	// ── Token issuance ──────────────────────────────────────────────────────
	app.post("/internal/issue-token", async (req, res) => {
		const { challengeId, requestId, resourceId, planId, txHash } = req.body as Record<
			string,
			string
		>;

		// Per-challenge failure takes precedence (persistent: fails all retries)
		if (challengeId && failForChallengeIds.has(challengeId)) {
			res.status(500).json({ error: "Backend down (per-challenge)" });
			return;
		}

		if (mode === "fail") {
			res.status(500).json({ error: "Backend down" });
			return;
		}

		const token = await new SignJWT({ challengeId, requestId, resourceId, planId, txHash })
			.setProtectedHeader({ alg: "HS256" })
			.setIssuedAt()
			.setExpirationTime("1h")
			.sign(secretBytes);

		res.json({ token, tokenType: "Bearer" });
	});

	// ── Per-challenge failure control ────────────────────────────────────────
	app.post("/test/fail-for-challenge", (req, res) => {
		const { challengeId } = req.body as { challengeId: string };
		if (!challengeId) {
			res.status(400).json({ error: "challengeId required" });
			return;
		}
		failForChallengeIds.add(challengeId);
		res.status(204).send();
	});

	app.post("/test/clear-fail-for-challenge", (req, res) => {
		const { challengeId } = req.body as { challengeId: string };
		if (!challengeId) {
			res.status(400).json({ error: "challengeId required" });
			return;
		}
		failForChallengeIds.delete(challengeId);
		res.status(204).send();
	});

	// ── Mode control ────────────────────────────────────────────────────────
	app.post("/test/set-mode", (req, res) => {
		const { mode: newMode } = req.body as { mode: "success" | "fail" };
		if (newMode !== "success" && newMode !== "fail") {
			res.status(400).json({ error: "mode must be 'success' or 'fail'" });
			return;
		}
		mode = newMode;
		res.status(204).send();
	});

	// ── PPR mode control ─────────────────────────────────────────────────────
	app.post("/test/set-ppr-mode", (req, res) => {
		const { mode: newMode } = req.body as { mode: "success" | "error" };
		if (newMode !== "success" && newMode !== "error") {
			res.status(400).json({ error: "mode must be 'success' or 'error'" });
			return;
		}
		pprMode = newMode;
		res.status(204).send();
	});

	// ── Internal token control (for gateway proxy tests) ─────────────────────
	app.post("/test/set-internal-secret", express.json(), (req: Request, res: Response) => {
		const { secret } = req.body as { secret?: string };
		pprInternalSecret = secret;
		res.json({ ok: true });
	});

	// ── Internal token validation helper ─────────────────────────────────────
	function validateInternalToken(req: Request, res: Response): boolean {
		if (!pprInternalSecret) return true; // not enforced when unset
		const token = req.headers["x-key0-internal-token"];
		if (token !== pprInternalSecret) {
			res
				.status(401)
				.json({ error: "unauthorized", message: "Missing or invalid X-Key0-Internal-Token" });
			return false;
		}
		return true;
	}

	// ── PPR routes (proxied to by standalone gateway after payment) ──────────
	app.get("/api/weather/:city", (req, res) => {
		if (!validateInternalToken(req, res)) return;
		if (pprMode === "error") {
			res.status(500).json({ error: "Backend down" });
			return;
		}
		const city = req.params["city"] ?? "unknown";
		const conditions = ["Sunny", "Cloudy", "Rainy", "Windy", "Partly Cloudy"];
		res.json({
			city,
			tempF: 72,
			condition: conditions[Math.floor(Math.random() * conditions.length)],
			humidity: "55%",
			txHash: req.headers["x-key0-tx-hash"] ?? null,
			planId: req.headers["x-key0-plan-id"] ?? null,
		});
	});

	app.get("/api/joke", (req, res) => {
		if (!validateInternalToken(req, res)) return;
		if (pprMode === "error") {
			res.status(500).json({ error: "Backend down" });
			return;
		}
		res.json({
			joke: "Why do programmers prefer dark mode? Because light attracts bugs.",
			txHash: req.headers["x-key0-tx-hash"] ?? null,
			planId: req.headers["x-key0-plan-id"] ?? null,
		});
	});

	// ── Gateway proxy free-plan route ─────────────────────────────────────────
	app.get("/api/status", (req: Request, res: Response) => {
		if (!validateInternalToken(req, res)) return;
		res.json({ status: "ok", pipelines: 5, uptime: 99.9 });
	});

	// ── Protected resource ──────────────────────────────────────────────────
	app.get("/api/resource/:id", async (req, res) => {
		const authHeader = req.headers.authorization;
		if (!authHeader?.startsWith("Bearer ")) {
			res.status(401).json({ error: "Missing Bearer token" });
			return;
		}

		const token = authHeader.slice(7);
		try {
			const { payload } = await jwtVerify(token, secretBytes);
			res.json({ data: "resource content", resourceId: req.params["id"], tokenSub: payload.sub });
		} catch {
			res.status(401).json({ error: "Invalid or expired token" });
		}
	});

	return new Promise((resolve) => {
		const server = app.listen(BACKEND_PORT, () => {
			console.log(`[e2e backend] Listening on port ${BACKEND_PORT}`);
			resolve(server);
		});
	});
}

export function resetMode(): void {
	mode = "success";
}

export function resetPprMode(): void {
	pprMode = "success";
}

export function resetPprInternalSecret(): void {
	pprInternalSecret = undefined;
}
