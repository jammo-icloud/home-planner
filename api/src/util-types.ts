/**
 * `Omit<Union, K>` collapses a discriminated union to only its shared keys,
 * which silently destroys every variant's own fields. This distributes over the
 * union first, so `DistributiveOmit<Event, 'id'>` is still a union of events.
 */
export type DistributiveOmit<T, K extends PropertyKey> =
  T extends unknown ? Omit<T, K> : never;
