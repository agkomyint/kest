import { expect, test } from "bun:test";
import { Inbox, type FormField } from "./inbox";
import { Agent, askControlToolDefinition } from "./agent";

const fields: FormField[] = [
  { id: "dataset", label: "Which dataset?", type: "choice", options: ["2020", "2023"], default: "2023" },
  { id: "survey", label: "Include the survey?", type: "yesno" },
  { id: "n", label: "How many sources?", type: "number", default: "5" },
];
const live = () => new AbortController().signal;

test("a form waits for the user, drafts are not sent, and send resolves the study", async () => {
  const inbox = new Inbox();
  const pending = inbox.ask("s1", "Study A", "Pick inputs", fields, live());
  const item = inbox.items[0]!;
  expect(item.kind).toBe("form");
  expect(inbox.unread()).toBe(1);
  // The model may not draft before the user has read it.
  expect(() => inbox.setDraft(item.id, { survey: "no" })).toThrow("not been read");
  inbox.markRead(item.id);
  inbox.setDraft(item.id, { dataset: "2020" });
  expect(inbox.missing(item)).toEqual(["survey"]);
  expect(() => inbox.send(item.id)).toThrow("Still unanswered: survey");
  expect(() => inbox.setDraft(item.id, { dataset: "1999" })).toThrow("not one of");
  expect(() => inbox.setDraft(item.id, { nope: "x" })).toThrow("Unknown field");
  inbox.setDraft(item.id, { survey: "No" });
  let sent = false;
  void pending.then(() => (sent = true));
  await Promise.resolve();
  expect(sent).toBe(false); // drafting alone sends nothing
  inbox.send(item.id);
  const out = await pending;
  expect(out.kind).toBe("answered");
  expect(out.text).toContain("Which dataset?: 2020");
  expect(out.text).toContain("Include the survey?: no");
  expect(out.text).toContain("How many sources?: 5"); // default filled in
  expect(item.status).toBe("answered");
  expect(() => inbox.send(item.id)).toThrow("already answered");
});

test("an unanswered form expires and tells the director to decide", async () => {
  const inbox = new Inbox();
  inbox.timeoutMs = 20;
  const events: string[] = [];
  inbox.onEvent = (_i, what) => events.push(what);
  const out = await inbox.ask("s1", "Study A", "Pick", fields, live());
  expect(out.kind).toBe("expired");
  expect(out.text).toContain("Decide what is best yourself");
  expect(out.text).toContain("2023");
  expect(inbox.items[0]!.status).toBe("expired");
  expect(events).toEqual(["added", "expired"]);
  expect(() => inbox.send(1)).toThrow("timed out");
});

test("money and publishing forms are sensitive: no defaults, no auto-decision, explicit user answers only", async () => {
  const inbox = new Inbox();
  inbox.timeoutMs = 20;
  const money: FormField[] = [{ id: "extra", label: "Add extra funding?", type: "yesno", default: "yes" }];
  const out = await inbox.ask("s", "S", "Need more", money, live());
  expect(out.kind).toBe("expired");
  expect(out.text).toContain("NOT approved");
  expect(out.text).not.toContain("yes"); // the director's default is never offered as a fallback
  inbox.timeoutMs = 60_000;
  const pending = inbox.ask("s", "S", "Raise the budget", money, live());
  const item = inbox.items[1]!;
  expect(item.sensitive).toBe(true);
  inbox.markRead(item.id);
  expect(inbox.missing(item)).toEqual(["extra"]); // the default does not count as an answer
  expect(() => inbox.send(item.id)).toThrow("Still unanswered");
  inbox.setDraft(item.id, { extra: "no" });
  inbox.send(item.id);
  const sent = await pending;
  expect(sent.text).toContain("Add extra funding?: no");
  expect(sent.text).toContain("/research budget");
  expect(() => inbox.ask("s", "S", "Scope", [], live())).toThrow("1 to 5");
  expect(inbox.items.at(-1)!.sensitive).toBe(true);
});

test("stopping the study closes its open form; dismissing a form does not answer it", async () => {
  const inbox = new Inbox();
  const controller = new AbortController();
  const pending = inbox.ask("s1", "Study A", "Pick", fields, controller.signal);
  inbox.dismiss(1);
  expect(inbox.items[0]!.status).toBe("read"); // still open
  controller.abort();
  expect((await pending).kind).toBe("aborted");
  expect(inbox.openForms()).toHaveLength(0);
});

test("milestone notes from one study merge when they come quickly", () => {
  const inbox = new Inbox();
  inbox.notify("s1", "A", "milestone", "found 3 sources");
  inbox.notify("s1", "A", "milestone", "found 7 sources");
  expect(inbox.items).toHaveLength(1);
  expect(inbox.items[0]!.title).toBe("found 7 sources");
  inbox.notify("s1", "A", "done", "finished");
  expect(inbox.items).toHaveLength(2);
  inbox.notify("s2", "B", "milestone", "other study");
  expect(inbox.items).toHaveLength(3);
});

test("study directors get the inbox tools; the control chat gets draft and send only after a form is read", () => {
  const director = new Agent("/tmp", async () => true);
  director.research = { id: "r1" } as never;
  director.onAskControl = async () => "";
  director.onNotifyControl = () => "";
  const names = (a: Agent) => a.toolDefs().map((t) => (t.type === "function" ? t.function.name : ""));
  expect(names(director)).toContain("ask_control");
  expect(names(director)).toContain("notify_control");
  expect(askControlToolDefinition.type).toBe("function");
  const chat = new Agent("/tmp", async () => true);
  let state: "none" | "draft" | "send" = "none";
  chat.inboxState = () => state;
  chat.onInboxDraft = () => "";
  chat.onInboxSend = () => ({ preview: "", send: () => "" });
  expect(names(chat)).not.toContain("inbox_draft");
  state = "draft";
  expect(names(chat)).toContain("inbox_draft");
  expect(names(chat)).not.toContain("inbox_send");
  state = "send";
  expect(names(chat)).toContain("inbox_send");
  expect(names(chat)).not.toContain("ask_control");
});
