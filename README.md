# InDesign MCP Server

A comprehensive **Model Context Protocol (MCP) server** for **Adobe InDesign automation** with **51+ professional tools**. This server enables AI assistants like Claude to directly control Adobe InDesign, automating complex publishing workflows, document creation, and professional layout tasks.

## Security and compatibility

This fork hardens the local macOS stdio server for GitHub Copilot and other MCP
clients. It targets InDesign 2026 (21.x) and newer, including InDesign Beta (22.x).
Installed application metadata and automated bridge tests are not a certification
of every InDesign API. Test authoring/export features on disposable documents
before using production files; Beta APIs can change.

- Set `INDESIGN_APP_PATH` to an exact, canonical `.app` path. There is no automatic
  stable/Beta discovery or fallback. Both installations can share
  `com.adobe.InDesign`, so bundle ID alone is insufficient. The selected app must
  already be running. Actual application path and version are checked before
  executing generated code; a mismatch fails closed without running the tool.
- `INDESIGN_ALLOWED_DIRS` is a **JSON array of existing absolute project
  directories**, not a colon-separated string. Default: `[]` (no filesystem
  access). Home, filesystem root, and broad shared roots are rejected.
  Symlink leaves are rejected; parent paths are canonicalized and must stay
  within an approved root. Adobe additionally rejects Finder aliases and checks
  that its native resolved target matches the approved path before file access.
  Literal URI-looking filename components are encoded, not interpreted as paths.
  Output parents must already exist.
- All tool arguments are checked against strict schemas without type coercion,
  including finite numbers, enums, nested table cells and color components.
  Untrusted strings are serialized as ExtendScript literals, not executable
  source. Unknown arguments are errors.
- Destructive operations are blocked by default. An operator must deliberately
  set `INDESIGN_ALLOW_DESTRUCTIVE=1` **and** the call must contain
  `confirmDestructive: true`. That model-supplied argument is only an
  acknowledgement, **not independent human approval**. This includes saving,
  closing, deleting pages, replacing text, editing existing styles/table data,
  exporting, packaging and data merge. Creation/additive layout tools can still
  modify the current document; this is not a read-only server.
- Arbitrary code is hidden and blocked unless the operator sets exactly
  `INDESIGN_ALLOW_ARBITRARY_CODE=1`. Keep it disabled. Enabling it deliberately
  bypasses all generated-tool restrictions.
- Saved active documents and linked assets must be inside approved roots.
  Existing unsaved user documents are refused; unsaved documents created/opened
  by this server are tracked for this process only. New-document saves require
  an explicit approved `.indd` destination. Close-with-save cannot invoke a
  Save As dialog for an unsaved document.
- Image export, packaging and data merge require a **new output directory**;
  they cannot write into an existing directory containing symlinks or old
  outputs. CSV merge image references must be absolute native paths inside
  approved roots, without percent escapes or tilde; aliases are refused.
- Requests are serialized. Temporary scripts/results use private per-request
  directories, with cleanup on both success and failure. Script and transport
  errors are reported as errors. A failed/timed-out transport blocks subsequent
  automation until the server restarts; a timeout cannot roll back edits already
  made in InDesign.

The bridge writes explicit Unix line endings and accepts native CR, CRLF and
UTF-8 BOM framing. An invalid response also blocks subsequent automation: the
requested action may already have completed even though its response was lost.
Inspect document state before reconnecting; never blindly repeat a failed
`create_document`, save or export. Reconnect MCP after updating bridge source so
the running server loads the fix.

PDF export resolves the public preset keys to installed names such as
`[High Quality Print]`; missing presets fail explicitly instead of substituting an
unrelated first preset. Export uses a temporary duplicate with supported Adobe
bleed, slug and image-compression properties, removes it afterward, and restores
the application's page range and auto-open preference even if export fails.
`Print` maps to High Quality Print; `Web` maps to Smallest File Size. Reconnect MCP
after updating `index.js` as well as `bridge.js`.

**Trust boundary:** This is application automation, not an OS sandbox. InDesign,
its fonts/plugins, imported documents/images and the MCP client remain trusted.
InDesign may follow embedded resources or use application caches outside project
roots. A malicious local process with the same account privileges can race
filesystem checks; do not share approved writable directories with untrusted
processes. Only open trusted publishing assets. Packaging may copy licensed fonts:
check licensing before distributing them.

Document text, previews, paths and other tool results are sent to the MCP client
and may enter its model context. Do not approve confidential documents unless
your client's data policy permits this. Treat instructions embedded in documents
or CSV cells as untrusted content, not authority to change policy. Review calls in
Copilot rather than granting blanket approval; OS Automation permission is not
per-operation human approval.

## 🚀 Features

### 📄 **Document Management**
- Create, open, save, and close documents with advanced options
- Support for all standard formats (A4, A5, Letter, Legal, Custom)
- Facing pages, bleeds, slugs, and margin configuration
- Multi-page document handling

### ✍️ **Text & Typography**
- Advanced text frame creation and editing
- Character and paragraph style management
- Find/replace with GREP support
- Professional typography controls (leading, tracking, optical margin alignment)

### 🎨 **Graphics & Layout**
- Image placement with multiple fit options
- Shape creation (rectangles, ellipses with styling)
- Layer management and organization
- Color swatch creation and management (CMYK, RGB, Spot colors)

### 📊 **Tables & Data**
- Table creation and data population
- Support for headers and footers
- CSV data integration capabilities

### 📤 **Export & Production**
- Professional PDF export with presets
- Image export (PNG, JPEG)
- EPUB export for digital publishing
- Package for print production
- Preflight checking

### 🔧 **Automation & Scripting**
- Data merge operations
- Custom ExtendScript execution
- Batch processing capabilities
- Professional publishing workflows

## 📋 Prerequisites

- **Adobe InDesign 2026 or newer**, or an explicitly selected Beta
- **macOS** (required for AppleScript integration)
- **Node.js 22+**
- **MCP-compatible client** (GitHub Copilot or another local stdio client)

## 🛠️ Installation

### 1. Clone the Repository
```bash
git clone https://github.com/kmanns/indesign-mcp-server.git
cd indesign-mcp-server
```

### 2. Install Dependencies
```bash
npm ci --ignore-scripts
npm run check
npm test
```

Use a checkout containing the reviewed hardening changes, not an unchanged
upstream checkout. Dependencies are pinned and locked; lifecycle scripts are not
needed. No GitHub PAT, token setup, push helper, global package install, debug port
or `npx` download is required. `npm audit --omit=dev --ignore-scripts` is a separate
registry check when network policy permits it; an unrun audit is not a clean audit.

### 3. Configure MCP Client

Do this only after reviewing the changes and completing the checks above. This
repository does not register itself or edit your Copilot configuration. Use
absolute paths to the Node executable and this checkout's `index.js`. Create a
dedicated project directory yourself and replace the example root below.

**GitHub Copilot local stdio example** (merge into the appropriate client settings;
do not overwrite existing servers):
```json
{
  "mcpServers": {
    "indesign": {
      "type": "local",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/reviewed/indesign-mcp-server/index.js"],
      "env": {
        "INDESIGN_APP_PATH": "/Applications/Adobe InDesign 2026/Adobe InDesign 2026.app",
        "INDESIGN_ALLOWED_DIRS": "[\"/absolute/path/to/dedicated-project\"]",
        "INDESIGN_ALLOW_DESTRUCTIVE": "0",
        "INDESIGN_ALLOW_ARBITRARY_CODE": "0"
      },
      "tools": ["*"]
    }
  }
}
```

`tools: ["*"]` exposes the normal authoring surface, **not a read-only mode**.
For first setup, use your client's tool allow-list to expose only
`get_application_info` until the selected path/version is confirmed. Then enable
the authoring tools you need. The server validates every enabled tool; a client
allow-list is an additional control, not a substitute for validation.

For Beta, use a separate server entry and set its exact path, for example:

```text
/Applications/Adobe InDesign 2027 (Beta)/Adobe InDesign 2027 (Beta).app
```

Installed names can differ. Do not target stable and Beta interchangeably or run
two server processes against the same application at once. Each process has its
own serialization/unsaved-document state.

### 4. Verify selection, then start the exact application manually

Call `get_application_info` to read the selected installed path/version without
launching InDesign. Start that exact application yourself. On first automation,
macOS may request permission under System Settings > Privacy & Security >
Automation for the client/Node process to control InDesign. Denial is an error,
not a reason to grant Full Disk Access or broaden project roots.

Use a dedicated disposable document under the approved project for the first
authoring smoke test. Never test close/delete/save against an existing user
document. Do not enable the destructive policy merely because a model asks:
review the intended workflow, back up files, and restart the server with the
policy explicitly enabled only when needed.

## 🎯 Quick Start

### Create a Professional Document
```javascript
// Create an A4 document with facing pages
create_document({
  preset: "A4",
  orientation: "Portrait", 
  pages: 4,
  facingPages: true,
  marginTop: 20,
  marginBottom: 20,
  marginLeft: 20,
  marginRight: 20
})
```

### Add Formatted Text
```javascript
// Create a text frame with professional typography
create_text_frame({
  content: "Professional Publishing with InDesign MCP",
  x: 20,
  y: 20,
  width: 170,
  height: 50,
  fontSize: 18,
  fontFamily: "Helvetica Neue",
  fontStyle: "Bold",
  alignment: "LEFT_ALIGN"
})
```

### Create and Apply Styles
```javascript
// Create a character style
create_character_style({
  name: "Emphasis",
  fontFamily: "Helvetica Neue",
  fontStyle: "Italic",
  textColor: "Red"
})

// Requires operator destructive policy and a reviewed call
find_replace_text({
  findText: "important",
  replaceText: "important",
  confirmDestructive: true
})
```

### Export Professional PDF
```javascript
export_pdf({
  filePath: "/absolute/path/to/dedicated-project/output.pdf",
  preset: "HighQualityPrint",
  includeBleed: true,
  confirmDestructive: true
})
```

## 🛠️ Available Tools

### Native Data Merge

The legacy `data_merge` tool has been removed: its `dataMergeSource`/
`exportRecords` calls were not the documented native API. Use these six typed
tools instead; they never enable arbitrary scripting or close/delete tools.
Append only these names to an existing client allow-list, preserving its policy,
project roots and excluded tools, then reconnect:

```json
["inspect_data_merge", "validate_data_merge_csv", "create_data_merge_csv",
 "select_data_merge_source", "bind_data_merge_fields", "export_data_merge_pdf"]
```

| Tool | Required arguments | Behavior |
| --- | --- | --- |
| `inspect_data_merge` | none | Returns active `documentId`, `documentPath`, native field names/types, real text/image bindings, story offsets and page-item IDs. Literal `<<Headline>>` text alone does not prove a native binding. |
| `validate_data_merge_csv` | `filePath` | Checks existing UTF-8 CSV and all image references without selecting it. |
| `create_data_merge_csv` | `filePath`, `headers`, `records`, `confirmDestructive: true` | Writes a **new** BOM-prefixed UTF-8 CSV. Records are arrays of strings in exact header order, not arbitrary object-key order. |
| `select_data_merge_source` | `documentId`, `documentPath`, `dataSourcePath`, `mode: "select"` or `"update"`, `confirmDestructive: true` | Selects a validated source on that exact saved active INDD. Update first pins the supplied path, then calls native `updateDataSource`; it requires that path to have been selected previously. |
| `bind_data_merge_fields` | the same three document/source arguments, `mappings`, `confirmDestructive: true` | Maps native field names to explicit frame IDs; repeated identical mappings are no-ops. |
| `export_data_merge_pdf` | the same three document/source arguments, `recordStart`, `recordEnd`, `filePath`, `oversetReportPath`, `confirmDestructive: true` | Exports one merged PDF using High Quality Print and an optional native overset report, both to new paths. Records are one-based, contiguous and explicit. |

All mutations require the operator policy `INDESIGN_ALLOW_DESTRUCTIVE=1` **and**
the strict per-call acknowledgement; the argument is not independent human
approval. Every document mutation pins both the ID and canonical saved INDD path
before and inside the native call. `documentPath`, the CSV, its images and outputs
must be in approved roots. CSV-only operations still require the exact app to be
running for the read-only Adobe filename/alias preflight.

Start with a backed-up copy in the approved project directory, then inspect its
native fields and frame IDs. Generate/validate a CSV with headers such as
`["Headline", "CTA", "@background"]` and rows containing absolute approved image
paths. Select it; map the discovered IDs explicitly:

```javascript
bind_data_merge_fields({
  documentId: 7,
  documentPath: "/approved/project/template.indd",
  dataSourcePath: "/approved/project/campaigns.csv",
  mappings: [
    {frameId: 271, fieldName: "Headline", type: "text"},
    {frameId: 294, fieldName: "CTA", type: "text"},
    {frameId: 251, fieldName: "background", type: "image"}
  ],
  confirmDestructive: true
})
```

The IDs are illustrative: use only IDs returned by inspection of that document.
Image headers have `@`, but native mapping names do not. Native text insertion
requires an unthreaded frame that is empty or contains **only** its exact
`<<FieldName>>` marker. The tool inserts a real
`dataMergeTextPlaceholders.add(story, insertionPoint, field)` object, verifies the
old marker's unchanged contents before removing it, and retains surrounding
formatting. An image target must be an empty Rectangle, Oval or Polygon;
`dataMergeImagePlaceholders.add(frame, field)` does not replace existing art or
change fitting. Conflicting bindings, multiple bindings in one frame, locked
targets, threaded stories and arbitrary text replacement are explicitly refused.
The entire mapping batch is validated before any insertion. A native runtime
failure can still leave partial insertions: inspect before retrying, rather than
blindly repeating the call.

Save the template with `save_document` after mapping or changing sources. A
same-schema replacement CSV must preserve field names, types **and order**;
source selection never silently removes or retypes existing fields. A persisted
path/hash receipt detects changed data between calls: explicitly select/update
before mapping/export when the CSV changes. Native receipts are not authority
to expand roots. Imported copies that still link to originals outside approved
roots must first have dependencies copied and relinked; do not widen access to
the original workspace for convenience.

CSV limits: 1..64 ASCII headers (`@?[A-Za-z][A-Za-z0-9_]*`, at most 64 name
characters), no case-insensitive duplicate native names, 1..1000 records, 10 MB
source size, 4000 characters per single-line cell. Quoted commas/quotes and
UTF-8 text are supported. Formula-leading `=`, `+`, `-`, `@`, control characters,
QR fields and multiline cells are refused. Image cells cannot be blank or
relative, contain URI escapes/tilde, or target symlinks, aliases or outside-root
files; PNG, JPEG and TIFF are supported.

Proof exports are limited to **10 records and 100 total output pages**,
single-record-per-template-page, no overwrites. The tool suppresses native
dialogs, temporarily prevents document splitting/new-document creation, and
restores preferences/preset afterward; existing image-fitting settings remain
unchanged. Read the returned overset report and inspect the actual PDF; requested
page counts are not independently verified output geometry. A report may be
absent when Adobe produces none. Use a client call timeout longer than the
server's bounded **120-second** native merge wait (for example 150 seconds).
On timeout, inspect files/app state and reconnect; the operation may have
completed. Never retry blindly or overwrite partial outputs.

Verified on **InDesign Beta 22.0.0.96**: native text + image fields, repeat mapping,
source selection/update, saved INDD bindings reopened from a byte-identical disk
copy, and a two-record merged PDF (two A5 pages, different text/images, native
overset report zero). The new API is not yet live-verified on stable InDesign
2026. Native merged INDD production (`mergeRecords`), multi-record grids,
arbitrary inline token replacement, QR fields and FFCPE cloud upload/rendering
are deliberately **not implemented** by these tools.

Official API references:
[DataMerge](https://developer.adobe.com/indesign/uxp/dom/api/d/data-merge/),
[text placeholders](https://developer.adobe.com/indesign/uxp/dom/api/d/data-merge-text-placeholders/),
[image placeholders](https://developer.adobe.com/indesign/uxp/dom/api/d/data-merge-image-placeholders/),
[fields](https://developer.adobe.com/indesign/uxp/dom/api/d/data-merge-field/),
[merge preferences](https://developer.adobe.com/indesign/uxp/dom/api/d/data-merge-preference/),
[merge options](https://developer.adobe.com/indesign/uxp/dom/api/d/data-merge-option/),
[record selection](https://developer.adobe.com/indesign/uxp/dom/api/r/record-selection/),
and [Adobe's Data Merge overview](https://helpx.adobe.com/indesign/desktop/automation-and-scripting/merge-data/data-merging-overview.html).

### **Document Management (5 tools)**
- `get_document_info` - Document information and statistics
- `get_application_info` - Selected installed application identity (no launch)
- `create_document` - Advanced document creation
- `open_document` - Open existing documents
- `save_document` - Save with optional new path
- `close_document` - Close with save options

### **Page Management (4 tools)**
- `add_page` - Add pages with position control
- `delete_page` - Remove pages safely
- `duplicate_page` - Copy pages with content
- `navigate_to_page` - Page navigation

### **Text Management (3 tools)**
- `create_text_frame` - Advanced text frame creation
- `edit_text_frame` - Modify existing frames
- `find_replace_text` - Search and replace with GREP

### **Graphics Management (3 tools)**
- `place_image` - Image placement with fit options
- `create_rectangle` - Rectangle creation with styling
- `create_ellipse` - Ellipse creation with styling

### **Style Management (4 tools)**
- `create_paragraph_style` - Paragraph style creation
- `create_character_style` - Character style creation
- `apply_paragraph_style` - Apply styles to text
- `list_styles` - List all available styles

### **Color Management (3 tools)**
- `create_color_swatch` - Create CMYK/RGB/Spot colors
- `list_color_swatches` - List available colors
- `apply_color` - Apply colors to objects

### **Table Management (2 tools)**
- `create_table` - Table creation with headers/footers
- `populate_table` - Fill tables with data

### **Layer Management (3 tools)**
- `create_layer` - Create new layers
- `set_active_layer` - Switch active layer
- `list_layers` - List all layers

### **Export & Production (4 tools)**
- `export_pdf` - Professional PDF export
- `export_images` - Multi-format image export
- `export_epub` - Digital publishing export
- `package_document` - Print production packaging

### **Automation & Utilities (4 tools)**
- `execute_indesign_code` - Custom ExtendScript execution
- `preflight_document` - Quality checking
- `view_document` - Document visualization
- `data_merge` - Automated data integration

## 💡 Use Cases

### **Automated Publishing**
- Generate newsletters, brochures, and reports from data
- Batch process multiple documents
- Consistent styling across document series

### **Data-Driven Documents**
- Mail merge for personalized materials
- Catalog generation from databases
- Financial reports with dynamic content

### **Professional Workflows**
- Template-based document creation
- Brand compliance automation
- Print production preparation

### **Educational Materials**
- Automated textbook layout
- Exercise sheet generation
- Multi-language document variants

## 🔧 Advanced Configuration

### Custom ExtendScript Integration

Disabled by default, including direct calls to the hidden tool. Enabling this
escape hatch grants the model the same scripting access as your local InDesign
account, including filesystem/network/system APIs; project roots cannot sandbox
arbitrary code. It is not required for normal authoring tools.
```javascript
execute_indesign_code({
  code: `
    // Custom InDesign scripting
    var doc = app.activeDocument;
    // Your custom automation logic here
  `
})
```

### Batch Processing Example
```javascript
// Process multiple files
// All paths must be absolute and inside approved project roots.
// Saving/closing/exporting also require the operator destructive policy.
const files = ["/approved/project/doc1.indd", "/approved/project/doc2.indd"];
for (const file of files) {
  await open_document({ filePath: file });
  await export_pdf({ 
    filePath: file.replace('.indd', '.pdf'),
    preset: 'HighQualityPrint',
    confirmDestructive: true
  });
  await close_document({ save: false, confirmDestructive: true });
}
```

## 🐛 Troubleshooting

### Common Issues

**"Selected InDesign is not running" / identity mismatch**
- Check `INDESIGN_APP_PATH` and call `get_application_info`.
- Start the selected stable or Beta application manually; no fallback is used.
- If an update changed the version/path, restart the server and verify again.
- Check macOS Automation permission, not blanket filesystem access.

**"Script execution failed"**
- Keep the intended document active and inside an approved project.
- Existing unsaved user documents are intentionally refused.
- Check the returned error; a transport failure requires inspecting the app and
  restarting the server. Do not blindly retry a partially completed operation.

**"Access denied" / folder already exists**
- Use a narrow existing root in the JSON `INDESIGN_ALLOWED_DIRS` array.
- Output files need existing parents; directory exports require a new leaf.
- Do not replace project roots with symlinks or widen access to the whole home.

**"Blocked ... operator policy"**
- A model boolean is insufficient. Keep the policy disabled unless an operator
  intentionally approves destructive automation in the client configuration.

**"Tool not found"**
- Restart MCP client after configuration changes
- Verify server is running with `node index.js`

### Debug Mode
Local development only. Do not enable the Node inspector in an installed MCP
server: it exposes a code-execution/debugging endpoint.
```bash
node --inspect index.js
```

### Validation and known limitations

`npm test` uses real production handlers, hostile arguments, ES3 parsing,
canonical/symlink path checks, destructive-policy checks, app-target/temporary-file
bridge tests and a real MCP stdio handshake. These tests do not start Adobe apps.
They do not prove all Adobe DOM operations work in a particular installed build.
Live stable/Beta authoring and export require separate disposable-document
verification. Some advanced legacy features (EPUB, preflight, packaging and data
merge in particular) depend on the installed Adobe DOM and may return explicit
errors; do not assume a successful mock/parse check proves live API support.

A bounded live validation on InDesign Beta 22.0.0.96 created a new one-page A5
layout, added seven text frames and RGB swatches/shapes, saved INDD and exported
PDF. The document reported no overset frames, and the actual PDF was checked for
page dimensions, content and appearance. This verifies that workflow in that
build, not every tool, stable InDesign, or insertion of real Data Merge fields.

An optional guarded smoke is available after review and explicit permission:

```bash
INDESIGN_LIVE_SMOKE=1 \
INDESIGN_APP_PATH="/Applications/Adobe InDesign 2026/Adobe InDesign 2026.app" \
npm run test:live
```

It refuses to launch InDesign, creates a private temporary project and a new
document, adds text, saves only within that project and closes only the owned
document through the production guards. It never uses the arbitrary-code tool.
If the active document changes, the operation fails rather than retargeting a
user document; failed disposable documents/directories may need manual cleanup.
The destructive policy is enabled only in that smoke process, not in MCP settings.
Run Beta separately with its exact path. This smoke does not exercise all exports.

## 🤝 Contributing

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/AmazingFeature`)
3. **Commit** your changes (`git commit -m 'Add some AmazingFeature'`)
4. **Push** to the branch (`git push origin feature/AmazingFeature`)
5. **Open** a Pull Request

## 📝 License

This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **Anthropic** for the Model Context Protocol
- **Adobe** for InDesign ExtendScript API
- **MCP Community** for tools and inspiration

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/lucdesign/indesign-mcp-server/issues)
- **Discussions**: [GitHub Discussions](https://github.com/lucdesign/indesign-mcp-server/discussions)

---

**Made with ❤️ for the publishing community**

*Transform your InDesign workflows with AI automation*