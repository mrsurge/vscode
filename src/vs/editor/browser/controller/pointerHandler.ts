/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BrowserFeatures } from '../../../base/browser/canIUse.js';
import * as dom from '../../../base/browser/dom.js';
import { EventType, Gesture, GestureEvent } from '../../../base/browser/touch.js';
import { mainWindow } from '../../../base/browser/window.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import * as platform from '../../../base/common/platform.js';
import { IPointerHandlerHelper, MouseHandler } from './mouseHandler.js';
import { NavigationCommandRevealType } from '../coreCommands.js';
import { IMouseTarget, MouseTargetType } from '../editorBrowser.js';
import { EditorMouseEvent, EditorPointerEventFactory } from '../editorDom.js';
import { ViewController } from '../view/viewController.js';
import { ViewContext } from '../../common/viewModel/viewContext.js';
import { TextAreaSyntethicEvents } from './editContext/textArea/textAreaEditContextInput.js';

function dispatchTextAreaTap(viewHelper: IPointerHandlerHelper): void {
	const event = document.createEvent('CustomEvent');
	event.initEvent(TextAreaSyntethicEvents.Tap, false, true);
	viewHelper.dispatchTextAreaEvent(event);
}

// A touch hold selects through the same word-selection command as double click.
// It never focuses the textarea; ordinary taps keep the existing IME activation.
class EditorTouchMouseHandler extends MouseHandler {
	private lastTouchAt = -Infinity;
	private touchActive = false;
	constructor(context: ViewContext, viewController: ViewController, viewHelper: IPointerHandlerHelper) {
		super(context, viewController, viewHelper);
		const recordTouch = (e: TouchEvent) => {
			this.lastTouchAt = Date.now();
			this.touchActive = e.touches.length > 0;
		};
		for (const type of ['touchstart', 'touchend', 'touchcancel']) {
			this._register(dom.addDisposableListener(viewHelper.viewDomNode, type, recordTouch, { capture: true, passive: true }));
		}
		this._register(dom.addDisposableListener(dom.getWindow(viewHelper.viewDomNode), 'blur', () => { this.touchActive = false; }));
		this._register(dom.addDisposableListener(viewHelper.linesContentDomNode, EventType.Hold, (e: GestureEvent) => {
			this.lastTouchAt = Date.now();
			this._dispatchGesture(e, false);
			// Expose the completed selection through the public context-menu event.
			// The touch-menu contribution can present it without relocating the caret.
			super._onContextMenu(new EditorMouseEvent(e, false, viewHelper.viewDomNode), false);
		}));
	}

	private isTouchMouseEvent(e: EditorMouseEvent): boolean {
		const event = e.browserEvent as MouseEvent & { pointerType?: string; sourceCapabilities?: { firesTouchEvents?: boolean } };
		return event.pointerType === 'touch' || event.sourceCapabilities?.firesTouchEvents === true
			|| (!event.pointerType && (this.touchActive || Date.now() - this.lastTouchAt < 1000));
	}

	protected override _onMouseMove(e: EditorMouseEvent): void {
		if (this.isTouchMouseEvent(e)) {
			return;
		}
		super._onMouseMove(e);
	}

	protected override _onContextMenu(e: EditorMouseEvent, testEventTarget: boolean): void {
		if (this.isTouchMouseEvent(e) && this.viewHelper.linesContentDomNode.contains(e.browserEvent.target as Node | null)) {
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		super._onContextMenu(e, testEventTarget);
	}

	protected _dispatchGesture(event: GestureEvent, inSelectionMode: boolean): void {
		const target = this._createMouseTarget(new EditorMouseEvent(event, false, this.viewHelper.viewDomNode), false);
		if (target.position) {
			this.viewController.dispatchMouse({
				position: target.position,
				mouseColumn: target.position.column,
				startedOnLineNumbers: false,
				revealType: NavigationCommandRevealType.Minimal,
				mouseDownCount: event.tapCount,
				inSelectionMode,
				altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
				leftButton: false, middleButton: false,
				onInjectedText: target.type === MouseTargetType.CONTENT_TEXT && target.detail.injectedText !== null
			});
		}
	}
}

/**
 * Currently only tested on iOS 13/ iPadOS.
 */
export class PointerEventHandler extends EditorTouchMouseHandler {
	private _lastPointerType: string;
	constructor(context: ViewContext, viewController: ViewController, viewHelper: IPointerHandlerHelper) {
		super(context, viewController, viewHelper);

		this._register(Gesture.addTarget(this.viewHelper.linesContentDomNode, true));
		this._register(dom.addDisposableListener(this.viewHelper.linesContentDomNode, EventType.Tap, (e) => this.onTap(e)));
		this._register(dom.addDisposableListener(this.viewHelper.linesContentDomNode, EventType.Change, (e) => this.onChange(e)));
		this._register(dom.addDisposableListener(this.viewHelper.linesContentDomNode, EventType.Contextmenu, (e: MouseEvent) => this._onContextMenu(new EditorMouseEvent(e, false, this.viewHelper.viewDomNode), false)));

		this._lastPointerType = 'mouse';

		this._register(dom.addDisposableListener(this.viewHelper.linesContentDomNode, 'pointerdown', (e: PointerEvent) => {
			const pointerType = e.pointerType;
			if (pointerType === 'mouse') {
				this._lastPointerType = 'mouse';
				return;
			} else if (pointerType === 'touch') {
				this._lastPointerType = 'touch';
			} else {
				this._lastPointerType = 'pen';
			}
		}));

		// PonterEvents
		const pointerEvents = new EditorPointerEventFactory(this.viewHelper.viewDomNode);

		this._register(pointerEvents.onPointerMove(this.viewHelper.viewDomNode, (e) => this._onMouseMove(e)));
		this._register(pointerEvents.onPointerUp(this.viewHelper.viewDomNode, (e) => this._onMouseUp(e)));
		this._register(pointerEvents.onPointerLeave(this.viewHelper.viewDomNode, (e) => this._onMouseLeave(e)));
		this._register(pointerEvents.onPointerDown(this.viewHelper.viewDomNode, (e, pointerId) => this._onMouseDown(e, pointerId)));
	}

	private onTap(event: GestureEvent): void {
		if (!event.initialTarget || !this.viewHelper.linesContentDomNode.contains(event.initialTarget as HTMLElement)) {
			return;
		}

		event.preventDefault();
		this.viewHelper.focusTextArea();
		dispatchTextAreaTap(this.viewHelper);
		this._dispatchGesture(event, /*inSelectionMode*/false);
	}

	private onChange(event: GestureEvent): void {
		if (this._lastPointerType === 'touch') {
			this._context.viewModel.viewLayout.deltaScrollNow(-event.translationX, -event.translationY);
		}
		if (this._lastPointerType === 'pen') {
			this._dispatchGesture(event, /*inSelectionMode*/true);
		}
	}

	protected override _onMouseDown(e: EditorMouseEvent, pointerId: number): void {
		if ((e.browserEvent as PointerEvent).pointerType === 'touch') {
			return;
		}

		super._onMouseDown(e, pointerId);
	}
}

class TouchHandler extends EditorTouchMouseHandler {

	constructor(context: ViewContext, viewController: ViewController, viewHelper: IPointerHandlerHelper) {
		super(context, viewController, viewHelper);

		this._register(Gesture.addTarget(this.viewHelper.linesContentDomNode, true));

		this._register(dom.addDisposableListener(this.viewHelper.linesContentDomNode, EventType.Tap, (e) => this.onTap(e)));
		this._register(dom.addDisposableListener(this.viewHelper.linesContentDomNode, EventType.Change, (e) => this.onChange(e)));
		this._register(dom.addDisposableListener(this.viewHelper.linesContentDomNode, EventType.Contextmenu, (e: MouseEvent) => this._onContextMenu(new EditorMouseEvent(e, false, this.viewHelper.viewDomNode), false)));
	}

	private onTap(event: GestureEvent): void {
		event.preventDefault();

		this.viewHelper.focusTextArea();

		const target = this._createMouseTarget(new EditorMouseEvent(event, false, this.viewHelper.viewDomNode), false);

		if (target.position) {
			// Send the tap event also to the <textarea> (for input purposes)
			dispatchTextAreaTap(this.viewHelper);

			this._dispatchGesture(event, false);
		}
	}

	private onChange(e: GestureEvent): void {
		this._context.viewModel.viewLayout.deltaScrollNow(-e.translationX, -e.translationY);
	}
}

export class PointerHandler extends Disposable {
	private readonly handler: MouseHandler;

	constructor(context: ViewContext, viewController: ViewController, viewHelper: IPointerHandlerHelper) {
		super();
		const isPhone = platform.isIOS || (platform.isAndroid && platform.isMobile);
		if (isPhone && BrowserFeatures.pointerEvents) {
			this.handler = this._register(new PointerEventHandler(context, viewController, viewHelper));
		} else if (mainWindow.TouchEvent) {
			this.handler = this._register(new TouchHandler(context, viewController, viewHelper));
		} else {
			this.handler = this._register(new MouseHandler(context, viewController, viewHelper));
		}
	}

	public getTargetAtClientPoint(clientX: number, clientY: number): IMouseTarget | null {
		return this.handler.getTargetAtClientPoint(clientX, clientY);
	}
}
