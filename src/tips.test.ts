import { expect, test } from "bun:test";
import { allTips, tipsFor, type TipContext } from "./tips";
import { newCompany } from "./research-company";

const context: TipContext = {
  connected: true,
  permission: "strict",
  researchEnabled: true,
  tavily: false,
  lsi: false,
};

test("the Markdown catalog supplies unique short tips with relevant first actions", () => {
  expect(allTips.length).toBeGreaterThan(30);
  expect(new Set(allTips.map((tip) => tip.id)).size).toBe(allTips.length);
  expect(tipsFor({ ...context, connected: false })[0]?.text).toContain(
    "/connect",
  );
  expect(
    tipsFor({ ...context, permission: "all" }).some(
      (tip) => tip.situation === "Wants fewer interruptions",
    ),
  ).toBe(false);
  const study = newCompany("Research");
  expect(tipsFor({ ...context, research: study })[0]?.text).toContain(
    "/research budget",
  );
  study.maxCostUsd = 5;
  expect(tipsFor({ ...context, research: study })[0]?.text).toContain(
    "/research start",
  );
  study.status = "paused";
  expect(tipsFor({ ...context, research: study })[0]?.text).toContain(
    "/research resume",
  );
});
