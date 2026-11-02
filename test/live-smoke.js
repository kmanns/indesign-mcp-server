import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { InDesignMCPServer } from '../index.js';

if (process.env.INDESIGN_LIVE_SMOKE !== '1') {
  throw new Error('Live smoke is opt-in: set INDESIGN_LIVE_SMOKE=1 and an exact INDESIGN_APP_PATH');
}

const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'indesign-mcp-smoke-')));
const server = new InDesignMCPServer({
  env: {
    INDESIGN_APP_PATH: process.env.INDESIGN_APP_PATH,
    INDESIGN_ALLOWED_DIRS: JSON.stringify([directory]),
    INDESIGN_ALLOW_DESTRUCTIVE: '1',
    INDESIGN_ALLOW_ARBITRARY_CODE: '0',
  },
});
let closed = false;
let created = false;
async function call(name, args = {}) {
  const result = await server.handleTool(name, args);
  if (result.isError) throw new Error(result.content.map(item => item.text ?? '').join('\n'));
  console.log(result.content.map(item => item.text ?? '').join('\n'));
  return result;
}

try {
  await call('get_application_info');
  server.bridge.assertRunning(server.bridge.applicationInfo());
  await call('create_document', { preset: 'A4', pages: 1 });
  assert.equal(server.unsavedDocuments.size, 1, 'Smoke must own exactly one new unsaved document');
  created = true;
  await call('create_text_frame', { content: 'Disposable MCP smoke: "quotes", backslash \\, and newline\nSecond line', pageIndex: 0 });
  await call('save_document', { filePath: path.join(directory, 'smoke.indd'), confirmDestructive: true });
  assert.ok(fs.statSync(path.join(directory, 'smoke.indd')).size > 0);
  await call('close_document', { save: false, confirmDestructive: true });
  closed = true;
  console.log('PASS: selected-app identity, dedicated-document creation, authoring, save and close');
} finally {
  // Never retarget or close a user document after a failure or active-document change.
  await server.server.close();
  if (closed || (!created && server.unsavedDocuments.size === 0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  } else {
    console.error(`Smoke failed; inspect only the disposable document. Preserved directory: ${directory}`);
  }
}
