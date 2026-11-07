"use client";

/**
 * The phone navigation.
 *
 * WHY A SECOND NAV EXISTS AT ALL. The top strip holds seven tabs. Measured
 * at 375px it rendered 327px past the viewport on every route — it scrolls,
 * with a fade, so nothing was unreachable, but reaching Settings meant
 * dragging a one-line strip sideways with the same thumb that is holding the
 * phone. That is the "stress through clicking" this replaces.
 *
 * It sits at the BOTTOM because that is where a thumb is. The top of a
 * modern phone is the hardest part of the screen to reach one-handed, and it
 * is where this product had put its only means of navigation.
 *
 * BELOW `md` ONLY. Above it this renders nothing and the top strip is
 * unchanged — not reduced, not restyled. The desktop design is approved as
 * it stands.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { MoreHorizontal, X, ExternalLink } from "lucide-react";
import { PRIMARY_TABS, MORE_TABS, DOCS_URL, isTabActive } from "@/lib/nav-tabs";
// INK/MUTED rather than `var(--ink)`: these are Tailwind THEME colours, not
// CSS custom properties, so there is no `--ink` to read at runtime. The
// token exists twice on purpose (see tailwind.config.ts) and lib/colors is
// the half that inline styles use.
import { INK, MUTED } from "@/lib/colors";

export function MobileTabBar() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);

  // Navigating closes the sheet. Without this, tapping Settings inside it
  // routes correctly and leaves the sheet sitting on top of the page you
  // just asked for.
  useEffect(() => {
    setMoreOpen(false);
  }, [pathname]);

  /**
   * Escape closes it, and while it is open the page behind does not scroll.
   *
   * The scroll lock is not polish: a fixed sheet over a scrollable page lets
   * a drag that starts on the sheet scroll the content underneath, so the
   * user dismisses the sheet and finds themselves somewhere else in a list
   * they did not mean to move.
   */
  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  const moreActive = MORE_TABS.some((t) => isTabActive(t.href, pathname));

  return (
    <>
      {moreOpen ? (
        <div className="fixed inset-0 z-50 md:hidden">
          {/* The scrim is a real button, not a div with an onClick: tapping
              outside a sheet to close it is the gesture everyone expects,
              and it should also be reachable from a keyboard. */}
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setMoreOpen(false)}
            className="absolute inset-0 bg-ink/20"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="More destinations"
            className="absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-line bg-card pb-[env(safe-area-inset-bottom)]"
          >
            <div className="flex items-center justify-between px-5 pt-4 pb-2">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-muted">
                More
              </p>
              <button
                type="button"
                onClick={() => setMoreOpen(false)}
                aria-label="Close menu"
                className="-mr-2 flex h-11 w-11 items-center justify-center rounded-lg text-muted"
              >
                <X size={18} />
              </button>
            </div>
            <nav className="px-2 pb-3">
              {MORE_TABS.map((tab) => {
                const active = isTabActive(tab.href, pathname);
                const Icon = tab.icon;
                return (
                  <Link
                    key={tab.href}
                    href={tab.href}
                    aria-current={active ? "page" : undefined}
                    // h-14: comfortably past the 44px floor, and a full-width
                    // row is the easiest target a phone can offer.
                    className="flex h-14 items-center gap-3 rounded-lg px-3 text-[15px] font-medium"
                    style={{ color: active ? INK : MUTED }}
                  >
                    <Icon size={18} strokeWidth={active ? 2.2 : 1.8} />
                    {tab.label}
                  </Link>
                );
              })}
              {/* Docs is not a tab — it leaves the app — so it is last, and
                  says so with an icon rather than silently opening a new
                  window from something that looks like every row above it. */}
              <a
                href={DOCS_URL}
                target="_blank"
                rel="noreferrer"
                className="flex h-14 items-center gap-3 rounded-lg px-3 text-[15px] font-medium text-muted"
              >
                <ExternalLink size={18} strokeWidth={1.8} />
                Docs
              </a>
            </nav>
          </div>
        </div>
      ) : null}

      <nav
        aria-label="Primary"
        /* pb for the iPhone home indicator. Without it the bottom row of
           labels sits under the system gesture bar, where a tap is taken by
           the OS and not by us — the control looks present and does
           nothing, which is worse than not being there. */
        className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        <div className="flex">
          {PRIMARY_TABS.map((tab) => {
            const active = isTabActive(tab.href, pathname);
            const Icon = tab.icon;
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className="flex h-14 flex-1 flex-col items-center justify-center gap-1"
                style={{ color: active ? INK : MUTED }}
              >
                <Icon size={19} strokeWidth={active ? 2.2 : 1.7} />
                <span className="text-[10px] font-medium leading-none">
                  {tab.shortLabel ?? tab.label}
                </span>
              </Link>
            );
          })}
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            aria-expanded={moreOpen}
            aria-haspopup="dialog"
            className="flex h-14 flex-1 flex-col items-center justify-center gap-1"
            // More is lit when the page you are on lives behind it, or the
            // current section simply disappears from the navigation.
            style={{ color: moreActive ? INK : MUTED }}
          >
            <MoreHorizontal size={19} strokeWidth={moreActive ? 2.2 : 1.7} />
            <span className="text-[10px] font-medium leading-none">More</span>
          </button>
        </div>
      </nav>
    </>
  );
}
