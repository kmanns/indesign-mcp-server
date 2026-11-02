import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { parse } from 'acorn';
import { InDesignMCPServer } from '../index.js';
import { dataMergeScript, dataMergeTools, readMergeCsv } from '../data-merge.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'indesign-merge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = fs.realpathSync(dir);
  const documentPath = path.join(root, 'template.indd');
  const image = path.join(root, 'image.png');
  const csv = path.join(root, 'source.csv');
  fs.writeFileSync(documentPath, 'fixture');
  fs.writeFileSync(image, 'fixture');
  fs.writeFileSync(csv, `Headline,CTA,@background\n"Hello, world",Join,${image}\n"Quoted ""text""",Shop,${image}\n`);
  const calls = [];
  const bridge = {
    execute: async (script, expectedDocument, approvedPaths = [], options) => {
      calls.push({ script, expectedDocument, approvedPaths: [...approvedPaths], options });
      return { text: 'ok', document: { id: 7, path: documentPath, links: [] } };
    },
  };
  const env = { INDESIGN_ALLOWED_DIRS: JSON.stringify([root]), INDESIGN_ALLOW_DESTRUCTIVE: '1' };
  const server = new InDesignMCPServer({ env, bridge });
  const args = { documentId: 7, documentPath, dataSourcePath: csv, confirmDestructive: true };
  return { root, image, csv, documentPath, server, bridge, calls, env, args };
}

function validArgs(name, f) {
  switch (name) {
    case 'inspect_data_merge': return {};
    case 'validate_data_merge_csv': return { filePath: f.csv };
    case 'create_data_merge_csv': return { filePath: path.join(f.root, 'new.csv'), headers: ['Headline', '@background'], records: [['Say "Hi", \u00e9', f.image]], confirmDestructive: true };
    case 'select_data_merge_source': return { ...f.args, mode: 'select' };
    case 'bind_data_merge_fields': return { ...f.args, mappings: [{ frameId: 11, fieldName: 'Headline', type: 'text' }] };
    case 'export_data_merge_pdf': return { ...f.args, recordStart: 1, recordEnd: 2, filePath: path.join(f.root, 'new.pdf'), oversetReportPath: path.join(f.root, 'overset.txt') };
  }
}

test('all Data Merge production handlers dispatch ES3 with atomic identity and guarded paths; legacy API is unavailable', async t => {
  const f = fixture(t);
  for (const tool of dataMergeTools) {
    f.calls.length = 0;
    const result = await f.server.handleTool(tool.name, validArgs(tool.name, f));
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.ok(f.calls.length);
    for (const call of f.calls) parse(call.script, { ecmaVersion: 3 });
    if (['select_data_merge_source', 'bind_data_merge_fields', 'export_data_merge_pdf'].includes(tool.name)) {
      assert.deepEqual(f.calls.at(-1).expectedDocument, { id: 7, path: f.documentPath, links: [] });
      assert.ok(f.calls.at(-1).approvedPaths.some(p => p.path === f.image));
    }
    assert.deepEqual(f.calls.at(-1).options, tool.name === 'export_data_merge_pdf' ? { timeoutMs: 120000 } : undefined);
  }
  f.calls.length = 0;
  assert.equal((await f.server.handleTool('data_merge', {})).isError, true);
  assert.equal(f.calls.length, 0);
});

test('CSV creation round trips exact Unicode/quotes/commas; never overwrites or accepts formulas/control characters', async t => {
  const f = fixture(t), args = validArgs('create_data_merge_csv', f);
  assert.equal((await f.server.handleTool('create_data_merge_csv', args)).isError, false);
  assert.deepEqual(readMergeCsv(args.filePath, f.server.files).headers, args.headers);
  assert.ok(fs.readFileSync(args.filePath, 'utf8').includes('"Say ""Hi"", \u00e9"'));
  assert.equal((await f.server.handleTool('create_data_merge_csv', args)).isError, true);
  for (const text of ['=SUM(1)', '+bad', '-formula', '@external', 'a\nb', '\0', '\t']) {
    f.calls.length = 0;
    const result = await f.server.handleTool('create_data_merge_csv', { ...args, filePath: path.join(f.root, 'blocked.csv'), records: [[text, f.image]] });
    assert.equal(result.isError, true);
    assert.equal(f.calls.length, 0);
    assert.equal(fs.existsSync(path.join(f.root, 'blocked.csv')), false);
  }
});

test('malformed CSV, duplicate/retyped headers, missing assets and unsafe paths reject before Adobe dispatch', async t => {
  const f = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'indesign-merge-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'image.png'), 'outside');
  fs.symlinkSync(path.join(outside, 'image.png'), path.join(f.root, 'link.png'));
  for (const csv of [
    '', 'Headline,headline\nA,B', 'Headline,@Headline\nA,B', 'a,b\nonly',
    '"unclosed\n', '@image\n../image.png', '@image\n/etc/passwd',
    `@image\n${f.root}/missing.png`, `@image\n${f.root}/link.png`,
    `@image\n${f.root}/../escape.png`, `@image\n${f.root}/%2f.png`,
    '@image\n', '#QR\ncode', 'field name\ntext',
  ]) {
    fs.writeFileSync(f.csv, csv);
    f.calls.length = 0;
    assert.equal((await f.server.handleTool('validate_data_merge_csv', { filePath: f.csv })).isError, true, csv);
    assert.equal(f.calls.length, 0);
  }
  fs.writeFileSync(f.csv, Buffer.from([0xff, 0xfe, 0x61]));
  assert.equal((await f.server.handleTool('validate_data_merge_csv', { filePath: f.csv })).isError, true);
  fs.writeFileSync(f.csv, 'Name\n' + 'Example\n'.repeat(1001));
  assert.equal((await f.server.handleTool('validate_data_merge_csv', { filePath: f.csv })).isError, true);
});

test('new mutation tools require strict confirmations, nested schemas and selected saved-document identity', async t => {
  const f = fixture(t);
  for (const name of ['create_data_merge_csv', 'select_data_merge_source', 'bind_data_merge_fields', 'export_data_merge_pdf']) {
    for (const confirm of [undefined, false, 'true', 1]) {
      f.calls.length = 0;
      assert.equal((await f.server.handleTool(name, { ...validArgs(name, f), confirmDestructive: confirm })).isError, true);
      assert.equal(f.calls.length, 0);
    }
  }
  for (const mappings of [
    [{ frameId: '11;evil()', fieldName: 'Headline', type: 'text' }],
    [{ frameId: 11, fieldName: 'Headline', type: 'text', replace: true }],
    [{ frameId: 11, fieldName: 'Headline', type: 'text' }, { frameId: 11, fieldName: 'CTA', type: 'text' }],
    [{ frameId: 11, fieldName: 'background', type: 'text' }],
  ]) {
    f.calls.length = 0;
    assert.equal((await f.server.handleTool('bind_data_merge_fields', { ...f.args, mappings })).isError, true);
    assert.equal(f.calls.length, 0);
  }
  for (const change of [{ documentId: 8 }, { documentPath: f.image }]) {
    f.calls.length = 0;
    assert.equal((await f.server.handleTool('select_data_merge_source', { ...f.args, mode: 'select', ...change })).isError, true);
    assert.ok(f.calls.every(c => c.script === '"";'));
  }
  for (const policy of [undefined, '0', 'true']) {
    f.server.env.INDESIGN_ALLOW_DESTRUCTIVE = policy;
    for (const name of ['create_data_merge_csv', 'select_data_merge_source', 'bind_data_merge_fields', 'export_data_merge_pdf']) {
      f.calls.length = 0;
      assert.equal((await f.server.handleTool(name, validArgs(name, f))).isError, true);
      assert.equal(f.calls.length, 0);
    }
  }
});

test('merge range and new outputs reject oversized/nonexistent records and existing report/PDF before any dispatch', async t => {
  const f = fixture(t), args = validArgs('export_data_merge_pdf', f);
  for (const change of [{ recordStart: 2, recordEnd: 1 }, { recordEnd: 11 }, { recordEnd: 3 },
    { filePath: f.documentPath }, { oversetReportPath: f.csv }]) {
    f.calls.length = 0;
    assert.equal((await f.server.handleTool('export_data_merge_pdf', { ...args, ...change })).isError, true);
    assert.equal(f.calls.length, 0);
  }
  fs.writeFileSync(args.filePath, 'do not overwrite');
  assert.equal((await f.server.handleTool('export_data_merge_pdf', args)).isError, true);
  assert.equal(fs.readFileSync(args.filePath, 'utf8'), 'do not overwrite');
});

function nativeFixture(f) {
  const fields = [{ fieldName: 'Headline', fieldType: 1 }, { fieldName: 'CTA', fieldType: 1 }, { fieldName: 'background', fieldType: 2 }];
  const textBindings = [], imageBindings = [], mutations = [];
  const labels = {};
  const frames = [11, 12].map(id => {
    const story = { id: id + 100, textContainers: [], characters: { length: 0 }, insertionPoints: [{}] };
    const frame = { id, constructor: { name: 'TextFrame' }, parentPage: { name: '1' }, locked: false, itemLayer: { locked: false }, parentStory: story, contents: '', label: '' };
    story.textContainers.push(frame);
    return frame;
  });
  frames.push({ id: 13, constructor: { name: 'Rectangle' }, parentPage: { name: '1' }, locked: false, itemLayer: { locked: false }, allGraphics: [], label: '' });
  textBindings.add = (story, offset, field) => {
    mutations.push(['text', story.id, field.fieldName]);
    textBindings.push({ parentStory: story, storyOffset: { index: 0 }, field });
  };
  imageBindings.add = (frame, field) => {
    mutations.push(['image', frame.id, field.fieldName]);
    imageBindings.push({ placeholderPageItem: frame, field });
  };
  const dm = { dataMergeFields: fields, selectDataSource: file => mutations.push(['source', file.fsName]),
    updateDataSource: () => mutations.push(['update']), dataMergePreferences: { recordSelection: 0, recordRange: '1', recordNumber: 1, recordsPerPage: 0 } };
  const d = { id: 7, saved: true, fullName: { fsName: f.documentPath }, pages: [{}], allPageItems: frames,
    dataMergeOptions: { createNewDocument: true, documentSize: 50 },
    dataMergeProperties: dm, dataMergeTextPlaceholders: textBindings, dataMergeImagePlaceholders: imageBindings,
    extractLabel: key => labels[key] ?? '', insertLabel: (key, value) => { labels[key] = value; } };
  const context = { app: { activeDocument: d, scriptPreferences: { userInteractionLevel: 'all' } },
    UserInteractionLevels: { NEVER_INTERACT: 'never' }, SourceFieldType: { TEXT_FIELD: 1, IMAGE_FIELD: 2 },
    File: p => ({ fsName: decodeURIComponent(p) }) };
  const source = readMergeCsv(f.csv, f.server.files);
  const run = (name, args = {}) => vm.runInNewContext(dataMergeScript(name, { ...f.args, ...args }, source), context);
  run('select_data_merge_source', { mode: 'select' });
  mutations.length = 0;
  return { d, dm, frames, context, run, mutations, source, textBindings, imageBindings };
}

test('native mappings are genuine, batch-prevalidated, additive and idempotent; unrelated text/art/bindings never replaced', t => {
  const f = fixture(t), n = nativeFixture(f);
  const mappings = [{ frameId: 11, fieldName: 'Headline', type: 'text' }, { frameId: 13, fieldName: 'background', type: 'image' }];
  assert.throws(() => n.run('bind_data_merge_fields', { mappings: [...mappings, { frameId: 999, fieldName: 'CTA', type: 'text' }] }), /Frame missing/);
  assert.equal(n.mutations.length, 0);
  assert.deepEqual(JSON.parse(n.run('bind_data_merge_fields', { mappings })), { inserted: 2, unchanged: 0 });
  assert.deepEqual(JSON.parse(n.run('bind_data_merge_fields', { mappings })), { inserted: 0, unchanged: 2 });
  assert.equal(n.textBindings.length, 1);
  assert.equal(n.imageBindings.length, 1);
  assert.throws(() => n.run('bind_data_merge_fields', { mappings: [{ frameId: 11, fieldName: 'CTA', type: 'text' }] }), /conflicts/);
  n.frames[1].contents = 'User text';
  assert.throws(() => n.run('bind_data_merge_fields', { mappings: [{ frameId: 12, fieldName: 'CTA', type: 'text' }] }), /empty or contain only/);
  n.frames[1].contents = '';
  n.frames[1].parentStory.textContainers.push(n.frames[0]);
  assert.throws(() => n.run('bind_data_merge_fields', { mappings: [{ frameId: 12, fieldName: 'CTA', type: 'text' }] }), /unthreaded/);
  n.dm.dataMergeFields[0].fieldName = 'Changed';
  assert.throws(() => n.run('select_data_merge_source', { mode: 'select' }), /differs/);
  assert.equal(n.mutations.length, 2);
  assert.equal(n.context.app.scriptPreferences.userInteractionLevel, 'all');
});

test('native image duplicate bindings fail closed and marker deletion verifies exact unchanged content', t => {
  const f = fixture(t), n = nativeFixture(f);
  const field = n.dm.dataMergeFields[2], frame = n.frames[2];
  n.imageBindings.push({ field, placeholderPageItem: frame }, { field, placeholderPageItem: frame });
  assert.throws(() => n.run('bind_data_merge_fields', { mappings: [{ frameId: 13, fieldName: 'background', type: 'image' }] }), /Multiple native image/);
  const text = n.frames[0];
  text.contents = '<<Headline>>';
  text.parentStory.characters.length = text.contents.length;
  let removed = false;
  text.parentStory.characters.itemByRange = () => ({ contents: 'CHANGED', remove() { removed = true; } });
  n.textBindings.add = story => { story.characters.length += 12; };
  assert.throws(() => n.run('bind_data_merge_fields', { mappings: [{ frameId: 11, fieldName: 'Headline', type: 'text' }] }), /refusing deletion/);
  assert.equal(removed, false);
  text.parentStory.characters.itemByRange = () => ({ contents: text.contents, remove() { removed = true; } });
  assert.equal(JSON.parse(n.run('bind_data_merge_fields', { mappings: [{ frameId: 11, fieldName: 'Headline', type: 'text' }] })).inserted, 1);
  assert.equal(removed, true);
});

test('hostile source path characters stay data in ES3 and native alias rejection prevents CSV creation', async t => {
  const f = fixture(t);
  const hostile = path.join(f.root, 'source"\\;__INJECTED__();.csv');
  fs.copyFileSync(f.csv, hostile);
  const result = await f.server.handleTool('select_data_merge_source', { ...f.args, dataSourcePath: hostile, mode: 'select' });
  assert.equal(result.isError, false);
  const script = f.calls.at(-1).script;
  parse(script, { ecmaVersion: 3 });
  assert.ok(script.includes('source%22%5C%3B__INJECTED__()'));
  f.bridge.execute = async (script, expected, paths) => {
    assert.ok(paths.some(p => p.path === f.image));
    throw new Error('Finder aliases are not permitted');
  };
  const args = validArgs('create_data_merge_csv', f);
  assert.equal((await f.server.handleTool('create_data_merge_csv', args)).isError, true);
  assert.equal(fs.existsSync(args.filePath), false);
});

test('changed CSV requires explicit source update; updates pin supplied file before native refresh', t => {
  const f = fixture(t), n = nativeFixture(f);
  fs.appendFileSync(f.csv, `New,Next,${f.image}\n`);
  const changed = readMergeCsv(f.csv, f.server.files);
  assert.throws(() => vm.runInNewContext(dataMergeScript('bind_data_merge_fields', {
    ...f.args, mappings: [{ frameId: 11, fieldName: 'Headline', type: 'text' }],
  }, changed), n.context), /CSV changed/);
  n.run('select_data_merge_source', { mode: 'update' });
  assert.deepEqual(n.mutations.map(m => m[0]), ['source', 'update']);
});

test('export generator restores native preferences/preset after failure and rejects page explosion before export', t => {
  const f = fixture(t), n = nativeFixture(f);
  n.textBindings.push({ field: n.dm.dataMergeFields[0], parentStory: n.frames[0].parentStory, storyOffset: { index: 0 } });
  const prefs = { ...n.dm.dataMergePreferences };
  const pdfPrefs = { viewPDF: true, pageRange: '3' };
  let removed = false;
  const copy = { isValid: true, remove() { removed = true; } };
  n.context.app.pdfExportPreferences = pdfPrefs;
  n.context.app.pdfExportPresets = { itemByName: () => ({ isValid: true, duplicate: () => copy }) };
  Object.assign(n.context, { RecordSelection: { RANGE: 2 }, RecordsPerPage: { SINGLE_RECORD: 1 }, PageRange: { ALL_PAGES: 'all' } });
  n.dm.exportFile = () => { throw new Error('test native export failure'); };
  const args = validArgs('export_data_merge_pdf', f);
  assert.throws(() => n.run('export_data_merge_pdf', args), /test native export failure/);
  assert.equal(removed, true);
  assert.deepEqual(n.dm.dataMergePreferences, prefs);
  assert.deepEqual(pdfPrefs, { viewPDF: true, pageRange: '3' });
  assert.deepEqual(n.d.dataMergeOptions, { createNewDocument: true, documentSize: 50 });
  assert.equal(n.context.app.scriptPreferences.userInteractionLevel, 'all');
  n.d.pages.length = 60;
  assert.throws(() => n.run('export_data_merge_pdf', args), /100 output pages/);
});

test('single-record export uses documented ONE_RECORD and bounded native options, then restores them', t => {
  const f = fixture(t), n = nativeFixture(f);
  n.textBindings.push({ field: n.dm.dataMergeFields[0], parentStory: n.frames[0].parentStory, storyOffset: { index: 0 } });
  const files = new Map();
  n.context.File = encoded => {
    const filePath = decodeURIComponent(encoded);
    if (!files.has(filePath)) files.set(filePath, { fsName: filePath, exists: false, length: 0 });
    return files.get(filePath);
  };
  n.context.RecordSelection = { RANGE: 2, ONE_RECORD: 3 };
  n.context.RecordsPerPage = { SINGLE_RECORD: 1 };
  n.context.PageRange = { ALL_PAGES: 'all' };
  n.context.app.pdfExportPreferences = { viewPDF: true, pageRange: '3' };
  n.context.app.pdfExportPresets = { itemByName: () => ({ isValid: true, duplicate: () => ({ isValid: true, remove() {} }) }) };
  n.dm.exportFile = file => {
    assert.equal(n.dm.dataMergePreferences.recordSelection, 3);
    assert.equal(n.dm.dataMergePreferences.recordNumber, 2);
    assert.deepEqual(n.d.dataMergeOptions, { createNewDocument: false, documentSize: 100 });
    file.exists = true; file.length = 100;
  };
  const args = { ...validArgs('export_data_merge_pdf', f), recordStart: 2, recordEnd: 2 };
  const script = dataMergeScript('export_data_merge_pdf', args, n.source);
  parse(script, { ecmaVersion: 3 });
  const result = JSON.parse(vm.runInNewContext(script, n.context));
  assert.equal(result.records, 1);
  assert.equal(result.expectedPages, 1);
  assert.equal(n.dm.dataMergePreferences.recordSelection, 0);
  assert.deepEqual(n.d.dataMergeOptions, { createNewDocument: true, documentSize: 50 });
});
