import { spawn } from "node:child_process";

const PUSH_TIMEOUT_MS = 180_000;

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, PUSH_TIMEOUT_MS);
    const take = (chunk: unknown) => {
      out += String(chunk);
      if (out.length > 8_000) out = out.slice(-8_000);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ code: 1, out: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, out: out.trim() });
    });
  });
}

/** Stage everything in the tab folder, commit when there is a diff, then push HEAD to main. */
export async function publishFolder(folder: string, message: string): Promise<string> {
  const add = await run("git", ["add", "-A"], folder);
  if (add.code !== 0) throw new Error(add.out || "git add failed");

  const staged = await run("git", ["diff", "--cached", "--quiet"], folder);
  const lines: string[] = [];
  if (staged.code === 1) {
    const text = message.trim().slice(0, 200);
    if (!text) throw new Error("publish_message_required");
    const commit = await run("git", ["commit", "-m", text], folder);
    if (commit.code !== 0) throw new Error(commit.out || "git commit failed");
    lines.push(commit.out);
  } else if (staged.code !== 0) {
    throw new Error(staged.out || "git status failed");
  } else {
    lines.push("nothing to commit");
  }

  const push = await run("git", ["push", "origin", "HEAD:main"], folder);
  if (push.code !== 0) throw new Error(push.out || "git push failed");
  lines.push(push.out || "pushed");
  return lines.filter(Boolean).join("\n").slice(-4000);
}
