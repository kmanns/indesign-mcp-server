import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { jsxString, adobePath } from './security.js';

function appleString(value) {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"';
}

export class InDesignBridge {
  constructor({ env = process.env, execFile = execFileSync, tempRoot = os.tmpdir(), platform = process.platform } = {}) {
    this.appPath = env.INDESIGN_APP_PATH;
    this.execFile = execFile;
    this.tempRoot = tempRoot;
    this.platform = platform;
    this.failed = false;
  }

  applicationInfo() {
    if (this.platform !== 'darwin') throw new Error('InDesign automation requires macOS');
    if (!this.appPath || !path.isAbsolute(this.appPath) || !this.appPath.endsWith('.app')) {
      throw new Error('Set INDESIGN_APP_PATH to the exact stable or Beta .app path; automatic selection is disabled');
    }
    const appPath = fs.realpathSync(this.appPath);
    if (appPath !== this.appPath) throw new Error('INDESIGN_APP_PATH must be the canonical application path');
    const metadata = JSON.parse(this.execFile('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')], { encoding: 'utf8', timeout: 10000 }));
    const version = metadata.CFBundleShortVersionString;
    if (metadata.CFBundleIdentifier !== 'com.adobe.InDesign' || !/^(Adobe )?InDesign(?: \(Beta\))?$/.test(metadata.CFBundleName ?? '') || !/^\d+(?:\.\d+)+$/.test(version ?? '') || Number(version.split('.')[0]) < 21) {
      throw new Error('Selected application is not a supported InDesign 2026+ installation');
    }
    return { path: appPath, version, bundleId: metadata.CFBundleIdentifier };
  }

  assertRunning(info) {
    const script = `ObjC.import('AppKit'); var apps = $.NSWorkspace.sharedWorkspace.runningApplications; var found = false;
      for (var i = 0; i < apps.count; i++) {
        var a = apps.objectAtIndex(i);
        if (a.bundleURL && ObjC.unwrap(a.bundleURL.path) === ${jsxString(info.path)}) found = true;
      }
      found ? 'running' : 'stopped';`;
    const result = this.execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { encoding: 'utf8', timeout: 10000 }).trim();
    if (result !== 'running') throw new Error('Selected InDesign is not running. Start that exact application manually; the server will not launch it');
  }

  async execute(script, expectedDocument, approvedPaths = [], { timeoutMs = 30000 } = {}) {
    if (this.failed) throw new Error('Bridge transport previously failed; inspect InDesign and restart the server before more automation');
    const info = this.applicationInfo();
    this.assertRunning(info);
    const directory = fs.mkdtempSync(path.join(this.tempRoot, 'indesign-mcp-'));
    fs.chmodSync(directory, 0o700);
    const scriptFile = path.join(directory, 'request.jsx');
    const resultFile = path.join(directory, 'result.txt');
    const appleFile = path.join(directory, 'request.applescript');
    const guard = expectedDocument?.id === null ? `
      if (app.documents.length) throw new Error("Active document changed; retry");
    ` : expectedDocument ? `
      if (!app.documents.length || app.activeDocument.id !== ${expectedDocument.id}) throw new Error("Active document changed; retry");
      var __currentPath = ""; try { __currentPath = app.activeDocument.fullName.fsName; } catch (__unsaved) {}
      if (__currentPath !== ${jsxString(expectedDocument.path)}) throw new Error("Document path changed; retry");
    ` : '';
    const pathGuards = approvedPaths.map(entry => `
      var __approvedFile = ${entry.directory ? 'Folder' : 'File'}(${jsxString(adobePath(entry.path))});
      if (__approvedFile.alias) throw new Error("Finder aliases are not permitted");
      if (__approvedFile.fsName !== ${jsxString(entry.path)}) throw new Error("Adobe path interpretation differs from approved native path");
    `).join('\n');
    const wrapped = `
      (function () {
        var __status = "OK", __result = "", __id = "", __path = "", __links = [];
        try {
          if (File(app.fullName).fsName !== ${jsxString(info.path)}) throw new Error("InDesign application identity mismatch");
          if (String(app.version) !== ${jsxString(info.version)}) throw new Error("InDesign version changed; restart server");
          ${guard}
          ${pathGuards}
          __result = eval(${jsxString(script)});
          if (app.documents.length) {
            __id = String(app.activeDocument.id);
            try { __path = app.activeDocument.fullName.fsName; } catch (__unsaved) {}
            for (var __i = 0; __i < app.activeDocument.links.length; __i++) {
              __links.push(encodeURIComponent(app.activeDocument.links[__i].filePath));
            }
          }
        } catch (__error) {
          __status = "ERR";
          __result = __error.message + " (line " + (__error.line || "unknown") + ")";
        }
        var __file = new File(${jsxString(adobePath(resultFile))});
        __file.encoding = "UTF-8";
        __file.lineFeed = "Unix";
        if (!__file.open("w")) throw new Error("Cannot open bridge result");
        try {
          __file.write([__status, encodeURIComponent(String(__result === undefined ? "" : __result)),
            encodeURIComponent(__id), encodeURIComponent(__path), __links.join(",")].join("\\n"));
        } finally { __file.close(); }
      }());
    `;
    try {
      fs.writeFileSync(scriptFile, wrapped, { mode: 0o600, flag: 'wx' });
      fs.writeFileSync(appleFile, `tell application ${appleString(info.path)}\n do script (POSIX file ${appleString(scriptFile)}) language javascript\nend tell\n`, { mode: 0o600, flag: 'wx' });
      try {
        this.execFile('/usr/bin/osascript', [appleFile], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
      } catch (error) {
        this.failed = true;
        throw new Error(`AppleScript transport failed; restart required: ${error.message}`);
      }
      if (!fs.existsSync(resultFile) || fs.statSync(resultFile).size > 8 * 1024 * 1024) {
        this.failed = true;
        throw new Error('Missing or oversized bridge result; restart required');
      }
      let fields;
      try {
        fields = fs.readFileSync(resultFile, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
        if (fields.length !== 5 || !['OK', 'ERR'].includes(fields[0])) throw new Error('Invalid field count or status');
        fields = [fields[0], ...fields.slice(1, 4).map(decodeURIComponent),
          fields[4] ? fields[4].split(',').map(decodeURIComponent) : []];
        if (fields[2] && (!/^\d+$/.test(fields[2]) || !Number.isSafeInteger(Number(fields[2])))) throw new Error('Invalid document identity');
      } catch (error) {
        this.failed = true;
        throw new Error(`Invalid bridge response; operation may already have run. Inspect InDesign and restart before retrying: ${error.message}`);
      }
      const text = fields[1];
      if (fields[0] === 'ERR') throw new Error(`InDesign script failed: ${text}`);
      const id = fields[2] ? Number(fields[2]) : null;
      return {
        text, application: info,
        document: id === null ? null : { id, path: fields[3], links: fields[4] },
      };
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}
