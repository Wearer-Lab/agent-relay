import fs from 'node:fs';
import { renameWithRetry } from './runtime.mjs';

// The broker writes its own output: one timestamped line per message, in
// broker.log, rotated by size so the log never grows without bound.
export const DEFAULT_LOG_MAX_BYTES = 1024 * 1024;
export const DEFAULT_LOG_KEEP = 2;

let current = null;

/** The log writer the broker process is writing to, if any. */
export function currentLogWriter() {
  return current;
}

/** Write one broker log line (timestamped by the writer). */
export function logLine(line) {
  if (!current) return false;
  try { current.write(String(line) + '\n'); return true; }
  catch { return false; }
}

/**
 * A size-bounded, timestamped log file. Lines are written in order; the file
 * is rotated once the next line would cross the bound.
 */
export function createLogWriter({ file, maxBytes = DEFAULT_LOG_MAX_BYTES, keep = DEFAULT_LOG_KEEP, now = () => new Date(), rename } = {}) {
  if (!file) throw new Error('A log file path is required.');
  const bound = Math.max(1024, Math.trunc(Number(maxBytes) || DEFAULT_LOG_MAX_BYTES));
  const kept = Math.max(0, Math.trunc(Number(keep) || 0));
  let fd = fs.openSync(file, 'a', 0o600);
  let size = fs.fstatSync(fd).size;
  let pending = '';
  let accepting = true;
  let chain = Promise.resolve();
  const writeAll = bytes => {
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
  };
  const rotate = async () => {
    fs.closeSync(fd);
    // The older rotations move up one slot, then the current file takes slot one.
    for (let index = kept; index >= 2; index--) {
      const from = `${file}.${index - 1}`, to = `${file}.${index}`;
      try { fs.unlinkSync(to); } catch { /* nothing to drop */ }
      try { await renameWithRetry(from, to, rename ? { rename } : {}); } catch { /* keep what we have */ }
    }
    if (kept > 0) {
      try { fs.unlinkSync(`${file}.${kept}`); } catch { /* nothing to drop */ }
      try { await renameWithRetry(file, `${file}.1`, rename ? { rename } : {}); } catch { /* keep what we have */ }
    } else {
      try { fs.unlinkSync(file); } catch { /* nothing to drop */ }
    }
    fd = fs.openSync(file, 'a', 0o600);
    size = 0;
  };
  const emit = async line => {
    const bytes = Buffer.from(`${now().toISOString()} ${line}\n`, 'utf8');
    if (size > 0 && size + bytes.length > bound) await rotate();
    writeAll(bytes);
    size += bytes.length;
  };
  const writer = {
    file, maxBytes: bound, keep: kept,
    get size() { return size; },
    write(chunk) {
      if (!accepting) return;
      pending += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index).replace(/\r$/u, '');
        pending = pending.slice(index + 1);
        chain = chain.then(() => emit(line));
      }
      if (pending.length > bound) {
        const line = pending;
        pending = '';
        chain = chain.then(() => emit(line));
      }
    },
    flush() {
      if (pending) { const line = pending; pending = ''; chain = chain.then(() => emit(line)); }
      return chain;
    },
    close() {
      if (!accepting) return chain;
      accepting = false;
      if (pending) { const line = pending; pending = ''; chain = chain.then(() => emit(line)); }
      chain = chain.then(() => { try { fs.closeSync(fd); } catch { /* already closed */ } });
      if (current === writer) current = null;
      return chain;
    },
  };
  return writer;
}

/**
 * Send a process stream to a size-bounded log file. The original writer is
 * restored by close(), so the caller can hand the streams back untouched.
 */
export function installLogWriter({ file, maxBytes, keep, now, streams = [process.stdout, process.stderr] } = {}) {
  const writer = createLogWriter({ file, maxBytes, keep, now });
  const patched = [];
  for (const stream of streams) {
    if (!stream || typeof stream.write !== 'function') continue;
    const original = stream.write.bind(stream);
    stream.write = (chunk, encoding, callback) => {
      try { writer.write(chunk); } catch { /* a log line never breaks the caller */ }
      const done = typeof encoding === 'function' ? encoding : callback;
      if (typeof done === 'function') { try { done(); } catch { /* ignore */ } }
      return true;
    };
    patched.push({ stream, original });
  }
  writer.restore = () => { for (const { stream, original } of patched) stream.write = original; };
  const close = writer.close.bind(writer);
  writer.close = () => { writer.restore(); return close(); };
  current = writer;
  return writer;
}
