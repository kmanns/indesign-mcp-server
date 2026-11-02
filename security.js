import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Ajv from 'ajv';

export function jsxString(value) {
  return JSON.stringify(String(value))
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function jsxLiteral(value) {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function adobePath(value) {
  return value.split('/').map(component => encodeURIComponent(component)).join('/');
}

export const destructiveTools = new Set([
  'save_document', 'close_document', 'delete_page', 'edit_text_frame',
  'insert_markdown_text', 'fix_typography_in_selection', 'clean_imported_text',
  'find_replace_text', 'populate_table', 'modify_paragraph_style',
  'modify_character_style', 'modify_object_style', 'export_pdf',
  'export_images', 'export_epub', 'package_document',
  'create_data_merge_csv', 'select_data_merge_source', 'bind_data_merge_fields', 'export_data_merge_pdf',
]);

const indices = /^(pageIndex|frameIndex|objectIndex|tableIndex|startIndex|endIndex)$/;
const counts = /^(pages|rows|columns|maxObjects|headerRows|footerRows|maxLength)$/;
const positive = /^(width|height|fontSize|leading|resolution)$/;
const nonnegative = /^(bleed|slug|marginTop|marginBottom|marginLeft|marginRight|spaceBefore|spaceAfter|strokeWidth|cornerRadius)$/;

export function secureSchema(tool) {
  const schema = structuredClone(tool.inputSchema);
  schema.additionalProperties = false;
  for (const [key, property] of Object.entries(schema.properties)) {
    if (property.type === 'number') {
      property.minimum = -100000;
      property.maximum = 100000;
      if (indices.test(key) || counts.test(key)) {
        property.type = 'integer';
        property.minimum = 0;
        property.maximum = key === 'maxLength' ? 1000000 : 10000;
      }
      if (['pages', 'rows', 'columns', 'maxObjects'].includes(key)) property.minimum = 1;
      if (positive.test(key)) property.exclusiveMinimum = 0;
      if (nonnegative.test(key)) property.minimum = 0;
      if (key === 'transparency') { property.minimum = 0; property.maximum = 100; }
      if (key === 'resolution') property.maximum = 1200;
    }
    if (property.type === 'string') property.maxLength = ['content', 'markdownText', 'code'].includes(key) ? 1000000 : 4096;
  }
  if (tool.name === 'create_document') schema.properties.preset.enum = ['A3', 'A4', 'A5', 'Letter', 'Legal', 'Custom'];
  if (tool.name === 'create_layer') schema.properties.color.enum = ['LIGHT_BLUE', 'RED', 'GREEN', 'BLUE', 'YELLOW', 'MAGENTA', 'CYAN', 'GRAY', 'BLACK', 'ORANGE', 'DARK_GREEN', 'TEAL', 'TAN', 'BROWN', 'VIOLET', 'GOLD', 'DARK_BLUE', 'PINK', 'LAVENDER', 'BRICK_RED', 'OLIVE_GREEN', 'PEACH', 'BURGUNDY', 'GRASS_GREEN', 'OCHRE', 'PURPLE', 'LIGHT_GRAY', 'CHARCOAL'];
  if (tool.name === 'export_images') schema.properties.format.enum = ['PNG', 'JPEG'];
  if (tool.name === 'export_epub') schema.properties.imageFormat.enum = ['PNG', 'JPEG'];
  if (tool.name === 'zoom_to_page') schema.properties.fitOption.enum = ['FIT_PAGE', 'FIT_SPREAD', 'ACTUAL_SIZE'];
  if (tool.name === 'find_replace_text') schema.properties.scope.enum = ['document', 'story', 'selection'];
  if (tool.name === 'preflight_document') schema.properties.scope.enum = ['document'];
  if (tool.name === 'create_color_swatch') {
    Object.assign(schema.properties.colorValues, {
      minItems: 3, maxItems: 4, items: { type: 'number', minimum: -128, maximum: 255 },
    });
  }
  if (tool.name === 'populate_table') {
    Object.assign(schema.properties.data, {
      minItems: 1, maxItems: 10000,
      items: {
        type: 'array', minItems: 1, maxItems: 1000,
        items: { type: ['string', 'number', 'boolean'], maxLength: 100000 },
      },
    });
  }
  if (destructiveTools.has(tool.name)) {
    schema.properties.confirmDestructive = {
      type: 'boolean', default: false,
      description: 'Request acknowledgement, NOT human approval. Also requires operator policy INDESIGN_ALLOW_DESTRUCTIVE=1.',
    };
  }
  return schema;
}

export function compileValidators(tools) {
  const ajv = new Ajv({ allErrors: true, strict: false, strictNumbers: true, ownProperties: true, coerceTypes: false, useDefaults: false });
  return new Map(tools.map(tool => [tool.name, ajv.compile(tool.inputSchema)]));
}

function inside(candidate, root) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

export class FilePolicy {
  constructor(env = process.env) {
    const roots = env.INDESIGN_ALLOWED_DIRS ? JSON.parse(env.INDESIGN_ALLOWED_DIRS) : [];
    if (!Array.isArray(roots)) throw new Error('INDESIGN_ALLOWED_DIRS must be a JSON array of absolute project directories');
    this.roots = roots.map(root => {
      if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Allowed roots must be absolute');
      const canonical = fs.realpathSync(root);
      if (!fs.statSync(canonical).isDirectory()) throw new Error('Allowed roots must be directories');
      if ([path.parse(canonical).root, os.homedir(), '/Users', '/Users/Shared', '/Applications', '/tmp', '/private/tmp'].includes(canonical)) {
        throw new Error('Choose a dedicated project directory, not a broad system or home root');
      }
      return canonical;
    });
  }

  validate(value, { existing = false, directory = false } = {}) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
      throw new Error('File paths must be absolute strings without NUL');
    }
    const absolute = path.resolve(value);
    let canonical;
    try {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error('Symlink leaf paths are not permitted');
      canonical = fs.realpathSync(absolute);
      if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error('Unexpected file type');
    } catch (error) {
      if (error.code !== 'ENOENT' || existing) throw error;
      // Only a new leaf is allowed; its parent must already exist.
      canonical = path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
    }
    if (!this.roots.some(root => inside(canonical, root))) throw new Error('Access denied: outside approved project directories');
    return canonical;
  }

}

export function validateSemantics(name, args) {
  for (const field of ['pageRange', 'recordRange']) {
    if (args[field] !== undefined && !/^(all|[1-9]\d*(?:-[1-9]\d*)?)$/.test(args[field])) throw new Error(`Invalid ${field}`);
    if (args[field]?.includes('-')) {
      const [start, end] = args[field].split('-').map(Number);
      if (end < start || end > 10000) throw new Error(`Invalid ${field} bounds`);
    }
  }
  if (name === 'create_document' && args.preset === 'Custom' && (!args.width || !args.height)) throw new Error('Custom documents require width and height');
  if (name === 'add_page' && args.position && args.position !== 'end' && args.pageIndex === undefined) throw new Error('pageIndex required for relative insertion');
  if (['insert_markdown_text', 'fix_typography_in_selection', 'find_typography_issues', 'clean_imported_text', 'analyze_text_problems'].includes(name) && !args.useSelectedFrame && args.frameIndex === undefined) throw new Error('Specify frameIndex or useSelectedFrame');
  if (name === 'create_table' && ((args.headerRows ?? 1) + (args.footerRows ?? 0) > args.rows || args.rows * args.columns > 100000)) throw new Error('Invalid table size/header/footer counts');
  if (args.startIndex !== undefined || args.endIndex !== undefined) {
    if (args.startIndex === undefined || args.endIndex === undefined || args.endIndex < args.startIndex) throw new Error('Provide an ordered startIndex/endIndex pair');
  }
  if (name === 'create_color_swatch') {
    const model = args.colorModel ?? 'CMYK';
    const ranges = model === 'CMYK' ? [[0, 100], [0, 100], [0, 100], [0, 100]] :
      model === 'RGB' ? [[0, 255], [0, 255], [0, 255]] : [[0, 100], [-128, 127], [-128, 127]];
    if (args.colorValues.length !== ranges.length || args.colorValues.some((value, i) => value < ranges[i][0] || value > ranges[i][1])) throw new Error('Invalid color components');
  }
}
