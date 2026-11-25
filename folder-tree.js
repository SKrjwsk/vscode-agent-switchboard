'use strict';

const os = require('os');
const path = require('path');

const HOME = os.homedir();
const MAX_SESSIONS_PER_FOLDER = 30;

/**
 * Nested folders by the segments of each session's cwd; sessions of the starting folder itself come last.
 * Sessions arrive newest first and Map keeps insertion order, so folders end up sorted by their newest session.
 */
function buildFolderTree(sessions, segmentsOf) {
    const root = newFolder('', '', '');
    for (const session of sessions) {
        const segments = segmentsOf(session.cwd);
        let folder = root;
        for (const [index, segment] of segments.entries()) {
            // segments are the trailing path parts of cwd, so going up from cwd gives the folder's own path
            const folderPath = path.resolve(session.cwd, ...Array(segments.length - 1 - index).fill('..'));
            folder = childFolder(folder, segment, folderPath);
            folder.sessionCount++;
        }
        if (folder.sessions.length < MAX_SESSIONS_PER_FOLDER) {
            folder.sessions.push(session);
        }
    }
    return [...root.subfolders.values(), ...root.sessions];
}

function newFolder(name, key, folderPath) {
    return { name, key, path: folderPath, subfolders: new Map(), sessions: [], sessionCount: 0 };
}

function childFolder(parent, name, folderPath) {
    if (!parent.subfolders.has(name)) {
        parent.subfolders.set(name, newFolder(name, `${parent.key}/${name}`, folderPath));
    }
    return parent.subfolders.get(name);
}

function homeRelativeSegments(cwd) {
    if (cwd === HOME) {
        return ['~'];
    }
    if (cwd.startsWith(HOME + path.sep)) {
        return cwd.slice(HOME.length + 1).split(path.sep);
    }
    return ['/', ...cwd.split(path.sep).filter(Boolean)];
}

module.exports = { buildFolderTree, homeRelativeSegments };
