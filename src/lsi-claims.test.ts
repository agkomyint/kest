import { expect, test } from "bun:test";
import { LsiTools } from "./lsi";

const KEY = "lsi_" + "a".repeat(32);
const signal = () => new AbortController().signal;

test("two studies in one Kest cannot claim the same question", async () => {
  const make = () =>
    new LsiTools(async () => true, {
      key: () => KEY,
      baseUrl: () => "https://lsi.example",
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });
  const a = make();
  const b = make();
  await a.execute("lsi_claim", { question_id: "LSI-Q-000042" }, signal());
  await expect(b.execute("lsi_claim", { question_id: "LSI-Q-000042" }, signal())).rejects.toThrow("already claimed");
  await a.execute("lsi_release", { question_id: "LSI-Q-000042" }, signal());
  await b.execute("lsi_claim", { question_id: "LSI-Q-000042" }, signal());
  await b.execute("lsi_release", { question_id: "LSI-Q-000042" }, signal());
});
