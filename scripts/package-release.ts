import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { version } from "../package.json";

const name = `kest-v${version}-${process.platform}-${process.arch}`;
const root = join("release", name);
await mkdir(join(root, "node_modules"), { recursive: true });
const binary = process.platform === "win32" ? "kest.exe" : "kest";
await cp(join("dist", binary), join(root, binary));
await cp("node_modules/playwright-core", join(root, "node_modules/playwright-core"), { recursive: true });
await cp("README.md", join(root, "README.md"));
await writeFile(join(root, "RUN.txt"), `Kest v${version}\n\nRun ${binary} from this folder. Keep node_modules beside the executable.\nBun is not required. Browser tools require installed Google Chrome or Microsoft Edge.\nUse /connect to configure your own provider credentials.\n`);
const archive = join("release", `${name}.${process.platform === "win32" ? "zip" : "tar.gz"}`);
const command = process.platform === "win32"
  ? ["powershell", "-NoProfile", "-Command", `Compress-Archive -LiteralPath '${root}' -DestinationPath '${archive}' -Force`]
  : ["tar", "-czf", archive, "-C", "release", name];
const result = Bun.spawnSync(command, { stdout: "inherit", stderr: "inherit" });
if (result.exitCode !== 0) process.exit(result.exitCode || 1);
const hash = createHash("sha256").update(new Uint8Array(await Bun.file(archive).arrayBuffer())).digest("hex");
await writeFile(`${archive}.sha256`, `${hash}  ${archive.split(/[\\/]/).at(-1)}\n`);
console.log(`Release folder: ${root}\nArchive: ${archive}`);
