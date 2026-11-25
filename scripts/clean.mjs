import { rm } from "node:fs/promises";

// Resolve from this script so cleanup always targets this project's generated output.
await rm(new URL("../dist/", import.meta.url), { recursive: true, force: true });
