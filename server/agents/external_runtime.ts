/**
 * External Agent Runtime
 *
 * Executes tasks on external agents (OpenClaw, Hermes, etc.) via CLI.
 * These agents run as child processes — Lumi dispatches a task, waits for
 * the result, and feeds it back into the orchestrator's aggregation pipeline.
 *
 * Security: commands are shell-quoted, tasks are capped at 4000 chars,
 * and execution has a configurable timeout.
 */

import { spawn } from 'child_process';
import os from 'os';

export interface ExternalAgentConfig {
  /** CLI command template. {task} is replaced with the task text. */
  command: string;
  /** Timeout in ms (default: 120000) */
  timeout?: number;
  /** Working directory for the process */
  cwd?: string;
}

export interface ExternalResult {
  success: boolean;
  output: string;
  exitCode: number | null;
  durationMs: number;
}

function quoteForPosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quoteForCmd(value: string): string {
  const escaped = value
    .replace(/\r?\n/g, ' ')
    .replace(/"/g, "'")
    .replace(/[%!^&|<>()]/g, '^$&');
  return `"${escaped}"`;
}

function quoteForShell(value: string): string {
  return os.platform() === 'win32' ? quoteForCmd(value) : quoteForPosix(value);
}

function buildCommand(command: string, task: string): string {
  const quotedTask = quoteForShell(task.slice(0, 4000));
  return command
    .replace(/"\{task\}"/g, quotedTask)
    .replace(/'\{task\}'/g, quotedTask)
    .replace(/\{task\}/g, quotedTask);
}

/**
 * Execute a task on an external agent via CLI.
 *
 * The command template supports one placeholder:
 *   {task} — replaced with the user's task text (shell-quoted)
 *
 * Examples:
 *   openclaw send --agent assistant --message "{task}"
 *   hermes chat --task "{task}"
 */
export async function executeExternalAgent(
  config: ExternalAgentConfig,
  task: string,
): Promise<ExternalResult> {
  const startTime = Date.now();
  const timeout = config.timeout || 120_000;

  // Build the command by substituting {task} as a single shell argument.
  const commandStr = buildCommand(config.command, task);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(commandStr, {
      shell: true,
      cwd: config.cwd || process.cwd(),
      timeout,
      windowsHide: true,
    });

    const done = (success: boolean, exitCode: number | null) => {
      if (settled) return;
      settled = true;
      const output = stdout.trim() || stderr.trim() || '(no output)';
      resolve({
        success,
        output: output.slice(0, 8000), // cap output
        exitCode,
        durationMs: Date.now() - startTime,
      });
    };

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      done(code === 0, code);
    });

    child.on('error', (err) => {
      stderr += err.message;
      done(false, -1);
    });

    setTimeout(() => {
      if (!settled) {
        child.kill('SIGTERM');
        done(false, null);
      }
    }, timeout + 2000); // 2s grace beyond timeout
  });
}

/**
 * Validate that a CLI command looks safe to execute.
 * Returns an error string if the command is rejected, null if OK.
 */
export function validateExternalCommand(command: string): string | null {
  if (!command || !command.trim()) {
    return 'External command is empty';
  }
  if (!command.includes('{task}')) {
    return 'External command must include {task} placeholder';
  }
  // Block obvious path traversal / shell injection patterns
  const lower = command.toLowerCase();
  const blocked = ['rm -rf', 'shutdown', 'reboot', 'format ', 'diskpart', 'del /f'];
  for (const b of blocked) {
    if (lower.includes(b)) return `Command contains blocked pattern: "${b}"`;
  }
  return null;
}
