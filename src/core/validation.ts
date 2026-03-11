import { Key0Error } from "../types/index.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TX_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const DOLLAR_RE = /^\$\d+(\.\d{1,6})?$/;

export function validateUUID(value: string, label: string): void {
	if (!UUID_RE.test(value)) {
		throw new Key0Error("INVALID_REQUEST", `${label} must be a valid UUID`, 400);
	}
}

export function validateTxHash(value: string): asserts value is `0x${string}` {
	if (!TX_RE.test(value)) {
		throw new Key0Error(
			"INVALID_REQUEST",
			"txHash must be a 0x-prefixed 64-char hex string",
			400,
		);
	}
}

export function validateAddress(value: string): asserts value is `0x${string}` {
	if (!ADDR_RE.test(value)) {
		throw new Key0Error(
			"INVALID_REQUEST",
			"Address must be a 0x-prefixed 40-char hex string",
			400,
		);
	}
}

export function validateNonEmpty(value: string, label: string): void {
	if (!value || value.trim().length === 0) {
		throw new Key0Error("INVALID_REQUEST", `${label} must not be empty`, 400);
	}
}

export function validateDollarAmount(value: string, label: string): void {
	if (!DOLLAR_RE.test(value)) {
		throw new Key0Error(
			"INVALID_REQUEST",
			`${label} must be a dollar amount (e.g. "$0.10")`,
			400,
		);
	}
}
