'use strict';

const vscode = require('vscode');
const path = require('path');
const { homeRelativeSegments } = require('./folder-tree');

// a window without an open folder shows every session
function isInWorkspace(cwd) {
    return workspaceRoots().length === 0 || workspaceRootOf(cwd) !== null;
}

// with nested workspace folders the most specific one wins
function workspaceRootOf(cwd) {
    const containing = workspaceRoots().filter((root) => cwd === root || cwd.startsWith(root + path.sep));
    return containing.sort((a, b) => b.length - a.length)[0] ?? null;
}

function workspaceRoots() {
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
}

// inside an open folder paths start at that folder, outside it at the home directory
function treeSegments(cwd) {
    const root = workspaceRootOf(cwd);
    if (!root) {
        return homeRelativeSegments(cwd);
    }
    return cwd === root ? [] : cwd.slice(root.length + 1).split(path.sep);
}

function relativeFolder(cwd) {
    return treeSegments(cwd).join('/') || '.';
}

module.exports = { isInWorkspace, treeSegments, relativeFolder };
