// Run by uninstall.sh: takes out the Claude Code hooks and file manager items this app added.
import { removeHooks } from './terminalInstall.ts';
import { folderMenuView, setFolderMenu } from './folderMenu.ts';

const hooks = await removeHooks();
console.log(hooks ? `Claude Code hooks: ${hooks}` : 'removed the Claude Code hooks, if any');
if ((await folderMenuView()).installed) {
  const menu = await setFolderMenu(false);
  console.log(menu ? `folder menu: ${menu}` : 'removed the folder menu items');
}
process.exit(0);
