import { type JWTPayload, importSPKI, jwtVerify } from "jose";

export type AccessTokenPayload = JWTPayload & {
	readonly sub: string; // requestId
	readonly jti: string; // challengeId
	readonly resourceId: string;
	readonly tierId: string;
	readonly txHash: string;
};

export type ValidatorConfig = {
	/** Shared secret for HS256 */
	secret?: string;
	/** Public key for RS256 (PEM format) */
	publicKey?: string;
	/** Algorithm to expect (default: HS256) */
	algorithm?: "HS256" | "RS256";
};

/**
 * Lightweight token validator for backend services.
 * Does not require blockchain connection or full SDK.
 *
 * @example
 * ```typescript
 * const payload = await validateAgentGateToken(
 *   req.headers.authorization,
 *   { secret: process.env.AGENTGATE_SECRET }
 * );
 * ```
 */
export async function validateAgentGateToken(
	authHeader: string | null | undefined,
	config: ValidatorConfig,
): Promise<AccessTokenPayload> {
	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		throw new Error("Missing or malformed Authorization header");
	}

	const token = authHeader.slice(7);
	const alg = config.algorithm || "HS256";

	let key: Uint8Array | Awaited<ReturnType<typeof importSPKI>>;

	if (alg === "RS256") {
		if (!config.publicKey) {
			throw new Error("RS256 algorithm requires publicKey");
		}
		key = await importSPKI(config.publicKey, alg);
	} else {
		if (!config.secret) {
			throw new Error("HS256 algorithm requires secret");
		}
		key = new TextEncoder().encode(config.secret);
	}

	try {
		const { payload } = await jwtVerify(token, key, {
			algorithms: [alg],
		});

		// Validate required claims
		const required = ["sub", "jti", "resourceId", "tierId", "txHash"];
		for (const claim of required) {
			if (!payload[claim]) {
				throw new Error(`Invalid token: missing claim ${claim}`);
			}
		}

		return payload as AccessTokenPayload;
	} catch (err: unknown) {
		if (err instanceof Error && err.message.includes("expired")) {
			throw new Error("Token expired");
		}
		throw new Error("Invalid token signature");
	}
}
