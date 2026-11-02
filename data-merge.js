import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { adobePath, jsxLiteral, jsxString } from './security.js';

const integer = { type: 'integer', minimum: 1, maximum: 2147483647 };
const string = { type: 'string', minLength: 1, maxLength: 4096 };
const documentProperties = { documentId: integer, documentPath: string };
const sourceProperties = { ...documentProperties, dataSourcePath: string };
const headers = { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true,
  items: { type: 'string', pattern: '^@?[A-Za-z][A-Za-z0-9_]{0,63}$' } };
const tool = (name, description, properties, required) => ({
  name, description, inputSchema: { type: 'object', additionalProperties: false, properties, required },
});

export const dataMergeTools = [
  tool('inspect_data_merge', 'Inspect genuine native fields, bindings and page-item IDs of the active approved document; literal <<text>> is not a binding.', {}, []),
  tool('validate_data_merge_csv', 'Validate UTF-8 CSV headers, records and absolute approved image paths. Does not select a source or modify a document.', { filePath: string }, ['filePath']),
  tool('create_data_merge_csv', 'Create a NEW UTF-8 CSV from exact headers and string row arrays; no overwrite. Image headers start @; image cells must be approved absolute native paths.', {
    filePath: string, headers, records: { type: 'array', minItems: 1, maxItems: 1000,
      items: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string', maxLength: 4000 } } },
  }, ['filePath', 'headers', 'records']),
  tool('select_data_merge_source', 'Select or update validated CSV on the exact SAVED active document. Existing native fields must match exactly; no removal/retyping of bindings.', {
    ...sourceProperties, mode: { type: 'string', enum: ['select', 'update'] },
  }, [...Object.keys(sourceProperties), 'mode']),
  tool('bind_data_merge_fields', 'Insert genuine native text/image placeholders on explicit frame IDs. Prevalidates the entire batch; repeats of identical bindings are no-ops. Text allows empty frames or an exact whole-frame <<Field>> marker only; no arbitrary replacement or threaded stories.', {
    ...sourceProperties, mappings: { type: 'array', minItems: 1, maxItems: 100,
      items: { type: 'object', additionalProperties: false, required: ['frameId', 'fieldName', 'type'],
        properties: { frameId: integer, fieldName: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,63}$' },
          type: { type: 'string', enum: ['text', 'image'] } } } },
  }, [...Object.keys(sourceProperties), 'mappings']),
  tool('export_data_merge_pdf', 'Native DataMerge.exportFile for an explicit contiguous range of at most 10 records and 100 output pages. New PDF and overset-report paths only. Does not create/close documents or change image fitting.', {
    ...sourceProperties, recordStart: { type: 'integer', minimum: 1, maximum: 1000 },
    recordEnd: { type: 'integer', minimum: 1, maximum: 1000 },
    filePath: string, oversetReportPath: string,
  }, [...Object.keys(sourceProperties), 'recordStart', 'recordEnd', 'filePath', 'oversetReportPath']),
];

const sourceLabel = 'indesign-mcp:validated-data-source:v1';

export function validateMergeRows(header, rows, files) {
  if (!Array.isArray(header) || !header.length || header.length > 64 ||
      header.some(h => typeof h !== 'string' || !/^@?[A-Za-z][A-Za-z0-9_]{0,63}$/.test(h))) {
    throw new Error('CSV headers require exact ASCII field names, optionally prefixed @ for images; QR fields are unsupported');
  }
  const names = header.map(h => h.replace(/^@/, ''));
  if (new Set(names.map(n => n.toLowerCase())).size !== names.length) throw new Error('Duplicate/ambiguous CSV field names');
  if (!rows.length || rows.length > 1000) throw new Error('CSV requires 1..1000 records');
  const images = [];
  for (const row of rows) {
    if (row.length !== header.length) throw new Error('CSV record column count must match exact headers');
    row.forEach((value, i) => {
      if (typeof value !== 'string' || value.length > 4000 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('CSV cells must be bounded single-line strings without control characters');
      if (/^[=+\-@]/.test(value)) throw new Error('Spreadsheet formula-like CSV cells are unsupported');
      if (header[i][0] === '@') {
        if (!value || !path.isAbsolute(value) || /[%~]/.test(value) || path.normalize(value) !== value) throw new Error('Image cells require nonempty normalized absolute native paths without URI escapes or tilde');
        const image = files.validate(value, { existing: true });
        if (!/\.(png|jpe?g|tiff?)$/i.test(image)) throw new Error('Data Merge supports PNG, JPEG and TIFF image sources only');
        images.push(image);
      }
    });
  }
  return { headers: header, records: rows.length, fields: header.map(h => ({ name: h.replace(/^@/, ''), type: h[0] === '@' ? 'image' : 'text' })), images: [...new Set(images)] };
}

export function readMergeCsv(value, files) {
  const filePath = files.validate(value, { existing: true });
  if (/[\u0000-\u001f\u007f]/.test(filePath)) throw new Error('CSV source paths cannot contain control characters');
  if (!/\.csv$/i.test(filePath)) throw new Error('Source requires a .csv path');
  if (fs.statSync(filePath).size > 10000000) throw new Error('CSV exceeds 10 MB limit');
  const bytes = fs.readFileSync(filePath);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const [header, ...rows] = parse(text, { bom: true, skip_empty_lines: true });
  const info = validateMergeRows(header, rows, files);
  return { ...info, filePath, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

function newOutput(server, value, extension) {
  const output = server.files.validate(value);
  if (path.extname(output).toLowerCase() !== extension) throw new Error(`Output requires ${extension}`);
  if (fs.existsSync(output)) throw new Error('Data Merge outputs must be new paths; overwrite is not supported');
  server.approvedPaths.push({ path: output, directory: false }, { path: path.dirname(output), directory: true });
  return output;
}

// ExtendScript has no guaranteed JSON global.
const jsonWriter = `
  function dmJSON(v) {
    if (v === null) return "null";
    if (typeof v === "string") return '"' + v.replace(/["\\\\\\u0000-\\u001f]/g, function(c) {
      return "\\\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4);
    }) + '"';
    if (typeof v !== "object") return String(v);
    var a = [], k;
    if (v instanceof Array) { for (k = 0; k < v.length; k++) a.push(dmJSON(v[k])); return "[" + a.join(",") + "]"; }
    for (k in v) if (v.hasOwnProperty(k)) a.push(dmJSON(k) + ":" + dmJSON(v[k]));
    return "{" + a.join(",") + "}";
  }
`;

const nativeHelpers = `
  var d = app.activeDocument, dm = d.dataMergeProperties;
  function dmType(field) {
    if (field.fieldType === SourceFieldType.TEXT_FIELD) return "text";
    if (field.fieldType === SourceFieldType.IMAGE_FIELD) return "image";
    return "unsupported";
  }
  function dmFields() {
    var out = [], i;
    for (i = 0; i < dm.dataMergeFields.length; i++) {
      var f = dm.dataMergeFields[i]; out.push({name:f.fieldName, type:dmType(f)});
    }
    return out;
  }
  function dmCheckFields(wanted, allowEmpty) {
    var fields = dmFields(), i;
    if (!fields.length && allowEmpty) return;
    if (fields.length !== wanted.length) throw new Error("Native fields differ from CSV; existing bindings will not be removed");
    for (i = 0; i < fields.length; i++) {
      if (fields[i].name !== wanted[i].name || fields[i].type !== wanted[i].type)
        throw new Error("Native field order/name/type differs from CSV; refusing destructive source change");
    }
  }
`;

export function dataMergeScript(name, args, source) {
  const fields = jsxLiteral(source?.fields ?? []);
  const token = source ? `${source.filePath}\n${source.sha256}` : '';
  let action;
  if (name === 'inspect_data_merge') {
    action = `
      var items = [], textBindings = [], imageBindings = [], i, j;
      for (i = 0; i < d.allPageItems.length; i++) {
        var item = d.allPageItems[i], kind = item.constructor.name;
        if (kind === "TextFrame" || kind === "Rectangle" || kind === "Oval" || kind === "Polygon")
          items.push({id:item.id, type:kind, page:item.parentPage ? item.parentPage.name : null,
            label:item.label, content:kind === "TextFrame" ? String(item.contents).slice(0,4000) : null});
      }
      for (i = 0; i < d.dataMergeTextPlaceholders.length; i++) {
        var t = d.dataMergeTextPlaceholders[i], ids = [];
        for (j = 0; j < t.parentStory.textContainers.length; j++) ids.push(t.parentStory.textContainers[j].id);
        textBindings.push({fieldName:t.field.fieldName, storyId:t.parentStory.id, offset:t.storyOffset.index, frameIds:ids});
      }
      for (i = 0; i < d.dataMergeImagePlaceholders.length; i++) {
        var p = d.dataMergeImagePlaceholders[i];
        imageBindings.push({fieldName:p.field.fieldName, frameId:p.placeholderPageItem.id});
      }
      return dmJSON({documentId:d.id, documentPath:d.saved ? d.fullName.fsName : "", fields:dmFields(),
        sourceReceipt:d.extractLabel(${jsxString(sourceLabel)}), items:items,
        textBindings:textBindings, imageBindings:imageBindings});`;
  } else if (name === 'select_data_merge_source') {
    action = `
      dmCheckFields(${fields}, true);
      if (${jsxString(args.mode)} === "update" && d.extractLabel(${jsxString(sourceLabel)}).split("\\n")[0] !== ${jsxString(source.filePath)})
        throw new Error("Update requires a previously selected identical source path");
      dm.selectDataSource(File(${jsxString(adobePath(source.filePath))}));
      ${args.mode === 'update' ? 'dm.updateDataSource();' : ''}
      dmCheckFields(${fields}, false);
      d.insertLabel(${jsxString(sourceLabel)}, ${jsxString(token)});
      return dmJSON({fields:dmFields(), records:${source.records}, source:${jsxString(source.filePath)}});`;
  } else if (name === 'bind_data_merge_fields') {
    action = `
      dmCheckFields(${fields}, false);
      if (d.extractLabel(${jsxString(sourceLabel)}) !== ${jsxString(token)}) throw new Error("CSV changed or source not selected; select/update it first");
      var mappings = ${jsxLiteral(args.mappings)}, plans = [], i, j, k;
      for (i = 0; i < mappings.length; i++) {
        var m = mappings[i], frame = null, field = null, existing = null;
        for (j = 0; j < d.allPageItems.length; j++) if (d.allPageItems[j].id === m.frameId) frame = d.allPageItems[j];
        if (!frame || !frame.parentPage || frame.locked || frame.itemLayer.locked) throw new Error("Frame missing, locked or not on a page");
        for (j = 0; j < dm.dataMergeFields.length; j++) if (dm.dataMergeFields[j].fieldName === m.fieldName) field = dm.dataMergeFields[j];
        if (!field || dmType(field) !== m.type) throw new Error("Field missing or wrong type");
        if (m.type === "text") {
          if (frame.constructor.name !== "TextFrame" || frame.parentStory.textContainers.length !== 1)
            throw new Error("Text requires one unthreaded text frame");
          for (j = 0; j < d.dataMergeTextPlaceholders.length; j++) {
            var tp = d.dataMergeTextPlaceholders[j];
            if (tp.parentStory.id === frame.parentStory.id) {
              if (existing) throw new Error("Multiple native bindings in frame; unsupported");
              existing = tp;
            }
          }
          if (existing && (existing.field.fieldName !== m.fieldName || existing.storyOffset.index !== 0))
            throw new Error("Existing text binding/content conflicts; no replacement performed");
          if (!existing && frame.contents !== "" && frame.contents !== "<<" + m.fieldName + ">>")
            throw new Error("Text frame must be empty or contain only its exact <<Field>> marker");
        } else {
          if (["Rectangle","Oval","Polygon"].join("|").indexOf(frame.constructor.name) < 0)
            throw new Error("Image requires Rectangle, Oval or Polygon");
          for (j = 0; j < d.dataMergeImagePlaceholders.length; j++) {
            var ip = d.dataMergeImagePlaceholders[j];
            if (ip.placeholderPageItem.id === frame.id) {
              if (existing) throw new Error("Multiple native image bindings in frame; unsupported");
              existing = ip;
            }
          }
          if (existing && existing.field.fieldName !== m.fieldName) throw new Error("Conflicting image binding; no replacement performed");
          if (!existing && frame.allGraphics.length) throw new Error("Image frame contains artwork; refusing replacement");
        }
        plans.push({frame:frame, field:field, type:m.type, skip:!!existing,
          original:m.type === "text" ? String(frame.contents) : ""});
      }
      var inserted = 0;
      try {
        for (i = 0; i < plans.length; i++) {
          var plan = plans[i]; if (plan.skip) continue;
          if (plan.type === "text") {
            var story = plan.frame.parentStory, oldLength = story.characters.length;
            d.dataMergeTextPlaceholders.add(story, story.insertionPoints[0], plan.field);
            if (oldLength) {
              var added = story.characters.length - oldLength;
              if (added <= 0) throw new Error("Native text placeholder was not inserted");
              var tail = story.characters.itemByRange(added, added + oldLength - 1);
              var tailContents = tail.contents;
              if (tailContents instanceof Array) tailContents = tailContents.join("");
              if (tailContents !== plan.original) throw new Error("Native marker range changed; refusing deletion");
              tail.remove();
            }
          } else d.dataMergeImagePlaceholders.add(plan.frame, plan.field);
          inserted++;
        }
      } catch (bindingError) {
        throw new Error("Native mapping may be partial (" + inserted + " completed frames); inspect bindings before retry: " + bindingError.message);
      }
      return dmJSON({inserted:inserted, unchanged:plans.length-inserted});`;
  } else {
    action = `
      dmCheckFields(${fields}, false);
      if (d.extractLabel(${jsxString(sourceLabel)}) !== ${jsxString(token)}) throw new Error("CSV changed or source not selected; select/update it first");
      if (!d.dataMergeTextPlaceholders.length && !d.dataMergeImagePlaceholders.length) throw new Error("No genuine native placeholders");
      if (d.pages.length * ${args.recordEnd - args.recordStart + 1} > 100) throw new Error("Merge exceeds 100 output pages");
      var pdf = File(${jsxString(adobePath(args.filePath))}), report = File(${jsxString(adobePath(args.oversetReportPath))});
      if (pdf.exists || report.exists) throw new Error("Output already exists; no overwrite");
      var preset = app.pdfExportPresets.itemByName("[High Quality Print]");
      if (!preset.isValid) preset = app.pdfExportPresets.itemByName("High Quality Print");
      if (!preset.isValid) throw new Error("High Quality Print preset missing");
      var pref = dm.dataMergePreferences, oldSelection = pref.recordSelection,
          oldRange = pref.recordRange, oldNumber = pref.recordNumber, oldPerPage = pref.recordsPerPage;
      var mergeOptions = d.dataMergeOptions, oldNewDocument = mergeOptions.createNewDocument,
          oldDocumentSize = mergeOptions.documentSize;
      var pdfPref = app.pdfExportPreferences, oldView = pdfPref.viewPDF, oldPages = pdfPref.pageRange, copy;
      try {
        dm.selectDataSource(File(${jsxString(adobePath(source?.filePath ?? ''))}));
        dmCheckFields(${fields}, false);
        ${args.recordStart === args.recordEnd ? `
          pref.recordSelection = RecordSelection.ONE_RECORD; pref.recordNumber = ${args.recordStart};
        ` : `
          pref.recordSelection = RecordSelection.RANGE;
          pref.recordRange = ${jsxString(args.recordStart + '-' + args.recordEnd)};
        `}
        pref.recordsPerPage = RecordsPerPage.SINGLE_RECORD;
        mergeOptions.createNewDocument = false; mergeOptions.documentSize = 100;
        copy = preset.duplicate(); copy.exportReaderSpreads = false; copy.exportAsSinglePages = false;
        pdfPref.viewPDF = false; pdfPref.pageRange = PageRange.ALL_PAGES;
        dm.exportFile(pdf, copy, report);
        if (!pdf.exists || pdf.length === 0) throw new Error("Native merge did not produce PDF");
      } finally {
        try { if (copy && copy.isValid) copy.remove(); }
        finally {
          pref.recordSelection = oldSelection; pref.recordRange = oldRange;
          pref.recordNumber = oldNumber; pref.recordsPerPage = oldPerPage;
          mergeOptions.createNewDocument = oldNewDocument; mergeOptions.documentSize = oldDocumentSize;
          pdfPref.viewPDF = oldView; pdfPref.pageRange = oldPages;
        }
      }
      return dmJSON({filePath:${jsxString(args.filePath)}, records:${args.recordEnd - args.recordStart + 1},
        expectedPages:d.pages.length * ${args.recordEnd - args.recordStart + 1},
        oversetReport:report.exists ? report.fsName : null});`;
  }
  if (name === 'inspect_data_merge') return `(function () { ${jsonWriter} ${nativeHelpers} ${action} }());`;
  return `(function () { ${jsonWriter} ${nativeHelpers}
    var oldInteraction = app.scriptPreferences.userInteractionLevel;
    try { app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT; ${action} }
    finally { app.scriptPreferences.userInteractionLevel = oldInteraction; }
  }());`;
}

export async function runDataMergeTool(server, name, args) {
  let source;
  if (name === 'create_data_merge_csv') {
    const info = validateMergeRows(args.headers, args.records, server.files);
    const output = newOutput(server, args.filePath, '.csv');
    server.approvedPaths.push(...info.images.map(image => ({ path: image, directory: false })));
    await server.bridge.execute('"CSV path preflight";', undefined, server.approvedPaths);
    const csv = '\uFEFF' + [args.headers, ...args.records].map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\r\n') + '\r\n';
    fs.writeFileSync(output, csv, { flag: 'wx', mode: 0o600 });
    return server.formatResponse(JSON.stringify({ filePath: output, ...info }), 'Created Data Merge CSV');
  }
  if (name === 'validate_data_merge_csv' || args.dataSourcePath) {
    source = readMergeCsv(args.dataSourcePath ?? args.filePath, server.files);
    server.approvedPaths.push({ path: source.filePath, directory: false }, ...source.images.map(image => ({ path: image, directory: false })));
    if (name === 'validate_data_merge_csv') {
      await server.bridge.execute('"CSV path preflight";', undefined, server.approvedPaths);
      return server.formatResponse(JSON.stringify(source), 'Validated Data Merge CSV');
    }
  }
  if (args.documentId) {
    const documentPath = server.files.validate(args.documentPath, { existing: true });
    if (!/\.indd$/i.test(documentPath)) throw new Error('Data Merge mutations require a saved .indd document');
    server.requestedDocument = { id: args.documentId, path: documentPath };
  }
  if (name === 'bind_data_merge_fields') {
    if (new Set(args.mappings.map(m => m.frameId)).size !== args.mappings.length) throw new Error('Duplicate frame IDs in mapping batch');
    for (const m of args.mappings) {
      if (!source.fields.some(f => f.name === m.fieldName && f.type === m.type)) throw new Error('Mapping field/type not in CSV');
    }
  }
  if (name === 'export_data_merge_pdf') {
    if (args.recordEnd < args.recordStart || args.recordEnd - args.recordStart >= 10 || args.recordEnd > source.records) throw new Error('Select an ordered, existing record range of at most 10');
    args.filePath = newOutput(server, args.filePath, '.pdf');
    args.oversetReportPath = newOutput(server, args.oversetReportPath, '.txt');
  }
  return server.formatResponse(await server.executeInDesignScript(dataMergeScript(name, args, source)), name);
}
