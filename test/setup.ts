import { afterEach } from "vitest";
import { cleanupTestDirectories } from "./helpers";

process.env.NODE_ENV = "test";

afterEach(async () => {
  await cleanupTestDirectories();
});
