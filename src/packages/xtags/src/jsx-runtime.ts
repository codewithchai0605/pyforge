import { Fragment, h, type Child } from "./index";
import { callComponent } from "./dom";

/** Upstream gets this from acode-plugin-types' html-tag-js typings; without
 *  that package it's just "any attribute bag". */
type HTMLElementAttributes = Record<string, unknown>;

/** Any attribute may also be given as a function (`class={() => …}`) to bind it reactively. */
type Reactive<T> = { [K in keyof T]?: T[K] | (() => T[K]) };

type IntrinsicProps = Reactive<Omit<HTMLElementAttributes, "children">> & {
  children?: Child;
};

type JsxProps = Record<string, unknown> & {
  children?: Child;
};

type JsxComponent = (props: never) => Node;

/** TypeScript's automatic JSX runtime for XTags. */
export function jsx(
  type: string,
  props: IntrinsicProps | null,
  key?: unknown,
): Node;
export function jsx(
  type: JsxComponent,
  props: JsxProps | null,
  key?: unknown,
): Node;
export function jsx(
  type: string | JsxComponent,
  props: JsxProps | null,
  key?: unknown,
): Node {
  const { children, ...attributes } = props ?? {};

  if (typeof type === "string") {
    return h(type, attributes, ...(children === undefined ? [] : [children]));
  }

  // `key` is reserved by the automatic JSX runtime: the compiler strips it
  // from props and passes it as the 3rd argument. On an element it is only a
  // reconciliation hint (there is nothing to reconcile here), so it is
  // dropped above; for a component it is handed back as an ordinary prop —
  // that is what makes `<For key={(item) => item.id}>` work under JSX.
  // Components run once and untracked (see callComponent).
  return callComponent(type as (props: unknown) => Node, {
    ...attributes,
    ...(key === undefined ? {} : { key }),
    ...(children === undefined ? {} : { children }),
  });
}

export const jsxs = jsx;
export const jsxDEV = jsx;
export { Fragment };

export namespace JSX {
  export type Element = Node;

  export interface ElementChildrenAttribute {
    children: unknown;
  }

  export interface IntrinsicElements {
    [elementName: string]: IntrinsicProps;
  }
}
