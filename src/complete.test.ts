import { expect, test } from "bun:test";
import {
  completeCandidates,
  completionHasChildren,
  longestCommonPrefix,
} from "./complete";

test("top-level prefix suggests research and resume", () => {
  expect(completeCandidates("/res")).toEqual(["/research", "/resume"]);
  expect(completeCandidates("/research")).toEqual(["/research"]);
});

test("child level suggests research subcommands", () => {
  expect(completeCandidates("/research ")).toContain("/research start");
  expect(completeCandidates("/research ")).toContain("/research resume");
  expect(completeCandidates("/research ")).toContain("/research budget");
  expect(completeCandidates("/research ")).toContain("/research tokens");
  expect(completeCandidates("/research b")).toEqual(["/research budget"]);
  expect(completeCandidates("/research m")).toEqual([
    "/research models",
    "/research model",
  ]);
  expect(completeCandidates("/research s")).toEqual(["/research start"]);
  expect(completeCandidates("/connect ")).toEqual([
    "/connect modal",
    "/connect baseten",
  ]);
  expect(completeCandidates("/permission m")).toEqual(["/permission minimal"]);
  expect(completeCandidates("/tasks")).toEqual(["/tasks"]);
});

test("third level suggests budget tokens", () => {
  expect(completeCandidates("/research budget ")).toEqual([
    "/research budget tokens",
  ]);
  expect(completeCandidates("/research budget t")).toEqual([
    "/research budget tokens",
  ]);
  expect(completeCandidates("/research budget 60")).toEqual([]);
});

test("longest common prefix extends shared stems", () => {
  expect(longestCommonPrefix(["/research", "/resume"])).toBe("/res");
  expect(longestCommonPrefix(["/research models", "/research model"])).toBe(
    "/research model",
  );
});

test("completionHasChildren flags commands with deeper levels", () => {
  expect(completionHasChildren("/research")).toBe(true);
  expect(completionHasChildren("/research budget")).toBe(true);
  expect(completionHasChildren("/tasks")).toBe(false);
});
