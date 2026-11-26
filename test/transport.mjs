// Credential-free stand-in for the Claude Code process; the SDK and MCP bridge stay real.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const capture = (value) => appendFileSync(process.env.SDK_TEST_CAPTURE, JSON.stringify(value) + '\n');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
capture({ argv: process.argv.slice(2), maxOutputTokens: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS });
const pending = new Map();
let sequence = 0;
function request(request) {
  const request_id = `fixture-${++sequence}`;
  return new Promise((resolve) => {
    pending.set(request_id, resolve);
    send({ type: 'control_request', request_id, request });
  });
}
const rpc = (method, params) => request({ subtype: 'mcp_message', server_name: 'custom-tools', message: { jsonrpc: '2.0', id: ++sequence, method, params } });
let initialized;
async function discover() {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
  capture({ discovery: await rpc('tools/list', {}) });
  capture({ permission: await request({ subtype: 'can_use_tool', tool_name: 'mcp__custom-tools__contract_tool', input: { payload: 'SDK must not execute' }, tool_use_id: 'denied-call' }) });
  capture({ deniedCall: await rpc('tools/call', { name: 'contract_tool', arguments: { payload: 'SDK must not execute' } }) });
  capture({ unknownCall: await rpc('tools/call', { name: 'unknown_tool', arguments: {} }) });
}
const event = (event) => send({ type: 'stream_event', event, session_id: 'fixture' });
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  capture({ received: message });
  if (message.type === 'control_response') {
    pending.get(message.response.request_id)?.(message.response);
    pending.delete(message.response.request_id);
  } else if (message.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
    if (message.request.subtype === 'initialize') initialized = discover();
    if (message.request.subtype === 'interrupt') send({ type: 'result', subtype: 'success', is_error: false, result: '' });
  } else if (message.type === 'user') {
    // Do not block stdin while the bidirectional SDK bridge services MCP requests.
    void (async () => {
      await initialized;
      if (process.env.SDK_TEST_SCENARIO === 'cancel') return;
      if (process.env.SDK_TEST_SCENARIO === 'quota') {
        // Claude Code sends rate_limit_event after the response's message_stop.
        event({ type: 'message_start', message: { usage: { input_tokens: 7, output_tokens: 0 } } });
        event({ type: 'content_block_start', index: 0, content_block: { type: 'text' } });
        event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'quota text' } });
        event({ type: 'content_block_stop', index: 0 });
        event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } });
        event({ type: 'message_stop' });
        send({ type: 'rate_limit_event', rate_limit_info: JSON.parse(process.env.SDK_TEST_RATE_LIMIT), uuid: '00000000-0000-4000-8000-000000000001', session_id: 'fixture' });
        send({ type: 'result', subtype: 'success', is_error: false, result: 'quota text', session_id: 'fixture' });
        return;
      }
      event({ type: 'message_start', message: { usage: { input_tokens: 7, output_tokens: 0 } } });
      for (const [index, type, deltaType, text] of [[0, 'thinking', 'thinking_delta', 'fixture thought'], [1, 'text', 'text_delta', 'fixture text']]) {
        event({ type: 'content_block_start', index, content_block: { type } });
        event({ type: 'content_block_delta', index, delta: { type: deltaType, [type === 'text' ? 'text' : 'thinking']: text } });
        event({ type: 'content_block_stop', index });
      }
      event({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'pi-call', name: 'mcp__custom-tools__contract_tool', input: {} } });
      event({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ payload: 'Pi ~/.pi/skills original', nested: { mode: 'strict', values: [2, 4] } }) } });
      event({ type: 'content_block_stop', index: 2 });
      event({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } });
      event({ type: 'message_stop' });
    })().catch((error) => { capture({ fixtureError: String(error) }); process.exit(1); });
  }
}
