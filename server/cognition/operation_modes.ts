/**
 * Operation Modes — how Lumi interacts with the user's system.
 *
 * Each mode defines a toolPolicy (security preset) and a prompt overlay that
 * instructs the LLM HOW to operate. Unlike conversation modes (casual/teaching/...),
 * operation modes govern tool usage, execution style, and user visibility.
 */
import { ToolPolicy } from '../personality/types';

export type OperationMode = 'desktop_control' | 'terminal' | 'autonomous';

export interface OperationModeConfig {
  id: OperationMode;
  label: string;
  labelCN: string;
  description: string;
  promptOverlay: string;
  toolPolicy: ToolPolicy;
}

export const OPERATION_MODE_CONFIGS: Record<OperationMode, OperationModeConfig> = {
  desktop_control: {
    id: 'desktop_control',
    label: 'Desktop',
    labelCN: '键鼠模式',
    description: 'Screenshot-driven mouse/keyboard control with confirmation for dangerous operations',
    promptOverlay: `## Operation Mode: Desktop Control (键鼠模式)
You are in Desktop Control mode. The user is watching the screen and expects you to interact directly with GUI elements using mouse and keyboard.
- ALWAYS use computer_use, mouse_move, mouse_click, mouse_drag, keyboard_type, and keyboard_press for desktop tasks
- Use screenshots (capture_screen) to see the screen and identify UI elements before clicking
- Move the mouse to the element FIRST, then click — never describe what to click without doing it
- For typing into fields: click the field first, then use keyboard_type
- After clicking buttons/links that trigger navigation, wait briefly then take another screenshot to verify
- Do NOT use command-line workarounds for tasks that should be done through the GUI — the user chose this mode specifically to see desktop automation
- If a task can be done with mouse/keyboard, do it that way. Only fall back to shell commands when GUI interaction is not feasible
- Be precise with screen coordinates — look carefully at screenshots to estimate pixel positions`,

    toolPolicy: {
      allowedTools: ['*'],
      requireConfirmation: [
        'desktop_run_command',
        'run_command',
        'write_file',
        'web_search',
        'url_fetch',
        'read_file',
        'read_files_batch',
        'search_files',
        'grep_files',
      ],
      forbiddenTools: [],
      securityOverrides: {
        'computer_use': 'safe',
      },
      maxIterations: 25,
    },
  },

  terminal: {
    id: 'terminal',
    label: 'Terminal',
    labelCN: '命令行模式',
    description: 'Shell-first operation — no mouse/keyboard tools, commands auto-execute',
    promptOverlay: `## Operation Mode: Terminal (命令行模式)
You are in Terminal mode. Work exclusively through command-line interfaces.
- Use run_command and desktop_run_command for all system operations
- Do NOT attempt to use mouse/keyboard tools — they are disabled in this mode
- Read and write files via shell commands or the read_file/write_file tools
- Use screenshots (capture_screen) to verify command results visually when helpful
- Be efficient: chain commands with &&, use pipes, redirect output
- Prefer one-liners over scripts unless the task is complex
- Report command output clearly — the user is reading a terminal-style log
- If a task truly requires GUI interaction, tell the user to switch to Desktop Control mode`,

    toolPolicy: {
      allowedTools: ['*'],
      requireConfirmation: [
        'web_search',
        'url_fetch',
      ],
      forbiddenTools: [
        'computer_use',
        'mouse_move',
        'mouse_click',
        'mouse_drag',
        'keyboard_type',
        'keyboard_press',
      ],
      securityOverrides: {
        'desktop_run_command': 'safe',
        'run_command': 'safe',
        'write_file': 'safe',
      },
      maxIterations: 25,
    },
  },

  autonomous: {
    id: 'autonomous',
    label: 'Auto',
    labelCN: '自由模式',
    description: 'Full autonomy — execute silently in background, report only results',
    promptOverlay: `## Operation Mode: Autonomous (自由模式)
You are in Autonomous mode. Execute tasks silently and efficiently in the background.
- Plan, execute, and report results in a single flow — do not ask for confirmations
- Use any tools available to complete the task without interrupting the user
- Be proactive: anticipate follow-up needs and handle them in the same pass
- Report completion concisely: what was done, key results, any issues
- If you need clarification on something non-critical, make your best guess and proceed — mention the assumption in your report
- For critical unknowns that would change the outcome, ask briefly then continue
- Chain multiple steps without pausing — the user chose this mode for unattended execution
- Use screenshots when needed for visual verification, but don't stream them
- Operate as if the user stepped away — minimize back-and-forth`,

    toolPolicy: {
      allowedTools: ['*'],
      requireConfirmation: [],
      forbiddenTools: [],
      securityOverrides: {
        'desktop_run_command': 'safe',
        'run_command': 'safe',
        'write_file': 'safe',
        'computer_use': 'safe',
      },
      maxIterations: 50,
    },
  },
};

export function getOperationModeConfig(mode?: string): OperationModeConfig | null {
  if (!mode) return null;
  return OPERATION_MODE_CONFIGS[mode as OperationMode] || null;
}
