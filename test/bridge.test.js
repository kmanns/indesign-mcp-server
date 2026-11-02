import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { parse } from 'acorn';
import { InDesignBridge } from '../bridge.js';

function fixture(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'indesign-bridge-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appPath = path.join(root, 'Adobe InDesign 2027 (Beta).app');
  fs.mkdirSync(appPath);
  const calls = [], directories = [];
  let running = options.running ?? true;
  const app = { fullName: options.actualPath ?? appPath, version: '22.0.0.96', documents: [] };
  const execFile = (command, args) => {
    calls.push({ command, args });
    if (command === '/usr/bin/plutil') return JSON.stringify({
      CFBundleName: 'InDesign (Beta)', CFBundleIdentifier: options.bundleId ?? 'com.adobe.InDesign',
      CFBundleShortVersionString: '22.0.0.96',
    });
    assert.equal(command, '/usr/bin/osascript');
    if (args[0] === '-l') {
      assert.ok(args[3].includes(JSON.stringify(appPath)), 'Running-process check must use exact path');
      return running ? 'running\n' : 'stopped\n';
    }
    const directory = path.dirname(args[0]);
    directories.push(directory);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    for (const file of ['request.jsx', 'request.applescript']) assert.equal(fs.statSync(path.join(directory, file)).mode & 0o777, 0o600);
    const appleScript = fs.readFileSync(args[0], 'utf8');
    assert.ok(appleScript.startsWith(`tell application "${appPath}"`));
    assert.ok(!appleScript.includes('activate'));
    if (options.transportError) throw new Error('simulated timeout');
    if (options.missingResult) return '';
    const wrapped = fs.readFileSync(path.join(directory, 'request.jsx'), 'utf8');
    parse(wrapped, { ecmaVersion: 3 });
    function File(filename) {
      filename = typeof filename === 'string' ? decodeURIComponent(filename) : filename.fsName;
      if (!(this instanceof File)) return {
        fsName: options.differentPath && filename !== appPath ? '/outside/target' : filename,
        alias: options.alias ?? false,
      };
      this.open = () => true;
      this.write = text => {
        if (options.requireUnix) assert.equal(this.lineFeed, 'Unix');
        const output = options.rawResult ?? text.replace(/\n/g, options.lineEnding ?? '\n');
        fs.writeFileSync(filename, (options.bom ? '\uFEFF' : '') + output);
      };
      this.close = () => {};
    }
    vm.runInNewContext(wrapped, { app, File, Folder: File, encodeURIComponent });
    return '';
  };
  const bridge = new InDesignBridge({ env: { INDESIGN_APP_PATH: appPath }, execFile, tempRoot: root, platform: 'darwin' });
  return { bridge, calls, directories, root, appPath, app, stop: () => { running = false; } };
}

test('explicit path/version selection distinguishes Beta despite shared bundle ID', t => {
  const f = fixture(t);
  assert.deepEqual(f.bridge.applicationInfo(), { path: f.appPath, version: '22.0.0.96', bundleId: 'com.adobe.InDesign' });
  assert.equal(f.calls.length, 1, 'Metadata lookup must not launch InDesign');
  f.bridge.appPath = undefined;
  assert.throws(() => f.bridge.applicationInfo(), /exact stable or Beta/);
});

test('non-running selection fails without any execution or auto-launch', async t => {
  const f = fixture(t, { running: false });
  await assert.rejects(f.bridge.execute('throw new Error("must not execute")'), /not running/);
  assert.equal(f.calls.length, 2);
  assert.equal(f.directories.length, 0);
});

test('untrusted application identities and symlink selectors fail closed', async t => {
  const f = fixture(t, { bundleId: 'com.other.app' });
  await assert.rejects(f.bridge.execute('"ok";'), /not a supported/);
  const g = fixture(t);
  const alias = path.join(g.root, 'Alias.app');
  fs.symlinkSync(g.appPath, alias);
  g.bridge.appPath = alias;
  assert.throws(() => g.bridge.applicationInfo(), /canonical/);
});

test('actual InDesign identity is checked before eval or any document mutation', async t => {
  const f = fixture(t, { actualPath: '/wrong/InDesign.app' });
  await assert.rejects(f.bridge.execute('app.mutated = true;'), /identity mismatch/);
  assert.equal(f.app.mutated, undefined);
  assert.ok(f.directories.every(directory => !fs.existsSync(directory)));
});

test('private per-request files capture statement completion and clean up concurrently', async t => {
  const f = fixture(t);
  const results = await Promise.all([
    f.bridge.execute('if (true) { "branch result"; }'),
    f.bridge.execute('try { "try result"; } catch(e) { "wrong"; }'),
  ]);
  assert.deepEqual(results.map(result => result.text), ['branch result', 'try result']);
  assert.equal(new Set(f.directories).size, 2);
  assert.ok(f.directories.every(directory => !fs.existsSync(directory)));
});

test('script errors propagate and temporary files are cleaned', async t => {
  const f = fixture(t);
  await assert.rejects(f.bridge.execute('throw new Error("explicit failure");'), /script failed: explicit failure/);
  assert.ok(f.directories.every(directory => !fs.existsSync(directory)));
});

test('transport timeout and missing results poison the bridge until restart', async t => {
  for (const option of [{ transportError: true }, { missingResult: true }]) {
    const f = fixture(t, option);
    await assert.rejects(f.bridge.execute('"ok";'), /restart required/);
    const count = f.calls.length;
    await assert.rejects(f.bridge.execute('"no further calls";'), /previously failed/);
    assert.equal(f.calls.length, count);
    assert.ok(f.directories.every(directory => !fs.existsSync(directory)));
  }
});

test('document changes between inspection and execution reject without mutation', async t => {
  const f = fixture(t);
  f.app.documents = [{}];
  f.app.activeDocument = { id: 8, fullName: { fsName: '/approved/changed.indd' }, links: [] };
  await assert.rejects(f.bridge.execute('app.mutated = true;', { id: 7, path: '/approved/old.indd' }), /Active document changed/);
  await assert.rejects(f.bridge.execute('app.mutated = true;', { id: 8, path: '/approved/old.indd' }), /Document path changed/);
  await assert.rejects(f.bridge.execute('app.mutated = true;', { id: null, path: '' }), /Active document changed/);
  assert.equal(f.app.mutated, undefined);
});

test('Finder aliases and Adobe/native target mismatches fail before file operations', async t => {
  for (const options of [{ alias: true }, { differentPath: true }]) {
    const f = fixture(t, options);
    await assert.rejects(f.bridge.execute('app.mutated = true;', undefined, [
      { path: path.join(f.root, 'alias-image.png'), directory: false },
    ]), /Finder aliases|path interpretation/);
    assert.equal(f.app.mutated, undefined);
  }
});

test('literal encoded dots, separators, percent and Unicode retain native path identity', async t => {
  const f = fixture(t);
  const nativePath = path.join(f.root, '%2e%2e', '%2f%25 image \u00e9.png');
  const result = await f.bridge.execute('"safe";', undefined, [{ path: nativePath, directory: false }]);
  assert.equal(result.text, 'safe');
});

test('native ExtendScript CR/CRLF and UTF-8 BOM framing preserve result and empty fields', async t => {
  for (const lineEnding of ['\n', '\r', '\r\n']) {
    const f = fixture(t, { lineEnding, bom: true, requireUnix: true });
    const result = await f.bridge.execute('"Text with\\nnewline and\\rcarriage return";');
    assert.equal(result.text, 'Text with\nnewline and\rcarriage return');
    assert.equal(result.document, null);
    assert.ok(f.directories.every(directory => !fs.existsSync(directory)));
  }
});

test('invalid framing, escapes and document identities poison the bridge without retry', async t => {
  for (const rawResult of ['OK\ntext', 'OK\n%ZZ\n\n\n', 'OK\ntext\n1x\n\n', 'OK\ntext\n1e3\n\n']) {
    const f = fixture(t, { rawResult });
    await assert.rejects(f.bridge.execute('"may have run";'), /operation may already have run/);
    const count = f.calls.length;
    await assert.rejects(f.bridge.execute('"must not retry";'), /previously failed/);
    assert.equal(f.calls.length, count);
    assert.ok(f.directories.every(directory => !fs.existsSync(directory)));
  }
});
