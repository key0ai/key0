import { type JWTPayload, jwtVerify } from "jose";
import { Key0Error } from "./types/index.js";

export type AccessTokenPayload = JWTPayload & {
	readonly sub: string; // requestId
	readonly jti: string; // challengeId
	readonly resourceId: string;
	readonly tierId: string;
	readonly txHash: string;
};

export type ValidateAccessTokenConfig = {
	readonly secret: string;
};

/**
 * Framework-agnostic token validation.
 * Returns decoded payload or throws.
 */
export async function validateToken(
	authHeader: string | null | undefined,
	config: ValidateAccessTokenConfig,
): Promise<AccessTokenPayload> {
	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		throw new Key0Error("INVALID_REQUEST", "Missing or malformed Authorization header", 401);
	}

	const token = authHeader.slice(7);
	const secret = new TextEncoder().encode(config.secret);

	try {
		const { payload } = await jwtVerify(token, secret);
		return payload as AccessTokenPayload;
	} catch (err: unknown) {
		if (err instanceof Error && err.message.includes("expired")) {
			throw new Key0Error("CHALLENGE_EXPIRED", "Access token expired", 401);
		}
		throw new Key0Error("INVALID_REQUEST", "Invalid access token", 401);
	}
}
