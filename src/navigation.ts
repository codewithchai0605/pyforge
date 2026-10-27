import { computed, signal, type Signal } from "xtags";
import { pushBack } from "@/components/backStack";

/**
 * Page-level navigation, as a stack.
 *
 *   Home → Packages → Settings   then Back, Back  returns Settings → Packages → Home.
 *
 * Pages stay mounted while something is pushed on top of them, so coming back
 * finds the scroll position and any half-typed input exactly as it was left.
 * "Home" (the editor) is always the bottom of the stack and can't be popped;
 * Back on Home is the app-exit flow (see main.ts), not a navigation.
 *
 * Transient surfaces (dialogs, menus, the drawer, the output sheet) are not
 * routes, but they share one Back order with pages: every pushed page also
 * registers with backStack.ts, so Back always closes whichever layer was
 * opened most recently (a page opened over the output sheet closes before it).
 */
export type RouteName = "home" | "packages" | "settings" | "terminal";

export interface Router {
  /** Bottom → top. Always starts with 'home'. */
  readonly stack: Signal<RouteName[]>;
  readonly current: Signal<RouteName>;
  readonly canGoBack: Signal<boolean>;
  /** Show `route` on top. If it is already in the stack, everything above it is dropped instead of duplicating it. */
  push(route: RouteName): void;
  /** Close the top page. Returns false (and does nothing) when already on Home. */
  pop(): boolean;
  /** Back to Home, dropping every page above it. */
  home(): void;
  /** True if `route` is anywhere in the stack (open or covered). */
  isOpen(route: RouteName): boolean;
}

export function createRouter(): Router {
  const stack = signal<RouteName[]>(["home"]);
  const current = computed(() => stack()[stack().length - 1]!);
  const canGoBack = computed(() => stack().length > 1);
  /** One entry on the shared Back order per open page. */
  const backEntries = new Map<RouteName, () => void>();

  /** Replace the stack, keeping the shared Back order in step with which pages are open. */
  function setStack(next: RouteName[]): void {
    for (const [route, release] of [...backEntries]) {
      if (!next.includes(route)) {
        release();
        backEntries.delete(route);
      }
    }
    for (const route of next) {
      if (route !== "home" && !backEntries.has(route))
        backEntries.set(
          route,
          pushBack(() => router.pop()),
        );
    }
    stack.set(next);
  }

  const router: Router = {
    stack,
    current,
    canGoBack,
    push(route) {
      const s = stack.peek();
      const at = s.indexOf(route);
      if (at !== -1) {
        if (at !== s.length - 1) setStack(s.slice(0, at + 1));
        return;
      }
      setStack([...s, route]);
    },
    pop() {
      const s = stack.peek();
      if (s.length <= 1) return false;
      setStack(s.slice(0, -1));
      return true;
    },
    home() {
      if (stack.peek().length > 1) setStack(["home"]);
    },
    isOpen: (route) => stack.peek().includes(route),
  };
  return router;
}
