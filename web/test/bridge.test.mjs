import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCodeRef, mdLight, keyCombo, shouldForwardKey, parentOriginOf, nodeMenuItems, codeRoute, codeOpenMessage, normaliseLink } from '../src/logic.mjs'

test('parseCodeRef: file paths in code spans', () => {
  assert.deepEqual(parseCodeRef('src/graph/agent.py:12-20'), { kind: 'code', title: 'src/graph/agent.py', url: 'src/graph/agent.py:12-20', path: 'src/graph/agent.py', line: 12, endLine: 20 })
  assert.equal(parseCodeRef('graph/agent.py#L7').line, 7)
  assert.equal(parseCodeRef('README.md').line, undefined)
  for (const no of ['create_agent', '/api/chat', '1.60.0', '../x.py', 'a b.py', 'https://x.dev/a.js']) assert.equal(parseCodeRef(no), null, no)
})

test('mdLight codeRefs option', () => {
  assert.match(mdLight('see `src/a.py:3`', { codeRefs: true }), /<code class="coderef" role="button" tabindex="0" data-path="src\/a.py" data-line="3"/)
  assert.equal(mdLight('see `src/a.py:3`'), '<p>see <code>src/a.py:3</code></p>', 'off by default')
  assert.match(mdLight('`create_agent`', { codeRefs: true }), /<code>create_agent<\/code>/)
})

test('code routing: click = pane, mod-click = editor, pane off = editor', () => {
  assert.equal(codeRoute({}, true), 'pane')
  assert.equal(codeRoute({ metaKey: true }, true), 'editor')
  assert.equal(codeRoute({ ctrlKey: true }, null), 'editor')
  assert.equal(codeRoute({}, false), 'editor')
  assert.equal(codeRoute({}, null), 'pane', 'unknown (older host) → the old behaviour')
  const m = codeOpenMessage({ project: 'p', path: 'a.py' }, normaliseLink('/a.py#L2'), 'n', 'editor')
  assert.deepEqual(m, { type: 'protoagent:code:open', project: 'p', path: 'a.py', open_in: 'editor', line: 2, note: 'n' })
})

test('key forwarding', () => {
  assert.equal(keyCombo({ key: 'K', metaKey: true, shiftKey: true }), 'mod+shift+k')
  assert.equal(keyCombo({ key: 'Shift', shiftKey: true }), null)
  assert.equal(shouldForwardKey({ key: 'k', metaKey: true }), true)
  assert.equal(shouldForwardKey({ key: 'k', ctrlKey: true, defaultPrevented: true }), false)
  assert.equal(shouldForwardKey({ key: 'p' }), false, 'plain keys stay in the view')
})

test('parentOriginOf', () => {
  assert.equal(parentOriginOf({ ancestorOrigins: ['tauri://localhost'], referrer: '', origin: 'http://127.0.0.1:7870' }), 'tauri://localhost')
  assert.equal(parentOriginOf({ ancestorOrigins: [], referrer: 'http://h:1/app/', origin: 'http://x' }), 'http://h:1')
  assert.equal(parentOriginOf({ referrer: '', origin: 'http://x' }), 'http://x')
})

test('nodeMenuItems', () => {
  const ids = (o) => nodeMenuItems(o).map((i) => i.id ?? '-')
  assert.deepEqual(ids({ hasCode: true, paneOn: true, canDrill: true, canPresent: true }), ['view', 'editor', '-', 'drill', 'details', 'present', '-', 'copy'])
  assert.deepEqual(ids({ hasCode: true, paneOn: false, canDrill: false, canPresent: false }), ['editor', '-', 'details', '-', 'copy'])
  assert.ok(nodeMenuItems({}).every((i) => !i.id || !i.id.includes('.')))
})
