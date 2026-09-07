/**
 * Declarative state machines.
 *
 * Session, connector, receipt and document lifecycles are all defined as a
 * table of legal transitions rather than as scattered `if (status === ...)`
 * checks. This buys three things:
 *
 *  - Illegal transitions fail in one place, with one error shape.
 *  - The legal graph is inspectable, so the API can advertise what is possible
 *    from the current state, and docs can be generated from the source.
 *  - Terminal states are explicit, which is what lets reapers and schedulers
 *    reason about "can this ever change again?".
 */

import { invalidTransition } from './errors.ts';

export interface StateMachineSpec<S extends string> {
  /** Name used in error messages, e.g. `'Session'`. */
  name: string;
  initial: S;
  /** For each state, the states it may move to. */
  transitions: Readonly<Record<S, readonly S[]>>;
}

export class StateMachine<S extends string> {
  readonly name: string;
  readonly initial: S;
  readonly #transitions: Readonly<Record<S, readonly S[]>>;

  constructor(spec: StateMachineSpec<S>) {
    this.name = spec.name;
    this.initial = spec.initial;
    this.#transitions = spec.transitions;
  }

  /** Every state in the machine. */
  states(): S[] {
    return Object.keys(this.#transitions) as S[];
  }

  /** States reachable in one step from `from`. */
  next(from: S): readonly S[] {
    return this.#transitions[from] ?? [];
  }

  canTransition(from: S, to: S): boolean {
    return this.next(from).includes(to);
  }

  /** A state with no outgoing transitions can never change again. */
  isTerminal(state: S): boolean {
    return this.next(state).length === 0;
  }

  /**
   * Assert a transition is legal, throwing `INVALID_STATE_TRANSITION` if not.
   * Returns `to` so it can be used inline: `status = sm.assert(status, 'ready')`.
   */
  assert(from: S, to: S): S {
    if (!this.canTransition(from, to)) throw invalidTransition(this.name, from, to);
    return to;
  }

  /**
   * States from which `target` is reachable at all (transitively). Used to
   * answer "is it still possible for this to succeed?" without hard-coding.
   */
  canEventuallyReach(from: S, target: S): boolean {
    const seen = new Set<S>([from]);
    const queue: S[] = [from];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === target) return true;
      for (const next of this.next(current)) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return false;
  }
}
