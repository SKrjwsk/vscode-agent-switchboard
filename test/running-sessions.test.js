'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matchRunningSessions, parseProcessLine } = require('../running-sessions');

const SHELL_PID = 100;
const terminal = { name: 'zsh' };

function proc(pid, ppid, command, startedAt = '2026-11-25T10:00:00') {
    return { pid, ppid, startedAt: new Date(startedAt), command };
}

function live(pid, sessionId, extra = {}) {
    return { pid, sessionId, cwd: '/work', name: null, state: 'working', ...extra };
}

function match({ processes, liveSessions, sessions = [], terminalsByPid = new Map() }) {
    return matchRunningSessions({ processes, liveSessions, sessions, terminalsByPid });
}

test('ps lines give pid, parent, start time and command', () => {
    const parsed = parseProcessLine('  4242     1 Wed Nov 25 09:05:07 2026     /usr/local/bin/claude --resume x');

    assert.deepEqual(parsed, {
        pid: 4242,
        ppid: 1,
        startedAt: new Date('Wed Nov 25 09:05:07 2026'),
        command: '/usr/local/bin/claude --resume x',
    });
});

test('a line that is not a process is skipped', () => {
    assert.equal(parseProcessLine(''), null);
});

test('a running session is linked to its transcript by the session id', () => {
    const session = { id: 'abc', title: 'Login fixes' };

    const { running } = match({
        processes: [proc(200, 1, 'claude')],
        liveSessions: [live(200, 'abc', { name: 'api', state: 'needsApproval', waitingFor: 'permission prompt' })],
        sessions: [session],
    });

    assert.equal(running.length, 1);
    assert.equal(running[0].session, session);
    assert.equal(running[0].name, 'api');
    assert.equal(running[0].state, 'needsApproval');
    assert.equal(running[0].waitingFor, 'permission prompt');
});

test('a session without a transcript yet is listed without a session', () => {
    const { running } = match({ processes: [proc(200, 1, 'claude')], liveSessions: [live(200, 'abc')] });

    assert.equal(running[0].session, null);
});

test('a stale file whose pid now belongs to another program is ignored', () => {
    const { running } = match({ processes: [proc(200, 1, '/bin/zsh')], liveSessions: [live(200, 'abc')] });

    assert.deepEqual(running, []);
});

test('claude processes without a session file are counted, not listed', () => {
    const { running, unlistedCount } = match({
        processes: [proc(200, 1, 'claude'), proc(201, 1, '/opt/bin/claude --resume x')],
        liveSessions: [live(200, 'abc')],
    });

    assert.equal(running.length, 1);
    assert.equal(unlistedCount, 1);
});

test('a process a few levels below a VS Code terminal shell belongs to that terminal', () => {
    const { running } = match({
        processes: [proc(SHELL_PID, 1, '/bin/zsh'), proc(150, SHELL_PID, 'zsh -ic claude'), proc(200, 150, 'claude')],
        liveSessions: [live(200, 'abc')],
        terminalsByPid: new Map([[SHELL_PID, terminal]]),
    });

    assert.equal(running[0].terminal, terminal);
});

test('sessions in VS Code come first, then the newest', () => {
    const { running } = match({
        processes: [
            proc(SHELL_PID, 1, '/bin/zsh'),
            proc(200, SHELL_PID, 'claude', '2026-11-25T08:00:00'),
            proc(300, 1, 'claude', '2026-11-25T09:00:00'),
            proc(400, 1, 'claude', '2026-11-25T10:00:00'),
        ],
        liveSessions: [live(300, 'b'), live(200, 'a'), live(400, 'c')],
        terminalsByPid: new Map([[SHELL_PID, terminal]]),
    });

    assert.deepEqual(running.map((item) => item.pid), [200, 400, 300]);
});
