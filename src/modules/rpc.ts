import type { Readable, Writable } from 'node:stream';

const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * Newline-delimited framing over a child process pipe. One JSON message per line; any other
 * content on stdout is a protocol violation (spec §2).
 */
export class LineChannel {
  private buffer = '';
  private readable: Readable;
  private writable: Writable;
  private onMessage: (text: string) => void;
  private onBroken: (error: Error) => void;
  private closed = false;
  private handleData: (chunk: Buffer | string) => void;

  constructor(
    readable: Readable,
    writable: Writable,
    onMessage: (text: string) => void,
    onBroken: (error: Error) => void = () => {},
  ) {
    this.readable = readable;
    this.writable = writable;
    this.onMessage = onMessage;
    this.onBroken = onBroken;
    this.handleData = (chunk) => {
      this.buffer += chunk.toString('utf8');
      if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES) {
        this.onBroken(new Error('module output line too long'));
        return;
      }
      let index = this.buffer.indexOf('\n');
      while (index >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line.length > 0) this.onMessage(line);
        index = this.buffer.indexOf('\n');
      }
    };
    readable.on('data', this.handleData);
  }

  write(payload: string): void {
    if (this.closed) return;
    this.writable.write(payload.endsWith('\n') ? payload : `${payload}\n`);
  }

  dispose(): void {
    this.closed = true;
    this.readable.removeListener('data', this.handleData);
  }
}
