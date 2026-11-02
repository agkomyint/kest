import { expect, test } from "bun:test";
import { lsiRequest } from "./lsi";
import { checkUrs, URS_EXAMPLE } from "./urs-check";

test("the documented example passes the preflight check", () => {
  expect(checkUrs(URS_EXAMPLE)).toEqual([]);
});

test("common rejections are caught with fixable messages", () => {
  const bad = {
    ...URS_EXAMPLE,
    findings: "a string",
    extra: 1,
    evidence: [
      { type: "benchmark", description: "local file", uri: "C:\\results\\a.json" },
      { type: "repository", description: "repo", uri: "https://example.org/r" },
      { type: "dataset", description: "nothing here" },
      { type: "benchmark", description: "huge", text: "x".repeat(7000) },
    ],
    conclusion: undefined,
  };
  const text = checkUrs(bad).join("\n");
  expect(text).toContain("findings must be an ARRAY");
  expect(text).toContain('unknown key "extra"');
  expect(text).toContain("evidence[0].uri");
  expect(text).toContain("40-character commit");
  expect(text).toContain("evidence[2] needs a public uri or inline text");
  expect(text).toContain("evidence[3].text is over");
  expect(text).toContain("conclusion is required");
});

test("lsi_publish fails before approval when the record is malformed", () => {
  expect(() => lsiRequest("lsi_publish", { research: { title: "x" } })).toThrow("Fix the research record");
  expect(lsiRequest("lsi_publish", { research: URS_EXAMPLE }).method).toBe("POST");
});
