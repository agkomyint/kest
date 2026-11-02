import os from "node:os";
import { statfs } from "node:fs/promises";

/**
 * What this computer can and cannot do, so research is planned inside it.
 * Facts are measured once; feasibility is computed, never guessed by the model.
 */
export type Machine = {
  os: string;
  arch: string;
  cpu: string;
  cores: number;
  ramGb: number;
  freeRamGb: number;
  diskFreeGb: number | null;
  gpu: { name: string; vramGb: number } | null;
  /** Apple silicon shares memory between CPU and GPU. */
  unified: boolean;
};

export type Tier = "potato" | "laptop" | "workstation";

const gb = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;

async function detectGpu(): Promise<Machine["gpu"]> {
  try {
    const proc = Bun.spawn(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), 3000);
    const text = await new Response(proc.stdout).text();
    clearTimeout(timer);
    const first = text.trim().split("\n")[0];
    if (!first) return null;
    const [name = "GPU", mem = "0"] = first.split(",").map((s) => s.trim());
    const mib = Number(mem);
    return Number.isFinite(mib) && mib > 0 ? { name, vramGb: Math.round((mib / 1024) * 10) / 10 } : null;
  } catch {
    return null;
  }
}

let cached: Promise<Machine> | null = null;
export function getMachine(cwd = process.cwd()): Promise<Machine> {
  cached ??= (async () => {
    let diskFreeGb: number | null = null;
    try {
      const fs = await statfs(cwd);
      diskFreeGb = gb(fs.bavail * fs.bsize);
    } catch {
      /* unknown */
    }
    const cpus = os.cpus();
    return {
      os: os.platform(),
      arch: os.arch(),
      cpu: cpus[0]?.model?.trim() ?? "unknown CPU",
      cores: cpus.length || 1,
      ramGb: gb(os.totalmem()),
      freeRamGb: gb(os.freemem()),
      diskFreeGb,
      gpu: await detectGpu(),
      unified: os.platform() === "darwin" && os.arch() === "arm64",
    };
  })();
  return cached;
}

export function tierOf(m: Machine): Tier {
  const memory = m.gpu ? Math.max(m.gpu.vramGb, 0) : m.ramGb;
  if ((m.gpu && m.gpu.vramGb >= 12) || m.ramGb >= 48) return "workstation";
  if (m.ramGb < 8 || m.cores <= 2 || (!m.gpu && memory < 8)) return "potato";
  return "laptop";
}

export function describeMachine(m: Machine): string {
  const gpu = m.gpu ? `${m.gpu.name} ${m.gpu.vramGb} GB VRAM` : m.unified ? "Apple unified memory (shared GPU)" : "no GPU";
  return `${m.os}/${m.arch} · ${m.cores} cores (${m.cpu}) · ${m.ramGb} GB RAM (${m.freeRamGb} free) · ${gpu} · ${m.diskFreeGb === null ? "disk unknown" : `${m.diskFreeGb} GB free disk`} · class: ${tierOf(m)}`;
}

export type Task = "inference" | "finetune_lora" | "train_full" | "download" | "dataset";
export type Check = { task: Task; params_b?: number; quant?: string; dataset_gb?: number; download_gb?: number };
export type Verdict = { verdict: "ok" | "tight" | "impossible"; need: string; have: string; reasons: string[]; alternatives: string[] };

const bytesPer: Record<string, number> = { fp32: 4, fp16: 2, bf16: 2, int8: 1, "8bit": 1, int4: 0.5, "4bit": 0.5, q4: 0.5 };

/** Other ways to get the work done, and what the user would have to do for each. */
function cloudOptions(task: Task, params?: number): string[] {
  const out = [
    "Hosted model API (no setup beyond a key): run the model through a provider API such as the connected provider; costs come out of the study budget. The user needs a funded API key (/connect).",
  ];
  if (task !== "download" && task !== "dataset")
    out.push(
      `Rent cloud GPU compute (Modal, RunPod, Lambda, Colab Pro${params && params > 70 ? "; this size needs several 80 GB GPUs, so estimate cost first" : ""}): the user must create an account, add payment, and set a spend cap; Kest can then use Modal after /connect modal. Estimate GPU-hours times the hourly rate and get the user's approval before any paid run.`,
    );
  else out.push("Process the data in the cloud (a rented VM or notebook with enough disk), then bring back only the results: the user must create an account and approve the cost.");
  return out;
}

/** Pure feasibility rules. "impossible" is a hard stop; "tight" means slow or offloaded but possible. */
export function checkFeasibility(m: Machine, c: Check): Verdict {
  const reasons: string[] = [];
  const alternatives: string[] = [];
  let verdict: Verdict["verdict"] = "ok";
  const worst = (v: Verdict["verdict"]) => {
    if (v === "impossible" || (v === "tight" && verdict === "ok")) verdict = v;
  };
  const quant = (c.quant ?? "fp16").toLowerCase();
  const per = bytesPer[quant] ?? 2;
  const disk = m.diskFreeGb;
  // Memory a model can use: VRAM on a GPU box, otherwise most of the system RAM.
  const usable = m.gpu ? m.gpu.vramGb : m.unified ? m.ramGb * 0.7 : m.ramGb * 0.75;
  let need = "";
  let have = `${Math.round(usable * 10) / 10} GB usable memory`;
  const params = c.params_b;

  if (c.task === "inference" || c.task === "finetune_lora" || c.task === "train_full") {
    if (params === undefined || !(params > 0)) {
      reasons.push("Give params_b (model size in billions of parameters) to check this.");
    } else {
      const weights = params * per;
      const factor = c.task === "inference" ? 1.2 : c.task === "finetune_lora" ? 1.5 : 0; // full training: 16 bytes/param with Adam
      const memNeed = c.task === "train_full" ? params * 16 * 1.1 : weights * factor;
      need = `${Math.round(memNeed * 10) / 10} GB memory for ${c.task.replace("_", " ")} (${params}B at ${quant})`;
      if (memNeed > usable) {
        worst("impossible");
        reasons.push(`Needs about ${Math.round(memNeed)} GB of ${m.gpu ? "VRAM" : "memory"}; this machine can use about ${Math.round(usable)} GB.`);
      } else if (memNeed > usable * 0.7 || (!m.gpu && !m.unified && weights > 8)) {
        worst("tight");
        reasons.push(m.gpu ? "Close to the VRAM limit; expect small batches and slow runs." : "No GPU: this runs on the CPU, so expect seconds per token or worse.");
      }
      if (c.task === "train_full" && !m.gpu && !m.unified && params > 0.1) {
        worst(params > 0.5 ? "impossible" : "tight");
        reasons.push("Training without a GPU is only practical for tiny models.");
      }
      if (disk !== null && weights > disk * 0.9) {
        worst("impossible");
        reasons.push(`The weights alone are about ${Math.round(weights)} GB; only ${disk} GB of disk is free.`);
      }
      if (verdict !== "ok") {
        const fit = Math.max(0.1, Math.floor((usable / (per * (c.task === "train_full" ? 16 / per * 1.1 : factor))) * 10) / 10);
        alternatives.push(`A model of about ${fit}B parameters or smaller fits here.`, "Use a small proxy model that shows the same effect, and say so in the report.");
        if (c.task !== "inference") alternatives.push("LoRA/QLoRA on a small model instead of full training.");
        alternatives.push(...cloudOptions(c.task, params));
      }
    }
  } else if (c.task === "download" || c.task === "dataset") {
    const size = c.task === "download" ? (c.download_gb ?? params) : c.dataset_gb;
    if (size === undefined || !(size >= 0)) reasons.push("Give download_gb or dataset_gb to check this.");
    else {
      need = `${size} GB ${c.task === "download" ? "download" : "dataset"}`;
      have = `${disk ?? "unknown"} GB free disk, ${m.ramGb} GB RAM`;
      if (disk !== null && size > disk * 0.9) {
        worst("impossible");
        reasons.push(`${size} GB does not fit in ${disk} GB of free disk.`);
      } else if (c.task === "dataset" && size > m.ramGb * 0.5) {
        worst("tight");
        reasons.push("Larger than half of RAM: process it in streaming chunks or a sample, not all at once.");
      }
      if (verdict !== "ok") alternatives.push("Use a representative sample or a streamed subset.", "Use a smaller public benchmark that tests the same question.", ...cloudOptions(c.task));
    }
  }
  if (verdict === "ok" && !reasons.length) reasons.push("Fits this machine.");
  return { verdict, need, have, reasons, alternatives };
}

export async function machineCheckTool(args: Record<string, unknown>): Promise<string> {
  const m = await getMachine();
  const tasks: Task[] = ["inference", "finetune_lora", "train_full", "download", "dataset"];
  const task = tasks.find((t) => t === args.task);
  if (!task) throw new Error(`machine_check needs task: ${tasks.join(", ")}.`);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const r = checkFeasibility(m, {
    task,
    params_b: num(args.params_b),
    quant: typeof args.quant === "string" ? args.quant : undefined,
    dataset_gb: num(args.dataset_gb),
    download_gb: num(args.download_gb),
  });
  const head = r.verdict === "impossible" ? "IMPOSSIBLE on this machine. Do not attempt it or work around it." : r.verdict === "tight" ? "TIGHT: possible but slow or limited. Scope it down or get the user's go-ahead first." : "OK.";
  return [
    head,
    `Machine: ${describeMachine(m)}`,
    r.need ? `Needs: ${r.need}. Have: ${r.have}.` : "",
    ...r.reasons.map((x) => `- ${x}`),
    r.alternatives.length ? `Instead:\n${r.alternatives.map((x) => `- ${x}`).join("\n")}` : "",
    r.verdict !== "ok" ? "Tell the user plainly what cannot run here, list the options above (smaller scope, hosted API, or cloud compute) including what they would have to do for each, and ask which they prefer. Never fake results or silently skip the experiment." : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Extra line for prepare results on weak machines, so the chat scopes the idea before starting it. */
export async function machineAdvice(): Promise<string> {
  const m = await getMachine();
  if (tierOf(m) !== "potato") return "";
  return `This computer is potato-class (${describeMachine(m)}). If the idea needs large models, big downloads or heavy compute, do not start it as is: call machine_check, then tell the user why it cannot run here and offer: a smaller version this machine can really run (small proxy model, sampled data), a hosted API within budget, or rented cloud compute (say what they would need to set up and what it would cost). Let them choose.`;
}
