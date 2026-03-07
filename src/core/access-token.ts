import { importPKCS8, jwtVerify, SignJWT } from "jose";

export type TokenClaims = {
	readonly sub: string; // requestId
	readonly jti: string; // challengeId
	readonly resourceId: string;
	readonly tierId: string;
	readonly txHash: string;
};

export type TokenResult = {
	readonly token: string;
	readonly expiresAt: Date;
};

export type AccessTokenIssuerConfig = {
	/** Shared secret for HS256 (required if algorithm is HS256) */
	secret?: string;
	/** Private key (PEM format) for RS256 (required if algorithm is RS256) */
	privateKey?: string;
	/** Algorithm to use (default: HS256) */
	algorithm?: "HS256" | "RS256";
};

export class AccessTokenIssuer {
	private readonly key: Uint8Array | string;
	private readonly algorithm: "HS256" | "RS256";
	private readonly privateKeyString?: string; // Store private key string for RS256

	constructor(config: AccessTokenIssuerConfig | string) {
		// Backward compatibility: if string is passed, treat as secret
		if (typeof config === "string") {
			if (config.length < 32) {
				throw new Error("ACCESS_TOKEN_SECRET must be at least 32 characters");
			}
			this.algorithm = "HS256";
			this.key = new TextEncoder().encode(config);
			return;
		}

		// New config-based approach
		this.algorithm = config.algorithm || "HS256";

		if (this.algorithm === "RS256") {
			if (!config.privateKey) {
				throw new Error("RS256 algorithm requires privateKey");
			}
			// Store as string, will be imported in sign() method
			this.privateKeyString = config.privateKey;
			this.key = config.privateKey; // Keep for type compatibility
		} else {
			if (!config.secret) {
				throw new Error("HS256 algorithm requires secret");
			}
			if (config.secret.length < 32) {
				throw new Error("ACCESS_TOKEN_SECRET must be at least 32 characters");
			}
			this.key = new TextEncoder().encode(config.secret);
		}
	}

	async sign(claims: TokenClaims, ttlSeconds: number): Promise<TokenResult> {
		const now = Math.floor(Date.now() / 1000);
		const exp = now + ttlSeconds;

		const jwt = new SignJWT({
			...claims,
		})
			.setProtectedHeader({ alg: this.algorithm })
			.setIssuedAt(now)
			.setExpirationTime(exp)
			.setSubject(claims.sub)
			.setJti(claims.jti);

		let signingKey: Uint8Array | Awaited<ReturnType<typeof importPKCS8>>;
		if (this.algorithm === "RS256") {
			// Import private key (PEM format)
			if (this.privateKeyString) {
				signingKey = await importPKCS8(this.privateKeyString, "RS256");
			} else {
				throw new Error("Private key not available for RS256 signing");
			}
		} else {
			signingKey = this.key as Uint8Array;
		}

		const token = await jwt.sign(signingKey);

		return {
			token,
			expiresAt: new Date(exp * 1000),
		};
	}

	async verify(token: string): Promise<TokenClaims & { iat: number; exp: number }> {
		if (this.algorithm === "RS256") {
			// For verification, we'd need public key, but this method is for internal use
			// In practice, verification should use the public key separately via validateAgentGateToken
			throw new Error("RS256 verification requires public key, use validateAgentGateToken instead");
		}
		const verifyKey = this.key as Uint8Array;
		const { payload } = await jwtVerify(token, verifyKey, {
			algorithms: [this.algorithm],
		});
		return payload as TokenClaims & { iat: number; exp: number };
	}

	async verifyWithFallback(
		token: string,
		fallbackSecrets: string[],
	): Promise<TokenClaims & { iat: number; exp: number }> {
		try {
			return await this.verify(token);
		} catch {
			// Primary secret failed — try fallbacks
		}

		for (const secret of fallbackSecrets) {
			try {
				const key = new TextEncoder().encode(secret);
				const { payload } = await jwtVerify(token, key);
				return payload as TokenClaims & { iat: number; exp: number };
			} catch {
				// Try next fallback
			}
		}

		throw new Error("Token verification failed with all secrets");
	}
}
