import { defineConfig } from "oxlint";
import typeScriptRecommended from "./node_modules/@ogs-gmbh/oxlint-presets/typescript-recommended.json" with { type: "json" };

export default defineConfig({
	plugins: ["typescript"],
	extends: [
		typeScriptRecommended
	],
	options: {
		// Use the strict compiler settings in tsconfig.json for type-aware rules.
		typeAware: true,
	}
});
