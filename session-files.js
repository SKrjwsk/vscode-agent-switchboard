'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const SESSIONS_ROOT = path.join(HOME, '.claude', 'projects');
const TITLE_LENGTH = 70;
// session files can be hundreds of MB; cwd and the first prompt sit at the top
const HEAD_BYTES = 256 * 1024;
// /rename appends the new title, so it sits near the end of the file
const TAIL_BYTES = 1024 * 1024;
// the id goes into a shell command, so only real session ids are accepted
const SESSION_FILE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
const SKILL_BODY_PREFIX = 'Base directory for this skill:';

// technical noise removed from titles; extend as new patterns show up
const NOISE_REPLACEMENTS = [
    [HOME, '~'],
    [/\[Image #\d+\]/g, ''],
];

// filePath -> { mtimeMs, header, customTitle, session }; only changed files are read again
const cache = new Map();
// absolute folder paths cut from titles, from the user's settings
let titlePathPrefixes = [];

/** Folder paths (absolute or starting with `~/`) cut from titles; titles are read again on the next scan. */
function setTitlePathPrefixes(prefixes) {
    // settings.json is edited by hand, so the value is not guaranteed to match the schema
    titlePathPrefixes = (Array.isArray(prefixes) ? prefixes : [])
        .filter((prefix) => typeof prefix === 'string' && prefix.trim() !== '')
        .map(toFolderPrefix);
    cache.clear();
}

function toFolderPrefix(prefix) {
    const absolute = prefix.trim().replace(/^~(?=$|\/)/, HOME);
    return absolute.endsWith(path.sep) ? absolute : absolute + path.sep;
}

/** Sessions of all projects, newest first: { id, filePath, cwd, title, modifiedAt }. */
function readSessions() {
    const filePaths = listSessionFiles();
    const sessions = filePaths.map(readSessionCached).filter(Boolean);

    // Claude Code deletes old transcripts; forget them too
    const existing = new Set(filePaths);
    for (const filePath of cache.keys()) {
        if (!existing.has(filePath)) {
            cache.delete(filePath);
        }
    }
    return sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/** The same list with only the given sessions read again (active ones change every few seconds). */
function rereadSessions(sessions, sessionIds) {
    return sessions
        .map((session) => (sessionIds.has(session.id) ? readSessionCached(session.filePath) : session))
        .filter(Boolean)
        .sort((a, b) => b.modifiedAt - a.modifiedAt);
}

function listSessionFiles() {
    return listDirectory(SESSIONS_ROOT).flatMap((projectDir) => {
        const dirPath = path.join(SESSIONS_ROOT, projectDir);
        return listDirectory(dirPath)
            .filter((name) => SESSION_FILE_NAME.test(name))
            .map((name) => path.join(dirPath, name));
    });
}

function listDirectory(dirPath) {
    try {
        return fs.readdirSync(dirPath);
    } catch {
        // a stray file (ENOTDIR), a folder deleted mid-scan (ENOENT) or without access: nothing to list
        return [];
    }
}

function readSessionCached(filePath) {
    try {
        return readSession(filePath);
    } catch {
        // the file vanished between listing and reading (cleanup of old sessions)
        cache.delete(filePath);
        return null;
    }
}

function readSession(filePath) {
    const stats = fs.statSync(filePath);
    const cached = cache.get(filePath);
    if (cached?.mtimeMs === stats.mtimeMs) {
        return cached.session;
    }

    // a complete head never changes, so an active session only rereads its tail
    const header = cached?.header.isComplete ? cached.header : readHeader(filePath);
    // the rename entry can scroll out of the tail as the session grows; keep the one seen before
    const customTitle = readCustomTitle(filePath, stats.size) ?? cached?.customTitle ?? null;
    const session = header.cwd
        ? {
            id: path.basename(filePath, '.jsonl'),
            filePath,
            cwd: header.cwd,
            title: customTitle ?? header.title ?? '(no prompt)',
            modifiedAt: stats.mtime,
        }
        : null;
    cache.set(filePath, { mtimeMs: stats.mtimeMs, header, customTitle, session });
    return session;
}

function readHeader(filePath) {
    let cwd = null;
    let title = null;
    for (const line of readBytes(filePath, 0, HEAD_BYTES).split('\n')) {
        const entry = parseJson(line);
        if (!entry) {
            continue;
        }

        if (!cwd && typeof entry.cwd === 'string') {
            cwd = entry.cwd;
        }
        if (!title && entry.type === 'user') {
            title = promptTitle(entry.message?.content);
        }
        if (cwd && title) {
            break;
        }
    }
    return { cwd, title, isComplete: Boolean(cwd && title) };
}

function readCustomTitle(filePath, size) {
    const tailStart = Math.max(0, size - TAIL_BYTES);
    const lines = readBytes(filePath, tailStart, TAIL_BYTES)
        .split('\n')
        .filter((line) => line.includes('"customTitle"'))
        .reverse();
    for (const line of lines) {
        const customTitle = parseJson(line)?.customTitle;
        if (typeof customTitle === 'string' && customTitle.trim() !== '') {
            return cleanTitle(customTitle);
        }
    }
    return null;
}

function readBytes(filePath, start, length) {
    const buffer = Buffer.allocUnsafe(length);
    const fd = fs.openSync(filePath, 'r');
    try {
        const bytesRead = fs.readSync(fd, buffer, 0, length, start);
        return buffer.toString('utf8', 0, bytesRead);
    } finally {
        fs.closeSync(fd);
    }
}

function parseJson(line) {
    try {
        return JSON.parse(line);
    } catch {
        // the first and last line of a read window are usually cut in half
        return null;
    }
}

function promptTitle(content) {
    const text = Array.isArray(content)
        ? content.map((block) => block?.text ?? '').join(' ')
        : content;
    if (typeof text !== 'string') {
        return null;
    }

    const singleLine = text.replace(/\s+/g, ' ').trim();
    if (singleLine.includes('<command-name>')) {
        return slashCommandTitle(singleLine);
    }
    // tags mark system-injected messages (reminders, pastes), the skill body is injected too
    if (singleLine === '' || singleLine.startsWith('<') || singleLine.startsWith(SKILL_BODY_PREFIX)) {
        return null;
    }
    return cleanTitle(singleLine);
}

function slashCommandTitle(text) {
    const name = text.match(/<command-name>(.*?)<\/command-name>/)?.[1];
    const args = text.match(/<command-args>(.*?)<\/command-args>/)?.[1]?.trim();
    // a bare command (/model, /clear) says nothing about the session; the next prompt names it better
    if (!name || !args) {
        return null;
    }
    return cleanTitle(`${name} ${args}`);
}

function cleanTitle(title) {
    const replacements = [...titlePathPrefixes.map((prefix) => [prefix, '']), ...NOISE_REPLACEMENTS];
    const cleaned = replacements
        .reduce((text, [pattern, replacement]) => text.replaceAll(pattern, replacement), title)
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned.slice(0, TITLE_LENGTH);
}

module.exports = { readSessions, rereadSessions, setTitlePathPrefixes };
