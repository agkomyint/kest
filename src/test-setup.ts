import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests must never read the developer's real ~/.kest (keys, LSI connection).
process.env.KEST_CONFIG_DIR ||= mkdtempSync(join(tmpdir(), "kest-test-config-"));
delete process.env.LSI_KEY;
