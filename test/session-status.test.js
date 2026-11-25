'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { useFakeHome, writeFile } = require('./fake-home');

const home = useFakeHome(after);
const sessionsDir = path.join(home, '.claude', 'sessions');
const { readLiveSessions, YOUR_TURN_WINDOW_MS } = require('../session-status');

// a fixed clock, so no test depends on the real time
const NOW = 1_000_000_000_000;

// the test runner's own pid is alive for the whole test
const LIVE_PID = process.pid;
// above the pid range of macOS and Linux, so never alive
const DEAD_PID = 2 ** 30;

beforeEach(() => fs.rmSync(sessionsDir, { recursive: true, force: true }));

function writeSessionFile(fileName, content) {
    writeFile(path.join(sessionsDir, fileName), JSON.stringify(content));
}

test('a live session file gives the session id, folder, name, state and its details', () => {
    writeSessionFile(`${LIVE_PID}.json`, {
        pid: LIVE_PID,
        sessionId: 'abc',
        cwd: '/work',
        name: 'api',
        status: 'waiting',
        waitingFor: 'permission prompt',
        statusUpdatedAt: NOW - 1000,
    });

    assert.deepEqual(readLiveSessions(NOW), [
        {
            pid: LIVE_PID,
            sessionId: 'abc',
            cwd: '/work',
            name: 'api',
            state: 'needsApproval',
            waitingFor: 'permission prompt',
            statusUpdatedAt: NOW - 1000,
        },
    ]);
});

function stateOf(status, extra = {}) {
    writeSessionFile(`${LIVE_PID}.json`, { pid: LIVE_PID, sessionId: 'abc', status, ...extra });
    return readLiveSessions(NOW)[0].state;
}

test('busy is working and waiting is needs approval, whatever it waits for', () => {
    assert.equal(stateOf('busy'), 'working');
    assert.equal(stateOf('waiting'), 'needsApproval');
    assert.equal(stateOf('waiting', { waitingFor: 'permission prompt' }), 'needsApproval');
    assert.equal(stateOf('waiting', { waitingFor: 'something else' }), 'needsApproval');
});

test('an unknown status gives no state', () => {
    assert.equal(stateOf('compacting'), null);
    assert.equal(stateOf(undefined), null);
});

test('idle is your turn until the window ends, then dormant', () => {
    assert.equal(stateOf('idle', { statusUpdatedAt: NOW }), 'yourTurn');
    assert.equal(stateOf('idle', { statusUpdatedAt: NOW - YOUR_TURN_WINDOW_MS + 1 }), 'yourTurn');
    assert.equal(stateOf('idle', { statusUpdatedAt: NOW - YOUR_TURN_WINDOW_MS }), 'dormant');
    assert.equal(stateOf('idle', { statusUpdatedAt: NOW - 24 * 60 * 60 * 1000 }), 'dormant');
});

test('an idle session without a usable time is your turn', () => {
    assert.equal(stateOf('idle'), 'yourTurn');
    assert.equal(stateOf('idle', { statusUpdatedAt: 'yesterday' }), 'yourTurn');
});

test('waitingFor and statusUpdatedAt are null when missing or of the wrong type', () => {
    writeSessionFile(`${LIVE_PID}.json`, { pid: LIVE_PID, sessionId: 'abc', status: 'waiting', waitingFor: 7 });

    const [live] = readLiveSessions(NOW);

    assert.equal(live.waitingFor, null);
    assert.equal(live.statusUpdatedAt, null);
});

test('a file left behind by an ended process is ignored', () => {
    writeSessionFile(`${DEAD_PID}.json`, { pid: DEAD_PID, sessionId: 'abc' });

    assert.deepEqual(readLiveSessions(), []);
});

test('only files named <pid>.json are read', () => {
    writeSessionFile(`${LIVE_PID}.secret.json`, { pid: LIVE_PID, sessionId: 'abc' });
    writeSessionFile('notes.json', { pid: LIVE_PID, sessionId: 'abc' });

    assert.deepEqual(readLiveSessions(), []);
});

test('files without a pid or session id, or with broken JSON, are ignored', () => {
    writeSessionFile('1.json', { sessionId: 'abc' });
    writeSessionFile('2.json', { pid: LIVE_PID });
    writeFile(path.join(sessionsDir, '3.json'), '{ broken');

    assert.deepEqual(readLiveSessions(), []);
});

test('no sessions folder means no running sessions', () => {
    assert.deepEqual(readLiveSessions(), []);
});
