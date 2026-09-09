import { spawn } from "node:child_process";

export interface CheckerInput {
  session_id: string;
  tool_name: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: "PostToolUse";
  tool_input: {
    file_path: string;
    content?: string;
    edits?: Array<{ old_string: string; new_string: string }>;
  };
}

/** Return checker feedback, or undefined on pass, timeout, or checker failure. */
export function checkComments(
  binary: string,
  input: CheckerInput,
  timeoutMs: number,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(binary, ["check"], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;
    const finish = (value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 250).unref();
      finish();
    }, timeoutMs);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 50_000) stderr += chunk;
    });
    child.on("error", () => finish());
    child.on("close", (code) =>
      finish(code === 2 && stderr.trim() ? stderr.trim() : undefined),
    );
    child.stdin.end(JSON.stringify(input));
  });
}
