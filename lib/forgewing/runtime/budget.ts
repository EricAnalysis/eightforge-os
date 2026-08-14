export class ForgewingCallBudget {
  readonly #maximum: number;
  #used = 0;

  constructor(maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 0) {
      throw new Error('Forgewing call budget must be a non-negative safe integer');
    }
    this.#maximum = maximum;
  }

  get used(): number {
    return this.#used;
  }

  tryConsume(): boolean {
    if (this.#used >= this.#maximum) return false;
    this.#used += 1;
    return true;
  }
}

