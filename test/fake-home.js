'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * A temporary home directory, removed after the test file.
 * The modules resolve os.homedir() when they load, so call this before requiring them.
 */
function useFakeHome(after) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-switchboard-'));
    process.env.HOME = home;
    after(() => fs.rmSync(home, { recursive: true, force: true }));
    return home;
}

function writeFile(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
}

function jsonLines(entries) {
    return entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
}

module.exports = { useFakeHome, writeFile, jsonLines };
