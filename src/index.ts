import {sleep} from './utils';


interface RequestCall<T> {
  (...args: any[]): Promise<T>;
}

interface ChainCall<T> {
  (next: RequestCall<T>): RequestCall<T>;
}

class RetryError extends Error {
  constructor(public readonly errors: Error[]) {
    super();
  }
}

interface RetryOptions {
  maxAttempts?: number;
  delay?: number;
  maxDelay?: number;
}


class TimeoutError extends Error {
  constructor() {
    super();
  }
}

interface TimeoutOptions {
  maxWait: number;
}


class Diplomat<T> {

  private chain: Array<ChainCall<T>> = [];

  run(fn: RequestCall<T>): RequestCall<T> {
    return this.chain.reduceRight<RequestCall<T>>((f, chainFn) => chainFn(f), fn);
  }

  fallback(fn: RequestCall<T>): Diplomat<T> {
    this.chain.push(
      (next) => (...args) => {
        console.log('-> fallback', ...args);
        return next(...args).catch(() => fn(...args));
      });
    return this;
  }

  retry(options: RetryOptions = {}): Diplomat<T> {
    const maxAttempts = options.maxAttempts || 3;
    const delay = options.delay || 1000;
    const maxDelay = options.maxDelay || 60 * 1000;

    this.chain.push(
      (next) => async (...args) => {
        console.log('-> retry', ...args);
        const startTime = Date.now();
        let attempts = 0;
        let errors = [];
        while (true) {
          try {
            attempts++;
            console.log('--> attempt', attempts);
            return await next(...args);
          } catch (err) {
            console.log('... error', err);
            errors.push(err);
            if (attempts >= maxAttempts || Date.now() + delay - startTime > maxDelay) {
              console.log('<- RetryError');
              throw new RetryError(errors);
            }
          }
          if (delay > 0) {
            await sleep(delay);
          }
        }
      });
    return this;
  }

  timeout(options: TimeoutOptions): Diplomat<T> {
    this.chain.push(
      (next) => (...args) => {
        console.log('-> timeout', ...args);
        return Promise.race([
          next(...args),
          new Promise<T>((_resolve, reject) => {
            setTimeout(reject, options.maxWait, new TimeoutError());
          })
        ]);
      });
    return this;
  }

}

function diplomat<T>() {
  return new Diplomat<T>();
}

export {
  diplomat,
}
