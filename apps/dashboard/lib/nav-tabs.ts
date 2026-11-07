/**
 * The destinations, in one place, because there are now TWO navigations.
 *
 * The top strip is the desktop one. Below `md` a bottom bar takes over, and
 * the moment a second component holds its own copy of this list the two
 * start to drift — a route added to one and not the other is unreachable
 * from half the product, and nothing fails to tell you.
 *
 * ORDER IS THE DESKTOP ORDER and must stay that way: the top strip renders
 * this array directly. The bottom bar does not reorder it either; it takes
 * the first PRIMARY_COUNT for its own slots and puts the rest behind More,
 * so "most used" is expressed by position here rather than by a second list
 * that could disagree with this one.
 */
import {
  LayoutGrid,
  Network,
  SlidersHorizontal,
  Receipt,
  Wallet,
  KeyRound,
  Settings,
  type LucideIcon,
} from "lucide-react";

export type NavTab = {
  label: string;
  href: string;
  /**
   * Shown only in the bottom bar. The top strip is text-only and stays that
   * way — icons there would be decoration beside a label that already says
   * the same thing, and the strip is the thing that was short of width.
   */
  icon: LucideIcon;
  /**
   * What the bottom bar calls it. "Budget Tree" is 11 characters and does
   * not fit a 75px slot at a legible size; "Agents" does. The long name is
   * the right one on desktop and the wrong one here, so both exist rather
   * than one being bent to serve the other.
   */
  shortLabel?: string;
};

/**
 * Registry tab hidden — planned as standalone registry.usefloat.xyz once
 * APIs are natively x402. Not linked until that work is complete.
 *
 * DOCS IS NOT A TAB. Every other entry switches which part of this vault you
 * are looking at; Docs leaves the application entirely, and it was the only
 * one carrying a target="_blank". It also cost 51px in a strip that was
 * measured 42px short of fitting "Settings" at 900px — so the item that is
 * not a section is the item that gives up its seat.
 */
export const NAV_TABS: NavTab[] = [
  { label: "Overview", href: "/", icon: LayoutGrid },
  { label: "Budget Tree", href: "/agents", icon: Network, shortLabel: "Agents" },
  { label: "Policies", href: "/policies", icon: SlidersHorizontal },
  { label: "Activity", href: "/activity", icon: Receipt },
  { label: "Fund", href: "/fund", icon: Wallet },
  { label: "Agent Keys", href: "/api-keys", icon: KeyRound, shortLabel: "Keys" },
  { label: "Settings", href: "/settings", icon: Settings },
];

/**
 * How many get their own slot in the bottom bar before More absorbs the rest.
 *
 * FOUR, plus More, is five slots. On the narrowest phone this product will
 * meet (320px, an iPhone SE in portrait) five slots are 64px each — above
 * the 44px touch floor with room for a label beneath the icon. Six slots is
 * 53px, which still clears the floor but leaves no room for the label, and
 * an unlabelled icon row is a guessing game.
 *
 * The four are Overview, Budget Tree, Policies and Activity: look, see the
 * agents, change what they may spend, check what they did. Fund, Agent Keys
 * and Settings are things you do once and revisit rarely, so they are one
 * extra tap behind More rather than crowding the four that are not.
 */
export const PRIMARY_COUNT = 4;

export const PRIMARY_TABS = NAV_TABS.slice(0, PRIMARY_COUNT);
export const MORE_TABS = NAV_TABS.slice(PRIMARY_COUNT);

export const DOCS_URL = "https://docs.usefloat.xyz/";

/**
 * Whether a tab is the one being looked at.
 *
 * "/" needs an exact match or it claims every route, since every path starts
 * with a slash. Everything else matches its own subtree, so /activity/abc
 * still lights up Activity.
 */
export function isTabActive(href: string, pathname: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");
}
