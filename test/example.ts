
import * as request from 'request-promise-native';
import * as _ from 'lodash';
import * as sinon from 'sinon';
import { expect } from 'chai';

import { diplomat, CircuitBreakerError, CircuitBreakerStatics, DistributeError } from '../src/';
import { sleep } from '../src/utils';

function fallback(host, a, b) {
  const s = `Fallback - ${host}, ${a}, ${b}`;
  console.log('## fallback:', s);
  return Promise.resolve(s);
}

function alwaysSuccess(host, a, b) {
  const s = `OK - ${host}, ${a}, ${b}`;
  console.log('-> alwaysSuccess:', s);
  return Promise.resolve(s);
}

function alwaysFail(host, a, b): never {
  const msg = `Error - ${host}, ${a}, ${b}`;
  console.log('-> alwaysFail:', msg);
  throw Error(msg);
}

function successOrFail(returnSuccess:boolean):Promise<string>{
  console.log(`-> successOrFail:${returnSuccess}`);
  if(returnSuccess){
    return Promise.resolve('Current call is successful')
  }else{
    return Promise.reject('Current call is failure')
  }
}

async function noReturn(host, a, b) {
  const msg = `Error - ${host}, ${a}, ${b}`;
  console.log('-> noReturn:', msg);
  await sleep(10000000);
  return Promise.resolve(msg);
}

describe('diplomat', () => {

  it('distribute: stop trying when until one path is successful', async () => {
    const spySuccessOrFail = sinon.spy(successOrFail);
    const f = diplomat().distribute(
      {
        addrs: [true, true],
        policy: 'ordered',
        maxAttempt: 200000,
        maxWait: 1000
      }).run(spySuccessOrFail);
    try {
      await f(false);
      sinon.assert.calledWith(spySuccessOrFail, true);
      sinon.assert.calledWith(spySuccessOrFail, false);
      sinon.assert.callCount(spySuccessOrFail, 2);
    } catch (err) {
      sinon.assert.fail('exception is thrown!',err);
    }
  });

  it('distribute: stop trying when attempt exceed max', async () => {
    const spyAlwaysFail = sinon.spy(alwaysFail);
    const maxAttempt = 4;
    const f = diplomat().distribute(
      {
        addrs: ['b.com', 'c.com'],
        policy: 'ordered',
        maxAttempt: maxAttempt,
        maxWait: 1000
      }).run(spyAlwaysFail);
    try {
      await f('a.com');
      sinon.assert.fail('exception is not thrown!');
    } catch (err) {
      expect(err).to.be.an.instanceof(DistributeError);
      sinon.assert.callCount(spyAlwaysFail, maxAttempt);
      sinon.assert.calledWith(spyAlwaysFail, 'a.com');
      sinon.assert.calledWith(spyAlwaysFail, 'b.com');
      sinon.assert.calledWith(spyAlwaysFail, 'c.com');
    }

  }).timeout(3000);

  const maxWait = 10;
  it('distribute: stop trying when duration exceed max', async () => {
    const spyAlwaysFail = sinon.spy(alwaysFail);
    const f = diplomat().distribute(
      {
        addrs: ['b.com', 'c.com'],
        policy: 'random',
        maxAttempt: 200000,
        maxWait: maxWait
      }).run(spyAlwaysFail);
    try {
      await f('a.com');
      sinon.assert.fail('exception is not thrown!');
    } catch (err) {
      expect(err).to.be.an.instanceof(DistributeError);
    }
  }).timeout(30+maxWait);

  it('circuit breaker window should advance', async () => {
    const slotDuration = 100;
    const slots = 10;
    const window = slots * slotDuration;
    const statics = new CircuitBreakerStatics(window, slots);
    statics.incTotal();
    statics.incFail();
    await sleep(slotDuration * 3);
    statics.incTotal();
    statics.incTotal();
    statics.incFail();
    expect(statics.getTotal()).to.eql(3);
    expect(statics.getFail()).to.eql(2);
    // now window have advanced 1 slot
    await sleep(slotDuration * 8);
    expect(statics.getTotal()).to.eql(2);
    expect(statics.getFail()).to.eql(1);
  }).timeout(3000);

  it('call should be made when circuit is half open,call should not be made when circuit is open', async () => {
    const resetTimeout = 1000;
    const option = {
      failureCountThreshold: 1,
      failureRateThreshold: 0.9,
      window: 10000,
      slots: 1,
      resetTimeout: resetTimeout
    }
    const spyAlwaysFail = sinon.spy(alwaysFail);
    const spyAlwaysSuccess = sinon.spy(alwaysSuccess);
    const f = diplomat().circuitBreaker(option).run(spyAlwaysFail);

    await f('foo.com').catch(() => { });
    sinon.assert.callCount(spyAlwaysFail, 1);

    // now circuit is open, immediate subsequent call should be skipped
    try {
      await f('foo.com');
      sinon.assert.fail('exception is not thrown!');
    } catch (err) {
      expect(err).to.be.an.instanceof(CircuitBreakerError);
    }
    sinon.assert.callCount(spyAlwaysFail, 1);

    await sleep(resetTimeout + 200);
    // now circuit is half open, test call should be made
    await f('foo.com').catch(() => { });
    sinon.assert.callCount(spyAlwaysFail, 2);

    // now circuit is opened again as last call fail, immediate subsequent call should be skipped
    await f('foo.com').catch(() => { });
    sinon.assert.callCount(spyAlwaysFail, 2);

    await sleep(resetTimeout + 200);
    // now circuit is half open, test call should be made
    await diplomat().circuitBreaker(option).run(spyAlwaysSuccess)()
    sinon.assert.callCount(spyAlwaysSuccess, 1);

    // now circuit is closed again as last call is successful, subsequent call should be made
    await diplomat().circuitBreaker(option).run(spyAlwaysSuccess)()
    sinon.assert.callCount(spyAlwaysSuccess, 2);

  }).timeout(15000);

  it('distribute().circuitBreaker() trigger circuit break per address', async () => {
    const resetTimeout = 1000;
    const spyAlwaysFail = sinon.spy(alwaysFail);
    const f = diplomat()
    .distribute({
      addrs: ['b.com', 'c.com'],
      policy: 'ordered',
      maxAttempt: 5,
      maxWait: 10*1000  
    })
    .circuitBreaker({
      failureCountThreshold: 1,
      failureRateThreshold: 0.9,
      window: 1000,
      slots: 1,
      resetTimeout: resetTimeout
    })
    .run(spyAlwaysFail);

    try {
      await f('a.com');
      sinon.assert.fail('exception is not thrown!');
    } catch (err) {
      expect(err).to.be.an.instanceof(DistributeError);
    }
    sinon.assert.callCount(spyAlwaysFail, 3);
  }).timeout(15000);

  it('always success', async () => {
    const f = diplomat()
      .fallback(fallback)
      .retry()
      .timeout({ maxWait: 500 })
      .run(alwaysSuccess);

    const result = await f('foo.com', 'foo-a', 'foo-b');
    console.log(result);
  });

  it('always fail', async () => {
    const f = diplomat()
      .fallback(fallback)
      .retry()
      .timeout({ maxWait: 500 })
      .run(alwaysFail);

    const result = await f('foo.com', 'foo-a', 'foo-b');
    console.log(result);
  }).timeout('5s');

  it('always timeout', async () => {
    const f = diplomat()
      .fallback(fallback)
      .retry()
      .timeout({ maxWait: 500 })
      .run(noReturn);

    const result = await f('foo.com', 'foo-a', 'foo-b');
    console.log(result);
  }).timeout('5s');

});
