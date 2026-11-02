import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests must never read the developer's real ~/.kest (keys, LSI connection).
process.env.KEST_CONFIG_DIR ||= mkdtempSync(join(tmpdir(), "kest-test-config-"));
delete process.env.LSI_KEY;
delete process.env.TAVILY_API_KEY;
// Tests must not write .kest/ into the repo; the local-chat test turns this on itself.
process.env.KEST_LOCAL_CHAT ||= "0";
