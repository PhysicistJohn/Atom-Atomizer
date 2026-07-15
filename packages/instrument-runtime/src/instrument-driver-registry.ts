import type { InstrumentDriverId } from '@tinysa/contracts';
import { validateInstrumentDriver, type InstrumentDriver } from './instrument-driver.js';

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
}
