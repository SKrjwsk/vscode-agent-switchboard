'use strict';

const fs = require('fs');

// bigger transcripts are shown from the end; the latest part is what the preview is for
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
const MAX_TOOL_TEXT = 600;
const MAX_THINKING_TEXT = 1200;

/** Read-only Markdown view of a session transcript: prompts, answers, thinking and tool calls. */
function renderTranscript(session) {
    const { text, isTruncated } = readTranscript(session.filePath);
    const sections = [
        `# ${escapeMarkdown(session.title)}`,
        `${inlineCode(session.cwd)} · session ${inlineCode(session.id)}`,
        isTruncated ? `_Only the last ${MAX_TRANSCRIPT_BYTES / 1024 / 1024} MB of the transcript are shown._` : null,
    ];

    let lastSpeaker = null;
    for (const entry of text.split('\n').map(parseJson).filter(Boolean)) {
        for (const block of renderEntry(entry)) {
            if (block.speaker !== lastSpeaker) {
                sections.push(`## ${block.speaker}`);
                lastSpeaker = block.speaker;
            }
            sections.push(block.markdown);
        }
    }
    return sections.filter(Boolean).join('\n\n') + '\n';
}

function readTranscript(filePath) {
    const size = fs.statSync(filePath).size;
    const start = Math.max(0, size - MAX_TRANSCRIPT_BYTES);
    const buffer = Buffer.allocUnsafe(size - start);
    const fd = fs.openSync(filePath, 'r');
    try {
        const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, start);
        return { text: buffer.toString('utf8', 0, bytesRead), isTruncated: start > 0 };
    } finally {
        fs.closeSync(fd);
    }
}

function parseJson(line) {
    try {
        return JSON.parse(line);
    } catch {
        // the first line of a window read from the end is cut in half
        return null;
    }
}

// one transcript line -> zero or more { speaker, markdown } blocks
function renderEntry(entry) {
    const content = entry.message?.content;
    if (entry.type === 'user') {
        return contentBlocks(content).map(renderUserBlock).filter(Boolean);
    }
    if (entry.type === 'assistant') {
        return contentBlocks(content).map(renderAssistantBlock).filter(Boolean);
    }
    return [];
}

function contentBlocks(content) {
    if (typeof content === 'string') {
        return [{ type: 'text', text: content }];
    }
    return Array.isArray(content) ? content : [];
}

function renderUserBlock(block) {
    if (block.type === 'tool_result') {
        return { speaker: 'Claude', markdown: `Result:\n\n${fenced(truncate(toolResultText(block.content), MAX_TOOL_TEXT))}` };
    }
    if (block.type !== 'text' || typeof block.text !== 'string') {
        return null;
    }

    const command = slashCommand(block.text);
    if (command) {
        return { speaker: 'User', markdown: inlineCode(command) };
    }
    // tags mark system-injected text (reminders, command output), not the user's words
    if (block.text.trim().startsWith('<')) {
        return null;
    }
    return { speaker: 'User', markdown: escapeMarkdown(block.text.trim()) };
}

function renderAssistantBlock(block) {
    if (block.type === 'text' && block.text?.trim()) {
        return { speaker: 'Claude', markdown: escapeMarkdown(block.text.trim()) };
    }
    if (block.type === 'thinking' && block.thinking?.trim()) {
        const thinking = escapeMarkdown(truncate(block.thinking.trim(), MAX_THINKING_TEXT));
        return { speaker: 'Claude', markdown: quoted(`Thinking: ${thinking}`) };
    }
    if (block.type === 'tool_use') {
        const input = truncate(JSON.stringify(block.input ?? {}, null, 2), MAX_TOOL_TEXT);
        return { speaker: 'Claude', markdown: `**Tool: ${escapeMarkdown(String(block.name))}**\n\n${fenced(input)}` };
    }
    return null;
}

function slashCommand(text) {
    const name = text.match(/<command-name>(.*?)<\/command-name>/)?.[1];
    if (!name) {
        return null;
    }
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
    return args ? `${name} ${args}` : name;
}

function toolResultText(content) {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content.map((part) => (part?.type === 'text' ? part.text : `[${part?.type}]`)).join('\n');
    }
    return '';
}

function truncate(text, limit) {
    return text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters)` : text;
}

// a fence longer than any backtick run inside, so tool output cannot close it early
function fenced(text) {
    const longestRun = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
    const fence = '`'.repeat(longestRun + 1);
    return `${fence}\n${text}\n${fence}`;
}

// Transcript text is untrusted (answers can repeat web content): links, images and HTML would
// render in the preview, so `\`, `[`, `]` and `<` are escaped everywhere except in fenced code blocks.
// Fences are recognized line by line as Markdown does; an unclosed fence is not trusted and is escaped.
function escapeMarkdown(text) {
    const lines = text.split('\n');
    let openFence = null;
    let openFenceLine = 0;

    lines.forEach((line, index) => {
        if (openFence) {
            if (closesFence(line, openFence)) {
                openFence = null;
            }
            return;
        }
        const fence = opensFence(line);
        if (fence) {
            openFence = fence;
            openFenceLine = index;
            return;
        }
        lines[index] = escapeLine(line);
    });

    if (openFence) {
        for (let index = openFenceLine; index < lines.length; index++) {
            lines[index] = escapeLine(lines[index]);
        }
    }
    return lines.join('\n');
}

function opensFence(line) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    // the info string of a backtick fence cannot contain a backtick, otherwise it is inline code
    if (!match || (match[1][0] === '`' && match[2].includes('`'))) {
        return null;
    }
    return match[1];
}

function closesFence(line, fence) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
    return match !== null && match[1][0] === fence[0] && match[1].length >= fence.length;
}

function escapeLine(line) {
    return line.replace(/[\\[\]<]/g, '\\$&');
}

// a backtick run longer than any inside, padded so a leading or trailing backtick survives;
// line breaks become spaces, a blank line would end the paragraph and the inline code with it
function inlineCode(rawText) {
    const text = rawText.replace(/[\r\n]+/g, ' ');
    const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
    const fence = '`'.repeat(longestRun + 1);
    return longestRun === 0 ? `${fence}${text}${fence}` : `${fence} ${text} ${fence}`;
}

function quoted(text) {
    return text.split('\n').map((line) => `> ${line}`).join('\n');
}

module.exports = { renderTranscript };
