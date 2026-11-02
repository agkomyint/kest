import { expect, test } from "bun:test";
import { checkFeasibility, describeMachine, tierOf, type Machine } from "./machine";

const base: Machine = { os: "win32", arch: "x64", cpu: "cpu", cores: 8, ramGb: 16, freeRamGb: 8, diskFreeGb: 100, gpu: null, unified: false };
const potato: Machine = { ...base, cores: 2, ramGb: 4, freeRamGb: 2, diskFreeGb: 20 };
const rig: Machine = { ...base, ramGb: 64, diskFreeGb: 2000, gpu: { name: "RTX 4090", vramGb: 24 } };

test("machine classes", () => {
  expect(tierOf(potato)).toBe("potato");
  expect(tierOf(base)).toBe("laptop");
  expect(tierOf(rig)).toBe("workstation");
  expect(describeMachine(rig)).toContain("RTX 4090");
});

test("a 1 trillion parameter model is impossible on a laptop and offers cloud options", () => {
  const r = checkFeasibility(base, { task: "inference", params_b: 1000, quant: "int4" });
  expect(r.verdict).toBe("impossible");
  expect(r.alternatives.join(" ")).toContain("cloud GPU");
  expect(r.alternatives.join(" ")).toContain("account");
});

test("small models fit, big-but-possible ones are tight, and training needs a GPU", () => {
  expect(checkFeasibility(base, { task: "inference", params_b: 3, quant: "int4" }).verdict).toBe("ok");
  expect(checkFeasibility(base, { task: "inference", params_b: 20, quant: "int4" }).verdict).toBe("tight");
  expect(checkFeasibility(base, { task: "train_full", params_b: 1 }).verdict).toBe("impossible");
  expect(checkFeasibility(potato, { task: "inference", params_b: 7, quant: "int4" }).verdict).toBe("impossible");
  expect(checkFeasibility(rig, { task: "inference", params_b: 7, quant: "int4" }).verdict).toBe("ok");
  expect(checkFeasibility(rig, { task: "inference", params_b: 70, quant: "fp16" }).verdict).toBe("impossible");
});

test("downloads and datasets are checked against disk and memory", () => {
  expect(checkFeasibility(potato, { task: "download", download_gb: 500 }).verdict).toBe("impossible");
  expect(checkFeasibility(base, { task: "dataset", dataset_gb: 30 }).verdict).toBe("tight");
  expect(checkFeasibility(base, { task: "dataset", dataset_gb: 2 }).verdict).toBe("ok");
});
