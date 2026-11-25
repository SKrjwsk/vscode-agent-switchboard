'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { useFakeHome, writeFile, jsonLines } = require('./fake-home');

const home = useFakeHome(after);
const { renderTranscript } = require('../transcript');

function render(entries) {
    const filePath = path.join(home, `${Math.random()}.jsonl`);
    writeFile(filePath, jsonLines(entries));
    return renderTranscript({ id: 'abc', title: 'Login fixes', cwd: '/work', filePath });
}

function user(content) {
    return { type: 'user', message: { content } };
}

function assistant(content) {
    return { type: 'assistant', message: { content } };
}

test('prompts and answers alternate under User and Claude headings', () => {
    const markdown = render([user('fix the form'), assistant([{ type: 'text', text: 'Done.' }])]);

    assert.equal(markdown, '# Login fixes\n\n`/work` · session `abc`\n\n## User\n\nfix the form\n\n## Claude\n\nDone.\n');
});

test('injected messages are skipped and slash commands shown with arguments', () => {
    const markdown = render([
        user('<system-reminder>context</system-reminder>'),
        user('<command-name>/review</command-name><command-args>PR 42</command-args>'),
    ]);

    assert.ok(!markdown.includes('system-reminder'));
    assert.ok(markdown.includes('`/review PR 42`'));
});

test('tool calls, results and thinking are shown under Claude', () => {
    const markdown = render([
        assistant([
            { type: 'thinking', thinking: 'check the form' },
            { type: 'tool_use', name: 'Read', input: { file: 'a.js' } },
        ]),
        user([{ type: 'tool_result', content: 'const a = 1;' }]),
    ]);

    assert.ok(markdown.includes('> Thinking: check the form'));
    assert.ok(markdown.includes('**Tool: Read**'));
    assert.ok(markdown.includes('Result:\n\n```\nconst a = 1;\n```'));
    assert.equal(markdown.match(/## /g).length, 1);
});

test('a tool result with backticks cannot close its code block early', () => {
    const markdown = render([user([{ type: 'tool_result', content: 'before ```` after' }])]);

    assert.ok(markdown.includes('`````\nbefore ```` after\n`````'));
});

test('long tool results are truncated', () => {
    const markdown = render([user([{ type: 'tool_result', content: 'x'.repeat(700) }])]);

    assert.ok(markdown.includes('… (100 more characters)'));
});

test('links, images and HTML in prompts and answers are escaped outside code blocks', () => {
    const markdown = render([
        user('see [x](command:foo) and <b>hi</b>'),
        assistant([{ type: 'text', text: '![p](https://example.com/p.png)\n```\na[0] <b>\n```' }]),
    ]);

    assert.ok(markdown.includes('see \\[x\\](command:foo) and \\<b>hi\\</b>'));
    assert.ok(markdown.includes('!\\[p\\](https://example.com/p.png)'));
    assert.ok(markdown.includes('```\na[0] <b>\n```'));
});

const PAYLOAD = '<img src=https://attacker.example/x.png>\n\n[x](command:workbench.action.terminal.new)';

function assertPayloadEscaped(markdown) {
    assert.ok(markdown.includes('\\<img src=https://attacker.example/x.png>'));
    assert.ok(markdown.includes('\\[x\\](command:workbench.action.terminal.new)'));
}

test('a fence opened in the middle of a line does not exempt the following text', () => {
    assertPayloadEscaped(render([assistant([{ type: 'text', text: `see \`\`\`\n\n${PAYLOAD}\n\n\`\`\` end` }])]));
});

test('a fence with a blank line before its closing does not exempt the text between', () => {
    assertPayloadEscaped(render([assistant([{ type: 'text', text: `\`\`\`x\`\`\`\n\n${PAYLOAD}\n\n\`\`\`` }])]));
});

test('an unclosed fence is escaped to the end', () => {
    assertPayloadEscaped(render([user(`\`\`\`\n${PAYLOAD}`)]));
});

test('a shorter or different closing fence does not end a code block', () => {
    const markdown = render([assistant([{ type: 'text', text: `\`\`\`\`\ncode\n\`\`\`\n~~~\n${PAYLOAD}` }])]);

    assertPayloadEscaped(markdown);
});

test('a backslash cannot cancel the escaping of the next character', () => {
    const markdown = render([user('\\[x](command:foo)')]);

    assert.ok(markdown.includes('\\\\\\[x\\](command:foo)'));
});

test('thinking blocks are escaped too', () => {
    const markdown = render([assistant([{ type: 'thinking', thinking: PAYLOAD.split('\n')[0] }])]);

    assert.ok(markdown.includes('\\<img src='));
});

test('a working folder with a blank line cannot end the header paragraph', () => {
    const filePath = path.join(home, 'newline.jsonl');
    writeFile(filePath, jsonLines([]));
    const markdown = renderTranscript({ id: 'abc', title: 'T', cwd: '/a\n\n<img src=x>', filePath });

    assert.ok(markdown.includes('`/a <img src=x>` · session `abc`'));
    assert.ok(!markdown.includes('\n\n<img'));
});

test('a working folder with backticks cannot break out of its inline code', () => {
    const filePath = path.join(home, 'ticks.jsonl');
    writeFile(filePath, jsonLines([]));
    const markdown = renderTranscript({ id: 'abc', title: 'T', cwd: '/a`b', filePath });

    assert.ok(markdown.includes('`` /a`b `` · session `abc`'));
});
