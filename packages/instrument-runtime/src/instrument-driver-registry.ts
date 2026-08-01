import type { InstrumentDriverId } from '@tinysa/contracts';
import {
  validateInstrumentDriver,
  validateInstrumentManualEndpointResult,
  type InstrumentDriver,
  type InstrumentManualEndpointResult,
} from './instrument-driver.js';

/** Immutable registry of drivers selected by trusted application composition. */
export class InstrumentDriverRegistry {
  readonly #drivers: readonly InstrumentDriver[];
  readonly #byId: ReadonlyMap<InstrumentDriverId, InstrumentDriver>;

  constructor(drivers: readonly InstrumentDriver[]) {
    const values = drivers.map((driver) => validateInstrumentDriver(driver));
    const byId = new Map<InstrumentDriverId, InstrumentDriver>();
    for (const driver of values) {
      if (byId.has(driver.driverId)) throw new Error(`Duplicate instrument driver ID ${driver.driverId}`);
      byId.set(driver.driverId, driver);
    }
    this.#drivers = Object.freeze([...values]);
    this.#byId = byId;
  }

  list(): readonly InstrumentDriver[] { return this.#drivers; }
  get(driverId: InstrumentDriverId): InstrumentDriver | undefined { return this.#byId.get(driverId); }
  require(driverId: InstrumentDriverId): InstrumentDriver {
    const driver = this.get(driverId);
    if (!driver) throw new Error(`Instrument driver ${driverId} is not statically registered`);
    return driver;
  }

  /**
   * Dispatches a user-entered address only through driver-owned standard
   * bootstrap hooks.  Sequential probing avoids turning one UI action into a
   * burst of concurrent hardware/network traffic as drivers are added.
   *
   * Deliberately return a homogeneous failure to the app: a driver may retain
   * native diagnostics internally, but a generic connection screen must not
   * become a catalog of device families.
   */
  async addManualEndpoint(endpoint: string): Promise<InstrumentManualEndpointResult> {
    const drivers = this.#drivers.filter((driver) => driver.addManualEndpoint !== undefined);
    if (!drivers.length) {
      return { ok: false, message: 'No installed instrument driver accepts manual addresses.' };
    }
    for (const driver of drivers) {
      try {
        const result = validateInstrumentManualEndpointResult(
          driver,
          await driver.addManualEndpoint!(endpoint),
        );
        if (result.ok) return result;
      } catch {
        // The driver contract boundary has already contained the diagnostic.
        // A subsequent standard driver may still recognize this address.
      }
    }
    return { ok: false, message: 'The address could not be verified by an installed instrument driver.' };
  }
}
