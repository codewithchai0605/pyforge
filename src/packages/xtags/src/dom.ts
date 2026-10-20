import { computed, effect, isSignal, onCleanup, untrack, type Signal } from './reactive';

/** A zero-argument function read to get the current value (a `Signal` is one). */
export type Accessor<T> = () => T;

export type Child =
	| Node
	| string
	| number
	| boolean
	| null
	| undefined
	| Signal<unknown>
	/** A reactive child: re-evaluated whenever a signal it read changes. May return any `Child`. */
	| (() => Child)
	| Child[];

/** A function that is a plain thunk (not a `Signal`, which is also callable). */
function isThunk(value: unknown): value is () => Child {
	return typeof value === 'function' && !isSignal(value);
}

/**
 * Runs a component function once, **untracked**: signals read while a
 * component is being constructed must not subscribe whichever reactive region
 * happens to be building it, or reading `store()` in a page body would rebuild
 * the whole page whenever the store changed. Components that want to react do
 * so through bindings (`() => …`, `effect`, `watch`).
 */
export function callComponent<P>(type: (props: P) => Node, props: P): Node {
	return untrack(() => type(props));
}

export type ComponentProps = Record<string, unknown> & { children?: Child };
export type Component<P extends ComponentProps = ComponentProps> = (props: P) => Node;

/**
 * Hyperscript factory: `h(type, props, ...children)`.
 *
 * This exact signature — not html-tag-js's custom Babel-AST JSX transform —
 * is what lets esbuild's *classic* JSX transform target xtags directly
 * (see examples/app/esbuild.config.mjs's jsxFactory/jsxFragment), with no
 * extra Babel dependency in the build at all.
 *
 * The component overload infers props via `Parameters<F>[0]` rather than
 * unifying against a separately-declared `P extends ComponentProps`. That
 * one change is what lets `h(Show, {...})` still check `props` against
 * `Show`'s own declared prop type (try passing it a props object missing
 * `when` and tsc should catch it).
 *
 * `For` (and any other generic component, `<T>(props: SomeProps<T>) => Node`)
 * is a narrower case, worth calling out explicitly: `<For each={...} key={...}>
 * {(item, index) => ...}</For>` type-checks `item`/`index` correctly in
 * JSX, but *not* because of anything in this overload — TypeScript's JSX
 * checker type-checks a JSX element directly against the tag's own
 * function signature (that's also what `JSX.ElementChildrenAttribute` in
 * index.ts is for), bypassing `h()`'s declared type entirely. Call `h`
 * directly instead of via JSX — `h(For, { each, key, children })`, the
 * shape every non-JSX caller in this codebase used to use — and that
 * bypass doesn't happen: TypeScript then has to resolve `For`'s own type
 * parameter itself, and inferring a generic function's type parameter
 * through a second, independent generic (`F` here) from a plain value
 * reference is a genuine, well-known TypeScript inference limitation, not
 * a one-off bug in this file — `For`'s `T` collapses to `unknown` and
 * every use of `item`/`index` in that call untypes with it. This isn't
 * hypothetical: it's exactly what happened in this package's own
 * `test/list.test.ts` before it was fixed (see git history / README).
 *
 * The fix for a direct call is a TS 4.7+ *instantiation expression* —
 * name `For`'s type argument explicitly so there's no inference left to
 * do: `h(For<Item>, { each, key, children })`. `h(Show, {...})` needs no
 * such workaround since `Show` isn't generic — this only comes up for a
 * component that has its own type parameter.
 */
export function h<F extends (props: never) => Node>(
	type: F,
	props: Parameters<F>[0] | null,
	...children: Child[]
): Node;
export function h(type: string, props: Record<string, unknown> | null, ...children: Child[]): Node;
export function h(
	type: string | Component<never>,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- implementation
	// signature only; must be broad enough to cover both overloads above (the
	// first overload's props type varies per-component via `Parameters<F>[0]`,
	// which isn't always a `Record<string, unknown>`, e.g. ForProps<T>).
	props: any,
	...children: Child[]
): Node {
	const resolvedProps = (props ?? {}) as Record<string, unknown>;

	if (typeof type === 'function') {
		const componentProps: Record<string, unknown> = { ...resolvedProps };
		// Only normalize `children` from h()'s trailing args when some were
		// actually passed (the JSX call shape) — an explicit `children` prop
		// given via the props object (the programmatic call shape, e.g.
		// `h(Show, { children: ... })`) must not be clobbered by an empty rest
		// array turning into `undefined`.
		if (children.length > 0) {
			componentProps.children = children.length === 1 ? children[0] : children;
		}
		return callComponent(type as (props: unknown) => Node, componentProps);
	}

	const el = createElement(type);
	// Attributes first, then children, then live properties (`value`, `checked`,
	// `model`, `ref`): `<select value="b">` can only select an <option> that
	// already exists, and `ref` callbacks should see a fully built element.
	applyProps(el, resolvedProps, false);
	appendChildren(el, children);
	applyProps(el, resolvedProps, true);
	return el;
}

/** Target of JSX fragment syntax (`<>...</>`) — see esbuild.config.mjs's jsxFragment. */
export function Fragment(props: { children?: Child }): Node {
	const frag = document.createDocumentFragment();
	appendChildren(frag, ([] as Child[]).concat(props.children ?? []));
	return frag;
}

/**
 * Toggles between two pre-built node sets based on a boolean-ish accessor,
 * without tearing down and recreating them each time — just moves them in
 * and out of a stable, layout-neutral wrapper (`display: contents`, so it
 * doesn't add an extra box to your layout).
 *
 * `when` accepts any zero-arg function, not just a `Signal` — a plain
 * `() => count() > 5` works directly; you don't need to wrap it in
 * `computed()` first just to satisfy the type (the implementation only
 * ever *calls* it, same as a Signal).
 */
export function Show(props: { when: () => unknown; children: Child; fallback?: Child }): Node {
	// Lazy mode: `children` / `fallback` given as a function (`() => <Heavy/>`)
	// are *built when needed and disposed when hidden* — the behaviour you want
	// for pages/panels that own sockets, timers or workers. The eager mode below
	// (nodes passed directly) builds everything up front and merely toggles it.
	if (isThunk(props.children) || isThunk(props.fallback)) {
		const frag = document.createDocumentFragment();
		// `computed` dedupes: truthy -> truthy does not rebuild the branch.
		const on = computed(() => Boolean(props.when()));
		mountDynamic(frag, () =>
			on() ? resolveBranch(props.children) : resolveBranch(props.fallback)
		);
		return frag;
	}

	const anchor = document.createElement('span');
	anchor.style.display = 'contents';

	const whenNodes = collectNodes(props.children);
	const fallbackNodes = props.fallback !== undefined ? collectNodes(props.fallback) : [];

	effect(() => {
		anchor.replaceChildren(...(props.when() ? whenNodes : fallbackNodes));
	});

	return anchor;
}

/** Evaluates a lazy branch once, untracked; eager branches pass straight through. */
function resolveBranch(branch: Child): Child {
	return isThunk(branch) ? untrack(branch) : branch;
}

/**
 * Renders `children` into a different container (`props.mount`, defaulting
 * to `document.body`) instead of wherever the `Portal` call sits in the
 * tree — the usual escape hatch for modals, tooltips, and toasts that need
 * to sit outside an `overflow: hidden`/`position: relative` ancestor while
 * still being declared, and disposed, alongside the rest of the UI that
 * owns them. Returns an empty marker node so it can still be used exactly
 * like any other child in the tree it's logically part of.
 */
export function Portal(props: { mount?: Element; children: Child }): Node {
	const target = props.mount ?? document.body;
	const nodes = collectNodes(props.children);
	for (const node of nodes) target.appendChild(node);

	onCleanup(() => {
		for (const node of nodes) node.parentNode?.removeChild(node);
	});

	return document.createComment('xtags-portal');
}

/**
 * Multi-branch conditional — an N-way `Show`. Pre-builds every branch's
 * nodes once (same "toggle without rebuild" behavior as `Show`) and swaps
 * in whichever one's `when` is first to return truthy:
 *
 * ```tsx
 * <Switch fallback={<p>no match</p>}>
 *   <Match when={() => status() === 'loading'}><Spinner /></Match>
 *   <Match when={() => status() === 'error'}><ErrorBanner /></Match>
 *   <Match when={() => status() === 'ready'}><Results /></Match>
 * </Switch>
 * ```
 */
export function Switch(props: { children: Child; fallback?: Child }): Node {
	// Each <Match> child was built via h(Match, {...}), and Match() (below)
	// just hands its own props straight back instead of building any DOM —
	// so what actually arrives here as `children` is an array of MatchProps
	// objects wearing a `Node` type for h()'s sake, not real nodes. Same
	// trick solid-js's Switch/Match uses, and for the same reason: it lets
	// <Match> sit in Switch's ordinary JSX children slot without every
	// branch's DOM getting eagerly built (by `h()` evaluating JSX children
	// before the parent component runs) only to have all but one thrown away.
	const branches = ([] as Child[])
		.concat(props.children ?? [])
		.filter((c) => c !== null && typeof c === 'object' && 'when' in (c as object))
		.map((c) => c as unknown as MatchProps);

	// Lazy mode: any thunk branch (`<Match when=…>{() => <Page/>}</Match>`) or
	// thunk fallback means "build only the selected branch, dispose the rest".
	if (branches.some((b) => isThunk(b.children)) || isThunk(props.fallback)) {
		const frag = document.createDocumentFragment();
		const prebuilt = branches.map((b) =>
			isThunk(b.children) ? null : collectNodes(b.children)
		);
		const active = computed(() => branches.findIndex((b) => b.when()));
		mountDynamic(frag, () => {
			const i = active();
			const branch = branches[i];
			if (branch) return prebuilt[i] ?? resolveBranch(branch.children);
			return resolveBranch(props.fallback);
		});
		return frag;
	}

	const anchor = document.createElement('span');
	anchor.style.display = 'contents';

	const built = branches.map((branch) => ({
		when: branch.when,
		nodes: collectNodes(branch.children),
	}));
	const fallbackNodes = props.fallback !== undefined ? collectNodes(props.fallback) : [];

	effect(() => {
		const active = built.find((branch) => branch.when());
		anchor.replaceChildren(...(active ? active.nodes : fallbackNodes));
	});

	return anchor;
}

interface MatchProps {
	when: () => unknown;
	children: Child;
}

/**
 * One branch of a `Switch`. Only meaningful as a direct child of `Switch`
 * — on its own it builds no DOM at all, it just hands its `when`/`children`
 * back to whichever `Switch` is evaluating its children (see the comment
 * in `Switch` above for why that's what makes the pairing work).
 */
export function Match(props: MatchProps): Node {
	return props as unknown as Node;
}

interface ContextEntry {
	ctx: object;
	value: unknown;
}

// A flat stack rather than a per-node tree: `Provider` pushes before
// evaluating its (necessarily deferred — see the Provider implementation
// below) children and pops after, so for the whole synchronous span in
// which a descendant's component function actually runs, the innermost
// enclosing Provider's value for a given context is whatever's nearest the
// top of this stack. `useContext` just walks it from the top down.
const contextStack: ContextEntry[] = [];

export interface Context<T> {
	readonly defaultValue: T;
	/**
	 * `children` must be a *function* (`() => <Child/>`), not a `<Child/>`
	 * passed directly. `h()` evaluates JSX children before calling the
	 * component they're passed to — by the time `Provider` runs, a directly-
	 * nested `<Consumer/>` would already have finished running and already
	 * called `useContext()` too early to see `value`. Wrapping it in a
	 * function defers that call until `Provider` is the one invoking it,
	 * which is after the value has been pushed onto the context stack.
	 */
	Provider: (props: { value: T; children: () => Child }) => Node;
}

/**
 * The "context/provider system for passing values down without prop
 * drilling" this library's README used to list under "what's still not
 * here". Create one with a default, read it with `useContext`, and supply
 * a value to a subtree with `<ctx.Provider>`:
 *
 * ```tsx
 * const ThemeContext = createContext<Signal<'light' | 'dark'>>(theme);
 *
 * const App = () => (
 *   <ThemeContext.Provider value={theme}>
 *     {() => <Toolbar />}
 *   </ThemeContext.Provider>
 * );
 *
 * const Toolbar = () => {
 *   const theme = useContext(ThemeContext); // the Signal itself
 *   return <div class={theme}>...</div>;    // still reactive from here down
 * };
 * ```
 *
 * Passing a `Signal` (rather than a plain value) as `value` is how you get
 * a context that stays live as it changes — `useContext` itself is a plain
 * one-time lookup done while a descendant is being built, same as reading
 * any other prop; it's whatever *value* you handed it (a signal or not)
 * that determines whether descendants react to later changes.
 */
export function createContext<T>(defaultValue: T): Context<T> {
	const ctx: Context<T> = {
		defaultValue,
		Provider(props) {
			if (typeof props.children !== 'function') {
				throw new TypeError(
					"Context.Provider's children must be a function — " +
						'`<ctx.Provider value={v}>{() => <Child/>}</ctx.Provider>`, not ' +
						'`<ctx.Provider value={v}><Child/></ctx.Provider>`. h() evaluates JSX ' +
						'children before calling Provider, so a directly-nested <Child/> would ' +
						'already have run (and already called useContext too early) by the time ' +
						'Provider gets a chance to make this value visible to it.'
				);
			}
			contextStack.push({ ctx, value: props.value });
			try {
				return Fragment({ children: props.children() });
			} finally {
				contextStack.pop();
			}
		},
	};
	return ctx;
}

/**
 * Reads the nearest enclosing `<ctx.Provider value={...}>`'s value for
 * `ctx`, or `ctx`'s `defaultValue` if it's being called outside any
 * matching Provider. Must be called synchronously while the consuming
 * component is being built (i.e. directly in a component function's body,
 * not inside a later callback) — same as reading any other prop.
 */
export function useContext<T>(ctx: Context<T>): T {
	for (let i = contextStack.length - 1; i >= 0; i--) {
		const frame = contextStack[i];
		if (frame && frame.ctx === ctx) return frame.value as T;
	}
	return ctx.defaultValue;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// Tags that must be created with `document.createElementNS(SVG_NS, ...)`
// instead of `document.createElement(...)`. Without this, `h('svg', ...)`
// and friends produce a plain, inert `HTMLUnknownElement` — the browser
// never renders it as a vector graphic at all, and every attribute on it
// is silently pointless. This is the full set of standard SVG element
// names; anything not in this set (including custom elements *inside* an
// `<svg>`, e.g. `foreignObject` content) still goes through the normal
// HTML path, which is correct for HTML embedded via `foreignObject`.
const SVG_TAGS = new Set([
	'svg',
	'a',
	'circle',
	'clipPath',
	'defs',
	'desc',
	'ellipse',
	'feBlend',
	'feColorMatrix',
	'feComponentTransfer',
	'feComposite',
	'feConvolveMatrix',
	'feDiffuseLighting',
	'feDisplacementMap',
	'feDistantLight',
	'feDropShadow',
	'feFlood',
	'feFuncA',
	'feFuncB',
	'feFuncG',
	'feFuncR',
	'feGaussianBlur',
	'feImage',
	'feMerge',
	'feMergeNode',
	'feMorphology',
	'feOffset',
	'fePointLight',
	'feSpecularLighting',
	'feSpotLight',
	'feTile',
	'feTurbulence',
	'filter',
	'foreignObject',
	'g',
	'image',
	'line',
	'linearGradient',
	'marker',
	'mask',
	'metadata',
	'mpath',
	'path',
	'pattern',
	'polygon',
	'polyline',
	'radialGradient',
	'rect',
	'stop',
	'switch',
	'symbol',
	'text',
	'textPath',
	'title',
	'tspan',
	'use',
	'view',
	'animate',
	'animateMotion',
	'animateTransform',
	'set',
]);

function createElement(tag: string): HTMLElement {
	const el = SVG_TAGS.has(tag)
		? document.createElementNS(SVG_NS, tag)
		: document.createElement(tag);
	return el as HTMLElement;
}

/**
 * Props applied as a real DOM/IDL property (`el.value = x`) rather than a
 * string attribute (`el.setAttribute('value', x)`) whenever the element
 * actually has that property. This matters most for `value`/`checked`:
 * the *attribute* only ever sets the element's initial/default state — once
 * a user (or your own code) has interacted with the control, setting the
 * attribute again does nothing, because the live value has diverged from
 * it. Setting the property keeps a `value={someSignal}`-style binding
 * authoritative for the control's entire lifetime, the way a "controlled
 * input" is meant to work.
 */
const PROPERTY_PROPS = new Set([
	'value',
	'checked',
	'selected',
	'indeterminate',
	'defaultValue',
	'defaultChecked',
	'muted',
]);

// A handful of event names people intuitively spell differently than the
// browser does; `onDoubleClick` silently registering a `doubleclick`
// listener (which no browser ever fires) is a real, silent footgun.
const EVENT_NAME_ALIASES: Record<string, string> = {
	doubleclick: 'dblclick',
};

/**
 * Applies `props` to `el` in one of two passes (see `h()`): the *early* pass
 * handles attributes, classes, styles and events; the *late* pass (after the
 * children exist) handles live properties, `model` and `ref`.
 *
 * Any non-event, non-`ref` prop whose value is a function (a `Signal` or a
 * plain `() => …` accessor) is bound reactively.
 */
function applyProps(el: HTMLElement, props: Record<string, unknown>, late: boolean): void {
	for (const [key, value] of Object.entries(props)) {
		if (key === 'children') continue;

		const isLate = key === 'ref' || key === 'model' || (PROPERTY_PROPS.has(key) && key in el);
		if (isLate !== late) continue;

		if (key === 'ref') {
			bindRef(el, value);
			continue;
		}

		if (key === 'model' && isSignal(value)) {
			bindModel(el, value);
			continue;
		}

		if (key === 'style') {
			bindStyle(el, value);
			continue;
		}

		if (key === 'class' || key === 'className') {
			bindClass(el, value);
			continue;
		}

		if (
			key.startsWith('on') &&
			key.length > 2 &&
			(typeof value === 'function' || Array.isArray(value))
		) {
			bindEvent(el, key, value as EventListener | [EventListener, AddEventListenerOptions?]);
			continue;
		}

		if (PROPERTY_PROPS.has(key) && key in el) {
			bindProperty(el, key, value);
			continue;
		}

		if (typeof value === 'function') {
			const accessor = value as () => unknown;
			effect(() => setAttr(el, key, accessor()));
			continue;
		}

		setAttr(el, key, value);
	}
}

function bindRef(el: HTMLElement, value: unknown): void {
	if (typeof value === 'function') {
		(value as (el: HTMLElement) => void)(el);
	} else if (value && typeof value === 'object') {
		(value as { current: HTMLElement | null }).current = el;
		onCleanup(() => {
			(value as { current: HTMLElement | null }).current = null;
		});
	}
}

/**
 * Two-way binding for form controls: `<input model={name} />` keeps
 * `name` and the input's live value in sync in both directions, instead of
 * wiring up `value`/`onInput` (or `checked`/`onChange`) by hand every time.
 * Checkboxes and radios bind to `.checked` via a `change` listener and
 * expect a boolean signal; everything else binds to `.value` via an
 * `input` listener and expects a string signal.
 */
function bindModel(el: HTMLElement, sig: Signal<unknown>): void {
	const isCheckable =
		el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio');

	if (isCheckable) {
		const input = el as HTMLInputElement;
		effect(() => {
			input.checked = Boolean(sig());
		});
		const onChange = () => (sig as Signal<boolean>).set(input.checked);
		input.addEventListener('change', onChange);
		onCleanup(() => input.removeEventListener('change', onChange));
	} else {
		const field = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
		effect(() => {
			writeProperty(field, 'value', sig());
		});
		registerSelectRefresh(field, () => writeProperty(field, 'value', untrack(sig)));
		const onInput = () => (sig as Signal<string>).set(field.value);
		field.addEventListener('input', onInput);
		onCleanup(() => field.removeEventListener('input', onInput));
	}
}

function bindEvent(
	el: HTMLElement,
	key: string,
	value: EventListener | [EventListener, AddEventListenerOptions?]
): void {
	const [handler, options] = Array.isArray(value) ? value : [value, undefined];
	if (typeof handler !== 'function') return;

	const raw = key.slice(2).toLowerCase();
	const eventName = EVENT_NAME_ALIASES[raw] ?? raw;

	el.addEventListener(eventName, handler, options);
	onCleanup(() => el.removeEventListener(eventName, handler, options));
}

/**
 * Writes a live property, skipping the write when the control already holds
 * that value. For text fields this matters: assigning the value a user just
 * typed back into the control (the normal "state mirrors the input" round
 * trip) can reset the caret or break IME composition in some WebViews.
 */
function writeProperty(el: HTMLElement, key: string, next: unknown): void {
	const target = el as unknown as Record<string, unknown>;
	if (key === 'value') {
		const str = next === null || next === undefined ? '' : String(next);
		if (target.value !== str) target.value = str;
	} else if (target[key] !== next) {
		target[key] = next;
	}
}

function bindProperty(el: HTMLElement, key: string, value: unknown): void {
	if (typeof value === 'function') {
		const accessor = value as () => unknown;
		effect(() => writeProperty(el, key, accessor()));
		if (key === 'value')
			registerSelectRefresh(el, () => writeProperty(el, key, untrack(accessor)));
	} else {
		writeProperty(el, key, value);
		if (key === 'value') registerSelectRefresh(el, () => writeProperty(el, key, value));
	}
}

// --- <select> value re-application -------------------------------------
//
// A <select>'s `value` can only pick an <option> that exists. When options
// are built/removed *after* the value was bound (a reactive child, `For`,
// `Show`), the selection silently falls back to the first option. Controls
// with a bound value register a refresher here, and every place that changes
// an element's children calls `refreshSelect` afterwards.
const selectRefreshers = new WeakMap<Element, () => void>();

function registerSelectRefresh(el: Element, refresh: () => void): void {
	if (el.nodeName === 'SELECT') selectRefreshers.set(el, refresh);
}

/** Re-applies the bound value of the <select> that `node` is (or sits directly inside, e.g. via <optgroup>). */
export function refreshSelect(node: Node | null): void {
	if (!node) return;
	const select =
		node.nodeName === 'SELECT' ? node : node.nodeName === 'OPTGROUP' ? node.parentNode : null;
	if (select) selectRefreshers.get(select as Element)?.();
}

// --- style ----------------------------------------------------------------

// Same rule Preact uses: a bare number gets "px" unless the property is
// unitless (`flex`, `opacity`, `zIndex`, `lineHeight`, `gridColumn`, …).
const IS_NON_DIMENSIONAL = /acit|ex(?:s|g|n|p|$)|rph|grid|ows|mnc|ntw|ine[ch]|zoo|^ord|itera/i;

function setStyleProp(el: HTMLElement, prop: string, value: unknown): void {
	const style = el.style as unknown as Record<string, string> & CSSStyleDeclaration;
	const custom = prop.includes('-');
	if (value === null || value === undefined || value === false || value === '') {
		if (custom) style.removeProperty(prop);
		else style[prop] = '';
		return;
	}
	const str =
		typeof value === 'number' && !IS_NON_DIMENSIONAL.test(prop) ? `${value}px` : String(value);
	// `style[prop] = …` silently ignores CSS custom properties (`--accent`) and
	// is unreliable for kebab-case names; `setProperty` handles both.
	if (custom) style.setProperty(prop, str);
	else style[prop] = str;
}

function applyStyle(
	el: HTMLElement,
	style: unknown,
	previous: Set<string>,
	perPropReactive: boolean
): Set<string> {
	if (typeof style === 'string') {
		el.style.cssText = style;
		return new Set();
	}
	const next = new Set<string>();
	if (style && typeof style === 'object') {
		for (const [prop, raw] of Object.entries(style as Record<string, unknown>)) {
			next.add(prop);
			if (perPropReactive && typeof raw === 'function') {
				const accessor = raw as () => unknown;
				effect(() => setStyleProp(el, prop, accessor()));
			} else {
				setStyleProp(el, prop, raw);
			}
		}
	}
	for (const prop of previous) if (!next.has(prop)) setStyleProp(el, prop, null);
	return next;
}

/**
 * `style` accepts a string, an object, or a function returning either.
 * Inside a static object each value may itself be a Signal/accessor; a
 * function-valued `style` is re-applied whole, and keys that disappear are
 * cleared.
 */
function bindStyle(el: HTMLElement, value: unknown): void {
	if (typeof value === 'function') {
		const accessor = value as () => unknown;
		let previous = new Set<string>();
		effect(() => {
			previous = applyStyle(el, accessor(), previous, false);
		});
	} else {
		applyStyle(el, value, new Set(), true);
	}
}

// --- class ------------------------------------------------------------------

type ClassValue = string | Record<string, unknown> | ClassValue[] | null | undefined;

function bindClass(el: HTMLElement, value: unknown): void {
	if (typeof value === 'function') {
		const accessor = value as () => ClassValue;
		effect(() => el.setAttribute('class', resolveClass(accessor())));
	} else {
		el.setAttribute('class', resolveClass(value as ClassValue));
	}
}

function resolveClass(value: ClassValue): string {
	if (!value) return '';
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) return value.map(resolveClass).filter(Boolean).join(' ');
	return Object.entries(value)
		.filter(([, enabled]) => Boolean(enabled))
		.map(([name]) => name)
		.join(' ');
}

function setAttr(el: HTMLElement, key: string, value: unknown): void {
	if (value === false || value === null || value === undefined) {
		el.removeAttribute(key);
	} else if (value === true) {
		el.setAttribute(key, '');
	} else {
		el.setAttribute(key, String(value));
	}
}

// --- children ------------------------------------------------------------------

function appendChildren(parent: Node, children: Child[]): void {
	for (const child of children) appendChild(parent, child);
}

function appendChild(parent: Node, child: Child): void {
	if (child === null || child === undefined || typeof child === 'boolean') return;

	if (Array.isArray(child)) {
		appendChildren(parent, child);
		return;
	}

	if (child instanceof Node) {
		parent.appendChild(child);
		return;
	}

	// A Signal or any `() => Child`: a reactive region.
	if (typeof child === 'function') {
		mountDynamic(parent, child as () => Child);
		return;
	}

	parent.appendChild(document.createTextNode(String(child)));
}

/**
 * A reactive region as a `Node`: `accessor` is re-run when what it reads
 * changes and its result replaces the region's content (see `mountDynamic`).
 * Handy for a component that is a pure function of signals/props:
 *
 * ```tsx
 * const Badge = (props) => dynamic(() => <b>{props.label()}</b>);
 * ```
 */
export function dynamic(accessor: () => Child): Node {
	const fragment = document.createDocumentFragment();
	mountDynamic(fragment, accessor);
	return fragment;
}

/** Removes every node strictly between two sibling markers. */
export function clearRange(start: Node, end: Node): void {
	const parent = start.parentNode;
	if (!parent) return;
	let node = start.nextSibling;
	while (node && node !== end) {
		const next = node.nextSibling;
		parent.removeChild(node);
		node = next;
	}
}

/**
 * A reactive region: `accessor` is re-run whenever a signal it reads changes,
 * and whatever it returns (text, a node, an array, null…) replaces the
 * region's previous content.
 *
 * - The region is delimited by two comment markers and is cleared *by range*
 *   (everything between the markers), so a nested region that changed its own
 *   content in the meantime can't leave stale nodes behind.
 * - Everything built during one run (components, bindings, `onCleanup`s) is
 *   owned by that run and disposed before the next one — so a view that
 *   mounts a page for `view === 'x'` really unmounts it again.
 * - Plain text updates in place (same text node) instead of rebuilding.
 */
function mountDynamic(parent: Node, accessor: () => Child): void {
	const start = document.createComment('');
	const end = document.createComment('');
	parent.appendChild(start);
	parent.appendChild(end);
	let text: Text | null = null;

	effect(() => {
		const value = accessor();
		const container = end.parentNode;
		if (!container) return; // region was removed from the document wholesale

		if (typeof value === 'string' || typeof value === 'number') {
			const str = String(value);
			if (text && start.nextSibling === text && text.nextSibling === end) {
				if (text.data !== str) text.data = str;
				return;
			}
			clearRange(start, end);
			text = document.createTextNode(str);
			container.insertBefore(text, end);
			refreshSelect(container);
			return;
		}

		text = null;

		// Returning the very node that is already in place is a no-op (keeps focus/scroll).
		if (value instanceof Node && start.nextSibling === value && value.nextSibling === end)
			return;

		const fragment = document.createDocumentFragment();
		appendChild(fragment, value);
		clearRange(start, end);
		container.insertBefore(fragment, end);
		refreshSelect(container);
	});
}

/** Turns any `Child` into the flat list of live DOM nodes it renders as. */
export function collectNodes(child: Child): Node[] {
	const tmp = document.createDocumentFragment();
	appendChild(tmp, child);
	return Array.from(tmp.childNodes);
}
