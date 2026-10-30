import test from 'node:test';
import assert from 'node:assert/strict';
import {scrubPaths} from '../lib/gateway.mjs';

test('room paths keep their folders on Windows and POSIX; other local paths never cross', () => {
  const windows = 'D:\\a\\agent-relay\\proj';
  assert.deepEqual(scrubPaths({claims: [{resource: `${windows}\\src\\app.js`}, {resource: windows}],
    note: `see ${windows}\\docs\\x.md and C:\\Users\\me\\secret.txt`, project: windows}, windows),
  {claims: [{resource: './src/app.js'}, {resource: '.'}], note: 'see ./docs/x.md and ./secret.txt', project: '.'});
  // A room reported with forward slashes still matches backslash paths, and the reverse.
  assert.equal(scrubPaths({r: `${windows}\\src\\app.js`}, 'D:/a/agent-relay/proj').r, './src/app.js');
  assert.deepEqual(scrubPaths({claims: [{resource: '/work/proj/src/app.js'}], other: '/etc/passwd'}, '/work/proj'),
    {claims: [{resource: './src/app.js'}], other: './passwd'});
});
