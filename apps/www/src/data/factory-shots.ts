/**
 * Real SAM screen captures used by the software-factory homepage (src/components/factory/): the
 * hero's home screen, captured from the current app (real components, mocked Northwind Labs data)
 * in both themes (`apps/www/public/images/factory/README.md`). Every other screen on the page is
 * an HTML version of the app's components (src/components/factory/mock/, HeroCard.astro).
 */
export interface FactoryShot {
  width: number;
  height: number;
  /** What the screen shows, for screen readers. */
  alt: string;
}

export const factoryShots = {
  'dashboard': {
    width: 1800,
    height: 1125,
    alt: "The SAM home screen: active tasks across the Payments, Merchant Portal and Ledger projects, some in progress, one sleeping, two queued",
  },
} satisfies Record<string, FactoryShot>;

export type FactoryShotName = keyof typeof factoryShots;

export const factoryShotFiles = (name: FactoryShotName) => ({
  dark: `/images/factory/${name}.webp`,
  light: `/images/factory/${name}-light.webp`,
});

/**
 * The control plane on a single VM is in progress. While false, the page labels that option
 * "soon"; flip it when the single-VM installer ships.
 */
export const SINGLE_VM_INSTALL_SHIPPED = false;
