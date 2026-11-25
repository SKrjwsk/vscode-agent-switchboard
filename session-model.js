'use strict';

const vscode = require('vscode');
const { readSessions, rereadSessions } = require('./session-files');
const { readLiveSessions } = require('./session-status');
const { findRunningSessions } = require('./running-sessions');
const { isInWorkspace } = require('./workspace');

const MINUTE_MS = 60 * 1000;

/**
 * One snapshot of sessions, their states and running processes, scanned once per cycle and shared by all views.
 * A light scan rereads only active sessions; a full scan lists every transcript.
 * Views re-render only when the snapshot changes, so open tooltips and the selection stay put.
 */
class SessionModel {
    constructor() {
        this.changeEmitter = new vscode.EventEmitter();
        this.onDidChange = this.changeEmitter.event;
        this.sessions = [];
        this.running = [];
        this.unlistedCount = 0;
        this.scanError = null;
        this.scanInProgress = null;
        this.isFullScanPending = false;
        this.fingerprint = '';
    }

    // a slow ps must not pile up overlapping scans
    refresh({ full = true } = {}) {
        if (this.scanInProgress) {
            this.isFullScanPending = this.isFullScanPending || full;
            return this.scanInProgress;
        }
        this.scanInProgress = this.scan(full).finally(() => {
            this.scanInProgress = null;
            if (this.isFullScanPending) {
                this.isFullScanPending = false;
                this.refresh({ full: true });
            }
        });
        return this.scanInProgress;
    }

    // for changes outside the snapshot: favorites, active terminal, workspace folders
    render() {
        this.changeEmitter.fire();
    }

    async scan(full) {
        const liveSessions = readLiveSessions();
        // a session started since the last full scan is not on the list yet
        const hasUnknownSession = liveSessions.some((live) => !this.sessionById(live.sessionId));
        const sessions = full || hasUnknownSession
            ? readSessions()
            : rereadSessions(this.sessions, this.activeSessionIds());
        const { running, unlistedCount, scanError } = await scanRunning(sessions, liveSessions);

        this.sessions = sessions;
        this.running = running;
        this.unlistedCount = unlistedCount;
        this.scanError = scanError;
        this.renderIfChanged();
    }

    renderIfChanged() {
        const fingerprint = JSON.stringify([
            this.sessions.map((session) => [session.id, session.title, Math.floor(session.modifiedAt / MINUTE_MS)]),
            this.running.map((proc) => [proc.pid, proc.session?.id, proc.state, proc.waitingFor, proc.statusUpdatedAt, Boolean(proc.terminal)]),
            this.unlistedCount,
            this.scanError,
        ]);
        if (fingerprint !== this.fingerprint) {
            this.fingerprint = fingerprint;
            this.render();
        }
    }

    workspaceSessions() {
        return this.sessions.filter((session) => isInWorkspace(session.cwd));
    }

    workspaceRunning() {
        return this.running.filter((proc) => isInWorkspace(proc.cwd));
    }

    sessionById(sessionId) {
        return this.sessions.find((session) => session.id === sessionId) ?? null;
    }

    activeSessionIds() {
        return new Set(this.running.filter((proc) => proc.session).map((proc) => proc.session.id));
    }

    runningProcessOf(sessionId) {
        return this.running.find((proc) => proc.session?.id === sessionId) ?? null;
    }

    needsApprovalCount() {
        return this.workspaceRunning().filter((proc) => proc.state === 'needsApproval').length;
    }
}

async function scanRunning(sessions, liveSessions) {
    try {
        const { running, unlistedCount } = await findRunningSessions(sessions, vscode.window.terminals, liveSessions);
        return { running, unlistedCount, scanError: null };
    } catch (error) {
        // ps failed or timed out; the next cycle tries again
        return { running: [], unlistedCount: 0, scanError: error.message };
    }
}

module.exports = { SessionModel };
