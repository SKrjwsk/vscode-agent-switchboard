'use strict';

const vscode = require('vscode');
const path = require('path');
const { buildFolderTree } = require('./folder-tree');
const { isInWorkspace, treeSegments, relativeFolder } = require('./workspace');

const SESSION_URI_SCHEME = 'claude-session';
const OUTSIDE_VSCODE_URI_SCHEME = 'claude-outside-vscode';
const LABEL_COLORS = {
    [SESSION_URI_SCHEME]: 'descriptionForeground',
    // not clickable, so it looks disabled
    [OUTSIDE_VSCODE_URI_SCHEME]: 'disabledForeground',
};
// colors are contributed in package.json, so they can be overridden in workbench.colorCustomizations
const STATE_COLORS = {
    working: new vscode.ThemeColor('agentSwitchboard.working'),
    needsApproval: new vscode.ThemeColor('agentSwitchboard.needsApproval'),
    yourTurn: new vscode.ThemeColor('agentSwitchboard.yourTurn'),
    dormant: new vscode.ThemeColor('agentSwitchboard.dormant'),
};

class OpenSessionsView {
    constructor(model, favorites) {
        this.model = model;
        this.favorites = favorites;
        this.onDidChangeTreeData = model.onDidChange;
    }

    getChildren(node) {
        return node ? [] : this.model.workspaceRunning();
    }

    getTreeItem(running) {
        return runningItem(running, this.favorites);
    }
}

class FavoriteSessionsView {
    constructor(model, favorites) {
        this.model = model;
        this.favorites = favorites;
        this.onDidChangeTreeData = model.onDidChange;
    }

    // in the order of adding, so rows stay put while sessions are active
    getChildren(node) {
        if (node) {
            return [];
        }
        return this.favorites.ids()
            .map((sessionId) => this.model.sessionById(sessionId))
            .filter((session) => session && isInWorkspace(session.cwd));
    }

    getTreeItem(session) {
        return sessionItem(session, this.model, this.favorites, { showFolder: true, showStar: false });
    }
}

class AllSessionsView {
    constructor(model, favorites) {
        this.model = model;
        this.favorites = favorites;
        this.onDidChangeTreeData = model.onDidChange;
    }

    getChildren(folder) {
        if (folder) {
            return [...folder.subfolders.values(), ...folder.sessions];
        }
        return buildFolderTree(this.model.workspaceSessions(), treeSegments);
    }

    getTreeItem(node) {
        if (node.subfolders) {
            return folderItem(node);
        }
        return sessionItem(node, this.model, this.favorites, { showFolder: false, showStar: true });
    }
}

// tree items have no label color option; a decoration on the item's resourceUri is the only way to tint it
class SessionDecorationProvider {
    provideFileDecoration(uri) {
        const color = LABEL_COLORS[uri.scheme];
        return color ? { color: new vscode.ThemeColor(color) } : undefined;
    }
}

// stable ids keep folders expanded and items selected across refreshes
function folderItem(folder) {
    const item = new vscode.TreeItem(folder.name, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `folder:${folder.key}`;
    item.description = `${folder.sessionCount}`;
    item.tooltip = folder.path;
    item.contextValue = 'folder';
    item.iconPath = new vscode.ThemeIcon('folder');
    return item;
}

// state colors live only in Open; the archive lists stay plain
function sessionItem(session, model, favorites, { showFolder, showStar }) {
    const running = model.runningProcessOf(session.id);
    const isFavorite = favorites.has(session.id);

    const item = new vscode.TreeItem(session.title, vscode.TreeItemCollapsibleState.None);
    item.id = `session:${session.id}`;
    item.description = joinParts([
        formatDate(session.modifiedAt),
        showFolder ? relativeFolder(session.cwd) : null,
        showStar && isFavorite ? '★' : null,
    ]);
    item.tooltip = joinLines([
        session.title,
        relativeFolder(session.cwd),
        running ? whereLine(running) : null,
        running?.terminal ? 'Click: switch to its tab' : 'Double-click: resume in a new tab',
        `Session ${session.id}`,
    ]);
    item.contextValue = joinParts(['session', isFavorite ? 'favorite' : 'notFavorite'], ' ');
    item.iconPath = new vscode.ThemeIcon('comment-discussion');
    item.resourceUri = vscode.Uri.from({ scheme: SESSION_URI_SCHEME, path: `/${session.id}` });
    item.command = { command: 'agentSwitchboard.click', title: 'Open session', arguments: [session] };
    return item;
}

function runningItem(running, favorites) {
    const label = running.session?.title ?? running.name ?? `claude (pid ${running.pid})`;
    const isActive = running.terminal !== null && running.terminal === vscode.window.activeTerminal;

    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `open:${running.pid}`;
    item.description = joinParts([
        running.state === 'needsApproval' ? 'needs approval' : null,
        path.basename(running.cwd),
        running.terminal ? null : 'outside VS Code',
        isActive ? 'active' : null,
    ]);
    item.tooltip = joinLines([
        label,
        running.cwd,
        stateLine(running),
        whereLine(running),
        running.session ? null : 'No transcript yet',
        running.terminal ? 'Click: switch to tab' : 'Click: show where it runs',
        `pid ${running.pid}: ${running.command}`,
    ]);
    item.contextValue = joinParts([
        running.terminal ? 'openInVsCode' : 'outsideVsCode',
        running.session ? 'hasSession' : null,
        running.session && favorites.has(running.session.id) ? 'favorite' : null,
        running.session && !favorites.has(running.session.id) ? 'notFavorite' : null,
    ], ' ');
    item.iconPath = new vscode.ThemeIcon(running.terminal ? 'terminal' : 'link-external', STATE_COLORS[running.state]);
    if (!running.terminal) {
        item.resourceUri = vscode.Uri.from({ scheme: OUTSIDE_VSCODE_URI_SCHEME, path: `/${running.pid}` });
    }
    item.command = running.terminal
        ? { command: 'agentSwitchboard.focus', title: 'Switch to tab', arguments: [running] }
        : { command: 'agentSwitchboard.showOutside', title: 'Show where it runs', arguments: [running] };
    return item;
}

function stateLine(running) {
    const since = running.statusUpdatedAt === null ? '' : ` since ${formatDate(new Date(running.statusUpdatedAt))}`;
    switch (running.state) {
        case 'working':
            return 'State: working';
        case 'needsApproval':
            return `State: needs approval (${running.waitingFor ?? 'waiting for you'})`;
        case 'yourTurn':
            return `State: your turn${since}`;
        case 'dormant':
            return `State: idle${since}`;
        default:
            return 'State: unknown';
    }
}

function whereLine(running) {
    return running.terminal ? 'Running in a VS Code tab' : `Running outside VS Code (pid ${running.pid})`;
}

function formatDate(date) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function joinParts(parts, separator = ' · ') {
    return parts.filter(Boolean).join(separator);
}

function joinLines(lines) {
    return lines.filter(Boolean).join('\n');
}

module.exports = { OpenSessionsView, FavoriteSessionsView, AllSessionsView, SessionDecorationProvider, formatDate };
