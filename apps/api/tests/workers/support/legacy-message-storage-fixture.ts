import { DurableObject } from 'cloudflare:workers';

/** Empty SQLite object: upgrade tests construct a real pre-078 database here. */
export class LegacyMessageStorageFixture extends DurableObject {}
