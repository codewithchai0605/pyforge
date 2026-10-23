import { computed } from 'xtags';
import type { Child } from 'xtags';
import type { RouteName, Router } from '@/navigation';
import { icon } from './icons';

export interface PageProps {
  route: RouteName;
  router: Router;
  title: string;
  /** Buttons for the right side of the header. */
  actions?: Child;
  /** Full-bleed body instead of a padded, scrolling column. */
  flush?: boolean;
  children?: Child;
}

/**
 * A full-screen page on the navigation stack. It slides in when its route is
 * pushed, stays mounted underneath whatever is pushed on top of it (so scroll
 * position and half-typed input survive a round trip), and its header Back
 * button is exactly Android's Back: `router.pop()`.
 */
export function Page({ route, router, title, actions, flush, children }: PageProps): Node {
  const isOpen = computed(() => router.stack().includes(route));
  const isTop = computed(() => router.current() === route);
  return (
    <div
      id={`${route}-page`}
      class={computed(() => ({ page: true, open: isOpen(), covered: isOpen() && !isTop() }))}
      style={{ zIndex: computed(() => String(50 + router.stack().indexOf(route))) }}
      aria-hidden={computed(() => String(!isTop()))}
      role="dialog"
      aria-label={title}
    >
      <header class="page-header">
        <button type="button" class="icon-btn" title="Back" aria-label="Back" onClick={() => router.pop()}>
          {icon('chevronRight', 22)}
        </button>
        <h1 class="page-title">{title}</h1>
        <span class="panel-spacer" />
        {actions}
      </header>
      <div class={flush ? 'page-body flush' : 'page-scroll'}>{children}</div>
    </div>
  );
}
