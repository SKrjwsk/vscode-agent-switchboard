'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { useFakeHome } = require('./fake-home');

const home = useFakeHome(after);
const { buildFolderTree, homeRelativeSegments } = require('../folder-tree');

const WORKSPACE = '/work';

function session(id, cwd) {
    return { id, cwd };
}

function segmentsFromWorkspace(cwd) {
    return cwd === WORKSPACE ? [] : cwd.slice(WORKSPACE.length + 1).split('/');
}

test('sessions are grouped by folder, sessions of the folder itself after its subfolders', () => {
    const sessions = [session('a', '/work/api/src'), session('b', '/work'), session('c', '/work/api')];

    const [api, rootSession] = buildFolderTree(sessions, segmentsFromWorkspace);

    assert.equal(api.name, 'api');
    assert.equal(api.path, '/work/api');
    assert.equal(api.sessionCount, 2);
    assert.deepEqual(api.sessions.map((item) => item.id), ['c']);
    assert.equal(api.subfolders.get('src').path, '/work/api/src');
    assert.equal(rootSession.id, 'b');
});

test('folders keep the order of their newest session', () => {
    const sessions = [session('new', '/work/web'), session('old', '/work/api'), session('older', '/work/web')];

    const folders = buildFolderTree(sessions, segmentsFromWorkspace);

    assert.deepEqual(folders.map((folder) => folder.name), ['web', 'api']);
});

test('a folder lists at most 30 sessions but counts all', () => {
    const sessions = Array.from({ length: 35 }, (_, index) => session(String(index), '/work/api'));

    const [api] = buildFolderTree(sessions, segmentsFromWorkspace);

    assert.equal(api.sessions.length, 30);
    assert.equal(api.sessionCount, 35);
});

test('paths outside a workspace start at the home directory', () => {
    assert.deepEqual(homeRelativeSegments(home), ['~']);
    assert.deepEqual(homeRelativeSegments(`${home}/code/app`), ['code', 'app']);
    assert.deepEqual(homeRelativeSegments('/opt/app'), ['/', 'opt', 'app']);
});
