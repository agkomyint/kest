export {};
const candidates = [
  [
    "Windows PowerShell",
    [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::Write('ok')",
    ],
  ],
  [
    "PowerShell 7",
    [
      "pwsh.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::Write('ok')",
    ],
  ],
  ["Bash", ["bash.exe", "--noprofile", "--norc", "-c", "printf ok"]],
  ["Python", ["python.exe", "-c", "print('ok', end='')"]],
  ["Bun", ["bun.exe", "-e", "process.stdout.write('ok')"]],
] as const;
for (const [name, cmd] of candidates) {
  const times: number[] = [];
  for (let i = 0; i < 8; i++) {
    const start = performance.now();
    const p = Bun.spawn([...cmd], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      windowsHide: true,
    });
    const timer = setTimeout(() => p.kill(), 10000);
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    clearTimeout(timer);
    if (code !== 0 || out !== "ok") {
      console.log(`${name}: unavailable (${code}) ${err.trim().slice(0, 160)}`);
      break;
    }
    if (i) times.push(performance.now() - start);
  }
  if (times.length) {
    times.sort((a, b) => a - b);
    console.log(
      `${name}: median ${times[Math.floor(times.length / 2)]!.toFixed(2)} ms (${times.length} warm samples)`,
    );
  }
}
