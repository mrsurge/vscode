/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type EditorTouchResult = { kind: 'tap'; count: number } | { kind: 'scroll' | 'hold' | 'cancel' };

/** Editor-only gesture ownership. Small IME/browser jitter is not a scroll, and
 * returning to the starting point cannot turn an established scroll into a tap. */
export class EditorTouchGesture {
	static readonly holdDelay = 700;
	private phase: 'pending' | 'scroll' | 'hold' | 'cancel' = 'cancel';
	private x = 0;
	private y = 0;
	private lastTap: { x: number; y: number; time: number } | undefined;

	start(x: number, y: number): void {
		this.x = x;
		this.y = y;
		this.phase = 'pending';
	}

	move(x: number, y: number): boolean {
		if (this.phase === 'pending' && Math.hypot(x - this.x, y - this.y) > 10) {
			this.phase = 'scroll';
			this.lastTap = undefined;
		}
		return this.phase === 'scroll';
	}

	hold(): boolean {
		if (this.phase !== 'pending') {
			return false;
		}
		this.phase = 'hold';
		this.lastTap = undefined;
		return true;
	}

	end(time: number): EditorTouchResult {
		const phase = this.phase;
		this.phase = 'cancel';
		if (phase !== 'pending') {
			return { kind: phase };
		}
		const previous = this.lastTap;
		const doubleTap = previous && time - previous.time <= 400
			&& Math.hypot(previous.x - this.x, previous.y - this.y) <= 24;
		this.lastTap = doubleTap ? undefined : { x: this.x, y: this.y, time };
		return { kind: 'tap', count: doubleTap ? 2 : 1 };
	}

	cancel(): void {
		this.phase = 'cancel';
		this.lastTap = undefined;
	}
}
