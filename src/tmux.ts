import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

/**
 * Thin wrapper over the tmux CLI. We deliberately drive tmux as a subprocess
 * (not via the libtmux protocol) so it works against whichever tmux the user
 * has installed and survives crashes of this Node process.
 */
export class TmuxError extends Error {
  constructor(
    msg: string,
    readonly stderr: string = "",
    readonly code: number | null = null,
  ) {
    super(msg);
    this.name = "TmuxError";
  }
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function runTmux(args: string[], opts: { check?: boolean } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("tmux", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    child.on("error", (e) => reject(new TmuxError(`tmux spawn failed: ${e.message}`)));
    child.on("close", (code) => {
      const result = { stdout, stderr, code: code ?? -1 };
      if (opts.check && result.code !== 0) {
        reject(
          new TmuxError(
            `tmux ${args.join(" ")} exited ${result.code}: ${stderr.trim()}`,
            stderr,
            result.code,
          ),
        );
        return;
      }
      resolve(result);
    });
  });
}

export interface TmuxSessionOptions {
  /** tmux session name (must be safe: [a-zA-Z0-9_-]). */
  name: string;
  /** The shell command to launch inside the session. */
  command: string;
  /** Working directory for the session. */
  cwd?: string;
  /** Path to a file where tmux pipes the pane output (tail buffer). */
  pipeFile?: string;
  /** Extra environment variables to set. */
  env?: Record<string, string>;
}

const VALID_NAME = /^[A-Za-z0-9_-]+$/;

export class TmuxSession {
  readonly name: string;
  readonly command: string;
  readonly cwd: string | undefined;
  readonly pipeFile: string | undefined;
  readonly env: Record<string, string> | undefined;

  constructor(opts: TmuxSessionOptions) {
    if (!VALID_NAME.test(opts.name)) {
      throw new TmuxError(`invalid session name: ${opts.name}`);
    }
    this.name = opts.name;
    this.command = opts.command;
    this.cwd = opts.cwd;
    this.pipeFile = opts.pipeFile;
    this.env = opts.env;
  }

  static async tmuxAvailable(): Promise<boolean> {
    try {
      const r = await runTmux(["-V"]);
      return r.code === 0;
    } catch {
      return false;
    }
  }

  async isAlive(): Promise<boolean> {
    const r = await runTmux(["has-session", "-t", this.name]);
    return r.code === 0;
  }

  async start(): Promise<void> {
    if (await this.isAlive()) {
      throw new TmuxError(`session ${this.name} already exists`);
    }
    const args = ["new-session", "-d", "-s", this.name];
    if (this.cwd) args.push("-c", this.cwd);
    if (this.env) {
      for (const [k, v] of Object.entries(this.env)) {
        args.push("-e", `${k}=${v}`);
      }
    }
    args.push(this.command);
    await runTmux(args, { check: true });

    if (this.pipeFile) {
      await fs.mkdir(dirname(this.pipeFile), { recursive: true });
      // Truncate prior contents.
      await fs.writeFile(this.pipeFile, "", "utf8");
      await runTmux(
        ["pipe-pane", "-t", `${this.name}:0`, "-o", `cat >> ${shellEscape(this.pipeFile)}`],
        { check: true },
      );
    }
  }

  async stop(): Promise<void> {
    if (!(await this.isAlive())) return;
    await runTmux(["kill-session", "-t", this.name], { check: true });
  }

  /** Restart = stop + start. Used by refresh. */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /**
   * Send literal text to the pane, then press Enter.
   * Uses tmux send-keys with literal flag to avoid keyword interpretation.
   */
  async send(text: string): Promise<void> {
    if (!(await this.isAlive())) {
      throw new TmuxError(`session ${this.name} not alive`);
    }
    // tmux send-keys -l treats input literally (no key-name interpretation).
    await runTmux(["send-keys", "-t", this.name, "-l", text], { check: true });
    await runTmux(["send-keys", "-t", this.name, "Enter"], { check: true });
  }

  /** Capture the last N lines of pane output. */
  async capture(lines = 200): Promise<string> {
    if (!(await this.isAlive())) {
      throw new TmuxError(`session ${this.name} not alive`);
    }
    const start = `-${Math.max(1, lines)}`;
    const r = await runTmux(["capture-pane", "-t", this.name, "-p", "-S", start], {
      check: true,
    });
    return r.stdout;
  }

  /** Read the pipe-pane tail file if configured. */
  async readPipeBuffer(maxBytes = 64 * 1024): Promise<string> {
    if (!this.pipeFile) return "";
    try {
      const stat = await fs.stat(this.pipeFile);
      const size = stat.size;
      if (size <= maxBytes) {
        return await fs.readFile(this.pipeFile, "utf8");
      }
      const fh = await fs.open(this.pipeFile, "r");
      try {
        const buf = Buffer.alloc(maxBytes);
        await fh.read(buf, 0, maxBytes, size - maxBytes);
        return buf.toString("utf8");
      } finally {
        await fh.close();
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw e;
    }
  }
}

function shellEscape(s: string): string {
  // single-quote escape for POSIX shells
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
