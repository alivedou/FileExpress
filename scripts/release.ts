import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/i.test(version))
  throw new Error("Usage: tsx scripts/release.ts X.Y.Z");
const run = (command: string, args: string[]): void => {
  execFileSync(command, args, { stdio: "inherit" });
};
const pkg = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
const previousVersion = pkg.version;
pkg.version = version;
await writeFile("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
run("npm", ["version", "--no-git-tag-version", version]);
const log = execFileSync("git", ["log", "--pretty=format:%s", `v${previousVersion}..HEAD`], {
  encoding: "utf8",
});
await writeFile(
  "CHANGELOG.md",
  `# Changelog\n\n## ${version} - ${new Date().toISOString().slice(0, 10)}\n\n${log
    .split("\n")
    .map((line) => `- ${line}`)
    .join("\n")}\n`,
  { flag: "a" },
);
run("git", ["tag", `v${version}`]);
run("docker", [
  "buildx",
  "build",
  "--platform",
  "linux/amd64,linux/arm64",
  "--push",
  "--sbom=true",
  "--provenance=mode=max",
  "-t",
  `ghcr.io/alivedou/fileexpress:${version}`,
  ".",
]);
run("cosign", ["sign", "--yes", `ghcr.io/alivedou/fileexpress:${version}`]);
run("gh", ["release", "create", `v${version}`, "--generate-notes"]);
