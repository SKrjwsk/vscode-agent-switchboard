'use strict';

const { test, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const path = require('path');
const { useFakeHome, writeFile, jsonLines } = require('./fake-home');

const home = useFakeHome(after);
const { readSessions, setTitlePathPrefixes } = require('../session-files');

afterEach(() => setTitlePathPrefixes([]));

function writeSession(entries, fileName = `${randomUUID()}.jsonl`) {
    writeFile(path.join(home, '.claude', 'projects', 'project', fileName), jsonLines(entries));
    return path.basename(fileName, '.jsonl');
}

function prompt(content) {
    return { type: 'user', cwd: '/work/app', message: { content } };
}

function titleOf(sessionId) {
    return readSessions().find((session) => session.id === sessionId)?.title;
}

test('the first user prompt is the title', () => {
    const id = writeSession([prompt('fix the login form'), prompt('and the logout')]);

    assert.equal(titleOf(id), 'fix the login form');
});

test('a /rename title wins over the first prompt', () => {
    const id = writeSession([prompt('fix the login form'), { customTitle: 'Login fixes' }]);

    assert.equal(titleOf(id), 'Login fixes');
});

test('injected messages and bare commands are skipped as titles', () => {
    const id = writeSession([
        prompt('<system-reminder>context</system-reminder>'),
        prompt('Base directory for this skill: /skills/x'),
        prompt('<command-name>/clear</command-name><command-args></command-args>'),
        prompt([{ type: 'text', text: 'real question' }]),
    ]);

    assert.equal(titleOf(id), 'real question');
});

test('a command with arguments becomes the title', () => {
    const id = writeSession([prompt('<command-name>/review</command-name><command-args>PR 42</command-args>')]);

    assert.equal(titleOf(id), '/review PR 42');
});

test('titles show the home directory as ~, drop image markers and are cut to 70 characters', () => {
    const id = writeSession([prompt(`open ${home}/notes.md [Image #1] ${'x'.repeat(100)}`)]);

    const title = titleOf(id);

    assert.ok(title.startsWith('open ~/notes.md x'));
    assert.equal(title.length, 70);
});

test('configured path prefixes are cut from titles', () => {
    const id = writeSession([prompt(`fix ${home}/work/app/README.md and /opt/tools/run.sh`)]);

    setTitlePathPrefixes(['~/work', '/opt/tools/']);

    assert.equal(titleOf(id), 'fix app/README.md and run.sh');
});

test('invalid prefix settings are ignored', () => {
    const id = writeSession([prompt(`fix ${home}/work/app.js`)]);

    setTitlePathPrefixes('~/work');
    assert.equal(titleOf(id), 'fix ~/work/app.js');

    setTitlePathPrefixes([42, '', '  ']);
    assert.equal(titleOf(id), 'fix ~/work/app.js');
});

test('files not named by a session id are not listed', () => {
    writeSession([prompt('not a session')], 'notes.jsonl');

    assert.equal(readSessions().some((session) => session.title === 'not a session'), false);
});

test('a folder that is not a string is ignored and the next valid one is used', () => {
    const id = writeSession([
        { type: 'user', cwd: { path: '/work' }, message: { content: 'first' } },
        { type: 'user', cwd: 42, message: { content: 'second' } },
        { type: 'user', cwd: '/work/app', message: { content: 'third' } },
    ]);

    assert.equal(readSessions().find((session) => session.id === id)?.cwd, '/work/app');
});

test('a transcript with a non-string folder only is not listed', () => {
    const id = writeSession([{ type: 'user', cwd: 42, message: { content: 'no folder' } }]);

    assert.equal(titleOf(id), undefined);
});

test('a transcript without a folder is not listed', () => {
    const id = writeSession([{ type: 'user', message: { content: 'no cwd' } }]);

    assert.equal(titleOf(id), undefined);
});
