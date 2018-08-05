
import * as request from 'request-promise-native';
import * as _ from 'lodash';

import { diplomat } from '../src/';
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

async function noReturn(host, a, b) {
  const msg = `Error - ${host}, ${a}, ${b}`;
  console.log('-> noReturn:', msg);
  await sleep(10000000);
  return Promise.resolve(msg);
}


describe('diplomat', () => {

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
