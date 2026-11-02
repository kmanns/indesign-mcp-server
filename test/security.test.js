import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { parse } from 'acorn';
import { InDesignMCPServer } from '../index.js';
import { FilePolicy, destructiveTools, jsxString, adobePath } from '../security.js';
import { dataMergeTools } from '../data-merge.js';

const attack = 'x"\'\\\n\r\u2028\u2029; __INJECTED__(); // ${anything} `';

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'indesign-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = fs.realpathSync(directory);
  const input = path.join(root, 'input"\\\n.indd');
  fs.writeFileSync(input, 'fixture');
  const image = path.join(root, 'image.png');
  fs.writeFileSync(image, 'fixture');
  const csv = path.join(root, 'records.csv');
  fs.writeFileSync(csv, 'name\nExample\n');
  const scripts = [];
  const bridge = {
    applicationInfo: () => ({ path: '/explicit/InDesign.app', version: '21.6.0.57' }),
    execute: async (script, expectedDocument) => {
      scripts.push({ script, expectedDocument });
      return { text: 'ok', document: null };
    },
    ...options.bridge,
  };
  const env = {
    INDESIGN_ALLOWED_DIRS: JSON.stringify([root]),
    INDESIGN_ALLOW_DESTRUCTIVE: '1',
    ...options.env,
  };
  const server = new InDesignMCPServer({ env, bridge });
  return { server, bridge, scripts, root, input, image, csv };
}

function argsFor(tool, f, malicious = false) {
  const result = {};
  const special = {
    filePath: tool.name === 'open_document' ? f.input : path.join(f.root, 'out"\\\n.' + (tool.name === 'export_pdf' ? 'pdf' : 'indd')),
    imagePath: f.image, dataSourcePath: f.csv,
    folderPath: path.join(f.root, `output-${tool.name}`),
    outputFolder: path.join(f.root, `output-${tool.name}`),
    colorValues: [0, 0, 0, 100], data: [[attack, 42, true]],
    rows: 3, columns: 3, headerRows: 1, footerRows: 0,
    startIndex: 0, endIndex: 1, pageRange: '1-2', recordRange: '1-2',
    confirmDestructive: true, code: '"custom";',
  };
  for (const [key, schema] of Object.entries(tool.inputSchema.properties)) {
    if (key in special) result[key] = special[key];
    else if (schema.enum) result[key] = schema.enum[0];
    else if (schema.type === 'boolean') result[key] = schema.default ?? true;
    else if (schema.type === 'number' || schema.type === 'integer') result[key] = schema.default ?? 1;
    else if (schema.type === 'string') result[key] = malicious ? attack : 'Example';
  }
  return result;
}

function walk(node, visit) {
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => { if (child?.type) walk(child, visit); });
    else if (value?.type) walk(value, visit);
  }
}

test('serializer preserves quotes, slash, CR/LF and Unicode separators as data', () => {
  const expression = jsxString(attack);
  parse(expression, { ecmaVersion: 3 });
  assert.equal(vm.runInNewContext(expression), attack);
});

test('Adobe path encoding preserves literal URI-looking filename components', () => {
  const nativePath = '/approved/%2e%2e/%2f%25 # \u00e9.png';
  assert.equal(decodeURIComponent(adobePath(nativePath)), nativePath);
  assert.ok(adobePath(nativePath).includes('%252e%252e'));
});

test('all production tool handlers generate ES3 and keep hostile strings out of executable syntax', async t => {
  const f = fixture(t);
  for (const tool of f.server.tools) {
    if (['get_application_info', 'execute_indesign_code', ...dataMergeTools.map(t => t.name)].includes(tool.name)) continue;
    f.scripts.length = 0;
    const result = await f.server.handleTool(tool.name, argsFor(tool, f, true));
    assert.notEqual(result.isError, true, `${tool.name}: ${JSON.stringify(result)}`);
    assert.ok(f.scripts.length, `${tool.name}: no dispatch`);
    const script = f.scripts.at(-1).script;
    let ast;
    try { ast = parse(script, { ecmaVersion: 3 }); }
    catch (error) { assert.fail(`${tool.name}: ${error.message}\n${script}`); }
    walk(ast, node => {
      assert.ok(!(node.type === 'Identifier' && node.name === '__INJECTED__'), `${tool.name}: executable payload`);
    });
  }
});

test('alternate boolean branches also produce ES3', async t => {
  const f = fixture(t);
  for (const tool of f.server.tools) {
    if (['get_application_info', 'execute_indesign_code', ...dataMergeTools.map(t => t.name)].includes(tool.name)) continue;
    const full = argsFor(tool, f);
    for (const [key, schema] of Object.entries(tool.inputSchema.properties)) {
      if (schema.type === 'boolean' && key !== 'confirmDestructive') full[key] = !full[key];
    }
    f.scripts.length = 0;
    const result = await f.server.handleTool(tool.name, full);
    assert.notEqual(result.isError, true, `${tool.name}: ${JSON.stringify(result)}`);
    parse(f.scripts.at(-1).script, { ecmaVersion: 3 });
  }
});

test('every argument type/enum rejects malicious confusion before bridge dispatch', async t => {
  const f = fixture(t);
  for (const tool of f.server.tools) {
    if (tool.name === 'execute_indesign_code') continue;
    for (const [key, schema] of Object.entries(tool.inputSchema.properties)) {
      const badValues = schema.enum ? [attack, 'invalid-enum'] :
        ['number', 'integer'].includes(schema.type) ? ['0; __INJECTED__()', null, Infinity, NaN, {}, [], ...(schema.type === 'integer' ? [-1, 0.5] : [])] :
        schema.type === 'boolean' ? ['true', 1, null] :
        schema.type === 'string' ? [4, {}, []] :
        schema.type === 'array' ? [{}, '[]'] : [];
      for (const value of badValues) {
        f.scripts.length = 0;
        const result = await f.server.handleTool(tool.name, { ...argsFor(tool, f), [key]: value });
        assert.equal(result.isError, true, `${tool.name}.${key}: accepted ${String(value)}`);
        assert.equal(f.scripts.length, 0, `${tool.name}.${key}: dispatched rejected input`);
      }
    }
    f.scripts.length = 0;
    const result = await f.server.handleTool(tool.name, { ...argsFor(tool, f), unexpected: 'value' });
    assert.equal(result.isError, true);
    assert.equal(f.scripts.length, 0);
  }
});

test('destructive policy is synchronous, strict and not model-authorized human approval', async t => {
  for (const policy of [undefined, '0', 'true', '1']) {
    const f = fixture(t, { env: { INDESIGN_ALLOW_DESTRUCTIVE: policy } });
    for (const tool of f.server.tools.filter(tool => destructiveTools.has(tool.name))) {
      for (const acknowledgement of [undefined, false, 'true', true]) {
        if (policy === '1' && acknowledgement === true) continue;
        f.scripts.length = 0;
        const args = { ...argsFor(tool, f), confirmDestructive: acknowledgement };
        const result = await f.server.handleTool(tool.name, args);
        assert.equal(result.isError, true, `${tool.name}: policy bypass`);
        assert.equal(f.scripts.length, 0, `${tool.name}: dispatched without authorization`);
      }
    }
  }
});

test('arbitrary code requires exactly 1 and is guarded even when invoked directly', async t => {
  for (const value of [undefined, '0', 'true', 'false', 'yes']) {
    const f = fixture(t, { env: { INDESIGN_ALLOW_ARBITRARY_CODE: value } });
    assert.equal((await f.server.handleTool('execute_indesign_code', { code: '__INJECTED__();' })).isError, true);
    assert.equal(f.scripts.length, 0);
    await assert.rejects(f.server.executeInDesignCode('"code";'), /disabled/);
  }
  const f = fixture(t, { env: { INDESIGN_ALLOW_ARBITRARY_CODE: '1' } });
  assert.equal((await f.server.handleTool('execute_indesign_code', { code: '"custom";' })).isError, false);
  assert.equal(f.scripts.at(-1).script, '"custom";');
});

test('path policy denies default access, siblings, symlink leaves and parent escapes', t => {
  const f = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'indesign-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'secret'), 'fixture');
  const policy = f.server.files;
  assert.equal(policy.validate(f.input, { existing: true }), f.input);
  assert.equal(policy.validate(path.join(f.root, 'new.indd')), path.join(f.root, 'new.indd'));
  assert.throws(() => new FilePolicy({}).validate(f.input), /outside approved/);
  assert.throws(() => policy.validate('../relative'), /absolute/);
  assert.throws(() => policy.validate(path.join(outside, 'secret')), /outside approved/);
  assert.throws(() => policy.validate(path.join(f.root, 'missing-parent', 'new')), /ENOENT/);
  fs.symlinkSync(outside, path.join(f.root, 'escape'));
  assert.throws(() => policy.validate(path.join(f.root, 'escape', 'secret')), /outside approved/);
  assert.throws(() => policy.validate(path.join(f.root, 'escape', 'new')), /outside approved/);
  fs.symlinkSync(path.join(outside, 'secret'), path.join(f.root, 'leaf'));
  assert.throws(() => policy.validate(path.join(f.root, 'leaf')), /Symlink/);
  fs.symlinkSync(path.join(outside, 'missing'), path.join(f.root, 'dangling'));
  assert.throws(() => policy.validate(path.join(f.root, 'dangling')), /Symlink/);
  assert.throws(() => new FilePolicy({ INDESIGN_ALLOWED_DIRS: JSON.stringify([os.homedir()]) }), /dedicated/);
});

test('read and write path rejection happens before any bridge call', async t => {
  const f = fixture(t);
  for (const [name, field] of [['open_document', 'filePath'], ['save_document', 'filePath'], ['place_image', 'imagePath'], ['export_pdf', 'filePath'], ['export_epub', 'filePath'], ['export_images', 'folderPath'], ['package_document', 'folderPath']]) {
    const tool = f.server.tools.find(tool => tool.name === name);
    const result = await f.server.handleTool(name, { ...argsFor(tool, f), [field]: '/etc/passwd' });
    assert.equal(result.isError, true, name);
    assert.equal(f.scripts.length, 0, name);
  }
});

test('output folders cannot overwrite existing content and merge image sources stay in roots', async t => {
  const f = fixture(t);
  for (const name of ['export_images', 'package_document']) {
    const tool = f.server.tools.find(tool => tool.name === name);
    const args = argsFor(tool, f);
    const dir = args.folderPath ?? args.outputFolder;
    fs.mkdirSync(dir);
    const result = await f.server.handleTool(name, args);
    assert.equal(result.isError, true);
    assert.equal(f.scripts.length, 0);
  }
  fs.writeFileSync(f.csv, '@image,name\n/etc/passwd,Example\n');
  const result = await f.server.handleTool('validate_data_merge_csv', { filePath: f.csv });
  assert.equal(result.isError, true);
  assert.equal(f.scripts.length, 0);
});

test('CSV image references reject alias-prone/URI spellings and reach Adobe path guards', async t => {
  const f = fixture(t);
  for (const reference of ['../outside.png', '~/secret.png', path.join(f.root, '%2e%2e', 'secret.png')]) {
    fs.writeFileSync(f.csv, `@image,name\n${reference},Example\n`);
    f.scripts.length = 0;
    const result = await f.server.handleTool('validate_data_merge_csv', { filePath: f.csv });
    assert.equal(result.isError, true);
    assert.equal(f.scripts.length, 0);
  }
  fs.writeFileSync(f.csv, `@image,name\n${f.image},Example\n`);
  let approved;
  f.bridge.execute = async (script, expected, paths) => {
    if (script !== '"";') approved = paths;
    return { text: 'ok', document: null };
  };
  assert.notEqual((await f.server.handleTool('validate_data_merge_csv', { filePath: f.csv })).isError, true);
  assert.ok(approved.some(entry => entry.path === f.image && entry.directory === false));
});

test('active document path and unsaved ownership are checked before mutation', async t => {
  const f = fixture(t);
  for (const document of [{ id: 1, path: '/etc/passwd', links: [] }, { id: 2, path: '', links: [] }]) {
    let calls = 0;
    f.bridge.execute = async () => { calls++; return { text: '', document }; };
    const result = await f.server.handleTool('save_document', { confirmDestructive: true });
    assert.equal(result.isError, true);
    assert.equal(calls, 1, 'Only read-only document inspection may dispatch');
  }
  f.server.unsavedDocuments.add(2);
  const result = await f.server.handleTool('save_document', { confirmDestructive: true });
  assert.equal(result.isError, true, 'New-document save must require explicit approved path');
});

test('requests serialize and pass an atomic document identity guard to execution', async t => {
  const f = fixture(t);
  let active = 0, maximum = 0;
  const guards = [];
  f.bridge.execute = async (script, expected) => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    if (script !== '"";') guards.push(expected);
    return { text: 'ok', document: { id: 9, path: f.input, links: [] } };
  };
  await Promise.all([f.server.handleTool('get_document_info'), f.server.handleTool('list_layers')]);
  assert.equal(maximum, 1);
  assert.deepEqual(guards.map(guard => guard.id), [9, 9]);
});

test('PDF export resolves installed preset names, uses supported properties and restores global preferences', async t => {
  const f = fixture(t);
  const response = await f.server.handleTool('export_pdf', {
    filePath: path.join(f.root, 'out.pdf'), confirmDestructive: true,
    pageRange: '1-2', colorProfile: 'Profile "safe"\\name', jpegQuality: 'Maximum',
  });
  assert.notEqual(response.isError, true);
  const script = f.scripts.at(-1).script;
  for (const fail of [false, true]) {
    const preferences = { pageRange: '7', viewPDF: true };
    const names = [];
    let removed = false;
    let exported = false;
    const supported = new Set(['useDocumentBleedWithPDF', 'bleedTop', 'bleedBottom', 'bleedInside',
      'bleedOutside', 'includeSlugWithPDF', 'exportReaderSpreads', 'exportAsSinglePages',
      'colorBitmapQuality', 'grayscaleBitmapQuality', 'pdfDestinationProfile']);
    const temporary = new Proxy({ isValid: true, remove() { removed = true; } }, {
      set(target, property, value) {
        assert.ok(supported.has(property), `Unsupported PDF preset property: ${property}`);
        target[property] = value;
        return true;
      },
    });
    const doc = { exportFile(format, file, dialog, preset) {
      exported = true;
      assert.equal(preferences.pageRange, '1-2');
      assert.equal(preferences.viewPDF, false);
      assert.equal(preset, temporary);
      assert.equal(temporary.includeSlugWithPDF, false);
      assert.equal(temporary.colorBitmapQuality, 'maximum');
      assert.equal(temporary.pdfDestinationProfile, 'Profile "safe"\\name');
      if (fail) throw new Error('test export failure');
    } };
    const context = {
      app: { documents: [doc], activeDocument: doc, pdfExportPreferences: preferences,
        pdfExportPresets: { itemByName(name) {
          names.push(name);
          return { isValid: name === '[High Quality Print]', duplicate: () => temporary };
        } } },
      File: value => value, ExportFormat: { PDF_TYPE: 'pdf' },
      CompressionQuality: { MAXIMUM: 'maximum' },
    };
    const result = vm.runInNewContext(script, context);
    assert.ok(exported);
    assert.ok(removed);
    assert.deepEqual(preferences, { pageRange: '7', viewPDF: true });
    assert.deepEqual(names, ['[High Quality Print]']);
    assert.match(result, fail ? /^Error exporting PDF: test export failure/ : /^PDF exported successfully/);
  }
});

test('PDF export never silently substitutes an unrelated missing preset', async t => {
  const f = fixture(t);
  await f.server.handleTool('export_pdf', { filePath: path.join(f.root, 'out.pdf'), confirmDestructive: true });
  const script = f.scripts.at(-1).script;
  let exported = false;
  const doc = { exportFile() { exported = true; } };
  const result = vm.runInNewContext(script, {
    app: { documents: [doc], activeDocument: doc,
      pdfExportPresets: { itemByName: () => ({ isValid: false }) } },
    File: value => value,
  });
  assert.match(result, /Required PDF preset is not installed: High Quality Print/);
  assert.equal(exported, false);
});
