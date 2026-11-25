'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Claude Code keeps one file per running process here (internal format, checked on Claude Code 2.1.312)
const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
// only `<pid>.json`; the same directory holds per-process secrets, which are never opened
const SESSION_FILE = /^\d+\.json$/;
// an idle session is "your turn" for this long after it finished, then it is dormant
const YOUR_TURN_WINDOW_MS = 30 * 60 * 1000;

/**
 * Every running Claude Code process:
 * { pid, sessionId, cwd, name, state, waitingFor, statusUpdatedAt }, where state is
 * working | needsApproval | yourTurn | dormant | null (unknown status).
 * A crashed process leaves its file behind, so only files whose pid is still alive count.
 */
function readLiveSessions(now = Date.now()) {
    return listSessionFiles()
        .map((fileName) => readSessionFile(path.join(SESSIONS_DIR, fileName), now))
        .filter((live) => live !== null && isAlive(live.pid));
}

function listSessionFiles() {
    try {
        return fs.readdirSync(SESSIONS_DIR).filter((name) => SESSION_FILE.test(name));
    } catch {
        // Claude Code has not run yet
        return [];
    }
}

function readSessionFile(filePath, now) {
    try {
        const file = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!Number.isInteger(file.pid) || typeof file.sessionId !== 'string') {
            return null;
        }
        const statusUpdatedAt = Number.isFinite(file.statusUpdatedAt) ? file.statusUpdatedAt : null;
        return {
            pid: file.pid,
            sessionId: file.sessionId,
            cwd: typeof file.cwd === 'string' ? file.cwd : null,
            name: typeof file.name === 'string' ? file.name : null,
            state: stateOf(file.status, statusUpdatedAt, now),
            waitingFor: typeof file.waitingFor === 'string' ? file.waitingFor : null,
            statusUpdatedAt,
        };
    } catch {
        // the process ended and its file was removed after listing
        return null;
    }
}

function stateOf(status, statusUpdatedAt, now) {
    if (status === 'busy') {
        return 'working';
    }
    if (status === 'waiting') {
        return 'needsApproval';
    }
    if (status === 'idle') {
        // without a time there is no evidence that the session has been idle for long
        const isDormant = statusUpdatedAt !== null && now - statusUpdatedAt >= YOUR_TURN_WINDOW_MS;
        return isDormant ? 'dormant' : 'yourTurn';
    }
    return null;
}

function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

module.exports = { readLiveSessions, YOUR_TURN_WINDOW_MS };
