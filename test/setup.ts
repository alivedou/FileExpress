import { afterEach } from "vitest";
import { cleanupTestDirectories } from "./helpers";

afterEach(async () => {
  await cleanupTestDirectories();
});
