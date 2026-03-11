/**
 * Backend Service Example
 *
 * This example shows how to integrate with Key0 standalone service.
 * It demonstrates both token validation modes:
 * - Native: Validates Key0 JWT tokens
 * - Remote: Issues custom tokens when Key0 calls /internal/issue-token
 *
 * Usage:
 *   bun run start
 */

import type { AccessTokenPayload } from "@riklr/key0";
import { validateKey0Token } from "@riklr/key0";
import express from "express";

const PORT = Number(process.env.PORT ?? 3000);
const KEY0_SECRET = process.env.KEY0_ACCESS_TOKEN_SECRET!;
const INTERNAL_AUTH_SECRET = process.env.INTERNAL_AUTH_SECRET!;

const app = express();
app.use(express.json());

// Mock database
const resources = new Map<string, { tierId: string }>([
	["default", { tierId: "basic" }], // Accept general API access
	["photo-1", { tierId: "basic" }],
	["photo-2", { tierId: "basic" }],
	["album-1", { tierId: "premium" }],
]);

const apiKeys = new Map<string, { expiresAt: Date; resourceId: string; tierId: string }>();

// ============================================================================
// Internal Endpoints (called by Key0 Service)
// ============================================================================

// Middleware to verify internal auth
function verifyInternalAuth(
	req: express.Request,
	res: express.Response,
	next: express.NextFunction,
) {
	const authHeader = req.headers["x-internal-auth"];
	if (authHeader !== INTERNAL_AUTH_SECRET) {
		return res.status(401).json({ error: "Unauthorized" });
	}
	next();
}

// Verify resource exists
app.post("/internal/verify-resource", verifyInternalAuth, (req, res) => {
	const { resourceId, tierId } = req.body;

	// Accept "default" for any tier (general API access)
	if (resourceId === "default") {
		return res.json({ valid: true });
	}

	// Validate specific resources
	const resource = resources.get(resourceId);
	const valid = resource !== undefined && resource.tierId === tierId;
	res.json({ valid });
});

// Issue token (only used if Key0 tokenMode="remote")
app.post("/internal/issue-token", (req, res) => {
	const { requestId: _requestId, resourceId, tierId, txHash: _txHash } = req.body;

	// Generate a custom API key (in production, use your actual key generation)
	const apiKey = `ak_${crypto.randomUUID().replace(/-/g, "")}`;
	const expiresAt = new Date(Date.now() + 3600 * 1000); // 1 hour

	// Store the key
	apiKeys.set(apiKey, { expiresAt, resourceId, tierId });

	console.log(`[Backend] Issued API key for resource ${resourceId}, tier ${tierId}`);

	res.json({
		token: apiKey,
		expiresAt: expiresAt.toISOString(),
		tokenType: "Bearer",
	});
});

// Payment received notification
app.post("/internal/payment-received", verifyInternalAuth, (req, res) => {
	const grant = req.body;
	console.log(`[Backend] Payment received: ${grant.resourceId} (${grant.tierId})`);
	console.log(`  TX: ${grant.explorerUrl}`);

	// Your payment handling logic here
	// e.g., update database, send webhook, etc.

	res.json({ received: true });
});

// ============================================================================
// Protected API Endpoints
// ============================================================================

// Middleware to validate Key0 tokens (Native Mode)
async function validateToken(
	req: express.Request,
	res: express.Response,
	next: express.NextFunction,
) {
	try {
		const payload = await validateKey0Token(req.headers.authorization, {
			secret: KEY0_SECRET,
		});

		// Attach token to request
		(req as express.Request & { key0Token: AccessTokenPayload }).key0Token = payload;
		next();
	} catch (err) {
		// If native token validation fails, check for custom API key (Remote Mode)
		const authHeader = req.headers.authorization;
		if (authHeader?.startsWith("Bearer ")) {
			const apiKey = authHeader.slice(7);
			const keyData = apiKeys.get(apiKey);
			if (keyData && keyData.expiresAt > new Date()) {
				// Valid API key
				(
					req as express.Request & {
						key0Token: { resourceId: string; tierId: string; type: string };
					}
				).key0Token = {
					resourceId: keyData.resourceId,
					tierId: keyData.tierId,
					type: "api-key",
				};
				return next();
			}
		}

		res.status(401).json({
			error: "Unauthorized",
			message: err instanceof Error ? err.message : "Invalid token",
		});
	}
}

// Protect API routes
app.use("/api", validateToken);

// Sample protected endpoint
app.get("/api/photos/:id", (req, res) => {
	const token = (req as unknown as { key0Token: AccessTokenPayload }).key0Token;

	// If token has "default" resourceId, it grants access to all resources (tier-scoped)
	// Otherwise, verify specific resource ID matches
	if (token.resourceId !== "default" && req.params.id !== token.resourceId) {
		return res.status(403).json({ error: "Token not valid for this resource" });
	}

	const resource = resources.get(req.params.id);
	if (!resource) {
		return res.status(404).json({ error: "Resource not found" });
	}

	// Verify tier access
	if (token.tierId !== resource.tierId) {
		return res.status(403).json({ error: "Token tier does not grant access to this resource" });
	}

	res.json({
		id: req.params.id,
		tierId: token.tierId,
		url: `https://cdn.example.com/photos/${req.params.id}.jpg`,
		title: `Photo ${req.params.id}`,
		resolution: "4K",
	});
});

app.get("/api/data/:id", (req, res) => {
	const token = (req as unknown as { key0Token: AccessTokenPayload }).key0Token;

	// Token with "default" resourceId grants tier-based access to all endpoints
	res.json({
		id: req.params.id,
		data: "premium content",
		tierId: token.tierId,
		resourceId: token.resourceId,
	});
});

// Health check
app.get("/health", (_req, res) => {
	res.json({ status: "ok", service: "backend" });
});

app.listen(PORT, () => {
	console.log("\n📦 Backend Service");
	console.log(`   Port: ${PORT}`);
	console.log("   Protected APIs: /api/*");
	console.log("   Internal endpoints: /internal/*\n");
});
