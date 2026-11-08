/**
 * Dev mode: full build once, then
 *  - the server restarts on src/server.ts changes (bun --watch),
 *  - the browser client is rebuilt whenever src/client/ changes (reload the page to see it).
 * Defaults to port 3001 so it doesn't clash with the Docker container on 3000.
 */
import { watch } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const bun = process.execPath;

const run = (args: string[]) => Bun.spawn([bun, ...args], { cwd: root, stdout: "inherit", stderr: "inherit" });

const first = run(["run", "scripts/build.ts"]);
if ((await first.exited) !== 0) process.exit(1);

process.env.PORT ??= "3001";
const server = run(["--watch", "run", "src/server.ts"]);

let timer: ReturnType<typeof setTimeout> | undefined;
let building = false;
let again = false;
async function rebuild() {
  if (building) return void (again = true);
  building = true;
  do {
    again = false;
    await run(["run", "scripts/build.ts", "--client"]).exited;
  } while (again);
  building = false;
}
watch(join(root, "src", "client"), { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(() => void rebuild(), 100);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.kill();
    process.exit(0);
  });
}
await server.exited;
