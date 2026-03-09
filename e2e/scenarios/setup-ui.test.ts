import { describe, expect, test } from "bun:test";
import { AGENTGATE_URL } from "../fixtures/constants.ts";

describe("Setup UI", () => {
	test("GET /setup/ returns HTML with built assets", async () => {
		const res = await fetch(`${AGENTGATE_URL}/setup/`);
		expect(res.status).toBe(200);

		const html = await res.text();
		expect(html).toContain("<!doctype html>");
		expect(html).toContain('<div id="root"></div>');
		// Vite-built assets should use /setup/ base path
		expect(html).toContain('src="/setup/assets/');
		expect(html).toContain('href="/setup/assets/');
	});

	test("GET /setup/assets/ JS bundle is loadable", async () => {
		// Fetch the HTML to extract the actual JS bundle filename
		const html = await (await fetch(`${AGENTGATE_URL}/setup/`)).text();
		const jsMatch = html.match(/src="(\/setup\/assets\/index-[^"]+\.js)"/);
		expect(jsMatch).not.toBeNull();

		const jsRes = await fetch(`${AGENTGATE_URL}${jsMatch![1]}`);
		expect(jsRes.status).toBe(200);
		expect(jsRes.headers.get("content-type")).toContain("javascript");
	});

	test("GET /setup/assets/ CSS bundle is loadable", async () => {
		const html = await (await fetch(`${AGENTGATE_URL}/setup/`)).text();
		const cssMatch = html.match(/href="(\/setup\/assets\/index-[^"]+\.css)"/);
		expect(cssMatch).not.toBeNull();

		const cssRes = await fetch(`${AGENTGATE_URL}${cssMatch![1]}`);
		expect(cssRes.status).toBe(200);
		expect(cssRes.headers.get("content-type")).toContain("css");
	});

	test("GET /api/setup/status returns configured status", async () => {
		const res = await fetch(`${AGENTGATE_URL}/api/setup/status`);
		expect(res.status).toBe(200);

		const data = (await res.json()) as { configured: boolean; setupProtected: boolean };
		// In e2e, the server is running with env vars so it should be configured
		expect(data.configured).toBe(true);
	});
});
