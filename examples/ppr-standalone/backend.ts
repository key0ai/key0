/**
 * Example backend — accepts requests from both:
 *   - Subscription clients (Bearer JWT, direct call — Key0 not in path)
 *   - PPR clients (proxied via Key0, X-Key0-Internal-Token header)
 *
 * Start: bun run start:backend
 *
 * Auth logic (requireAuth middleware):
 *   1. PPR path: request came through Key0 gateway with payment already settled.
 *      Key0 injects X-Key0-Internal-Token on every proxied request.
 *   2. Subscription path: client holds a Bearer JWT issued by the gateway after
 *      paying the subscription plan. validateKey0Token verifies the signature.
 *
 * In production, additionally restrict inbound access to the gateway's IP only.
 */

import { validateKey0Token } from "@key0ai/key0";
import express, { type NextFunction, type Request, type Response } from "express";

const PORT = Number(process.env["BACKEND_PORT"] ?? 3001);
// Must match proxyTo.proxySecret in gateway.ts / KEY0_PROXY_SECRET env var
const PROXY_SECRET = process.env["KEY0_PROXY_SECRET"] ?? "dev-proxy-secret-change-in-production!!";
// Must match KEY0_ACCESS_TOKEN_SECRET used by the gateway's AccessTokenIssuer
const JWT_SECRET =
	process.env["KEY0_ACCESS_TOKEN_SECRET"] ?? "dev-secret-change-me-in-production-32chars!";

const app = express();
app.use(express.json());

// ── Auth middleware ───────────────────────────────────────────────────────────
// Accepts either a Key0 proxy secret (PPR path) or a valid Key0 JWT (subscription path).
async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
	// PPR path: request came through Key0 gateway with payment already settled.
	// Key0 injects X-Key0-Internal-Token on every proxied request.
	if (req.headers["x-key0-internal-token"] === PROXY_SECRET) {
		next();
		return;
	}

	// Subscription path: client has a valid Bearer JWT from the gateway.
	// validateKey0Token accepts the full Authorization header.
	const auth = req.headers.authorization;
	if (auth?.startsWith("Bearer ")) {
		try {
			await validateKey0Token(auth, { secret: JWT_SECRET });
			next();
			return;
		} catch {
			res.status(401).json({ error: "Invalid token" });
			return;
		}
	}

	res.status(401).json({
		error: "Authentication required",
		message:
			"Provide a Bearer token (subscription) or route through the Key0 gateway (pay-per-request).",
	});
}

// ── GET /api/weather/:city ───────────────────────────────────────────────────
// Accessed by both subscription clients (direct Bearer) and PPR clients (via Key0 proxy).
app.get("/api/weather/:city", requireAuth, (req, res) => {
	const city = req.params["city"] ?? "unknown";

	// Payment metadata forwarded by the gateway for PPR requests.
	// Absent for subscription clients (they call directly — no gateway headers).
	const txHash = req.headers["x-key0-tx-hash"];
	const planId = req.headers["x-key0-plan-id"];
	const amount = req.headers["x-key0-amount"];
	const payer = req.headers["x-key0-payer"];
	const accessMode = req.headers["x-key0-internal-token"] ? "pay-per-request" : "subscription";

	const conditions = ["Sunny", "Cloudy", "Rainy", "Windy", "Partly Cloudy"];
	res.json({
		city,
		tempF: Math.round(55 + Math.random() * 35),
		condition: conditions[Math.floor(Math.random() * conditions.length)],
		humidity: `${Math.round(40 + Math.random() * 40)}%`,
		source: "backend",
		accessMode,
		// Only present for PPR requests:
		...(txHash ? { payment: { txHash, planId, amount, payer } } : {}),
	});
});

// ── GET /api/joke ────────────────────────────────────────────────────────────
app.get("/api/joke", requireAuth, (req, res) => {
	const txHash = req.headers["x-key0-tx-hash"];
	const planId = req.headers["x-key0-plan-id"];
	const amount = req.headers["x-key0-amount"];
	const payer = req.headers["x-key0-payer"];

	const jokes = [
		"Why do programmers prefer dark mode? Because light attracts bugs.",
		"A SQL query walks into a bar, walks up to two tables and asks: 'Can I join you?'",
		"Why did the developer go broke? Because he used up all his cache.",
		"There are only 10 types of people in the world: those who understand binary, and those who don't.",
		"Why do Java developers wear glasses? Because they don't C#.",
	];

	res.json({
		joke: jokes[Math.floor(Math.random() * jokes.length)],
		source: "backend",
		...(txHash ? { payment: { txHash, planId, amount, payer } } : {}),
	});
});

// ── GET /health ───────────────────────────────────────────────────────────────
// Free route — no auth required (Key0 proxies this without payment).
app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
	console.log(`\nBackend API running on http://localhost:${PORT}`);
	console.log(`  Weather: GET http://localhost:${PORT}/api/weather/:city`);
	console.log(`  Joke:    GET http://localhost:${PORT}/api/joke`);
	console.log(`  Health:  GET http://localhost:${PORT}/health  (free, no auth)`);
	console.log(`\n  Auth patterns accepted:`);
	console.log(`    PPR:          X-Key0-Internal-Token: <PROXY_SECRET>  (from Key0 gateway)`);
	console.log(`    Subscription: Authorization: Bearer <JWT>             (client calls directly)`);
	console.log(`\n  NOTE: Start the gateway (gateway.ts) to enable payment-gated access.\n`);
});
