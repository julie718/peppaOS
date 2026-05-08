import { ToolRegistry } from '../registry';
import { registerFileOpsTools } from './file_ops';
import { registerSystemOpsTools } from './system_ops';
import { registerWebOpsTools } from './web_tools';
import { registerCodeOpsTools } from './code_tools';
import { registerDataOpsTools } from './data_tools';
import { registerDesktopTools } from './desktop_tools';
import { registerGitTools } from './git_tools';
import { registerVerifyTools } from './verify_tools';

export function registerAllTools(registry: ToolRegistry): void {
  registerFileOpsTools(registry);
  registerSystemOpsTools(registry);
  registerWebOpsTools(registry);
  registerCodeOpsTools(registry);
  registerDataOpsTools(registry);
  registerDesktopTools(registry);
  registerGitTools(registry);
  registerVerifyTools(registry);
}
