'use strict';

const { execFile } = require('child_process');
const path = require('path');
const util = require('util');

const execFileAsync = util.promisify(execFile);
const EXEC_OPTIONS = {
    // ps prints lstart in the system locale otherwise; Date parses only the C format
    env: { ...process.env, LC_ALL: 'C' },
    timeout: 2000,
};

/**
 * Running Claude Code processes with their session and owning VS Code terminal,
 * plus the number of claude processes without a session file (older Claude Code), which cannot be listed.
 * Claude Code names the session of each pid itself (see session-status); ps adds the start time and the parent chain.
 */
async function findRunningSessions(sessions, terminals, liveSessions) {
    const processes = await listProcesses();
    const terminalsByPid = await terminalsByShellPid(terminals);
    return matchRunningSessions({ processes, liveSessions, sessions, terminalsByPid });
}

function matchRunningSessions({ processes, liveSessions, sessions, terminalsByPid }) {
    const processByPid = new Map(processes.map((proc) => [proc.pid, proc]));
    const parentByPid = new Map(processes.map((proc) => [proc.pid, proc.ppid]));
    const sessionById = new Map(sessions.map((session) => [session.id, session]));

    const listed = liveSessions
        // a stale file whose pid now belongs to another program
        .filter((live) => live.cwd !== null && isClaude(processByPid.get(live.pid)))
        .map((live) => ({
            ...processByPid.get(live.pid),
            cwd: live.cwd,
            name: live.name,
            state: live.state,
            waitingFor: live.waitingFor,
            statusUpdatedAt: live.statusUpdatedAt,
            // null until Claude Code writes the first line of the transcript
            session: sessionById.get(live.sessionId) ?? null,
            terminal: owningTerminal(live.pid, parentByPid, terminalsByPid),
        }))
        .sort(insideVsCodeFirstThenNewest);
    const unlistedCount = processes.filter(isClaude).length - listed.length;
    return { running: listed, unlistedCount };
}

async function listProcesses() {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,lstart=,command='], EXEC_OPTIONS);
    return stdout.split('\n').map(parseProcessLine).filter(Boolean);
}

function parseProcessLine(line) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\w+ \w+ +\d+ [\d:]+ \d+)\s+(.*)$/);
    if (!match) {
        return null;
    }

    const [, pid, ppid, startedAt, command] = match;
    return {
        pid: Number(pid),
        ppid: Number(ppid),
        startedAt: new Date(startedAt),
        command,
    };
}

function isClaude(proc) {
    return proc !== undefined && path.basename(proc.command.split(/\s+/)[0]) === 'claude';
}

async function terminalsByShellPid(terminals) {
    const entries = await Promise.all(terminals.map(async (terminal) => [await terminal.processId, terminal]));
    return new Map(entries.filter(([pid]) => pid !== undefined));
}

// claude can sit a few levels below the terminal shell (zsh -ic, wrappers), so walk up the parents
function owningTerminal(pid, parentByPid, terminalsByPid) {
    for (let current = pid; current > 1; current = parentByPid.get(current) ?? 0) {
        if (terminalsByPid.has(current)) {
            return terminalsByPid.get(current);
        }
    }
    return null;
}

function insideVsCodeFirstThenNewest(a, b) {
    if (Boolean(a.terminal) !== Boolean(b.terminal)) {
        return a.terminal ? -1 : 1;
    }
    return b.startedAt - a.startedAt;
}

module.exports = { findRunningSessions, matchRunningSessions, parseProcessLine };
