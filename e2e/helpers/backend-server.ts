/**
 * Controllable backend server for e2e tests.
 *
 * Endpoints:
 *   POST /internal/issue-token   ← Key2a Docker calls this after payment
 *   POST /test/set-mode          ← Tests switch between "success" / "fail"
 *   GET  /api/resource/:id       ← Protected resource, validates Bearer JWT
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

export function startBackend(): Promise<Server> {
	const app = express();
	app.use(express.json());

	// ── Token issuance ──────────────────────────────────────────────────────
	app.post("/internal/issue-token", async (req, res) => {
		const { challengeId, requestId, resourceId, tierId, txHash } = req.body as Record<
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

		const token = await new SignJWT({ challengeId, requestId, resourceId, tierId, txHash })
			.setProtectedHeader({ alg: "HS256" })
			.setIssuedAt()
			.setExpirationTime("1h")
			.sign(secretBytes);

		const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
		res.json({ token, expiresAt, tokenType: "Bearer" });
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
