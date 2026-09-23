/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the actual gesture dispatcher with deterministic DOM/timer seams.
// No browser, IME or rendered font assumptions belong in these source tests.
function harness(editor = true) {
	let now = 10_000;
	let nextTimer = 0;
	const timers = new Map();
	class Element {
		listeners = new Map();
		events = [];
		isConnected = true;
		constructor(parent = null) { this.parentElement = parent; }
		contains(node) { return node === this || Boolean(node?.parentElement && this.contains(node.parentElement)); }
		dispatchEvent(event) { this.events.push(event); for (const fn of this.listeners.get(event.type) ?? []) {fn(event);} }
	}
	const document = new Element();
	document.createEvent = () => ({ initEvent(type) { this.type = type; } });
	const window = new Element();
	window.document = document;
	window.ontouchstart = null;
	class Disposable {
		static None = { dispose() {} };
		_store = { add: value => value };
		_register(value) { return value; }
		dispose() {}
	}
	class LinkedList extends Set {
		push(value) { this.add(value); return () => this.delete(value); }
	}
	const noop = { dispose() {} };
	const dom = {
		addDisposableListener(target, type, fn) {
			const listeners = target.listeners.get(type) ?? new Set();
			target.listeners.set(type, listeners);
			listeners.add(fn);
			return { dispose: () => listeners.delete(fn) };
		},
		scheduleAtNextAnimationFrame: () => noop,
	};
	const context = vm.createContext({
		Node: Element, document, navigator: { maxTouchPoints: 1 }, console,
		Date: class extends Date { static now() { return now; } constructor() { super(now); } },
		setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: now + delay }); return id; },
		clearTimeout(id) { timers.delete(id); },
	});
	const dependencies = {
		'./dom.js': dom,
		'./window.js': { mainWindow: window },
		'../common/decorators.js': { memoize: (_target, _key, descriptor) => descriptor },
		'../common/event.js': { Event: { runAndSubscribe(_event, callback, initial) { callback(initial); return noop; } } },
		'../common/lifecycle.js': { Disposable, markAsSingleton: value => value, toDisposable: dispose => ({ dispose }) },
		'../common/linkedList.js': { LinkedList },
	};
	function load(name) {
		const source = readFileSync(new URL(`../src/vs/base/browser/${name}.ts`, import.meta.url), 'utf8');
		const { outputText } = ts.transpileModule(source, { compilerOptions: {
			module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true,
		} });
		const exports = {};
		vm.runInContext(`(function(require,exports){${outputText}\n})`, context)(id => {
			assert.ok(id in dependencies, `unexpected dependency ${id}`);
			return dependencies[id];
		}, exports);
		return exports;
	}
	dependencies['./editorTouchGesture.js'] = load('editorTouchGesture');
	const { Gesture, EventType } = load('touch');
	const target = new Element();
	const text = new Element(target);
	const registration = Gesture.addTarget(target, editor);
	const list = values => Object.assign([...values], { item: i => values[i] });
	const touch = (x, y, id = 1) => ({ identifier: id, target: text, pageX: x, pageY: y });
	function send(type, changed, active = type === 'touchend' || type === 'touchcancel' ? [] : changed) {
		document.dispatchEvent({ type, touches: list(active), targetTouches: list(active), changedTouches: list(changed), preventDefault() {}, stopPropagation() {} });
	}
	function advance(ms) {
		now += ms;
		for (const [id, timer] of [...timers]) {if (timer.at <= now) { timers.delete(id); timer.fn(); }}
	}
	const events = type => target.events.filter(e => e.type === EventType[type]);
	return { send, touch, advance, events, registration, timers, window };
}

test('small touch jitter preserves the second tap; separated taps stay independent', () => {
	const h = harness();
	h.send('touchstart', [h.touch(30, 30)]);
	h.advance(30);
	h.send('touchend', [h.touch(30, 30)]);
	h.advance(100);
	h.send('touchstart', [h.touch(32, 32)]);
	h.send('touchmove', [h.touch(34, 33)]);
	h.send('touchend', [h.touch(34, 33)]);
	assert.deepEqual(h.events('Tap').map(e => e.tapCount), [1, 2]);
	assert.equal(h.events('Change').length, 0);
	h.send('touchstart', [h.touch(100, 100)]);
	h.send('touchend', [h.touch(100, 100)]);
	assert.equal(h.events('Tap').at(-1).tapCount, 1);
});

test('hold selects once before release without a tap or contextmenu on release', () => {
	const h = harness();
	h.send('touchstart', [h.touch(20, 30)]);
	h.advance(700);
	assert.equal(h.events('Hold').length, 1);
	assert.equal(h.events('Hold')[0].tapCount, 2);
	h.send('touchend', [h.touch(20, 30)]);
	assert.equal(h.events('Tap').length + h.events('Contextmenu').length, 0);
	assert.equal(h.timers.size, 0);
});

test('scroll ownership is irreversible even when the finger returns to its origin', () => {
	const h = harness();
	h.send('touchstart', [h.touch(20, 30)]);
	h.advance(20);
	h.send('touchmove', [h.touch(20, 55)]);
	h.advance(20);
	h.send('touchmove', [h.touch(20, 30)]);
	h.advance(800);
	h.send('touchend', [h.touch(20, 30)]);
	assert.equal(h.events('Change').length, 2);
	assert.equal(h.events('Tap').length + h.events('Hold').length + h.events('Contextmenu').length, 0);
});

test('cancel, multitouch and target disposal invalidate pending holds', () => {
	for (const cancel of ['touchcancel', 'multitouch', 'dispose', 'blur']) {
		const h = harness();
		h.send('touchstart', [h.touch(20, 30)]);
		if (cancel === 'dispose') {h.registration.dispose();}
		else if (cancel === 'blur') {h.window.dispatchEvent({ type: 'blur' });}
		else if (cancel === 'multitouch') {h.send('touchstart', [h.touch(40, 30, 2)], [h.touch(20, 30), h.touch(40, 30, 2)]);}
		else {h.send('touchcancel', [h.touch(20, 30)]);}
		h.advance(1000);
		assert.equal(h.events('Hold').length, 0, cancel);
		assert.equal(h.timers.size, 0, cancel);
	}
});

test('non-editor gesture targets retain their contextmenu-on-release contract', () => {
	const h = harness(false);
	h.send('touchstart', [h.touch(20, 30)]);
	h.advance(800);
	assert.equal(h.events('Hold').length, 0);
	h.send('touchend', [h.touch(20, 30)]);
	assert.equal(h.events('Contextmenu').length, 1);
});

test('native paragraph movement handles whitespace, repeated jumps, bounds and selection', () => {
	const source = readFileSync(new URL('../src/vs/editor/common/cursor/cursorMoveOperations.ts', import.meta.url), 'utf8');
	const { outputText } = ts.transpileModule(source, { compilerOptions: {
		module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
	} });
	const exports = {};
	// These particular native operations use only the model/cursor contracts below.
	vm.runInNewContext(`(function(require,exports){${outputText}\n})`)(() => ({}), exports);
	const lines = ['one', 'two', '  ', '', 'three', 'four', '', 'five'];
	const model = {
		getLineCount: () => lines.length,
		getLineFirstNonWhitespaceColumn: n => lines[n - 1].trim() ? 1 : 0,
		getLineMinColumn: () => 1,
	};
	const cursor = n => ({ position: { lineNumber: n, column: 2 }, move(select, line, column) { return { select, line, column }; } });
	const { MoveOperations } = exports;
	for (const [method, start, end] of [
		['moveToNextBlankLine', 1, 3], ['moveToNextBlankLine', 3, 7],
		['moveToNextBlankLine', 7, 8], ['moveToNextBlankLine', 8, 8],
		['moveToPrevBlankLine', 8, 7], ['moveToPrevBlankLine', 7, 4],
		['moveToPrevBlankLine', 4, 1], ['moveToPrevBlankLine', 1, 1],
	]) {
		for (const select of [false, true]) {
			assert.deepEqual(MoveOperations[method]({}, model, cursor(start), select), { select, line: end, column: 1 });
		}
	}
});

test('pointer holds use native word selection without IME focus and ignore duplicate touch context menus', () => {
	const source = readFileSync(new URL('../src/vs/editor/browser/controller/pointerHandler.ts', import.meta.url), 'utf8');
	const { outputText } = ts.transpileModule(source, { compilerOptions: {
		module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
	} });
	const listeners = new Map();
	const lines = { contains: target => target === 'text' };
	const root = {};
	let focus = 0;
	let moves = 0;
	const commands = [];
	const menus = [];
	class Disposable { _register(value) { return value; } }
	class MouseHandler extends Disposable {
		constructor(_context, viewController, viewHelper) { super(); this.viewController = viewController; this.viewHelper = viewHelper; }
		_createMouseTarget() { return { position: { lineNumber: 2, column: 4 }, type: 1, detail: { injectedText: null } }; }
		_onContextMenu(e) { menus.push(e); }
		_onMouseMove() { moves++; }
	}
	const events = { Tap: 'tap', Change: 'change', Contextmenu: 'context', Hold: 'hold' };
	const pointerEvents = new Proxy({}, { get: () => () => ({ dispose() {} }) });
	const dependencies = {
		'../../../base/browser/canIUse.js': { BrowserFeatures: { pointerEvents: true } },
		'../../../base/browser/dom.js': {
			getWindow: () => ({}),
			addDisposableListener(target, type, fn) { listeners.set(`${target === lines ? 'lines' : 'root'}:${type}`, fn); return { dispose() {} }; },
		},
		'../../../base/browser/touch.js': { EventType: events, Gesture: { addTarget: () => ({ dispose() {} }) } },
		'../../../base/browser/window.js': { mainWindow: {} },
		'../../../base/common/lifecycle.js': { Disposable },
		'../../../base/common/platform.js': {},
		'./mouseHandler.js': { MouseHandler },
		'../coreCommands.js': { NavigationCommandRevealType: { Minimal: 0 } },
		'../editorBrowser.js': { MouseTargetType: { CONTENT_TEXT: 1 } },
		'../editorDom.js': { EditorMouseEvent: class { constructor(browserEvent) { this.browserEvent = browserEvent; } }, EditorPointerEventFactory: class { constructor() { return pointerEvents; } } },
		'./editContext/textArea/textAreaEditContextInput.js': { TextAreaSyntethicEvents: { Tap: 'tap' } },
	};
	const exports = {};
	vm.runInNewContext(`(function(require,exports){${outputText}\n})`)(id => {
		assert.ok(id in dependencies, id);
		return dependencies[id];
	}, exports);
	const instance = new exports.PointerEventHandler({}, { dispatchMouse: command => commands.push(command) }, {
		viewDomNode: root, linesContentDomNode: lines, focusTextArea() { focus++; },
	});
	listeners.get('root:touchstart')({ touches: [{}] });
	listeners.get('lines:hold')({ type: 'hold', tapCount: 2, initialTarget: 'text' });
	assert.equal(commands[0].mouseDownCount, 2);
	assert.equal(focus, 0);
	assert.equal(menus.length, 1);
	let suppressed = 0;
	instance._onContextMenu({ browserEvent: { pointerType: 'touch', target: 'text' }, preventDefault() { suppressed++; }, stopPropagation() {} }, true);
	assert.equal(suppressed, 1);
	assert.equal(menus.length, 1);
	instance._onMouseMove({ browserEvent: { pointerType: 'touch' } });
	instance._onMouseMove({ browserEvent: { pointerType: 'mouse' } });
	assert.equal(moves, 1);
});
