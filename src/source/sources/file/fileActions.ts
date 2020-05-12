import { FileSource } from './fileSource';
import pathLib from 'path';
import {
  fsCopyFileRecursive,
  fsRename,
  fsTrash,
  fsRimraf,
  fsMkdirp,
  fsTouch,
  isWindows,
  listDrive,
  prompt,
  overwritePrompt,
  Notifier,
  input,
  bufnrByWinnrOrWinid,
} from '../../../util';
import { workspace, listManager } from 'coc.nvim';
import open from 'open';
import { driveList } from '../../../lists/drives';
import { gitManager } from '../../../gitManager';
import { RevealStrategy, OpenStrategy } from '../../../types';
import { explorerWorkspaceFolderList } from '../../../lists/workspaceFolders';

export function initFileActions(file: FileSource) {
  const { nvim } = file;

  file.addNodeAction(
    'gotoParent',
    async () => {
      if (file.root === '') {
        return;
      }
      const nodeUri = file.currentNode()?.uri;
      if (/^[A-Za-z]:[\\\/]$/.test(file.root)) {
        file.root = '';
      } else {
        file.root = pathLib.dirname(file.root);
        await file.cd(file.root);
      }
      await file.expandNode(file.rootNode);
      if (nodeUri) {
        await file.gotoNodeUid(nodeUri);
      }
    },
    'change directory to parent directory',
  );
  file.addNodesAction(
    'reveal',
    async ({ args }) => {
      const target = args[0];
      let targetBufnr: number | null = null;
      let targetPath: string | null = null;
      if (/\d+/.test(target)) {
        targetBufnr = parseInt(target, 10);
        if (targetBufnr === 0) {
          targetBufnr = workspace.bufnr;
        }
      } else {
        const revealStrategy = (target ?? 'previousWindow') as RevealStrategy;

        const actions: Record<
          RevealStrategy,
          null | ((args?: string[]) => void | Promise<void>)
        > = {
          select: async () => {
            await file.explorer.selectWindowsUI(async (winnr) => {
              targetBufnr = await bufnrByWinnrOrWinid(winnr);
            });
          },
          sourceWindow: async () => {
            targetBufnr = await bufnrByWinnrOrWinid(
              await file.explorer.sourceWinnr(),
            );
          },
          previousBuffer: async () => {
            targetBufnr = await file.explorer.explorerManager.previousBufnr.get();
          },
          previousWindow: async () => {
            targetBufnr = await bufnrByWinnrOrWinid(
              await file.explorer.explorerManager.prevWinnrByPrevWindowID(),
            );
          },
          path: async () => {
            targetPath = args[1];
            if (!targetPath) {
              targetPath = await input(
                'Input a reveal path: ',
                file.currentNode()?.fullpath ?? '',
                'file',
              );
            }
          },
        };
        await actions[revealStrategy]?.();
      }

      if (targetBufnr) {
        const bufinfo = await nvim.call('getbufinfo', [targetBufnr]);
        if (!bufinfo[0] || !bufinfo[0].name) {
          return;
        }

        targetPath = bufinfo[0].name;
      }

      if (!targetPath) {
        return;
      }

      const expandOptions = args[1] ?? '';
      const compact = expandOptions.includes('compact');
      const [revealNode, notifiers] = await file.revealNodeByPathNotifier(
        targetPath,
        {
          compact,
        },
      );
      if (revealNode) {
        await Notifier.runAll(notifiers);
      }
    },
    'reveal buffer in explorer',
    {
      menus: {
        '0': 'use current buffer',
        '0:compact': 'use current buffer and compact',
        select: 'use select windows UI',
        previousBuffer: 'use last used buffer',
        previousWindow: 'use last used window',
        sourceWindow: 'use the window where explorer opened',
        path: {
          description: 'use custom path',
          args: 'path:<path>',
          async actionArgs() {
            return ['path'];
          },
        },
      },
    },
  );
  file.addNodeAction(
    'cd',
    async ({ node, args }) => {
      const cdTo = async (fullpath: string) => {
        await file.cd(fullpath);
        file.root = fullpath;
        await file.expandNode(file.rootNode);
      };
      const path = args[0];
      if (path !== undefined) {
        await cdTo(path);
      } else {
        if (node.directory) {
          await cdTo(node.fullpath);
        }
      }
    },
    'change directory to current node',
    {
      menus: {
        path: {
          description: '',
          args: '<path>',
          async actionArgs() {
            return [
              await input(
                'input a cd path: ',
                file.currentNode()?.fullpath ?? '',
                'file',
              ),
            ];
          },
        },
      },
    },
  );
  file.addNodeAction(
    'workspaceFolders',
    async () => {
      explorerWorkspaceFolderList.setFileSource(file);
      const disposable = listManager.registerList(explorerWorkspaceFolderList);
      await listManager.start(['--normal', explorerWorkspaceFolderList.name]);
      disposable.dispose();
    },
    'change directory to current node',
  );
  file.addNodeAction(
    'open',
    async ({ node, args: [openStrategy, ...args] }) => {
      if (node.directory) {
        const directoryAction = file.config.openActionForDirectory;
        if (directoryAction) {
          await file.doAction(directoryAction, node);
        }
      } else {
        await file.openAction(node, () => node.fullpath, {
          openStrategy: openStrategy as OpenStrategy,
          args,
        });
      }
    },
    'open file or directory',
    {
      multi: true,
      menus: file.openActionMenu,
    },
  );
  file.addNodeAction(
    'drop',
    async ({ node }) => {
      if (!node.directory) {
        await nvim.command(`drop ${node.fullpath}`);
        await file.explorer.tryQuitOnOpen();
      }
    },
    'open file by drop command',
    { multi: true },
  );
  file.addNodeAction(
    'expand',
    async ({ node, args }) => {
      if (node.directory) {
        const options = (args[0] ?? '').split('|');
        const recursive = options.includes('recursive');
        const compact = options.includes('compact');
        const uncompact = options.includes('uncompact');
        const recursiveSingle = options.includes('recursiveSingle');
        await file.expandNode(node, {
          recursive,
          compact,
          uncompact,
          recursiveSingle,
        });
      }
    },
    'expand directory',
    {
      multi: true,
      menus: {
        recursive: 'recursively',
        compact: 'single child folders will be compressed in a combined node',
        uncompact: 'reset the combined node',
        'compact:uncompact': 'compact or uncompact',
        recursiveSingle: 'expand single child folder recursively',
      },
    },
  );
  file.addNodeAction(
    'expandRecursive',
    async ({ node }) => {
      // tslint:disable-next-line: ban
      workspace.showMessage(
        'Deprecated, use expand:recursive instead of it',
        'warning',
      );
      return file.doAction('expand', [node], ['recursive']);
    },
    'expand directory recursively (deprecated)',
    { multi: true },
  );
  file.addNodeAction(
    'collapse',
    async ({ node, args }) => {
      const options = (args[0] ?? '').split('|');
      const recursive = options.includes('recursive');
      if (node.directory && file.nodeStores.isExpanded(node)) {
        await file.collapseNode(node, { recursive });
      } else if (node.parent) {
        await file.collapseNode(node.parent, { recursive });
      }
    },
    'collapse directory',
    {
      multi: true,
      menus: {
        recursive: 'recursively',
      },
    },
  );
  file.addNodeAction(
    'collapseRecursive',
    async ({ node }) => {
      // tslint:disable-next-line: ban
      workspace.showMessage(
        'Deprecated, use collapse:recursive instead of it',
        'warning',
      );
      return file.doAction('collapse', [node], ['recursive']);
    },
    'collapse directory recursively (deprecated)',
    { multi: true },
  );
  file.addNodeAction(
    'expandOrCollapse',
    async ({ node }) => {
      // tslint:disable-next-line: ban
      workspace.showMessage(
        'Deprecated, use ["expanded?", "expand", "collapse"] instead of it',
        'warning',
      );
      if (node.directory) {
        if (file.nodeStores.isExpanded(node)) {
          await file.doAction('collapse', node);
        } else {
          await file.doAction('expand', node);
        }
      }
    },
    'expand or collapse directory',
    { multi: true },
  );

  file.addNodesAction(
    'copyFilepath',
    async ({ nodes }) => {
      await file.copyToClipboard(
        nodes ? nodes.map((it) => it.fullpath).join('\n') : file.root,
      );
      // tslint:disable-next-line: ban
      workspace.showMessage('Copy filepath to clipboard');
    },
    'copy full filepath to clipboard',
  );
  file.addNodesAction(
    'copyFilename',
    async ({ nodes }) => {
      await file.copyToClipboard(
        nodes
          ? nodes.map((it) => it.name).join('\n')
          : pathLib.basename(file.root),
      );
      // tslint:disable-next-line: ban
      workspace.showMessage('Copy filename to clipboard');
    },
    'copy filename to clipboard',
  );
  file.addNodesAction(
    'copyFile',
    async ({ nodes }) => {
      const clearNodes = [...file.copiedNodes, ...file.cutNodes];
      file.copiedNodes.clear();
      file.cutNodes.clear();
      nodes.forEach((node) => {
        file.copiedNodes.add(node);
      });
      file.requestRenderNodes(clearNodes.concat(nodes));
    },
    'copy file for paste',
  );
  file.addNodesAction(
    'cutFile',
    async ({ nodes }) => {
      const clearNodes = [...file.copiedNodes, ...file.cutNodes];
      file.copiedNodes.clear();
      file.cutNodes.clear();
      nodes.forEach((node) => {
        file.cutNodes.add(node);
      });
      file.requestRenderNodes(clearNodes.concat(nodes));
    },
    'cut file for paste',
  );
  file.addNodeAction(
    'pasteFile',
    async ({ node }) => {
      const targetDir = file.getPutTargetDir(node);
      if (file.copiedNodes.size > 0) {
        const nodes = Array.from(file.copiedNodes);
        await overwritePrompt(
          nodes.map((node) => ({
            source: node.fullpath,
            target: pathLib.join(targetDir, pathLib.basename(node.fullpath)),
          })),
          fsCopyFileRecursive,
        );
        file.requestRenderNodes(nodes);
        file.copiedNodes.clear();
        await file.reload(node.parent ? node.parent : node);
      } else if (file.cutNodes.size > 0) {
        const nodes = Array.from(file.cutNodes);
        await overwritePrompt(
          nodes.map((node) => ({
            source: node.fullpath,
            target: pathLib.join(targetDir, pathLib.basename(node.fullpath)),
          })),
          fsRename,
        );
        file.cutNodes.clear();
        await file.reload(file.rootNode);
      } else {
        // tslint:disable-next-line: ban
        workspace.showMessage('Copied files or cut files is empty', 'error');
      }
    },
    'paste files to here',
  );
  file.addNodesAction(
    'delete',
    async ({ nodes }) => {
      if (
        nodes.some((node) => file.bufManager.modified(node.fullpath)) &&
        (await prompt('Buffer is being modified, discard it?')) !== 'yes'
      ) {
        return;
      }

      const list = nodes.map((node) => node.fullpath).join('\n');
      if (
        (await prompt('Move these files or directories to trash?\n' + list)) !==
        'yes'
      ) {
        return;
      }

      await fsTrash(nodes.map((node) => node.fullpath));

      for (const node of nodes) {
        await file.bufManager.remove(node.fullpath, true);
      }
    },
    'move file or directory to trash',
    { reload: true },
  );
  file.addNodesAction(
    'deleteForever',
    async ({ nodes }) => {
      if (
        nodes.some((node) => file.bufManager.modified(node.fullpath)) &&
        (await prompt('Buffer is being modified, discard it?')) !== 'yes'
      ) {
        return;
      }

      const list = nodes.map((node) => node.fullpath).join('\n');
      if (
        (await prompt(
          'Forever delete these files or directories?\n' + list,
        )) !== 'yes'
      ) {
        return;
      }

      for (const node of nodes) {
        await fsRimraf(node.fullpath);
        await file.bufManager.remove(node.fullpath, true);
      }
    },
    'delete file or directory forever',
    { reload: true },
  );

  file.addNodeAction(
    'addFile',
    async ({ node, args }) => {
      let filename =
        args[0] ?? (await input('Input a new filename: ', '', 'file'));
      filename = filename.trim();
      if (!filename) {
        return;
      }
      if (filename.endsWith('/') || filename.endsWith('\\')) {
        await file.doAction('addDirectory', node, [filename]);
        return;
      }
      const putTargetNode = file.getPutTargetNode(node);
      const targetPath = pathLib.join(putTargetNode.fullpath, filename);
      await overwritePrompt(
        [
          {
            source: null,
            target: targetPath,
          },
        ],
        async (_source, target) => {
          await fsTouch(target);
        },
      );
      await file.reload(putTargetNode);
      const [, notifiers] = await file.revealNodeByPathNotifier(targetPath, {
        node: putTargetNode,
      });
      await Notifier.runAll(notifiers);
    },
    'add a new file',
  );
  file.addNodeAction(
    'addDirectory',
    async ({ node, args }) => {
      let directoryName =
        args[0] ?? (await input('Input a new directory name: ', '', 'file'));
      directoryName = directoryName.trim().replace(/(\/|\\)*$/g, '');
      if (!directoryName) {
        return;
      }
      const putTargetNode = file.getPutTargetNode(node);
      const targetPath = pathLib.join(putTargetNode.fullpath, directoryName);
      await overwritePrompt(
        [
          {
            source: null,
            target: targetPath,
          },
        ],
        async (_source, target) => {
          await fsMkdirp(target);
        },
      );
      const reloadNotifier = await file.reloadNotifier(putTargetNode);
      const [, revealNotifiers] = await file.revealNodeByPathNotifier(
        targetPath,
        {
          node: putTargetNode,
        },
      );
      await Notifier.runAll([reloadNotifier, ...revealNotifiers]);
    },
    'add a new directory',
  );
  file.addNodeAction(
    'rename',
    async ({ node }) => {
      if (
        file.bufManager.modified(node.fullpath) &&
        (await prompt('Buffer is being modified, discard it?')) !== 'yes'
      ) {
        return;
      }

      const targetPath = await input(
        `Rename: ${node.fullpath} -> `,
        node.fullpath,
        'file',
      );
      if (targetPath.length == 0) {
        return;
      }

      await overwritePrompt(
        [
          {
            source: node.fullpath,
            target: targetPath,
          },
        ],
        fsRename,
      );

      await file.bufManager.remove(node.fullpath, true);

      await file.reload(file.rootNode);
    },

    'rename a file or directory',
  );

  file.addNodesAction(
    'systemExecute',
    async ({ nodes }) => {
      if (nodes) {
        await Promise.all(nodes.map((node) => open(node.fullpath)));
      } else {
        await open(file.root);
      }
    },
    'use system application open file or directory',
  );

  if (isWindows) {
    file.addNodeAction(
      'listDrive',
      async () => {
        const drives = await listDrive();
        driveList.setExplorerDrives(
          drives.map((drive) => ({
            name: drive,
            callback: async (drive) => {
              file.root = drive;
              await file.expandNode(file.rootNode);
            },
          })),
        );
        const disposable = listManager.registerList(driveList);
        await listManager.start([
          '--normal',
          '--number-select',
          driveList.name,
        ]);
        disposable.dispose();
      },
      'list drives',
    );
  }

  file.addNodeAction(
    'search',
    async ({ node }) => {
      await file.searchByCocList(
        node.isRoot ? node.fullpath : pathLib.dirname(node.fullpath),
        false,
      );
    },
    'search by coc-list',
  );

  file.addNodeAction(
    'searchRecursive',
    async ({ node }) => {
      await file.searchByCocList(pathLib.dirname(node.fullpath), true);
    },
    'search by coc-list recursively',
  );

  file.addNodesAction(
    'gitStage',
    async ({ nodes }) => {
      await gitManager.cmd.stage(...nodes.map((node) => node.fullpath));
      await file.reload(file.rootNode);
    },
    'add file to git index',
  );

  file.addNodesAction(
    'gitUnstage',
    async ({ nodes }) => {
      await gitManager.cmd.unstage(...nodes.map((node) => node.fullpath));
      await file.reload(file.rootNode);
    },
    'reset file from git index',
  );
}
