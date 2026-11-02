import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('real stdio handshake, tool discovery and rejected calls never require InDesign', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../index.js', import.meta.url))],
    env: { PATH: process.env.PATH ?? '', INDESIGN_ALLOWED_DIRS: '[]' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'security-regression', version: '1.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 50);
    assert.ok(tools.some(tool => tool.name === 'get_application_info'));
    assert.ok(!tools.some(tool => tool.name === 'execute_indesign_code'));
    assert.ok(!tools.some(tool => tool.name === 'data_merge'));
    for (const name of ['inspect_data_merge', 'validate_data_merge_csv', 'create_data_merge_csv',
      'select_data_merge_source', 'bind_data_merge_fields', 'export_data_merge_pdf']) {
      assert.ok(tools.some(tool => tool.name === name));
    }
    for (const call of [
      { name: 'close_document', arguments: { save: true, confirmDestructive: true } },
      { name: 'create_text_frame', arguments: { content: 'ok', fontSize: '1; execute()' } },
      { name: 'open_document', arguments: { filePath: '/etc/passwd' } },
      { name: 'execute_indesign_code', arguments: { code: 'app.documents.add();' } },
      { name: 'select_data_merge_source', arguments: { documentId: 1, documentPath: '/etc/passwd', dataSourcePath: '/etc/passwd', mode: 'select', confirmDestructive: true } },
      { name: 'create_data_merge_csv', arguments: { filePath: '/etc/new.csv', headers: ['Name'], records: [['Example']], confirmDestructive: true } },
    ]) assert.equal((await client.callTool(call)).isError, true);
  } finally {
    await client.close();
  }
});
