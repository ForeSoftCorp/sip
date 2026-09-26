import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: ["typescript"],
  options: {
    // Crucial for strict, context-heavy TypeScript checks
    typeAware: true, 
  }
});