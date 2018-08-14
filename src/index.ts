import { sleep } from './utils';
import * as _ from 'lodash';


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

const enum CircuitBreakerState {
  CLOSED,
  OPEN,
  HALF_OPEN
}

const CircuitBreakerStateStr = [
  "CLOSED",
  "OPEN",
  "HALF_OPEN"
]

interface CircuitBreakerOption {
  failureCountThreshold: number;
  failureRateThreshold: number;
  window: number;
  slots: number;
  resetTimeout: number;
}

class CircuitBreakerError extends Error {
  constructor(public readonly errors: Error[]) {
    super();
  }
}

class CircuitBreakerStatics {
  private slotIterator = 0;
  private totals: Array<number> = [];
  private fails: Array<number> = [];
  private state = CircuitBreakerState.CLOSED;

  constructor(window: number, private slots: number) {
    this.resetCounts();
    setInterval(() => {
      this.slotIterator = ++this.slotIterator % slots;
      this.totals[this.slotIterator] = 0;
      this.fails[this.slotIterator] = 0;
    }, window / slots);
  }

  resetCounts(): void {
    this.totals = _.range(0, this.slots, 0); //[0,0,..0]
    this.fails = _.range(0, this.slots, 0);  //[0,0,..0]
  }

  incTotal(): void {
    this.totals[this.slotIterator]++;
  }

  incFail(): void {
    this.fails[this.slotIterator]++;
  }

  getTotal(): number {
    return _.sum(this.totals);
  }

  getFail(): number {
    return _.sum(this.fails);
  }

  getState(): CircuitBreakerState {
    return this.state;
  }

  setState(newState: CircuitBreakerState): void {
    console.log(`circuit breaker state: ${CircuitBreakerStateStr[this.state]} ===> ${CircuitBreakerStateStr[newState]}`);
    this.state = newState;
  }
}

interface CircuitBreakerStaticsMapType {
  [propName: string]: CircuitBreakerStatics
}


interface DistributeOptions {
  addrs: Array<any>;
  policy: string;
  maxAttempt: number;
  maxWait: number;
}

class DistributeError extends Error {
  constructor(public readonly errors: Error[]) {
    super();
  }
}

class Diplomat<T> {
  private CircuitBreakerStaticsMap: CircuitBreakerStaticsMapType = {};

  private chain: Array<ChainCall<T>> = [];
  private currentBackendID: string = '';
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

  distribute(options: DistributeOptions) {
    this.chain.push(
      (next) => async (...args) => {
        console.log('-> distribute', ...args);
        options.addrs = _.concat([...args], options.addrs);
        let iterator = 0;
        let attempt = 0;
        let timeOut = false;
        const expire = new Promise<T>((resolve, _reject) => {
          if (options.maxWait) {
            setTimeout(() => {
              console.log('distribute exceed max duration!');
              timeOut = true;
              resolve();
            }, options.maxWait);
          }
        });

        while (true) {
          try {
            this.currentBackendID=iterator.toString();
            console.log(`backend id:${this.currentBackendID}`);
            return await Promise.race([
              expire,
              next(options.addrs[iterator])
            ]);
          } catch (err) {
            if (options.maxAttempt && ++attempt >= options.maxAttempt) {
              console.log('distribute exceed max attempt!');
              throw new DistributeError([new Error("Distribute exceed max attempt!")]);
            }
            if (timeOut) {
              throw new DistributeError([new Error("Distribute exceed max duration!")]);
            }
            if (options.policy === 'ordered') {
              iterator = (++iterator) % options.addrs.length;
            } else {
              iterator = Math.floor(options.addrs.length * Math.random());
            }
          }
          // need to sleep awhile, otherwise timer 
          // callback get no chance to run
          await sleep(1);
        }
      });
    return this;
  }

  circuitBreaker(option: CircuitBreakerOption): Diplomat<T> {
    let CircuitBreakerStaticsMap = this.CircuitBreakerStaticsMap;
    let statics: CircuitBreakerStatics; 

    function getMyStatics(id: string): CircuitBreakerStatics {
      if (!CircuitBreakerStaticsMap[id]) {
        CircuitBreakerStaticsMap[id] = new CircuitBreakerStatics(option.window, option.slots);
      }
      return CircuitBreakerStaticsMap[id];
    }

    function transitToOpen() {
      statics.setState(CircuitBreakerState.OPEN);
      setTimeout(() => {
        statics.setState(CircuitBreakerState.HALF_OPEN);
      }, option.resetTimeout);
    }

    function transitToClose() {
      statics.setState(CircuitBreakerState.CLOSED);
      statics.resetCounts();
    }

    function exceedFailureThreshold(){
      return (statics.getFail()>=option.failureCountThreshold || statics.getFail()/statics.getTotal()>=option.failureCountThreshold);
    }

    this.chain.push(
      (next) => async (...args) => {
        console.log(`-> circuitBreaker  ${this.currentBackendID} `, ...args);
        if(this.currentBackendID){
          statics = getMyStatics(this.currentBackendID);
        }else{
          statics = getMyStatics('single');
        }
        if(statics.getState() === CircuitBreakerState.OPEN){
            const msg = `reject due to circuit ${this.currentBackendID} is open!`;
            console.log(msg);
            throw new CircuitBreakerError([new Error(msg)]);
        }

        try {
          statics.incTotal();
          let res = await next(...args);
          if (statics.getState() === CircuitBreakerState.HALF_OPEN) {
            transitToClose();
          }
          return res;
        } catch (err) {
          console.log(err);
          statics.incFail();
          if (exceedFailureThreshold()) {
            transitToOpen();
            throw new CircuitBreakerError([new Error(`circuit is opened!`)]);
          }
          throw err;
        }
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
  CircuitBreakerError,
  CircuitBreakerStatics,
  DistributeError,
}
