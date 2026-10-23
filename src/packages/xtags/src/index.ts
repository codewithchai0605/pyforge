export {
  h,
  Fragment,
  Show,
  Portal,
  Switch,
  Match,
  createContext,
  useContext,
  dynamic,
} from "./dom";
export type {
  Accessor,
  Child,
  Component,
  ComponentProps,
  Context,
} from "./dom";
export { For } from "./list";
export type { ForProps } from "./list";
export { render } from "./render";
export {
  signal,
  effect,
  computed,
  isSignal,
  batch,
  untrack,
  onCleanup,
  createRoot,
  onMount,
  watch,
  read,
} from "./reactive";
export type { Signal } from "./reactive";

// So `import { h, Fragment } from 'xtags'; ...JSX...` type-checks under the
// classic JSX transform.
//
// Upstream xtags (the acode-plugin repo) gets `JSX.Element` and
// `JSX.IntrinsicElements` from the ambient html-tag-js typings that the
// acode-plugin-types package ships, and only adds `ElementChildrenAttribute`
// itself. This project has no such package, so it declares all three here
// (a global namespace can only be declared once, so if you ever add
// acode-plugin-types to this project, delete `Element` and
// `IntrinsicElements` below and keep `ElementChildrenAttribute`).
import type { Child } from "./dom";
declare global {
  namespace JSX {
    type Element = Node;
    interface IntrinsicElements {
      [tagName: string]: Record<string, unknown> & { children?: Child };
    }
    interface ElementChildrenAttribute {
      children: unknown;
    }
  }
}
