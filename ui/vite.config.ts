import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	base: "/setup/",
	plugins: [react(), tailwindcss()],
	server: {
		proxy: {
			"/api": "http://localhost:3000",
		},
	},
});
