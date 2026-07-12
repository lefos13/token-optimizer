"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LogExcerptCollector = void 0;
const FAILURE_MARKER = /(?:^|\b)(error|errors|failed|failure|exception|traceback|panic|assert(?:ion)?|✕|✗|FAIL)\b/i;
/* Streaming retention keeps only the configured head, tail, and a few marker windows. Counters are updated from the original chunks, while retained lines are capped independently so a pathological line cannot defeat the memory bound. */
class LogExcerptCollector {
    head = [];
    tail = [];
    recent = [];
    markers = [];
    headLines;
    tailLines;
    markerWindows;
    markerContextLines;
    maxLineCharacters;
    decoders = {
        stdout: new node_string_decoder_1.StringDecoder('utf8'),
        stderr: new node_string_decoder_1.StringDecoder('utf8'),
    };
    pending = '';
    totalBytes = 0;
    totalCharacters = 0;
    totalLines = 0;
    finished = false;
    constructor(options = {}) {
        this.headLines = Math.max(0, Math.floor(options.headLines ?? 100));
        this.tailLines = Math.max(0, Math.floor(options.tailLines ?? 200));
        this.markerWindows = Math.max(0, Math.floor(options.markerWindows ?? 5));
        this.markerContextLines = Math.max(0, Math.floor(options.markerContextLines ?? 4));
        this.maxLineCharacters = Math.max(1, Math.floor(options.maxLineCharacters ?? 8192));
    }
    push(stream, chunk) {
        if (this.finished)
            throw new Error('Cannot push after finish');
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        this.totalBytes += bytes.length;
        /* Decode large pipe chunks incrementally so a single binary or long-line
         * write cannot create a full-size UTF-16 string in every collector. */
        for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
            const text = this.decoders[stream].write(bytes.subarray(offset, offset + 64 * 1024));
            this.totalCharacters += text.length;
            this.consumeText(text);
        }
    }
    consumeText(text) {
        this.pending += text;
        let newline = this.pending.indexOf('\n');
        while (newline >= 0) {
            let line = this.pending.slice(0, newline);
            if (line.endsWith('\r'))
                line = line.slice(0, -1);
            this.pending = this.pending.slice(newline + 1);
            this.consumeLine(line);
            newline = this.pending.indexOf('\n');
        }
        if (this.pending.length > this.maxLineCharacters * 2) {
            this.pending = this.pending.slice(0, this.maxLineCharacters * 2);
        }
    }
    finish() {
        if (this.finished)
            return this.buildExcerpt();
        for (const stream of ['stdout', 'stderr']) {
            const text = this.decoders[stream].end();
            this.totalCharacters += text.length;
            this.consumeText(text);
        }
        this.finished = true;
        if (this.pending.length > 0) {
            this.consumeLine(this.pending);
            this.pending = '';
        }
        return this.buildExcerpt();
    }
    consumeLine(line) {
        const number = this.totalLines++;
        const retained = { number, text: line.slice(0, this.maxLineCharacters) };
        if (number < this.headLines)
            this.head.push(retained);
        if (this.tailLines > 0) {
            this.tail.push(retained);
            if (this.tail.length > this.tailLines)
                this.tail.shift();
        }
        this.recent.push(retained);
        if (this.recent.length > this.markerContextLines + 1)
            this.recent.shift();
        for (const window of this.markers) {
            if (window.remaining > 0) {
                window.lines.push(retained);
                window.remaining--;
            }
        }
        if (this.markers.length < this.markerWindows && FAILURE_MARKER.test(line)) {
            const before = this.recent.slice(0, -1);
            this.markers.push({ lines: [...before, retained], remaining: this.markerContextLines });
        }
    }
    buildExcerpt() {
        const selected = new Map();
        for (const line of this.head)
            selected.set(line.number, line);
        for (const window of this.markers)
            for (const line of window.lines)
                selected.set(line.number, line);
        for (const line of this.tail)
            selected.set(line.number, line);
        const lines = [...selected.values()].sort((a, b) => a.number - b.number);
        let text = '';
        for (let i = 0; i < lines.length; i++) {
            if (i > 0) {
                const omitted = lines[i].number - lines[i - 1].number - 1;
                text += omitted > 0 ? `\n\n... [TRUNCATED - ${omitted} LINES OMITTED] ...\n\n` : '\n';
            }
            text += lines[i].text;
        }
        const cappedLine = lines.some((line) => line.text.length >= this.maxLineCharacters);
        const truncated = cappedLine || lines.length < this.totalLines;
        return { text, totalCharacters: this.totalCharacters, totalChars: this.totalCharacters, totalBytes: this.totalBytes, totalLines: this.totalLines, truncated };
    }
}
exports.LogExcerptCollector = LogExcerptCollector;
const node_string_decoder_1 = require("node:string_decoder");
