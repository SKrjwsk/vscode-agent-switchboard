'use strict';

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Favorites } = require('./favorites');
const { SessionModel } = require('./session-model');
const { OpenSessionsView, FavoriteSessionsView, AllSessionsView, SessionDecorationProvider, formatDate } = require('./views');
const { relativeFolder } = require('./workspace');
const { renderTranscript } = require('./transcript');
const { setTitlePathPrefixes } = require('./session-files');

// sessions started or closed outside VS Code (Ghostty, tmux) and state changes give no event, so the model is polled:
// states and active sessions often, the whole transcript list rarely
const POLL_MS = 3000;
const FULL_SCAN_EVERY_POLLS = 10;
// a new terminal starts claude a moment after it opens
const NEW_TERMINAL_SCAN_DELAY_MS = 3000;
const DOUBLE_CLICK_MS = 500;
const TAB_NAME_LENGTH = 30;
const STATUS_BAR_MESSAGE_MS = 3000;
const TRANSCRIPT_URI_SCHEME = 'claude-transcript';
const TITLE_PATH_PREFIXES_SETTING = 'agentSwitchboard.titlePathPrefixes';

function activate(context) {
    applyTitleSettings();
    const favorites = new Favorites(context.globalState);
    const model = new SessionModel();
    const openView = vscode.window.createTreeView('agentSwitchboardOpen', { treeDataProvider: new OpenSessionsView(model, favorites) });
    const views = [
        openView,
        vscode.window.createTreeView('agentSwitchboardFavorites', { treeDataProvider: new FavoriteSessionsView(model, favorites) }),
        vscode.window.createTreeView('agentSwitchboardAll', { treeDataProvider: new AllSessionsView(model, favorites) }),
    ];
    const timers = refreshTimers(model, views);
    const resumeOnDoubleClick = onDoubleClick((session) => resumeSession(model, session));
    const setFavorite = (add) => async (node) => {
        const sessionId = sessionOf(node).id;
        await (add ? favorites.add(sessionId) : favorites.remove(sessionId));
        model.render();
    };

    context.subscriptions.push(
        ...views,
        timers,
        model.onDidChange(() => updateOpenViewStatus(openView, model)),
        ...views.map((view) => view.onDidChangeVisibility((event) => event.visible && model.refresh())),
        vscode.window.onDidChangeWindowState((state) => state.focused && model.refresh()),
        vscode.window.onDidOpenTerminal(() => timers.refreshLater()),
        vscode.window.onDidCloseTerminal(() => model.refresh()),
        vscode.window.onDidChangeActiveTerminal(() => model.render()),
        vscode.workspace.onDidChangeWorkspaceFolders(() => model.render()),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(TITLE_PATH_PREFIXES_SETTING)) {
                applyTitleSettings();
                model.refresh({ full: true });
            }
        }),
        vscode.window.registerFileDecorationProvider(new SessionDecorationProvider()),
        vscode.workspace.registerTextDocumentContentProvider(TRANSCRIPT_URI_SCHEME, transcriptProvider(model)),
        vscode.commands.registerCommand('agentSwitchboard.readTranscript', (node) => openTranscript(sessionOf(node))),
        vscode.commands.registerCommand('agentSwitchboard.startClaudeHere', (folder) => startClaudeIn(folder.path)),
        vscode.commands.registerCommand('agentSwitchboard.startClaudeInWorkspace', startClaudeInWorkspace),
        vscode.commands.registerCommand('agentSwitchboard.refresh', () => model.refresh()),
        vscode.commands.registerCommand('agentSwitchboard.search', () => searchSessions(model, favorites)),
        vscode.commands.registerCommand('agentSwitchboard.click', (session) => clickSession(model, session, resumeOnDoubleClick)),
        vscode.commands.registerCommand('agentSwitchboard.resume', (node) => resumeSession(model, sessionOf(node))),
        vscode.commands.registerCommand('agentSwitchboard.copyResume', (node) => copyResumeCommand(sessionOf(node))),
        vscode.commands.registerCommand('agentSwitchboard.focus', (running) => running.terminal.show()),
        vscode.commands.registerCommand('agentSwitchboard.showOutside', showOutside),
        vscode.commands.registerCommand('agentSwitchboard.close', closeSessionTab),
        vscode.commands.registerCommand('agentSwitchboard.addFavorite', setFavorite(true)),
        vscode.commands.registerCommand('agentSwitchboard.removeFavorite', setFavorite(false)),
    );
    model.refresh();
}

function applyTitleSettings() {
    setTitlePathPrefixes(vscode.workspace.getConfiguration().get(TITLE_PATH_PREFIXES_SETTING, []));
}

// polls only while the window is focused and a view is visible; several VS Code windows would scan in parallel otherwise
function refreshTimers(model, views) {
    let pollCount = 0;
    const pollTimer = setInterval(() => {
        if (vscode.window.state.focused && views.some((view) => view.visible)) {
            pollCount++;
            model.refresh({ full: pollCount % FULL_SCAN_EVERY_POLLS === 0 });
        }
    }, POLL_MS);
    let delayedTimer = null;

    return {
        refreshLater: () => {
            clearTimeout(delayedTimer);
            delayedTimer = setTimeout(() => model.refresh(), NEW_TERMINAL_SCAN_DELAY_MS);
        },
        dispose: () => {
            clearInterval(pollTimer);
            clearTimeout(delayedTimer);
        },
    };
}

// the badge shows on the panel icon even when the panel is collapsed
function updateOpenViewStatus(openView, model) {
    const needsApproval = model.needsApprovalCount();
    openView.badge = needsApproval > 0
        ? { value: needsApproval, tooltip: `${needsApproval} Claude session(s) need your approval` }
        : undefined;
    openView.message = openViewMessage(model);
}

function openViewMessage(model) {
    if (model.scanError) {
        return `Cannot list running sessions: ${model.scanError}`;
    }
    if (model.unlistedCount > 0) {
        return `${model.unlistedCount} Claude process(es) not listed: no session file in ~/.claude/sessions (older Claude Code). See README → Limitations.`;
    }
    return undefined;
}

// rows in Open carry the process, rows in Favorites and All the session itself
function sessionOf(node) {
    return node.session ?? node;
}

// a session already running in VS Code switches on a single click, any other resumes on a double click
function clickSession(model, session, resumeOnDoubleClick) {
    const running = model.runningProcessOf(session.id);
    if (running?.terminal) {
        running.terminal.show();
        return;
    }
    resumeOnDoubleClick(session);
}

async function resumeSession(model, session) {
    await model.refresh();
    const running = model.runningProcessOf(session.id);
    if (running?.terminal) {
        running.terminal.show();
        return;
    }
    if (running && !(await confirmSecondInstance(running))) {
        return;
    }
    if (!fs.existsSync(session.cwd)) {
        vscode.window.showErrorMessage(`The session folder no longer exists: ${session.cwd}`);
        return;
    }

    openClaudeTerminal(session.title, session.cwd, `claude --resume ${session.id}`);
}

// cwd goes to the terminal options, not through the shell, so odd folder names cannot run commands
function openClaudeTerminal(tabName, cwd, command) {
    const terminal = vscode.window.createTerminal({
        name: tabName.slice(0, TAB_NAME_LENGTH),
        cwd,
        // always the first (left) editor group, wherever the focus is
        location: { viewColumn: vscode.ViewColumn.One },
    });
    terminal.show();
    terminal.sendText(command);
}

async function startClaudeInWorkspace() {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length <= 1) {
        await startClaudeIn(folders[0]?.uri.fsPath ?? os.homedir());
        return;
    }

    const picked = await vscode.window.showWorkspaceFolderPick();
    if (picked) {
        await startClaudeIn(picked.uri.fsPath);
    }
}

async function startClaudeIn(folderPath) {
    const name = await vscode.window.showInputBox({
        title: 'Start Claude here',
        prompt: folderPath,
        placeHolder: 'Session name (optional, passed as -n)',
    });
    // Escape cancels; an empty name starts an unnamed session
    if (name === undefined) {
        return;
    }
    const command = name ? `claude -n ${shellQuote(name)}` : 'claude';
    openClaudeTerminal(name || path.basename(folderPath), folderPath, command);
}

// read-only Markdown rendered from the transcript each time the document is opened
function transcriptProvider(model) {
    return {
        provideTextDocumentContent(uri) {
            const session = model.sessionById(path.basename(uri.path, '.md'));
            return session ? renderTranscript(session) : 'Session not found. It may have been deleted by Claude Code cleanup.';
        },
    };
}

async function openTranscript(session) {
    // a new query per opening, so VS Code renders the transcript again instead of reusing the old document
    const uri = vscode.Uri.from({ scheme: TRANSCRIPT_URI_SCHEME, path: `/${session.id}.md`, query: String(Date.now()) });
    await vscode.commands.executeCommand('markdown.showPreview', uri);
}

// two processes would append to the same transcript
async function confirmSecondInstance(running) {
    const openAnyway = 'Open second instance';
    const answer = await vscode.window.showWarningMessage(
        `This session is already running outside VS Code (pid ${running.pid}).`,
        { modal: true, detail: 'A second instance writes to the same transcript.' },
        openAnyway,
    );
    return answer === openAnyway;
}

async function copyResumeCommand(session) {
    await vscode.env.clipboard.writeText(`cd ${shellQuote(session.cwd)} && claude --resume ${session.id}`);
    vscode.window.setStatusBarMessage(`Copied: ${session.title}`, STATUS_BAR_MESSAGE_MS);
}

// single quotes stop $(...), backticks and variables in folder names from running in the user's shell
function shellQuote(text) {
    return `'${text.replaceAll("'", "'\\''")}'`;
}

function showOutside(running) {
    vscode.window.showInformationMessage(`Running outside VS Code: pid ${running.pid} in ${running.cwd}`);
}

async function closeSessionTab(running) {
    if (running.state === 'working' && !(await confirmStopWorking())) {
        return;
    }
    running.terminal.dispose();
}

async function confirmStopWorking() {
    const closeAndStop = 'Close and stop';
    const answer = await vscode.window.showWarningMessage(
        'Claude is working in this session. Close the tab and stop it?',
        { modal: true },
        closeAndStop,
    );
    return answer === closeAndStop;
}

async function searchSessions(model, favorites) {
    await model.refresh();
    const picked = await vscode.window.showQuickPick(
        model.workspaceSessions().map((session) => ({
            label: session.title,
            description: [
                formatDate(session.modifiedAt),
                relativeFolder(session.cwd),
                favorites.has(session.id) ? '★' : null,
                model.runningProcessOf(session.id) ? 'running' : null,
            ].filter(Boolean).join(' · '),
            session,
        })),
        { placeHolder: 'Search sessions by title, date or folder', matchOnDescription: true },
    );
    if (picked) {
        await resumeSession(model, picked.session);
    }
}

// tree views have no double-click event; two clicks on the same session within DOUBLE_CLICK_MS count as one
function onDoubleClick(action) {
    let lastClick = { sessionId: null, time: 0 };

    return (session) => {
        const now = Date.now();
        const isDoubleClick = lastClick.sessionId === session.id && now - lastClick.time < DOUBLE_CLICK_MS;
        if (!isDoubleClick) {
            lastClick = { sessionId: session.id, time: now };
            return;
        }

        lastClick = { sessionId: null, time: 0 };
        action(session);
    };
}

module.exports = { activate };
