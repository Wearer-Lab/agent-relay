import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export function gitCommonDir(directory, {timeout = 2000, exec = execFile} = {}) {
  return new Promise(resolve => {
    exec('git', ['rev-parse', '--git-common-dir'], {
      cwd: directory, timeout, maxBuffer: 64 * 1024, windowsHide: true
    }, async (error, stdout) => {
      if (error) return resolve(null);
      const value = String(stdout).trim();
      if (!value) return resolve(null);
      const resolved = path.isAbsolute(value) ? path.normalize(value) : path.resolve(directory, value);
      try {
        const canonical = await fs.realpath(resolved);
        if (!(await fs.stat(canonical)).isDirectory()) return resolve(null);
        resolve(canonical);
      } catch { resolve(null); }
    });
  });
}
